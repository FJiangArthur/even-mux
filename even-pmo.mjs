#!/usr/bin/env node
// even-pmo — a PMO that watches every Orca and Codex conversation (through even-mux) and answers
// for you when it's safe, escalating everything else to you on the glasses / web panel.
//
// Modes:  off     – not watching
//         shadow  – decides and logs what it *would* do; sends nothing (default on first run)
//         draft   – every reply becomes a draft you approve
//         auto    – low-risk replies are sent; risky ones are escalated to you
//
// Hard rules (enforced in code, not just in the prompt):
//   • approval menus are never answered automatically
//   • replies / questions matching escalatePatterns (deploy, prod, delete, push, migrate, pay, send, secrets…)
//     are escalated
//   • low-confidence answers are escalated
//   • per-session and global rate limits; repeated back-and-forth without you → escalated
//
// The PMO itself is a session on the glasses (pin it) and has a web panel at /ui (loopback only).

import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const VERSION = "0.1.0";
const DIR = process.env.EVEN_PMO_DIR || path.join(os.homedir(), ".even-pmo");
const CONFIG_PATH = path.join(DIR, "config.json");
const STATE_PATH = path.join(DIR, "state.json");
const PKG_DIR = path.dirname(fs.realpathSync(fileURLToPath(import.meta.url)));
const PMO_ID = "5e1f0a00-0000-4000-8000-0000000000a1";
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();

const DEFAULT_PATTERNS = [
  "\\b(deploy|deployment|release|rollback|roll back|production|prod)\\b",
  "migrat",
  "rm -rf|--force|force[- ]push|reset --hard|drop (table|database)|truncate",
  "\\bgit (push|merge|rebase)\\b|\\bmerge (the |this )?(pr|branch)",
  "\\b(delete|remove all|wipe|purge)\\b",
  "secret|token|password|credential|api[ _-]?key",
  "\\b(pay|payment|invoice|purchase|billing|refund|charge)\\b",
  "send (an? )?(email|message)|publish|post to|tweet",
  "上线|部署|生产|回滚|迁移|删除|清空|推送|合并|付款|支付|发送|发布|密钥|密码|凭证",
];

function loadConfig() {
  fs.mkdirSync(DIR, { recursive: true });
  let cfg = {};
  if (fs.existsSync(CONFIG_PATH)) cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  const merged = {
    port: 3460,
    host: "127.0.0.1",
    token: randomBytes(16).toString("hex"),
    mux: { url: "http://127.0.0.1:3456", token: "auto" },
    watchBackends: ["orca", "codex"],
    pollMs: 8000,
    claudeCommand: "claude",
    model: null,
    concurrency: 2,
    limits: { perSessionPerHour: 4, perHour: 30, minGapSec: 90, maxConsecutive: 3 },
    escalatePatterns: DEFAULT_PATTERNS,
    owner: "Art Jiang — senior ML engineer; runs many AI coding agents (Claude Code, Codex, Pi) across a Mac and an EC2 host 'artekne'. Prefers concise, direct, technically precise replies. Bilingual English / 中文: reply in the language the agent uses.",
    instructions: "",
    ...cfg,
  };
  if (!fs.existsSync(CONFIG_PATH) || !cfg.token) fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2) + "\n", { mode: 0o600 });
  if (merged.mux.token === "auto") {
    try { merged.mux.token = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".even-mux", "config.json"), "utf8")).token; } catch {}
  }
  return merged;
}

// ── persisted state ─────────────────────────────────────────────────────
class State {
  constructor() {
    let d = {};
    try { d = JSON.parse(fs.readFileSync(STATE_PATH, "utf8")); } catch {}
    this.mode = d.mode ?? "shadow";
    this.muted = new Set(d.muted ?? []);
    this.seen = d.seen ?? {};                 // sessionId → signature already handled
    this.log = d.log ?? [];                   // newest last
    this.escalations = d.escalations ?? [];   // open items
    this.sent = d.sent ?? [];                 // [{at, sessionId}] auto sends, for rate limits
    this.consecutive = d.consecutive ?? {};   // sessionId → auto replies since you last spoke
    this.lastAuto = d.lastAuto ?? {};         // sessionId → text of the PMO's last auto reply
    this.dirty = false;
    setInterval(() => this.flush(), 3000).unref();
  }
  touch() { this.dirty = true; }
  flush() {
    if (!this.dirty) return;
    this.dirty = false;
    const cut = now() - 24 * 3600e3;
    this.sent = this.sent.filter((s) => s.at > cut);
    this.log = this.log.slice(-400);
    fs.writeFileSync(STATE_PATH, JSON.stringify({
      mode: this.mode, muted: [...this.muted], seen: this.seen, log: this.log,
      escalations: this.escalations, sent: this.sent, consecutive: this.consecutive, lastAuto: this.lastAuto,
    }, null, 2));
  }
}

// ── Claude (the PMO's brain) ────────────────────────────────────────────
class Brain {
  constructor(cfg) { this.cfg = cfg; this.active = 0; this.queue = []; }

  async run(system, user) {
    if (this.active >= this.cfg.concurrency) await new Promise((r) => this.queue.push(r));
    this.active++;
    try { return await this.once(system, user); }
    finally { this.active--; this.queue.shift()?.(); }
  }

  once(system, user) {
    return new Promise((resolve, reject) => {
      const env = { ...process.env };
      delete env.ANTHROPIC_API_KEY;      // an API key in the shell makes `claude -p` hang here; use the claude.ai login
      delete env.ANTHROPIC_BASE_URL;
      const args = ["-p", "--output-format", "json", "--max-turns", "1", "--strict-mcp-config", "--tools", "", "--system-prompt", system];
      if (this.cfg.model) args.push("--model", this.cfg.model);
      const p = spawn(this.cfg.claudeCommand, args, { env, cwd: os.tmpdir(), stdio: ["pipe", "pipe", "pipe"] });
      let out = "", err = "";
      const timer = setTimeout(() => { p.kill("SIGKILL"); reject(new Error("claude timed out")); }, 180000);
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (err += d));
      p.on("error", (e) => { clearTimeout(timer); reject(e); });
      p.on("close", () => {
        clearTimeout(timer);
        try {
          const env2 = JSON.parse(out.slice(out.indexOf("{")));
          if (env2.is_error) return reject(new Error(String(env2.result ?? "claude error").slice(0, 300)));
          const text = String(env2.result ?? "");
          const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
          resolve({ json, cost: env2.total_cost_usd ?? 0 });
        } catch (e) {
          reject(new Error(`bad claude output: ${(err || out).slice(0, 300)}`));
        }
      });
      p.stdin.end(user);
    });
  }
}

const DECIDE_SYSTEM = (cfg) => `You are the PMO (project manager) for ${cfg.owner}
You supervise many AI coding agents. One of them has just stopped and is waiting. Decide whether to answer it on the owner's behalf.

Reply on the owner's behalf ONLY when the answer is low-risk and clear:
- the agent asks whether to continue / proceed with work that is already scoped and agreed;
- the agent asks a clarifying question you can answer from the conversation itself;
- the agent offers options and one is clearly marked recommended or obviously matches the stated goal.

ESCALATE (never answer yourself) anything involving: approval of a tool/command, deleting or overwriting data, force operations, deploys, production systems, migrations, git push / merge / release, spending money, sending email/messages/posts externally, credentials or secrets, changing scope or priorities, anything irreversible, or anything you are not sure about. For escalations still write the reply you would suggest.

If the agent only reports finished work and asks nothing, choose "none".

Write replies as the owner: short, direct, in the same language the agent used. No pleasantries.
${cfg.instructions ? `\nStanding instructions from the owner:\n${cfg.instructions}\n` : ""}
Output ONLY a JSON object:
{"action":"reply"|"escalate"|"none","reply":"<text to send, or suggested text>","reason":"<one short sentence>","confidence":0.0-1.0,"summary":"<one line: where this session stands>"}`;

const CHAT_SYSTEM = (cfg) => `You are the PMO for ${cfg.owner}
You can see a snapshot of all the AI agent sessions you supervise. Answer the owner's message concisely in their language.
If the owner tells you to tell / ask / instruct one or more sessions something, include actions with the exact sessionId from the snapshot and the text to send (as the owner).
Output ONLY a JSON object: {"answer":"<reply to the owner>","actions":[{"sessionId":"...","text":"..."}]}`;

// ── PMO ─────────────────────────────────────────────────────────────────
class Pmo {
  constructor(cfg) {
    this.cfg = cfg;
    this.st = new State();
    this.brain = new Brain(cfg);
    this.patterns = (cfg.escalatePatterns ?? DEFAULT_PATTERNS).map((p) => new RegExp(p, "i"));
    this.rows = [];                // last /mux/sessions snapshot (watched only)
    this.prevKey = new Map();      // sessionId → status|timestamp
    this.lastInfo = new Map();     // sessionId → last /last result
    this.inflight = new Set();
    this.events = [];
    this.nextId = 1;
    this.clients = new Set();
    this.firstPoll = true;
    this.lastError = null;
  }

  // ── even-mux access ──
  async mux(method, p, body, timeout = 30000) {
    const u = new URL(p, this.cfg.mux.url);
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const req = http.request(u, { method, timeout, headers: {
        authorization: `Bearer ${this.cfg.mux.token}`, ...(data ? { "content-type": "application/json", "content-length": data.length } : {}),
      } }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          let json = null; try { json = JSON.parse(text); } catch {}
          if (res.statusCode >= 400) return reject(new Error(json?.error?.message ?? json?.error ?? `HTTP ${res.statusCode}`));
          resolve(json);
        });
      });
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", reject);
      if (data) req.write(data);
      req.end();
    });
  }

  // ── PMO's own session (what the glasses show) ──
  emit(msg) {
    const id = this.nextId++;
    this.events.push({ id, msg, at: now() });
    if (this.events.length > 500) this.events.splice(0, this.events.length - 500);
    const frame = `id: ${id}\ndata: ${JSON.stringify(msg)}\n\n`;
    for (const res of this.clients) { try { res.write(frame); } catch { this.clients.delete(res); } }
  }
  say(text) {
    this.emit({ type: "status", state: "busy", sessionId: PMO_ID, provider: "claude" });
    this.emit({ type: "result", success: true, text, sessionId: PMO_ID, costUsd: 0, provider: "claude", turns: 1, durationMs: 0, inputTokens: 0, outputTokens: 0 });
    this.emit({ type: "status", state: "idle", sessionId: PMO_ID, provider: "claude" });
  }
  record(entry) {
    this.st.log.push({ at: now(), ...entry });
    this.st.touch();
    log(`[pmo] ${entry.action} · ${entry.title ?? entry.sessionId ?? ""} · ${entry.reason ?? ""}`.slice(0, 200));
  }

  // ── watching ──
  async poll() {
    if (this.st.mode === "off") return;
    let data;
    try { data = await this.mux("GET", "/mux/sessions", undefined, 60000); this.lastError = null; }
    catch (e) { this.lastError = `even-mux: ${e.message}`; return; }
    this.rows = (data.sessions ?? []).filter((s) => this.cfg.watchBackends.includes(s.backend) && s.id !== PMO_ID);
    const checks = [];
    for (const s of this.rows) {
      if (this.st.muted.has(s.id)) continue;
      const key = `${s.status}|${s.timestamp}`;
      const changed = this.prevKey.get(s.id) !== key;
      this.prevKey.set(s.id, key);
      if (!changed && s.status !== "awaiting") continue;
      if (s.status === "busy") continue;
      checks.push(s);
    }
    const baseline = this.firstPoll;
    this.firstPoll = false;
    for (const s of checks) this.check(s, baseline).catch((e) => log(`[pmo] check ${s.id.slice(0, 8)}: ${e.message}`));
  }

  async check(s, baseline) {
    if (this.inflight.has(s.id)) return;
    this.inflight.add(s.id);
    try {
      const last = await this.mux("GET", `/api/sessions/${encodeURIComponent(s.id)}/last`, undefined, 60000);
      this.lastInfo.set(s.id, { ...last, title: s.display ?? s.title, backend: s.backend, at: now() });
      if (last.state === "busy") return;
      const sig = last.pending ? `pending:${last.stamp}:${last.pending.description}` : `done:${last.stamp}`;
      if (baseline && this.st.seen[s.id] === undefined) { this.st.seen[s.id] = sig; this.st.touch(); return; }
      if (this.st.seen[s.id] === sig) return;
      this.st.seen[s.id] = sig;
      this.st.touch();
      if (!last.pending && !String(last.text ?? "").trim()) return;
      await this.decide(s, last);
    } finally {
      this.inflight.delete(s.id);
    }
  }

  risky(...texts) {
    const t = texts.filter(Boolean).join("\n");
    return this.patterns.find((re) => re.test(t))?.source ?? null;
  }

  rateLimited(sessionId) {
    const L = this.cfg.limits;
    const hour = now() - 3600e3;
    const mine = this.st.sent.filter((x) => x.sessionId === sessionId);
    if (this.st.sent.filter((x) => x.at > hour).length >= L.perHour) return "global hourly limit";
    if (mine.filter((x) => x.at > hour).length >= L.perSessionPerHour) return "session hourly limit";
    if (mine.length && now() - mine[mine.length - 1].at < L.minGapSec * 1000) return "too soon after last auto reply";
    if ((this.st.consecutive[sessionId] ?? 0) >= L.maxConsecutive) return `${L.maxConsecutive} auto replies in a row without you`;
    return null;
  }

  async decide(s, last) {
    const title = s.display ?? s.title;
    // Someone other than the PMO spoke to this agent since our last auto reply → reset the streak.
    const mine = (this.st.lastAuto[s.id] ?? "").trim();
    if (last.prompt && mine && String(last.prompt).trim() !== mine) { this.st.consecutive[s.id] = 0; this.st.touch(); }
    const base = { sessionId: s.id, title, backend: s.backend, question: String(last.pending?.description || last.text || "").slice(-500) };

    // Approval menus: never automatic.
    if (last.pending?.kind === "approval") {
      return this.escalate({ ...base, kind: "approval", draft: "", reason: "approval menu — always yours", options: last.pending.options ?? [], detail: last.pending.detail ?? "" });
    }

    let history = [];
    try { history = (await this.mux("GET", `/api/sessions/${encodeURIComponent(s.id)}/history?limit=6`)).history ?? []; } catch {}
    const convo = history.map((h) => `${h.role.toUpperCase()}: ${String(h.text).slice(0, 1200)}`).join("\n\n");
    const user = [
      `Session: ${title}  (backend: ${s.backend}, provider: ${s.provider ?? "?"}, folder: ${s.cwd || "?"})`,
      last.pending ? `The agent is asking: ${last.pending.description}\n${last.pending.detail ?? ""}` : "",
      last.prompt ? `Last instruction the agent received:\n${String(last.prompt).slice(0, 1500)}` : "",
      convo ? `Recent conversation (oldest first):\n${convo}` : "",
      `Agent's latest message (it is now waiting):\n${String(last.text ?? "").slice(-4000)}`,
    ].filter(Boolean).join("\n\n");

    let d;
    try { d = (await this.brain.run(DECIDE_SYSTEM(this.cfg), user)).json; }
    catch (e) { this.record({ ...base, action: "error", reason: e.message }); return; }
    const reply = String(d.reply ?? "").trim();
    let action = d.action;
    let reason = String(d.reason ?? "");
    const conf = Number(d.confidence ?? 0);

    if (action === "none") { this.record({ ...base, action: "none", reason, summary: d.summary }); return; }
    if (action === "reply") {
      const hit = this.risky(reply, base.question);
      if (hit) { action = "escalate"; reason = `risk pattern /${hit}/ — ${reason}`; }
      else if (conf < 0.6) { action = "escalate"; reason = `low confidence (${conf}) — ${reason}`; }
      else if (!reply) { action = "escalate"; reason = `empty reply — ${reason}`; }
    }
    if (action === "reply" && this.st.mode === "auto") {
      const limited = this.rateLimited(s.id) ?? (mine && reply === mine && (this.st.consecutive[s.id] ?? 0) > 0 ? "same reply as last time — possible loop" : null);
      if (limited) { action = "escalate"; reason = `${limited} — ${reason}`; }
    }
    if (action === "reply" && this.st.mode === "draft") action = "escalate";

    if (this.st.mode === "shadow") {
      this.record({ ...base, action: action === "reply" ? "shadow-reply" : "shadow-escalate", reply, reason, confidence: conf, summary: d.summary });
      return;
    }
    if (action === "reply") return this.send(base, reply, reason, conf);
    return this.escalate({ ...base, kind: last.pending?.kind === "question" ? "question" : "reply", draft: reply, reason, confidence: conf, summary: d.summary });
  }

  async send(base, text, reason, confidence, by = "auto") {
    try {
      await this.mux("POST", "/api/prompt", { sessionId: base.sessionId, text });
      if (by === "auto") {
        this.st.sent.push({ at: now(), sessionId: base.sessionId });
        this.st.consecutive[base.sessionId] = (this.st.consecutive[base.sessionId] ?? 0) + 1;
        this.st.lastAuto[base.sessionId] = text;
      } else {
        this.st.consecutive[base.sessionId] = 0;
        this.st.lastAuto[base.sessionId] = "";
      }
      this.record({ ...base, action: by === "auto" ? "auto-reply" : "sent", reply: text, reason, confidence });
      this.say(`${by === "auto" ? "✅ 已自动回复" : "📤 已发送"} ${base.title}\n→ ${text}`);
    } catch (e) {
      this.record({ ...base, action: "error", reply: text, reason: `send failed: ${e.message}` });
      this.say(`⚠️ 发送失败 ${base.title}: ${e.message}`);
    }
  }

  escalate(item) {
    if (this.st.escalations.some((x) => x.sessionId === item.sessionId && x.question === item.question)) return;
    const esc = { id: randomBytes(6).toString("hex"), at: now(), ...item };
    this.st.escalations.push(esc);
    this.record({ ...item, action: "escalated" });
    this.emitEscalation(esc);
  }

  escOptions(esc) {
    if (esc.kind === "approval") {
      const opts = (esc.options ?? []).map((o) => {
        const m = String(o).match(/^(\d)[.)]\s*(.*)$/);
        if (m) return { key: `opt:${m[1]}`, text: m[2] };
        const label = { allow: "Yes", allowAlways: "Yes, for this session", deny: "No" }[o] ?? String(o);
        return { key: `opt:${o}`, text: label };
      });
      return [...opts, { key: "skip", text: "跳过（我自己去看）" }];
    }
    return [
      ...(esc.draft ? [{ key: "send", text: "发送建议回复" }] : []),
      { key: "skip", text: "跳过（我自己去看）" },
    ];
  }

  emitEscalation(esc) {
    this.emit({
      type: "permission_request",
      toolName: "PMO",
      description: `[${esc.title}] ${esc.kind === "approval" ? "需要审批" : "在等你"}：${String(esc.question).slice(-220)}`,
      detail: esc.draft ? `建议回复：${esc.draft}\n(${esc.reason})` : String(esc.detail || esc.reason || ""),
      toolUseId: esc.id,
      options: this.escOptions(esc),
      suggestions: null,
    });
  }

  async resolve(escId, key, text) {
    const i = this.st.escalations.findIndex((x) => x.id === escId);
    if (i < 0) throw new Error("no such escalation");
    const esc = this.st.escalations[i];
    this.st.escalations.splice(i, 1);
    this.st.touch();
    const base = { sessionId: esc.sessionId, title: esc.title, backend: esc.backend, question: esc.question };
    this.emit({ type: "permission_result", toolName: "PMO", summary: esc.title, decision: key === "skip" ? "denied" : "allowed" });
    if (key === "skip") { this.record({ ...base, action: "skipped" }); return; }
    if (key?.startsWith("opt:")) {
      const decision = key.slice(4);
      try {
        await this.mux("POST", "/api/permission-response", { sessionId: esc.sessionId, decision });
        this.st.consecutive[esc.sessionId] = 0;
        this.record({ ...base, action: "approved-by-you", reply: decision });
        this.say(`✔ ${esc.title}: 已选 ${decision}`);
      } catch (e) {
        this.record({ ...base, action: "error", reason: `approval failed: ${e.message}` });
        this.say(`⚠️ ${esc.title}: ${e.message}`);
      }
      return;
    }
    const msg = (text ?? "").trim() || esc.draft;
    if (!msg) throw new Error("nothing to send");
    await this.send(base, msg, "sent by you", 1, "you");
  }

  // ── talking to the PMO ──
  async chat(text) {
    const m = text.match(/^\s*(回复|reply)\s*[:：]\s*([\s\S]+)$/i);
    if (m && this.st.escalations.length) {
      const esc = this.st.escalations[0];
      return this.resolve(esc.id, "send", m[2]);
    }
    this.emit({ type: "user_prompt", text });
    this.emit({ type: "status", state: "busy", sessionId: PMO_ID, provider: "claude" });
    const snapshot = this.rows.map((s) => {
      const li = this.lastInfo.get(s.id);
      return `- ${s.id} | ${s.display ?? s.title} | ${s.status}${li?.text ? ` | last: ${String(li.text).replace(/\s+/g, " ").slice(0, 240)}` : ""}`;
    }).join("\n");
    const open = this.st.escalations.map((e) => `- [${e.title}] ${String(e.question).slice(-160)}`).join("\n") || "(none)";
    const recent = this.st.log.slice(-15).map((l) => `- ${new Date(l.at).toISOString().slice(11, 16)} ${l.action} ${l.title ?? ""}: ${String(l.reply ?? l.reason ?? "").slice(0, 120)}`).join("\n");
    const user = `Sessions:\n${snapshot}\n\nWaiting for the owner:\n${open}\n\nRecent PMO actions:\n${recent}\n\nOwner says: ${text}`;
    let d;
    try { d = (await this.brain.run(CHAT_SYSTEM(this.cfg), user)).json; }
    catch (e) { this.say(`⚠️ ${e.message}`); return; }
    const done = [];
    for (const a of d.actions ?? []) {
      const s = this.rows.find((r) => r.id === a.sessionId);
      if (!s || !a.text) continue;
      await this.send({ sessionId: s.id, title: s.display ?? s.title, backend: s.backend, question: "" }, a.text, `you asked: ${text.slice(0, 80)}`, 1, "you");
      done.push(s.display ?? s.title);
    }
    this.say(`${d.answer ?? ""}${done.length ? `\n\n已发送给：${done.join("、")}` : ""}`);
  }

  reviewWaiting() {
    let n = 0;
    for (const s of this.rows) {
      if (s.status !== "busy" && this.st.seen[s.id] !== undefined && !this.st.muted.has(s.id)) { delete this.st.seen[s.id]; this.prevKey.delete(s.id); n++; }
    }
    this.firstPoll = false;
    this.st.touch();
    return n;
  }

  title() {
    const n = this.st.escalations.length;
    return `★ PMO · ${n ? `${n} 件待你处理` : "无待办"} · ${{ off: "已关闭", shadow: "观察模式", draft: "草稿模式", auto: "自动模式" }[this.st.mode] ?? this.st.mode}`;
  }

  stateJson() {
    const hour = now() - 3600e3;
    return {
      mode: this.st.mode,
      watching: this.rows.length,
      busy: this.rows.filter((r) => r.status === "busy").length,
      autoRepliesLastHour: this.st.sent.filter((x) => x.at > hour).length,
      limits: this.cfg.limits,
      escalations: this.st.escalations.map((e) => ({ ...e, options: this.escOptions(e) })),
      log: this.st.log.slice(-150).reverse(),
      muted: [...this.st.muted].map((id) => ({ id, title: this.rows.find((r) => r.id === id)?.display ?? id })),
      sessions: this.rows.map((r) => ({ id: r.id, title: r.display ?? r.title, backend: r.backend, status: r.status, muted: this.st.muted.has(r.id) })),
      error: this.lastError,
    };
  }
}

// ── HTTP: even-terminal API for the glasses + loopback control/UI ───────
function main() {
  const cfg = loadConfig();
  const pmo = new Pmo(cfg);

  const send = (res, status, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
    res.end(body);
  };
  const readBody = (req) => new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || "{}")); } catch { resolve({}); } });
  });

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    const body = req.method === "GET" ? {} : await readBody(req);
    try {
      // Loopback control panel
      if (u.pathname === "/ui" || u.pathname.startsWith("/pmo/")) {
        const addr = req.socket.remoteAddress ?? "";
        if (!/^(::ffff:)?127\.|^::1$/.test(addr)) return send(res, 403, { error: "loopback only" });
        if (u.pathname === "/ui") {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
          return res.end(fs.readFileSync(path.join(PKG_DIR, "pmo-ui.html")));
        }
        if (u.pathname === "/pmo/state") return send(res, 200, pmo.stateJson());
        if (u.pathname === "/pmo/mode" && req.method === "POST") {
          if (!["off", "shadow", "draft", "auto"].includes(body.mode)) return send(res, 400, { error: "bad mode" });
          pmo.st.mode = body.mode; pmo.st.touch();
          pmo.say(`模式切换为：${pmo.title().split(" · ").pop()}`);
          return send(res, 200, { ok: true });
        }
        if (u.pathname === "/pmo/escalation" && req.method === "POST") {
          await pmo.resolve(body.id, body.key, body.text);
          return send(res, 200, { ok: true });
        }
        if (u.pathname === "/pmo/mute" && req.method === "POST") {
          if (body.muted) pmo.st.muted.add(body.sessionId); else pmo.st.muted.delete(body.sessionId);
          pmo.st.touch();
          return send(res, 200, { ok: true });
        }
        if (u.pathname === "/pmo/review-waiting" && req.method === "POST") return send(res, 200, { ok: true, queued: pmo.reviewWaiting() });
        if (u.pathname === "/pmo/chat" && req.method === "POST") { pmo.chat(String(body.text ?? "")).catch(() => {}); return send(res, 202, { ok: true }); }
        return send(res, 404, { error: "not found" });
      }

      if (!u.pathname.startsWith("/api/")) return send(res, 404, { error: "not found" });
      const h = req.headers.authorization;
      const tok = h?.startsWith("Bearer ") ? h.slice(7) : u.searchParams.get("token");
      if (tok !== cfg.token) return send(res, 401, { error: { code: "auth_failed", message: "Unauthorized" } });
      const p = u.pathname.slice(4);
      const status = pmo.st.escalations.length ? "awaiting" : "idle";

      if (p === "/sessions") {
        const lastAt = pmo.events.length ? pmo.events[pmo.events.length - 1].at : now();
        return send(res, 200, { sessions: [{ id: PMO_ID, title: pmo.title(), timestamp: new Date(Math.max(lastAt, now() - 60e3)).toISOString(), cwd: "", provider: "claude", status }] });
      }
      if (p === "/prompt" && req.method === "POST") {
        if (!body.text) return send(res, 400, { error: "Missing 'text' field" });
        pmo.chat(String(body.text)).catch((e) => pmo.say(`⚠️ ${e.message}`));
        return send(res, 202, { ok: true, sessionId: PMO_ID, provider: "claude" });
      }
      if (p === "/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
        res.write(":ok\n\n");
        if (u.searchParams.get("needReplay") === "true") for (const e of pmo.events) res.write(`id: ${e.id}\ndata: ${JSON.stringify(e.msg)}\n\n`);
        // Re-raise open escalations so a fresh viewer can act on them.
        for (const esc of pmo.st.escalations) pmo.emitEscalation(esc);
        pmo.clients.add(res);
        const hb = setInterval(() => { try { res.write(":heartbeat\n\n"); } catch {} }, 15000);
        res.on("close", () => { clearInterval(hb); pmo.clients.delete(res); });
        return;
      }
      if (p === "/messages") {
        const after = Number(u.searchParams.get("after")) || 0;
        return send(res, 200, { messages: pmo.events.filter((e) => e.id > after).map((e) => ({ id: e.id, ...e.msg })), state: status, sessionId: PMO_ID, provider: "claude" });
      }
      if (p === "/status") return send(res, 200, { state: status, sessionId: PMO_ID, provider: "claude" });
      if (p === "/permission-response" && req.method === "POST") {
        const esc = pmo.st.escalations[0];
        if (!esc) return send(res, 400, { error: "Nothing is waiting for you" });
        await pmo.resolve(esc.id, body.decision === "deny" ? "skip" : body.decision);
        return send(res, 200, { ok: true });
      }
      if (p === "/question-response" && req.method === "POST") return send(res, 200, { ok: true });
      if (p === "/interrupt" && req.method === "POST") return send(res, 200, { ok: true });
      if (/^\/sessions\/[^/]+\/history$/.test(p)) {
        return send(res, 200, { history: pmo.st.log.slice(-10).map((l) => ({ role: "assistant", text: `${l.action} · ${l.title ?? ""}${l.reply ? ` → ${l.reply}` : ""}` })) });
      }
      if (p === "/info") return send(res, 200, { account: { email: "", organization: "", subscriptionType: "" }, model: "PMO (Claude)", version: VERSION, provider: "claude", extra: { expose: "off" } });
      if (p === "/update-check") return send(res, 200, { packageName: "even-pmo", currentVersion: VERSION, newestVersion: VERSION, updateAvailable: false, checkedAt: new Date().toISOString() });
      return send(res, 404, { error: "not found" });
    } catch (e) {
      log(`[err] ${u.pathname}: ${e.message}`);
      return send(res, e.statusCode ?? 500, { error: e.message });
    }
  });

  server.listen(cfg.port, cfg.host, () => {
    log(`even-pmo v${VERSION} on ${cfg.host}:${cfg.port} · mode ${pmo.st.mode} · panel http://127.0.0.1:${cfg.port}/ui`);
    log(`add to even-mux: { "url": "http://127.0.0.1:${cfg.port}", "token": "<~/.even-pmo/config.json token>", "tag": "", "allProviders": true }`);
  });

  (async () => {
    await sleep(2000);
    for (;;) {
      await pmo.poll().catch((e) => { pmo.lastError = e.message; });
      await sleep(cfg.pollMs);
    }
  })();
  const bye = () => { pmo.st.dirty = true; pmo.st.flush(); process.exit(0); };
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);
}

main();
