#!/usr/bin/env node
// even-codex — Codex threads (Codex UI in ChatGPT.app, Codex CLI) on Even Realities glasses.
//
// Runs its own `codex app-server --listen stdio://` (the same thing ChatGPT.app does) and speaks
// the even-terminal HTTP/SSE API, so even-mux can list it as one more backend. All app-servers read
// the same ~/.codex store, so Codex UI threads are listed, readable and resumable from here.
//
// Caveats (inherent to Codex UI owning its own private app-server):
//   • A reply sent from here is written to the thread on disk; ChatGPT's Codex UI shows it after the
//     thread is reopened. If the UI is actively running a turn on the same thread, we refuse to write.
//   • Approval prompts raised inside the Codex UI can't be answered from here; approvals for turns
//     started from here (glasses / PMO) can.
//
// Usage:  even-codex            start (config: ~/.even-codex/config.json, created on first run)
//         even-codex doctor     list what it sees

import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

const VERSION = "0.1.0";
const DIR = process.env.EVEN_CODEX_DIR || path.join(os.homedir(), ".even-codex");
const CONFIG_PATH = path.join(DIR, "config.json");
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function loadConfig() {
  fs.mkdirSync(DIR, { recursive: true });
  let cfg = {};
  if (fs.existsSync(CONFIG_PATH)) cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  const merged = {
    port: 3459,
    host: "127.0.0.1",
    token: randomBytes(16).toString("hex"),
    codexCommand: "codex",
    sourceKinds: ["cli", "vscode", "appServer"],
    listLimit: 60,
    defaultCwd: null,
    // Noise: readiness probes, and Codex threads that Orca already shows as terminals.
    hideTitles: ["^Reply READY", "^Readiness probe", "^Confirm readiness", "^You are working inside Orca"],
    originatorLabels: { "Codex Desktop": "Codex UI", codex_work_desktop: "Codex UI", "codex-tui": "Codex CLI" },
    ...cfg,
  };
  if (!fs.existsSync(CONFIG_PATH) || !cfg.token) fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2) + "\n", { mode: 0o600 });
  return merged;
}

// ── app-server client (newline-delimited JSON-RPC over stdio) ─────────
class AppServer {
  constructor(cmd) {
    this.cmd = cmd;
    this.nextId = 1;
    this.pending = new Map();
    this.onNotification = () => {};
    this.onRequest = () => {};
    this.ready = null;
  }

  start() {
    this.ready = new Promise((resolve, reject) => {
      const p = spawn(this.cmd, ["app-server", "--listen", "stdio://"], { stdio: ["pipe", "pipe", "pipe"] });
      this.proc = p;
      let buf = "";
      p.stdout.on("data", (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (line.trim()) this.handle(line);
        }
      });
      p.stderr.on("data", (d) => { const s = d.toString().trim(); if (s) log(`[app-server] ${s.slice(0, 300)}`); });
      p.on("error", (e) => reject(e));
      p.on("exit", (code) => {
        log(`[app-server] exited (${code}); restarting in 3s`);
        for (const { reject: rj } of this.pending.values()) rj(new Error("app-server exited"));
        this.pending.clear();
        setTimeout(() => this.start(), 3000);
      });
      this.call("initialize", {
        clientInfo: { name: "even-codex", title: "even-codex", version: VERSION },
        capabilities: { experimentalApi: true },
      }, 20000).then((r) => {
        this.send({ method: "initialized" });
        log(`[app-server] ready (${r.userAgent ?? "?"})`);
        resolve(r);
      }, reject);
    });
    this.ready.catch((e) => log(`[app-server] start failed: ${e.message}`));
    return this.ready;
  }

  send(obj) { this.proc?.stdin.write(JSON.stringify(obj) + "\n"); }

  handle(line) {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.id !== undefined && m.method === undefined) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.reject(Object.assign(new Error(m.error.message ?? "app-server error"), { code: m.error.code }));
      else p.resolve(m.result);
    } else if (m.id !== undefined && m.method) {
      Promise.resolve(this.onRequest(m.method, m.params ?? {}, m.id)).catch((e) => log(`[request] ${m.method}: ${e.message}`));
    } else if (m.method) {
      try { this.onNotification(m.method, m.params ?? {}); } catch (e) { log(`[notify] ${m.method}: ${e.message}`); }
    }
  }

  call(method, params, timeoutMs = 30000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  async rpc(method, params, timeoutMs) { await this.ready; return this.call(method, params, timeoutMs); }
  respond(id, result) { this.send({ id, result }); }
  respondError(id, message) { this.send({ id, error: { code: -32601, message } }); }
}

// ── helpers ────────────────────────────────────────────────────────────
const textOf = (item) => {
  if (!item) return "";
  if (typeof item.text === "string") return item.text;
  if (Array.isArray(item.content)) return item.content.map((c) => c.text ?? "").filter(Boolean).join("\n");
  return "";
};
const iso = (sec) => new Date(Number(sec ?? Date.now() / 1000) * 1000).toISOString();
const srcOf = (th) => (typeof th.source === "string" ? th.source : th.source?.custom ?? (th.source?.subAgent ? "subAgent" : "unknown"));

// ── sessions ───────────────────────────────────────────────────────────
class Thread {
  constructor(id, hub) {
    this.id = id;
    this.hub = hub;
    this.meta = null;
    this.events = [];
    this.nextId = 1;
    this.clients = new Set();
    this.state = "idle";
    this.loaded = false;           // resumed into *our* app-server
    this.turnId = null;
    this.turnStartedAt = 0;
    this.lastAgentText = "";
    this.lastPrompt = "";
    this.approvals = [];           // [{ rpcId, method, params }]
    this.questions = [];
  }

  emit(msg) {
    const id = this.nextId++;
    this.events.push({ id, msg });
    if (this.events.length > 500) this.events.splice(0, this.events.length - 500);
    const frame = `id: ${id}\ndata: ${JSON.stringify(msg)}\n\n`;
    for (const res of this.clients) { try { res.write(frame); } catch { this.clients.delete(res); } }
  }

  setState(s) {
    if (this.state === s) return;
    this.state = s;
    if (s === "busy" || s === "idle") this.emit({ type: "status", state: s, sessionId: this.id, provider: "codex" });
  }

  async ensureLoaded() {
    if (this.loaded) return;
    // Refuse to write into a thread the Codex UI is running right now.
    const last = await this.hub.lastTurn(this.id).catch(() => null);
    if (last?.status === "inProgress") {
      throw Object.assign(new Error("This thread is running in Codex UI right now; try again when it finishes"), { statusCode: 409 });
    }
    await this.hub.app.rpc("thread/resume", { threadId: this.id }, 60000);
    this.loaded = true;
  }

  async prompt(text) {
    if (this.state === "busy" && this.turnId) {
      await this.hub.app.rpc("turn/steer", { threadId: this.id, expectedTurnId: this.turnId, input: [{ type: "text", text, text_elements: [] }] })
        .catch(() => { throw Object.assign(new Error("Thread is busy"), { statusCode: 409 }); });
      this.emit({ type: "user_prompt", text });
      return;
    }
    await this.ensureLoaded();
    this.lastPrompt = text;
    this.lastAgentText = "";
    const r = await this.hub.app.rpc("turn/start", { threadId: this.id, input: [{ type: "text", text, text_elements: [] }] }, 60000);
    this.turnId = r?.turn?.id ?? this.turnId;
    this.turnStartedAt = Date.now();
    this.emit({ type: "user_prompt", text });
    this.setState("busy");
  }

  // ── app-server events for this thread ──
  onNotification(method, p) {
    switch (method) {
      case "turn/started":
        this.turnId = p.turn?.id ?? this.turnId;
        this.turnStartedAt ||= Date.now();
        this.setState("busy");
        break;
      case "item/agentMessage/delta":
        this.emit({ type: "text_delta", text: p.delta ?? "" });
        break;
      case "item/started": {
        const it = p.item ?? {};
        if (it.type === "commandExecution") this.emit({ type: "tool_start", name: "Bash", toolId: it.id });
        else if (it.type === "fileChange") this.emit({ type: "tool_start", name: "Edit", toolId: it.id });
        else if (it.type === "mcpToolCall" || it.type === "dynamicToolCall") this.emit({ type: "tool_start", name: it.tool ?? "Tool", toolId: it.id });
        else if (it.type === "webSearch") this.emit({ type: "tool_start", name: "WebSearch", toolId: it.id });
        break;
      }
      case "item/completed": {
        const it = p.item ?? {};
        if (it.type === "agentMessage") this.lastAgentText = textOf(it) || this.lastAgentText;
        else if (it.type === "commandExecution") this.emit({ type: "tool_end", name: "Bash", toolId: it.id, summary: String(it.command ?? "").slice(0, 160), detail: { input: {}, output: String(it.aggregatedOutput ?? "").slice(-2000) } });
        else if (it.type === "fileChange") this.emit({ type: "tool_end", name: "Edit", toolId: it.id, summary: (it.changes ?? []).map((c) => c.path).filter(Boolean).join(", ").slice(0, 160) || "file change", detail: { input: {}, output: "" } });
        else if (it.type === "mcpToolCall" || it.type === "dynamicToolCall") this.emit({ type: "tool_end", name: it.tool ?? "Tool", toolId: it.id, summary: String(it.tool ?? ""), detail: { input: {}, output: "" } });
        else if (it.type === "webSearch") this.emit({ type: "tool_end", name: "WebSearch", toolId: it.id, summary: String(it.query ?? ""), detail: { input: {}, output: "" } });
        break;
      }
      case "turn/completed": {
        const t = p.turn ?? {};
        if (t.status === "failed") this.emit({ type: "error", message: t.error?.message ?? "Turn failed" });
        this.emit({
          type: "result", success: t.status === "completed", text: this.lastAgentText, sessionId: this.id,
          costUsd: 0, provider: "codex", turns: 1, durationMs: this.turnStartedAt ? Date.now() - this.turnStartedAt : 0,
          inputTokens: 0, outputTokens: 0,
        });
        this.turnStartedAt = 0;
        this.approvals = [];
        this.setState("idle");
        break;
      }
      case "thread/status/changed": {
        const st = p.status ?? {};
        if (st.type === "active" && (st.activeFlags ?? []).length) this.state = "awaiting";
        break;
      }
      case "error":
        this.emit({ type: "error", message: p.error?.message ?? p.message ?? "Codex error" });
        break;
    }
  }

  // ── approvals / questions raised by our app-server ──
  addApproval(method, params, rpcId) {
    this.approvals.push({ method, params, rpcId });
    this.state = "awaiting";
    const isFile = /fileChange|applyPatch/.test(method);
    const desc = isFile
      ? `Apply file changes${params.grantRoot ? ` (write access to ${params.grantRoot})` : ""}`
      : String(params.command ?? (Array.isArray(params.command) ? params.command.join(" ") : "Run command"));
    this.emit({
      type: "permission_request",
      toolName: isFile ? "Edit" : "Bash",
      description: desc.slice(0, 300),
      detail: [params.reason, params.cwd].filter(Boolean).join("\n").slice(0, 300),
      toolUseId: String(rpcId),
      options: [{ text: "Yes", key: "allow" }, { text: "Yes, for this session", key: "allowAlways" }, { text: "No", key: "deny" }],
      suggestions: null,
    });
  }

  respondPermission(decision) {
    const a = this.approvals.shift();
    if (!a) return false;
    const legacy = a.method === "execCommandApproval" || a.method === "applyPatchApproval";
    const value = legacy
      ? { allow: "approved", allowAlways: "approved_for_session" }[decision] ?? "denied"
      : { allow: "accept", allowAlways: "acceptForSession" }[decision] ?? "decline";
    this.hub.app.respond(a.rpcId, { decision: value });
    this.emit({ type: "permission_result", toolName: "Approval", summary: "", decision: decision === "allowAlways" ? "always" : decision === "allow" ? "allowed" : "denied" });
    this.state = this.approvals.length ? "awaiting" : "busy";
    return true;
  }

  addQuestion(params, rpcId) {
    const qs = params.questions ?? [];
    this.questions.push({ rpcId, qs });
    this.state = "awaiting";
    this.emit({
      type: "user_question",
      toolUseId: String(rpcId),
      questions: qs.map((q) => ({
        question: String(q.question ?? q.prompt ?? ""), header: String(q.header ?? ""), multiSelect: false,
        options: (q.options ?? []).map((o) => ({ label: String(o.label ?? o), description: String(o.description ?? ""), preview: "" })),
      })),
    });
  }

  respondQuestion(answer) {
    const q = this.questions.shift();
    if (!q) return false;
    let parsed = null;
    try { parsed = JSON.parse(answer); } catch {}
    const answers = {};
    q.qs.forEach((qq, i) => {
      const a = parsed && typeof parsed === "object" ? (parsed[String(i)] ?? parsed[qq.id] ?? "") : (i === 0 ? answer : "");
      answers[qq.id ?? String(i)] = { answers: [String(a)] };
    });
    this.hub.app.respond(q.rpcId, { answers });
    this.emit({ type: "question_answer", answers });
    this.state = this.questions.length ? "awaiting" : "busy";
    return true;
  }

  async interrupt() {
    if (this.approvals.length) this.respondPermission("deny");
    if (this.turnId && this.loaded) await this.hub.app.rpc("turn/interrupt", { threadId: this.id, turnId: this.turnId }).catch(() => {});
  }
}

class Hub {
  constructor(cfg) {
    this.cfg = cfg;
    this.app = new AppServer(cfg.codexCommand);
    this.threads = new Map();
    this.metas = new Map();
    this.lastTurnCache = new Map();   // id → { updatedAt, turn }
    this.app.onNotification = (method, p) => {
      const id = p.threadId ?? p.thread?.id;
      if (id && this.threads.has(id)) this.threads.get(id).onNotification(method, p);
    };
    this.app.onRequest = (method, p, rpcId) => {
      const t = p.threadId && this.thread(p.threadId);
      if (!t) return this.app.respondError(rpcId, "unknown thread");
      if (/requestApproval$|^execCommandApproval$|^applyPatchApproval$/.test(method)) return t.addApproval(method, p, rpcId);
      if (method === "item/tool/requestUserInput") return t.addQuestion(p, rpcId);
      this.app.respondError(rpcId, `even-codex does not handle ${method}`);
    };
  }

  thread(id) {
    let t = this.threads.get(id);
    if (!t) { t = new Thread(id, this); this.threads.set(id, t); }
    return t;
  }

  hidden(th) {
    const title = th.name || th.preview || "";
    return (this.cfg.hideTitles ?? []).some((re) => new RegExp(re, "i").test(title));
  }

  label(th) {
    return this.cfg.originatorLabels?.[th.originator] ?? th.originator ?? srcOf(th);
  }

  async list(limit, cwd) {
    const r = await this.app.rpc("thread/list", {
      limit: Math.max(limit, this.cfg.listLimit), sortKey: "updated_at", archived: false,
      sourceKinds: this.cfg.sourceKinds, ...(cwd ? { cwd } : {}),
    });
    const rows = (r?.data ?? []).filter((th) => !this.hidden(th));
    for (const th of rows) this.metas.set(th.id, th);
    return rows;
  }

  async lastTurn(id) {
    const meta = this.metas.get(id);
    const cached = this.lastTurnCache.get(id);
    if (cached && meta && cached.updatedAt === meta.updatedAt && cached.turn?.status !== "inProgress") return cached.turn;
    const r = await this.app.rpc("thread/turns/list", { threadId: id, limit: 1, itemsView: "full" }, 20000);
    const turn = r?.data?.[0] ?? null;
    this.lastTurnCache.set(id, { updatedAt: meta?.updatedAt, turn });
    return turn;
  }

  /** Common "where is this conversation at" contract used by the PMO. */
  async last(id) {
    const t = this.threads.get(id);
    if (t?.approvals.length) {
      const a = t.approvals[0];
      return { state: "awaiting", stamp: `approval:${a.rpcId}`, text: t.lastAgentText, prompt: t.lastPrompt,
        pending: { kind: "approval", description: String(a.params.command ?? "file change"), detail: String(a.params.reason ?? ""), options: ["allow", "allowAlways", "deny"] } };
    }
    if (t?.questions.length) {
      const q = t.questions[0];
      return { state: "awaiting", stamp: `question:${q.rpcId}`, text: t.lastAgentText, prompt: t.lastPrompt,
        pending: { kind: "question", description: q.qs.map((x) => x.question).join(" / "), detail: "", options: [] } };
    }
    const turn = await this.lastTurn(id);
    if (!turn) return { state: "idle", stamp: "", text: "", prompt: "" };
    const items = turn.items ?? [];
    const agent = [...items].reverse().find((i) => i.type === "agentMessage");
    const user = items.find((i) => i.type === "userMessage");
    return {
      state: turn.status === "inProgress" || t?.state === "busy" ? "busy" : "idle",
      stamp: `${turn.id}:${turn.status}`,
      text: textOf(agent),
      prompt: textOf(user),
      pending: null,
    };
  }

  async history(id, limit) {
    const r = await this.app.rpc("thread/turns/list", { threadId: id, limit: Math.min(limit, 10), itemsView: "full" }, 30000);
    const out = [];
    for (const turn of [...(r?.data ?? [])].reverse()) {
      for (const it of turn.items ?? []) {
        if (it.type === "userMessage" && textOf(it)) out.push({ role: "user", text: textOf(it) });
        if (it.type === "agentMessage" && textOf(it)) out.push({ role: "assistant", text: textOf(it) });
      }
    }
    return out.slice(-limit);
  }

  async newThread(text, cwd) {
    const r = await this.app.rpc("thread/start", { cwd: cwd ?? this.cfg.defaultCwd ?? os.homedir() }, 60000);
    const id = r?.thread?.id;
    if (!id) throw new Error("thread/start returned no thread id");
    const t = this.thread(id);
    t.loaded = true;
    await t.prompt(text);
    return t;
  }
}

// ── HTTP (even-terminal compatible) ─────────────────────────────────────
function main() {
  const cfg = loadConfig();
  const hub = new Hub(cfg);
  hub.app.start();

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
    const t0 = Date.now();
    res.on("finish", () => { if (u.pathname !== "/api/events") log(`${res.statusCode} ${req.method} ${u.pathname} ${Date.now() - t0}ms`); });
    if (!u.pathname.startsWith("/api/")) return send(res, 404, { error: "not found" });
    const h = req.headers.authorization;
    const tok = h?.startsWith("Bearer ") ? h.slice(7) : u.searchParams.get("token");
    if (tok !== cfg.token) return send(res, 401, { error: { code: "auth_failed", message: "Unauthorized" } });
    const body = req.method === "GET" ? {} : await readBody(req);
    const q = (k) => u.searchParams.get(k) ?? body[k];
    const p = u.pathname.slice(4);

    try {
      if (p === "/sessions" && req.method === "GET") {
        const limit = Number(q("limit")) || 10;
        const rows = await hub.list(limit, q("cwd"));
        const top = rows.slice(0, Math.max(limit, 10));
        const sessions = await Promise.all(top.map(async (th) => {
          const t = hub.threads.get(th.id);
          let status = t?.state ?? "idle";
          if (!t || status === "idle") {
            const turn = await hub.lastTurn(th.id).catch(() => null);
            if (turn?.status === "inProgress") status = "busy";
          }
          const title = (th.name || th.preview || "Codex thread").replace(/\s+/g, " ").trim();
          return { id: th.id, title: `[${hub.label(th)}] ${title}`.slice(0, 72), timestamp: iso(th.updatedAt ?? th.createdAt), cwd: th.cwd ?? "", provider: "codex", status };
        }));
        return send(res, 200, { sessions });
      }

      if (p === "/prompt" && req.method === "POST") {
        if (!body.text || typeof body.text !== "string") return send(res, 400, { error: "Missing 'text' field" });
        const t = body.sessionId ? hub.thread(body.sessionId) : null;
        if (t) await t.prompt(body.text);
        const s = t ?? await hub.newThread(body.text, body.cwd);
        return send(res, 202, { ok: true, sessionId: s.id, provider: "codex" });
      }

      const sid = q("sessionId");
      if (p === "/events") {
        if (!sid) return send(res, 400, { error: "Missing 'sessionId' query parameter" });
        const t = hub.thread(sid);
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
        res.write(":ok\n\n");
        if (q("needReplay") === "true") for (const e of t.events) res.write(`id: ${e.id}\ndata: ${JSON.stringify(e.msg)}\n\n`);
        t.clients.add(res);
        const hb = setInterval(() => { try { res.write(":heartbeat\n\n"); } catch {} }, 15000);
        res.on("close", () => { clearInterval(hb); t.clients.delete(res); });
        return;
      }
      if (p === "/messages") {
        if (!sid) return send(res, 400, { error: "Missing 'sessionId'" });
        const t = hub.thread(sid);
        const after = Number(q("after")) || 0;
        return send(res, 200, { messages: t.events.filter((e) => e.id > after).map((e) => ({ id: e.id, ...e.msg })), state: t.state, sessionId: sid, provider: "codex" });
      }
      if (p === "/status") {
        if (!sid) return send(res, 400, { error: "Missing 'sessionId'" });
        if (!hub.threads.has(sid) && !hub.metas.has(sid)) await hub.list(100).catch(() => {});
        if (!hub.threads.has(sid) && !hub.metas.has(sid)) return send(res, 404, { error: "Session not found" });
        return send(res, 200, { state: hub.thread(sid).state, sessionId: sid, provider: "codex" });
      }
      if (p === "/permission-response" && req.method === "POST") {
        const t = hub.threads.get(body.sessionId);
        if (!t || !t.respondPermission(body.decision || "deny")) return send(res, 400, { error: "No permission request is pending" });
        return send(res, 200, { ok: true });
      }
      if (p === "/question-response" && req.method === "POST") {
        const t = hub.threads.get(body.sessionId);
        if (!t || !t.respondQuestion(body.answer ?? "")) return send(res, 400, { error: "No question is pending" });
        return send(res, 200, { ok: true });
      }
      if (p === "/interrupt" && req.method === "POST") {
        const t = hub.threads.get(body.sessionId);
        if (t) await t.interrupt();
        return send(res, 200, { ok: true });
      }
      const m = p.match(/^\/sessions\/([^/]+)\/(history|last)$/);
      if (m) {
        if (m[2] === "history") return send(res, 200, { history: await hub.history(m[1], Number(q("limit")) || 10).catch(() => []) });
        if (!hub.metas.has(m[1])) await hub.list(100).catch(() => {});
        return send(res, 200, await hub.last(m[1]));
      }
      if (p === "/info") return send(res, 200, { account: { email: "", organization: "", subscriptionType: "" }, model: "Codex", version: VERSION, provider: "codex", extra: { expose: "off" } });
      if (p === "/update-check") return send(res, 200, { packageName: "even-codex", currentVersion: VERSION, newestVersion: VERSION, updateAvailable: false, checkedAt: new Date().toISOString() });
      if (p === "/metrics") return send(res, 200, { codex: { tracked: hub.threads.size } });
      return send(res, 404, { error: "not found" });
    } catch (e) {
      log(`[err] ${p}: ${e.message}`);
      return send(res, e.statusCode ?? 500, { error: e.message });
    }
  });

  server.listen(cfg.port, cfg.host, () => {
    log(`even-codex v${VERSION} listening on ${cfg.host}:${cfg.port}`);
    log(`add to even-mux: { "url": "http://127.0.0.1:${cfg.port}", "token": "<~/.even-codex/config.json token>", "tag": "", "allProviders": true }`);
  });
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
}

async function doctor() {
  const cfg = loadConfig();
  const hub = new Hub(cfg);
  await hub.app.start();
  const rows = await hub.list(30);
  for (const th of rows.slice(0, 30)) {
    const turn = await hub.lastTurn(th.id).catch(() => null);
    console.log(`${iso(th.updatedAt).slice(5, 16)}  ${String(hub.label(th)).padEnd(10)} ${String(turn?.status ?? "-").padEnd(11)} ${(th.name || th.preview || "").replace(/\s+/g, " ").slice(0, 60)}`);
  }
  process.exit(0);
}

const cmd = process.argv[2];
if (cmd === "doctor") doctor().catch((e) => { console.error(e.message); process.exit(1); });
else if (!cmd || cmd === "start") main();
else { console.log("usage: even-codex [start|doctor]"); process.exit(1); }
