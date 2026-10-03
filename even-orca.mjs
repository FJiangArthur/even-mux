#!/usr/bin/env node
// even-orca — drive Orca agent terminals from Even Realities glasses via the Orca CLI.
//
// Speaks the even-terminal HTTP/SSE API the Even app already understands, and translates it to
// `orca` CLI calls:
//
//   Even app                          even-orca                         orca CLI
//   GET  /api/sessions         →  terminal list --json  (every host: local, ssh:*, runtime:*)
//   POST /api/prompt           →  terminal send --text … --enter      (existing session)
//                                 terminal create --command claude     (new session, @worktree)
//                                 worktree create --agent … --prompt   (new worktree, @new:name)
//   GET  /api/events (SSE)     ←  terminal wait --for tui-idle  (idle / busy / approval probe)
//                                 terminal read --screen        (answer text, approval menu)
//   POST /api/permission-response → terminal send --text 1|2|3|<Esc>
//   POST /api/interrupt        →  terminal send --text <Esc>
//
// Sessions are Orca terminals running an agent TUI (Claude Code, Codex, …). Because Orca already
// federates SSH targets and paired Orca servers, remote sessions show up with no extra setup.
//
// Usage:
//   even-orca                start (config: ~/.even-orca/config.json, created on first run)
//   even-orca doctor         check the orca CLI and print what it sees

import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

const VERSION = "0.1.0";
const DIR = process.env.EVEN_ORCA_DIR || path.join(os.homedir(), ".even-orca");
const CONFIG_PATH = path.join(DIR, "config.json");
const ESC = "\u001b";
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── config ──────────────────────────────────────────────────────────────
function loadConfig() {
  fs.mkdirSync(DIR, { recursive: true });
  let cfg = {};
  if (fs.existsSync(CONFIG_PATH)) cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  const defaults = {
    port: 3458,
    host: "0.0.0.0",           // use 127.0.0.1 when running behind even-mux
    token: randomBytes(16).toString("hex"),
    name: "orca",
    orcaCommand: null,          // null → $ORCA_CLI_COMMAND, else `orca` (`orca-ide` on Linux)
    defaultAgent: "claude",     // agent for new sessions when the app doesn't specify codex
    defaultWorktree: null,      // selector for new sessions without @target, e.g. "path:/Users/me/app"
    includeAllTerminals: false, // true → plain shells are listed too, not only agent TUIs
    pollBusyMs: 1500,
    pollIdleMs: 5000,
  };
  const merged = { ...defaults, ...cfg };
  if (!fs.existsSync(CONFIG_PATH) || !cfg.token) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2) + "\n", { mode: 0o600 });
  }
  return merged;
}

// ── orca CLI runner ─────────────────────────────────────────────────────
class OrcaError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// Real Orca wraps single-object results: { terminal: {...} }, { wait: {...} }, { send: {...} }.
const WRAP_KEYS = new Set(["terminal", "wait", "send", "read", "create", "split", "show"]);
function unwrap(r) {
  if (r && typeof r === "object" && !Array.isArray(r)) {
    const ks = Object.keys(r);
    if (ks.length === 1 && WRAP_KEYS.has(ks[0]) && r[ks[0]] && typeof r[ks[0]] === "object") return r[ks[0]];
  }
  return r;
}
function findKey(obj, key, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 4) return undefined;
  if (key in obj) return obj[key];
  for (const v of Object.values(obj)) { const f = findKey(v, key, depth + 1); if (f !== undefined) return f; }
  return undefined;
}
const BUSY_SCREEN = /(esc to interrupt|ctrl\+c to interrupt|Working \(|• Working|Thinking…|…\s*\(\d+s)/i;

class Orca {
  constructor(cfg) {
    this.exe = cfg.orcaCommand || process.env.ORCA_CLI_COMMAND || (process.platform === "linux" ? "orca-ide" : "orca");
    this.active = 0;
    this.queue = [];
    this.max = 6;
  }

  async run(args, timeoutMs = 30000) {
    if (this.active >= this.max) await new Promise((r) => this.queue.push(r));
    this.active++;
    try {
      return await new Promise((resolve, reject) => {
        execFile(this.exe, [...args, "--json"], { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
          let parsed = null;
          try { parsed = JSON.parse(stdout); } catch {}
          if (parsed?.ok === true) return resolve(unwrap(parsed.result));
          if (parsed?.ok === false) return reject(new OrcaError(parsed.error?.code ?? "error", parsed.error?.message ?? "orca error"));
          if (err?.code === "ENOENT") return reject(new OrcaError("cli_missing", `orca CLI not found: ${this.exe}`));
          reject(new OrcaError("bad_output", (stderr || err?.message || stdout || "no output").toString().trim().slice(0, 400)));
        });
      });
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }

  /** Every terminal Orca knows, across local, SSH and paired-server hosts. */
  async listAll() {
    const first = await this.run(["terminal", "list", "--limit", "200"]);
    const rows = [...(first.terminals ?? [])];
    const extra = first.hostScope?.omittedHostSelectors ?? [];
    await Promise.all(extra.map(async ({ selector }) => {
      if (!selector) return;
      try {
        const r = await this.run(["terminal", "list", "--limit", "200", ...selector.split(/\s+/)], 15000);
        rows.push(...(r.terminals ?? []));
      } catch (e) {
        log(`[orca] list ${selector} failed: ${e.code}`);
      }
    }));
    const seen = new Set();
    return rows.filter((t) => !seen.has(t.handle) && seen.add(t.handle));
  }

  /** idle | busy | blocked:<reason> | exited | gone */
  async probe(handle) {
    try {
      const r = await this.run(["terminal", "wait", "--terminal", handle, "--for", "tui-idle", "--timeout-ms", "700"], 10000);
      if (r.status === "exited") return "exited";
      if (r.blockedReason) return `blocked:${r.blockedReason}`;
      return r.satisfied ? "idle" : "busy";
    } catch (e) {
      if (/timeout/i.test(e.code) || /timeout/i.test(e.message)) {
        // tui-idle doesn't settle for every TUI (e.g. idle Codex); decide from the rendered screen.
        try {
          const tail = (await this.screen(handle)).slice(-8).join("\n");
          return BUSY_SCREEN.test(tail) ? "busy" : "idle";
        } catch { return "busy"; }
      }
      if (/stale|not_found|unknown_terminal/i.test(e.code)) return "gone";
      throw e;
    }
  }

  async screen(handle) {
    const r = await this.run(["terminal", "read", "--terminal", handle, "--screen"], 10000);
    return (r.tail ?? []).map((l) => l.replace(/\s+$/, ""));
  }

  /** Orca's hook-driven agent roster: paneKey ("tabId:leafId") → agent, plus worktree names. */
  async fleet() {
    const r = await this.run(["worktree", "ps", "--limit", "500"], 20000);
    const agents = new Map();
    const names = new Map();
    for (const w of r.worktrees ?? []) {
      if (w.displayName) names.set(w.worktreeId, w.displayName);
      for (const a of w.agents ?? []) if (a.paneKey) agents.set(a.paneKey, a);
    }
    return { agents, names };
  }

  async hosts() {
    const r = await this.run(["host", "list"], 15000);
    const m = new Map();
    for (const h of r.hosts ?? []) {
      if (h.kind === "local") continue;
      m.set(h.kind === "ssh" ? `ssh:${h.id}` : `runtime:${h.id}`, h.name);
      m.set(h.id, h.name);
    }
    return m;
  }

  send(handle, { text, enter = false, waitSubmit }) {
    const args = ["terminal", "send", "--terminal", handle];
    if (text !== undefined) args.push("--text", text);
    if (enter) args.push("--enter");
    if (waitSubmit) args.push("--wait-submit", String(waitSubmit));
    return this.run(args, 20000 + (waitSubmit ?? 0) * 1000);
  }
}

// ── screen parsing (Claude Code / Codex TUIs) ──────────────────────────
const RULE = /^[\s─━═╭╮╰╯│┃┌┐└┘]*[─━═][\s─━═╭╮╰╯│┃┌┐└┘]*$/;
const SPINNER = /(esc to interrupt|ctrl\+c to interrupt|\? for shortcuts|shift\+tab to cycle|auto-accept edits|bypass permissions)/i;
const USER_ECHO = /^\s*[>›❯]\s+(\S.*)$/;
const OPTION = /^\s*(?:[❯>›]\s*)?(\d)[.)]\s+(.+?)\s*$/;
const BULLET = /^(\s*)[⏺●•◦]\s?/;
const TOOL_LINE = /^\s*[⏺●•]\s+(?:([A-Z][A-Za-z]+)\((.*?)\)?\s*$|(Ran|Edited|Read|Explored|Searched|Updated|Added|Deleted|Wrote)\s+(.+))/;

const unbox = (l) => l.replace(/^\s*[│┃]\s?/, "").replace(/\s?[│┃]\s*$/, "");

/** Index where the bottom composer / status chrome starts; everything from there down is UI. */
function composerStart(lines) {
  const last = lines.length;
  for (let i = last - 1; i >= Math.max(0, last - 12); i--) {
    if (USER_ECHO.test(unbox(lines[i])) || /^\s*[>›❯]\s*$/.test(unbox(lines[i]))) {
      let j = i;
      while (j > 0 && i - j < 3 && !RULE.test(lines[j - 1]) && !/^\s*╭/.test(lines[j - 1])) j--;
      return j > 0 && (RULE.test(lines[j - 1]) || /^\s*╭/.test(lines[j - 1])) ? j - 1 : i;
    }
  }
  return last;
}

function cleanBlock(lines, { dropTools = false } = {}) {
  const out = [];
  let inTool = false;
  for (let l of lines) {
    if (RULE.test(l) || SPINNER.test(l)) continue;
    if (dropTools) {
      if (TOOL_LINE.test(l)) { inTool = true; continue; }
      if (inTool && (/^\s*⎿/.test(l) || /^\s{4,}\S/.test(l))) continue;
      if (/^\s*[⏺●•]/.test(l) || !l.trim()) inTool = false;
    }
    l = unbox(l).replace(BULLET, "$1").replace(/^\s*⎿\s?/, "  ");
    if (!l.trim() && (!out.length || !out[out.length - 1].trim())) continue;
    out.push(l);
  }
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out.join("\n").slice(-4000);
}

/** The agent's answer to the latest user turn, as visible on screen. */
function extractAnswer(lines, promptText) {
  const cut = composerStart(lines);
  const body = lines.slice(0, cut);
  let anchor = -1;
  const needle = (promptText ?? "").trim().slice(0, 30);
  for (let i = body.length - 1; i >= 0; i--) {
    const m = unbox(body[i]).match(USER_ECHO);
    if (m && (!needle || m[1].includes(needle.slice(0, 20)) || anchor === -1)) {
      anchor = i;
      if (!needle || m[1].includes(needle.slice(0, 20))) break;
    }
  }
  const turn = anchor >= 0 ? body.slice(anchor + 1) : body.slice(-25);
  return cleanBlock(turn, { dropTools: true }) || cleanBlock(turn) || cleanBlock(body.slice(-15));
}

/** Numbered approval / choice menu at the bottom of the screen. */
function extractMenu(lines) {
  const tail = lines.slice(-25).map(unbox);
  let end = -1;
  for (let i = tail.length - 1; i >= 0; i--) if (OPTION.test(tail[i])) { end = i; break; }
  if (end < 0) return null;
  let start = end;
  while (start > 0 && (OPTION.test(tail[start - 1]) || !tail[start - 1].trim())) start--;
  while (start <= end && !OPTION.test(tail[start])) start++;
  const options = [];
  for (let i = start; i <= end; i++) {
    const m = tail[i].match(OPTION);
    if (m) options.push({ key: m[1], text: m[2].replace(/\s*\((?:y|a|n|esc|p)\)\s*$/i, "") });
  }
  const context = [];
  for (let i = start - 1; i >= 0 && context.length < 6; i--) {
    const l = tail[i];
    if (RULE.test(l) || /^\s*[╭╰]/.test(l)) { if (context.length) break; continue; }
    if (l.trim()) context.unshift(l.trim());
  }
  const ctx = context.filter((l) => !USER_ECHO.test(l));
  let qi = -1;
  for (let i = ctx.length - 1; i >= 0; i--) if (/\?\s*$/.test(ctx[i])) { qi = i; break; }
  if (qi < 0) qi = ctx.length - 1;
  const question = ctx[qi] ?? "Approval needed";
  const detail = ctx.filter((_, i) => i !== qi).slice(-3).join("\n");
  return { question, detail, options };
}

function toolLines(lines) {
  const found = [];
  const body = lines.slice(0, composerStart(lines));
  let from = 0;
  for (let i = body.length - 1; i >= 0; i--) if (USER_ECHO.test(unbox(body[i]))) { from = i + 1; break; }
  for (const l of body.slice(from)) {
    const m = l.match(TOOL_LINE);
    if (m) found.push({ name: m[1] ?? m[3], summary: (m[2] ?? m[4] ?? "").slice(0, 120), raw: l.trim() });
  }
  return found;
}

// ── sessions ────────────────────────────────────────────────────────────
const uuidFrom = (key) => {
  const h = createHash("sha1").update(key).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const hostOf = (row) => row.executionHostId ?? "local";
const hostLabel = (row) => {
  const h = hostOf(row);
  return h === "local" ? "" : h.replace(/^(ssh|runtime):/, "");
};
const paneKeyOf = (row) => `${row.tabId}:${row.leafId}`;
const cleanBranch = (b) => (b ?? "").replace(/^refs\/heads\//, "");
const TITLE_NOISE = /^[\s✳✻◐◑◒◓◔◕●•·⠁-⣿]+/u;
const STATE_MAP = { working: "busy", blocked: "awaiting", waiting: "awaiting", done: "idle" };
const toolSig = (a) => (a?.toolName ? `${a.toolName}|${typeof a.toolInput === "string" ? a.toolInput : JSON.stringify(a.toolInput ?? "")}` : "");
const providerOf = (row) => (/codex/i.test(row.agentIdentity ?? row.title ?? "") ? "codex" : "claude");
const isAgentRow = (row) => !!row.agentIdentity || /claude|codex|gemini|opencode|\bpi\b|grok|omp/i.test(row.title ?? "");

class Session {
  constructor(id, row, hub) {
    this.id = id;
    this.row = row;
    this.hub = hub;
    this.events = [];
    this.nextId = 1;
    this.clients = new Set();
    this.state = "idle";          // idle | busy | awaiting
    this.lastPrompt = null;
    this.turnStartedAt = 0;
    this.menu = null;
    this.menuSig = null;
    this.toolsSeen = new Set();
    this.timer = null;
    this.ticking = false;
    this.lastSeen = Date.now();
  }
  get handle() { return this.row.handle; }
  get provider() { return providerOf(this.row); }

  emit(msg) {
    const id = this.nextId++;
    this.events.push({ id, msg });
    if (this.events.length > 500) this.events.splice(0, this.events.length - 500);
    const frame = `id: ${id}\ndata: ${JSON.stringify(msg)}\n\n`;
    for (const res of this.clients) { try { res.write(frame); } catch { this.clients.delete(res); } }
  }

  setState(next) {
    if (this.state === next) return;
    this.state = next;
    if (next === "busy" || next === "idle") this.emit({ type: "status", state: next, sessionId: this.id, provider: this.provider });
  }

  /** Keep polling while someone is watching or a turn is in flight. */
  schedule(ms) {
    clearTimeout(this.timer);
    const active = this.state !== "idle";
    if (!active && this.clients.size === 0) return;
    const delay = ms ?? (active ? this.hub.cfg.pollBusyMs : this.hub.cfg.pollIdleMs);
    this.timer = setTimeout(() => this.tick().finally(() => this.schedule()), delay);
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const agent = await this.hub.agentFor(this.row);
      if (agent) { await this.tickAgent(agent); return; }
      let p = await this.hub.orca.probe(this.handle);
      if (p === "gone") {
        await this.hub.refresh(true);
        p = await this.hub.orca.probe(this.handle);
      }
      if (p === "exited" || p === "gone") {
        if (this.state !== "idle") this.emit({ type: "error", message: "Terminal exited" });
        this.setState("idle");
        return;
      }
      if (p === "busy") {
        if (this.state === "idle") this.beginTurn(null);
        this.state = "busy";
        await this.reportTools();
        return;
      }
      if (p.startsWith("blocked:")) {
        if (this.state === "idle") this.beginTurn(null);
        await this.reportMenu(p.slice(8));
        return;
      }
      // idle
      if (this.state !== "idle") await this.finishTurn();
    } catch (e) {
      log(`[${this.id.slice(0, 8)}] tick: ${e.code ?? ""} ${e.message}`);
    } finally {
      this.ticking = false;
    }
  }

  /** Drive the session from Orca's hook-reported agent state (working/blocked/waiting/done). */
  async tickAgent(a) {
    const st = a.state;
    const stamp = `${a.stateStartedAt ?? ""}|${a.updatedAt ?? ""}`;
    const tsig = toolSig(a);
    if (this.lastStamp === undefined) {
      // First look at this pane: take a baseline, don't replay old history as new events.
      this.lastStamp = stamp;
      this.lastTool = tsig;
      if (st === "working") this.beginTurn(null);
      else if (st === "blocked" || st === "waiting") { this.beginTurn(null); await this.reportMenu(st === "blocked" ? "agent-approval-prompt" : "agent-interactive-prompt"); }
      return;
    }
    if (st !== "done" && this.state === "idle") this.beginTurn(null);
    if (tsig && tsig !== this.lastTool && st !== "done") {
      const toolId = createHash("sha1").update(this.id + tsig + stamp).digest("hex").slice(0, 16);
      const input = typeof a.toolInput === "string" ? a.toolInput : JSON.stringify(a.toolInput ?? "");
      this.emit({ type: "tool_start", name: a.toolName, toolId });
      this.emit({ type: "tool_end", name: a.toolName, toolId, summary: input.replace(/\s+/g, " ").slice(0, 120) || a.toolName, detail: { input: {}, output: "" } });
    }
    this.lastTool = tsig;
    if (st === "working") {
      if (this.state === "idle") this.beginTurn(null);
      this.state = "busy";
      this.menuSig = null;
    } else if (st === "blocked" || st === "waiting") {
      if (this.state === "idle") this.beginTurn(null);
      await this.reportMenu(st === "blocked" ? "agent-approval-prompt" : "agent-interactive-prompt");
    } else if (st === "done") {
      const newTurnFinished = stamp !== this.lastStamp && stamp !== this.promptBaseline;
      const waitingForStart = this.promptBaseline !== undefined && stamp === this.promptBaseline && Date.now() - this.turnStartedAt < 60000;
      if (!waitingForStart && (this.state !== "idle" || newTurnFinished)) {
        if (this.state === "idle") this.beginTurn(null);
        this.promptBaseline = undefined;
        await this.finishTurn(a.lastAssistantMessage);
      }
    }
    this.lastStamp = stamp;
  }

  beginTurn(promptText) {
    this.lastPrompt = promptText;
    this.turnStartedAt = Date.now();
    this.toolsSeen.clear();
    this.menuSig = null;
    this.setState("busy");
  }

  async reportTools(screenLines) {
    const lines = screenLines ?? await this.hub.orca.screen(this.handle);
    for (const t of toolLines(lines)) {
      if (this.toolsSeen.has(t.raw)) continue;
      this.toolsSeen.add(t.raw);
      const toolId = createHash("sha1").update(this.id + t.raw).digest("hex").slice(0, 16);
      this.emit({ type: "tool_start", name: t.name, toolId });
      this.emit({ type: "tool_end", name: t.name, toolId, summary: t.summary || t.name, detail: { input: {}, output: "" } });
    }
  }

  async reportMenu(reason) {
    const lines = await this.hub.orca.screen(this.handle);
    const menu = extractMenu(lines) ?? { question: reason.replace(/^(agent|codex)-/, "").replace(/-/g, " "), detail: "", options: [] };
    const sig = JSON.stringify(menu);
    this.state = "awaiting";
    if (sig === this.menuSig) return;
    this.menuSig = sig;
    this.menu = menu;
    const options = menu.options.length
      ? menu.options.map((o) => ({ text: o.text, key: o.key }))
      : [{ text: "Yes", key: "allow" }, { text: "No", key: "deny" }];
    this.emit({
      type: "permission_request",
      toolName: reason.includes("approval") ? "Approval" : "Prompt",
      description: menu.question,
      detail: menu.detail,
      toolUseId: sig.length.toString(36) + Date.now().toString(36),
      options,
      suggestions: null,
    });
  }

  async finishTurn(hookText) {
    if (this.queued && !this.lastPrompt) {
      // A startup menu (trust prompt etc.) just cleared; now deliver the real first prompt.
      const queued = this.queued;
      this.queued = null;
      this.state = "idle";
      this.menu = null;
      await this.prompt(queued);
      return;
    }
    let text = typeof hookText === "string" && hookText.trim() ? hookText.trim().slice(-6000) : null;
    if (!text) {
      const lines = await this.hub.orca.screen(this.handle);
      await this.reportTools(lines);
      text = extractAnswer(lines, this.lastPrompt);
    }
    this.emit({
      type: "result",
      success: true,
      text,
      sessionId: this.id,
      costUsd: 0,
      provider: this.provider,
      turns: 1,
      durationMs: this.turnStartedAt ? Date.now() - this.turnStartedAt : 0,
      inputTokens: 0,
      outputTokens: 0,
    });
    this.menu = null;
    this.setState("idle");
    const queued = this.queued;
    this.queued = null;
    if (queued) await this.prompt(queued);
  }

  async prompt(text) {
    if (this.state === "awaiting") {
      this.queued = text;                 // agent is showing a menu; send once it clears
      return;
    }
    const r = await this.hub.orca.send(this.handle, { text, enter: true, waitSubmit: 3 });
    if (r.accepted === false) {
      throw Object.assign(new Error(`Orca refused input${r.refusedReason ? ` (${r.refusedReason})` : ""}`), { statusCode: 409 });
    }
    const a = this.hub.agents.get(paneKeyOf(this.row));
    this.promptBaseline = a ? `${a.stateStartedAt ?? ""}|${a.updatedAt ?? ""}` : undefined;
    this.emit({ type: "user_prompt", text });
    this.beginTurn(text);
    this.schedule(800);
  }

  async respond(decision) {
    const keys = (this.menu?.options ?? []).map((o) => o.key);
    let text;
    if (/^\d$/.test(decision)) text = decision;
    else if (decision === "allow") text = "1";
    else if (decision === "allowAlways") text = keys.length >= 3 ? "2" : "1";
    else text = ESC;
    await this.hub.orca.send(this.handle, { text });
    const chosen = this.menu?.options.find((o) => o.key === text);
    const denied = text === ESC || /^no\b/i.test(chosen?.text ?? "");
    this.emit({
      type: "permission_result",
      toolName: "Approval",
      summary: this.menu?.question ?? "",
      decision: denied ? "denied" : /always|don.t ask/i.test(chosen?.text ?? "") ? "always" : "allowed",
    });
    this.menu = null;
    this.menuSig = null;
    this.state = "busy";
    this.schedule(600);
  }

  async answer(answer) {
    // Free-text answer to a choice prompt: pick a matching option, else type it.
    const opts = this.menu?.options ?? [];
    const s = String(answer ?? "").trim();
    const hit = opts.find((o) => o.key === s || o.text.toLowerCase() === s.toLowerCase());
    if (hit || /^\d$/.test(s)) return this.respond(hit?.key ?? s);
    if (!s || s === "skip") return this.respond("deny");
    await this.hub.orca.send(this.handle, { text: s, enter: true });
    this.state = "busy";
    this.schedule(600);
  }

  async interrupt() {
    await this.hub.orca.send(this.handle, { text: ESC });
    this.schedule(600);
  }

  async history(limit) {
    const lines = await this.hub.orca.screen(this.handle);
    const body = lines.slice(0, composerStart(lines));
    const turns = [];
    let cur = null;
    for (const l of body) {
      const u = unbox(l).match(USER_ECHO);
      if (u) { turns.push({ role: "user", text: u[1] }); cur = { role: "assistant", lines: [] }; turns.push(cur); continue; }
      if (cur) cur.lines.push(l);
    }
    const out = turns
      .map((t) => ({ role: t.role, text: t.role === "user" ? t.text : (cleanBlock(t.lines, { dropTools: true }) || cleanBlock(t.lines)) }))
      .filter((t) => t.text?.trim());
    return out.slice(-Math.min(limit, 10));
  }
}

class Hub {
  constructor(cfg) {
    this.cfg = cfg;
    this.orca = new Orca(cfg);
    this.sessions = new Map();     // id → Session
    this.byHandle = new Map();     // handle → id
    this.rows = [];
    this.refreshedAt = 0;
    this.refreshing = null;
    this.agents = new Map();       // paneKey → Orca agent record
    this.wtNames = new Map();      // worktreeId → display name
    this.hostNames = new Map();    // executionHostId → host name
    this.fleetAt = 0;
    this.fleetP = null;
    this.hostsAt = 0;
  }

  async loadFleet(maxAgeMs = 1000) {
    if (Date.now() - this.fleetAt < maxAgeMs) return;
    this.fleetP ??= this.orca.fleet().then(({ agents, names }) => {
      this.agents = agents;
      this.wtNames = names;
      this.fleetAt = Date.now();
    }).catch((e) => log(`[orca] worktree ps: ${e.code ?? ""} ${e.message}`)).finally(() => { this.fleetP = null; });
    return this.fleetP;
  }

  async agentFor(row) {
    await this.loadFleet(1000);
    return this.agents.get(paneKeyOf(row)) ?? null;
  }

  hostName(row) {
    const h = hostOf(row);
    return h === "local" ? "" : this.hostNames.get(h) ?? hostLabel(row);
  }

  keyOf(row) {
    return `${hostOf(row)}|${row.worktreeId}|${row.leafId ?? row.tabId ?? row.handle}`;
  }

  async refresh(force = false) {
    if (!force && Date.now() - this.refreshedAt < 3000) return this.rows;
    this.refreshing ??= (async () => {
      try {
        const hostsDue = Date.now() - this.hostsAt > 300000;
        const [rows] = await Promise.all([
          this.orca.listAll(),
          this.loadFleet(0),
          hostsDue ? this.orca.hosts().then((m) => { this.hostNames = m; this.hostsAt = Date.now(); }).catch(() => {}) : null,
        ]);
        this.rows = rows;
        this.byHandle.clear();
        for (const row of rows) {
          const id = uuidFrom(this.keyOf(row));
          this.byHandle.set(row.handle, id);
          const s = this.sessions.get(id);
          if (s) { s.row = row; s.lastSeen = Date.now(); }
          else this.sessions.set(id, new Session(id, row, this));
        }
        this.refreshedAt = Date.now();
        return rows;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  async get(id) {
    let s = this.sessions.get(id);
    if (!s) { await this.refresh(true); s = this.sessions.get(id); }
    return s ?? null;
  }

  listable(row) {
    return (this.cfg.includeAllTerminals || isAgentRow(row)) && row.connected !== false && !row.exitCause;
  }

  titleOf(row) {
    const a = this.agents.get(paneKeyOf(row));
    const wt = this.wtNames.get(row.worktreeId) || cleanBranch(row.branch) || path.basename(row.worktreePath || "");
    const where = [this.hostName(row), wt].filter(Boolean).join("·");
    let t = (row.title ?? "").replace(TITLE_NOISE, "").replace(/\s*\|\s*\S+$/, "").trim();
    if (!t || /^(pi|claude|codex|gemini|terminal)( ready)?$/i.test(t) || /@[\w.-]+:/.test(t)) {
      t = (a?.taskTitle || a?.displayName || a?.prompt || row.agentIdentity || t || "terminal").replace(/\s+/g, " ").trim();
    }
    return `${where ? `[${where}] ` : ""}${t}`.slice(0, 72);
  }

  stateOf(row, session) {
    const a = this.agents.get(paneKeyOf(row));
    if (a?.state && STATE_MAP[a.state]) return STATE_MAP[a.state];
    return session?.state ?? "idle";
  }

  /** Resolve "@target" to an Orca worktree selector. */
  worktreeSelector(target, cwd) {
    if (target) {
      const t = target.toLowerCase();
      const row = this.rows.find((r) => cleanBranch(r.branch).toLowerCase() === t)
        ?? this.rows.find((r) => (this.wtNames.get(r.worktreeId) ?? "").toLowerCase() === t)
        ?? this.rows.find((r) => path.basename(r.worktreePath ?? "").toLowerCase() === t)
        ?? this.rows.find((r) => this.hostName(r).toLowerCase() === t);
      if (row) return `id:${row.worktreeId}`;
      if (/^(id|path|branch|issue):/.test(target)) return target;
      return `branch:${target}`;
    }
    if (this.cfg.defaultWorktree) return this.cfg.defaultWorktree;
    if (cwd && fs.existsSync(cwd)) return `path:${cwd}`;
    return null;
  }

  async newSession(text, provider, cwd) {
    await this.refresh();
    // "@new:<name> …"  → new worktree with an agent; "@<worktree|branch|host> …" → agent in it
    const m = text.match(/^\s*@(\S+)\s+([\s\S]+)$/);
    let target = m?.[1] ?? null;
    let body = m ? m[2] : text;
    const agent = provider === "codex" ? "codex" : this.cfg.defaultAgent;

    if (target?.startsWith("new:")) {
      const name = target.slice(4);
      const r = await this.orca.run(["worktree", "create", "--name", name, "--agent", agent, "--prompt", body], 120000);
      const handle = findKey(r, "startupTerminal")?.handle;
      if (!handle) throw Object.assign(new Error("worktree created but no agent terminal was started"), { statusCode: 502 });
      const s = await this.adopt(handle);
      s.emit({ type: "user_prompt", text: body });
      s.beginTurn(body);
      s.schedule(1500);
      return s;
    }

    const selector = this.worktreeSelector(target, cwd);
    if (!selector) {
      throw Object.assign(new Error("No worktree for a new session: start the prompt with @<branch> or set defaultWorktree"), { statusCode: 400 });
    }
    const created = await this.orca.run(["terminal", "create", "--worktree", selector, "--command", agent, "--title", agent], 60000);
    const s = await this.adopt(created.handle);
    // Let the agent TUI boot before typing into it.
    let p = "busy";
    for (let i = 0; i < 20 && p === "busy"; i++) {
      p = await this.orca.probe(created.handle);
      if (p === "busy") await sleep(1000);
    }
    if (p.startsWith("blocked:")) {
      s.queued = body;                       // e.g. trust-this-folder prompt; answer it first
      s.beginTurn(null);
      await s.reportMenu(p.slice(8));
      s.schedule();
      return s;
    }
    await s.prompt(body);
    return s;
  }

  async adopt(handle) {
    for (let i = 0; i < 5; i++) {
      await this.refresh(true);
      const id = this.byHandle.get(handle);
      if (id) return this.sessions.get(id);
      await sleep(500);
    }
    throw Object.assign(new Error(`terminal ${handle} did not appear in terminal list`), { statusCode: 502 });
  }
}

// ── HTTP server ─────────────────────────────────────────────────────────
function main() {
  const cfg = loadConfig();
  const hub = new Hub(cfg);

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
  const need = async (res, id) => {
    if (!id) { send(res, 400, { error: "Missing 'sessionId'" }); return null; }
    const s = await hub.get(id);
    if (!s) send(res, 404, { error: "Session not found" });
    return s;
  };

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
        const rows = (await hub.refresh(true)).filter((r) => hub.listable(r));
        const wantProvider = q("provider");
        const cwd = q("cwd");
        const list = rows
          .filter((r) => !cwd || (r.worktreePath ?? "").startsWith(cwd))
          .filter((r) => !wantProvider || wantProvider === "claude-sync" || providerOf(r) === wantProvider || !r.agentIdentity)
          .sort((a, b) => (b.lastOutputAt ?? 0) - (a.lastOutputAt ?? 0))
          .slice(0, limit)
          .map((r) => {
            const s = hub.sessions.get(hub.byHandle.get(r.handle));
            return {
              id: s.id,
              title: hub.titleOf(r),
              timestamp: new Date(r.lastOutputAt ?? Date.now()).toISOString(),
              cwd: r.worktreePath ?? "",
              provider: providerOf(r),
              status: hub.stateOf(r, s),
            };
          });
        // Refresh live status for the top few, like even-terminal does.
        await Promise.all(list.slice(0, 6).map(async (item) => {
          const s = hub.sessions.get(item.id);
          if (s.state !== "idle" || hub.agents.has(paneKeyOf(s.row))) return;
          const pr = await hub.orca.probe(s.handle).catch(() => "idle");
          item.status = pr === "busy" ? "busy" : pr.startsWith("blocked:") ? "awaiting" : "idle";
        }));
        return send(res, 200, { sessions: list });
      }

      if (p === "/prompt" && req.method === "POST") {
        const text = body.text;
        if (!text || typeof text !== "string") return send(res, 400, { error: "Missing 'text' field" });
        let s;
        if (body.sessionId) {
          s = await need(res, body.sessionId);
          if (!s) return;
          await s.prompt(text);
        } else {
          s = await hub.newSession(text, body.provider, body.cwd);
        }
        return send(res, 202, { ok: true, sessionId: s.id, provider: s.provider });
      }

      if (p === "/events" && req.method === "GET") {
        const s = await need(res, q("sessionId"));
        if (!s) return;
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
        res.write(":ok\n\n");
        if (q("needReplay") === "true") for (const e of s.events) res.write(`id: ${e.id}\ndata: ${JSON.stringify(e.msg)}\n\n`);
        s.clients.add(res);
        const hb = setInterval(() => { try { res.write(":heartbeat\n\n"); } catch {} }, 15000);
        res.on("close", () => { clearInterval(hb); s.clients.delete(res); });
        s.schedule(200);
        return;
      }

      if (p === "/messages" && req.method === "GET") {
        const s = await need(res, q("sessionId"));
        if (!s) return;
        const after = Number(q("after")) || 0;
        return send(res, 200, {
          messages: s.events.filter((e) => e.id > after).map((e) => ({ id: e.id, ...e.msg })),
          state: s.state, sessionId: s.id, provider: s.provider,
        });
      }

      if (p === "/status" && req.method === "GET") {
        const s = await need(res, q("sessionId"));
        if (!s) return;
        return send(res, 200, { state: s.state, sessionId: s.id, provider: s.provider });
      }

      if (p === "/permission-response" && req.method === "POST") {
        const s = await need(res, body.sessionId);
        if (!s) return;
        if (s.state !== "awaiting") return send(res, 400, { error: "No permission request is pending" });
        await s.respond(body.decision || "deny");
        return send(res, 200, { ok: true });
      }

      if (p === "/question-response" && req.method === "POST") {
        const s = await need(res, body.sessionId);
        if (!s) return;
        await s.answer(body.answer);
        return send(res, 200, { ok: true });
      }

      if (p === "/interrupt" && req.method === "POST") {
        const s = await need(res, body.sessionId);
        if (!s) return;
        await s.interrupt();
        return send(res, 200, { ok: true });
      }

      const hist = p.match(/^\/sessions\/([^/]+)\/history$/);
      if (hist) {
        const s = await hub.get(hist[1]);
        if (!s) return send(res, 200, { history: [] });
        return send(res, 200, { history: await s.history(Number(q("limit")) || 10) });
      }

      if (p === "/info") {
        let version = "Unknown";
        try { version = (await hub.orca.run(["status"], 8000))?.version ?? "Orca"; } catch {}
        return send(res, 200, {
          account: { email: "", organization: "", subscriptionType: "" },
          model: "Orca",
          version: String(version),
          provider: q("provider") ?? cfg.defaultAgent,
          extra: { expose: "off" },
        });
      }

      if (p === "/update-check") {
        return send(res, 200, { packageName: "even-orca", currentVersion: VERSION, newestVersion: VERSION, updateAvailable: false, checkedAt: new Date().toISOString() });
      }

      if (p === "/metrics") return send(res, 200, { orca: { tracked: hub.sessions.size } });

      return send(res, 404, { error: "not found" });
    } catch (e) {
      log(`[err] ${p}: ${e.code ?? ""} ${e.message}`);
      return send(res, e.statusCode ?? (e.code === "cli_missing" ? 503 : 500), { error: e.message });
    }
  });

  server.listen(cfg.port, cfg.host, () => printBanner(cfg, hub));
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
}

function pickAddress(host) {
  if (host && host !== "0.0.0.0") return host;
  const addrs = Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === "IPv4" && !a.internal);
  const ts = addrs.find((a) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address));
  const lan = addrs.find((a) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address));
  return (process.env.EVEN_ORCA_PREFER === "lan" ? lan ?? ts : ts ?? lan)?.address ?? "localhost";
}

async function printBanner(cfg, hub) {
  console.log(`\n  even-orca v${VERSION}  listening on ${cfg.host}:${cfg.port}  (orca CLI: ${hub.orca.exe})`);
  try {
    const rows = await hub.refresh(true);
    const agents = rows.filter((r) => hub.listable(r));
    const hosts = [...new Set(rows.map(hostOf))];
    console.log(`  ${agents.length} agent terminal(s) across ${hosts.length} host(s): ${hosts.join(", ") || "none"}`);
  } catch (e) {
    console.log(`  ⚠ orca CLI: ${e.message}`);
  }
  if (cfg.host === "127.0.0.1") {
    console.log(`  loopback only — add to even-mux: { "url": "http://127.0.0.1:${cfg.port}", "token": "${cfg.token}" }\n`);
    return;
  }
  const params = new URLSearchParams({ token: cfg.token, defaultProvider: cfg.defaultAgent === "codex" ? "codex" : "claude", name: cfg.name });
  const url = `http://${pickAddress(cfg.host)}:${cfg.port}?${params}`;
  console.log(`  pair URL: ${url}\n`);
  try {
    const qr = (await import("qrcode-terminal")).default;
    qr.generate(url, { small: true }, (s) => console.log(s));
  } catch {
    console.log("  (npm i qrcode-terminal for a QR code)");
  }
}

async function doctor() {
  const cfg = loadConfig();
  const hub = new Hub(cfg);
  console.log(`orca CLI: ${hub.orca.exe}`);
  try {
    const st = await hub.orca.run(["status"], 10000);
    console.log(`status: ${JSON.stringify(st).slice(0, 300)}`);
  } catch (e) {
    console.log(`status failed: ${e.code} ${e.message}`);
    if (e.code === "cli_missing") console.log("Register the CLI in Orca → Settings → General → Orca CLI.");
    process.exit(1);
  }
  const rows = await hub.refresh(true);
  for (const r of rows) {
    const id = hub.byHandle.get(r.handle);
    const a = hub.agents.get(paneKeyOf(r));
    const probe = a ? `${a.state} (hook)` : await hub.orca.probe(r.handle).catch((e) => `err:${e.code}`);
    console.log(`${hub.listable(r) ? "✓" : " "} ${hub.titleOf(r).padEnd(48)} ${String(r.agentIdentity ?? "-").padEnd(8)} ${probe.padEnd(12)} ${id}`);
  }
  console.log("✓ = listed to the glasses (agent terminals; set includeAllTerminals for shells)");
}

// exported for tests
export { extractAnswer, extractMenu, toolLines, composerStart };

const cmd = process.argv[2];
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("even-orca.mjs") || process.argv[1]?.endsWith("even-orca")) {
  if (cmd === "doctor") doctor();
  else if (!cmd || cmd === "start") main();
  else { console.log("usage: even-orca [start|doctor]"); process.exit(1); }
}
