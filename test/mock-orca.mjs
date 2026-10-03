#!/usr/bin/env node
// Fake `orca` CLI for testing even-orca. Mirrors the real --json envelopes and a Claude-Code-like
// screen. State lives in $MOCK_ORCA_STATE so each CLI invocation sees the previous ones.
import fs from "node:fs";

const STATE = process.env.MOCK_ORCA_STATE;
const now = Date.now();
const wrap = (key) => (result) => out({ [key]: result });
const out = (result) => { console.log(JSON.stringify({ id: "req", ok: true, result, _meta: { runtimeId: "mock" } })); };
const fail = (code, message) => { console.log(JSON.stringify({ id: "req", ok: false, error: { code, message } })); process.exitCode = 1; };

function initial() {
  const t = (handle, leafId, branch, host, agent, title, lines) => ({
    handle, leafId, tabId: `tab-${leafId}`, worktreeId: `repo1::/w/${branch}`, worktreePath: `/w/${branch}`, branch: `refs/heads/${branch}`,
    executionHostId: host, agentIdentity: agent, title, connected: true, writable: true, preview: "",
    lastOutputAt: now, ptyId: `pty-${leafId}`, phase: "idle", lines,
  });
  return {
    seq: 3,
    terminals: [
      t("term_a", "leaf-a", "main", "local", "claude", "claude", ["✻ Welcome to Claude Code", "", "> earlier question", "⏺ earlier answer"]),
      t("term_b", "leaf-b", "train", "ssh:gpu-box", "codex", "codex", ["› previous", "• codex previous answer"]),
      t("term_c", "leaf-c", "main", "local", undefined, "zsh", ["$ ls"]),
    ],
  };
}
const st = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : initial();
const save = () => fs.writeFileSync(STATE, JSON.stringify(st));

// advance time-based phases
for (const t of st.terminals) {
  if (t.phase === "booting" && now > t.until) { t.phase = "idle"; t.lines.push("✻ Welcome to Claude Code"); }
  if (t.phase === "busy" && t.approvalAt && now > t.approvalAt) {
    t.phase = "approval"; t.blockedAt = t.approvalAt; t.approvalAt = null;
    t.lines.push("⏺ Bash(rm -rf build)");
  }
  if (t.phase === "busy" && now > t.until) {
    t.phase = "idle"; t.doneAt = t.until; t.lastMsg = `${t.reply}\nSecond line of the answer.`;
    t.lines.push("⏺ Bash(npm test)", "  ⎿  12 passed", "", `⏺ ${t.reply}`, "  Second line of the answer.");
    t.lastOutputAt = now;
  }
}

function screen(t) {
  const lines = [...t.lines];
  if (t.phase === "approval") {
    lines.push("╭────────────────────────────────────╮", "│ Bash command                        │", "│   rm -rf build                      │",
      "│ Do you want to proceed?             │", "│ ❯ 1. Yes                            │",
      "│   2. Yes, and don't ask again for rm │", "│   3. No, and tell Claude what to do │", "╰────────────────────────────────────╯");
    return lines;
  }
  if (t.phase === "busy" || t.phase === "booting") lines.push("", "✻ Thinking… (esc to interrupt)");
  lines.push("────────────────────────────────────", "> ", "────────────────────────────────────", "  ? for shortcuts");
  return lines;
}

const argv = process.argv.slice(2).filter((a) => a !== "--json");
const flag = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const has = (n) => argv.includes(`--${n}`);
const find = () => st.terminals.find((t) => t.handle === flag("terminal"));
const [a, b] = argv;
const pub = (t) => { const { phase, lines, until, reply, approvalAt, blockedAt, doneAt, startedAt, lastMsg, lastPrompt, ...rest } = t; return rest; };
function agentOf(t) {
  if (!t.agentIdentity) return null;
  const state = t.phase === "approval" ? "blocked" : t.phase === "idle" ? "done" : "working";
  const at = state === "blocked" ? t.blockedAt : state === "done" ? (t.doneAt ?? 1000) : (t.startedAt ?? 1000);
  return { paneKey: `${t.tabId}:${t.leafId}`, state, agentType: t.agentIdentity, prompt: t.lastPrompt ?? "", taskTitle: null, displayName: null,
    lastAssistantMessage: t.lastMsg ?? "earlier answer", toolName: state === "working" ? "Bash" : state === "blocked" ? "Bash" : "Read",
    toolInput: state === "blocked" ? "rm -rf build" : state === "working" ? "npm test" : "README.md", stateStartedAt: at, updatedAt: at, interrupted: false };
}

if (a === "status") out({ version: "1.9.0-mock", running: true });
else if (a === "host" && b === "list") out({ hosts: [{ kind: "local", name: "this machine", id: "local", selector: "--host local" }, { kind: "ssh", name: "gpu-box", id: "gpu-box", selector: "--host ssh:gpu-box", connected: true }] });
else if (a === "worktree" && b === "ps") {
  const byWt = new Map();
  for (const t of st.terminals) { const w = byWt.get(t.worktreeId) ?? { worktreeId: t.worktreeId, displayName: t.branch === "train" ? "Training run" : null, agents: [] }; const ag = agentOf(t); if (ag) w.agents.push(ag); byWt.set(t.worktreeId, w); }
  out({ worktrees: [...byWt.values()] });
}
else if (a === "terminal" && b === "list") {
  const host = flag("host");
  if (host) out({ terminals: st.terminals.filter((t) => t.executionHostId === host).map(pub), totalCount: 1, truncated: false, hostScope: { hostIds: [host], omittedHostIds: [] } });
  else out({
    terminals: st.terminals.filter((t) => t.executionHostId === "local").map(pub), totalCount: 2, truncated: false,
    hostScope: { hostIds: ["local"], omittedHostIds: ["ssh:gpu-box"], omittedHostSelectors: [{ hostId: "ssh:gpu-box", selector: "--host ssh:gpu-box" }] },
  });
}
else if (a === "terminal" && b === "read") {
  const t = find(); if (!t) fail("terminal_handle_stale", "stale"); else wrap("terminal")({ handle: t.handle, status: "running", tail: screen(t), truncated: false, nextCursor: null, source: has("screen") ? "screen" : "stream" });
}
else if (a === "terminal" && b === "wait") {
  const t = find();
  if (!t) fail("terminal_handle_stale", "stale");
  else if (t.phase === "idle") wrap("wait")({ handle: t.handle, condition: "tui-idle", satisfied: true, status: "running", exitCode: null });
  else if (t.phase === "approval") wrap("wait")({ handle: t.handle, condition: "tui-idle", satisfied: false, status: "running", exitCode: null, blockedReason: "agent-approval-prompt" });
  else { await new Promise((r) => setTimeout(r, Number(flag("timeout-ms") ?? 100))); fail("timeout", "timeout"); }
}
else if (a === "terminal" && b === "send") {
  const t = find(); const text = flag("text");
  if (!t) fail("terminal_handle_stale", "stale");
  else {
    if (t.phase === "approval") {
      if (text === "1" || text === "2") { t.phase = "busy"; t.until = now + 1200; t.reply = "Removed build and re-ran tests."; t.lines.push("  ⎿  (no output)"); }
      else if (text === "\u001b" || text === "3") { t.phase = "idle"; t.lines.push("  ⎿  Interrupted by user"); }
    } else if (text === "\u001b") { if (t.phase === "busy") { t.phase = "idle"; t.lines.push("  ⎿  Interrupted"); } }
    else if (has("enter")) {
      t.lines.push(`> ${text}`); t.lastPrompt = text; t.phase = "busy"; t.startedAt = now; t.until = now + 2500; t.reply = `Answer to: ${text}`;
      if (/\brm\b|clean/.test(text)) t.approvalAt = now + 800;
    }
    t.lastOutputAt = now;
    fs.appendFileSync(STATE + ".sends", JSON.stringify({ handle: t.handle, text, enter: has("enter") }) + "\n");
    wrap("send")({ handle: t.handle, accepted: true, bytesWritten: (text ?? "").length, ...(has("enter") ? { prompt: { requestId: "r1", stages: ["input_accepted", "turn_started"], provider: "claude" } } : {}) });
  }
}
else if (a === "terminal" && b === "create") {
  const wt = flag("worktree"); const branch = wt.replace(/^(id:repo1::\/w\/|branch:|path:\/w\/)/, "");
  const n = ++st.seq;
  st.terminals.push({ handle: `term_${n}`, leafId: `leaf-${n}`, tabId: `tab-${n}`, worktreeId: `repo1::/w/${branch}`, worktreePath: `/w/${branch}`, branch,
    executionHostId: "local", agentIdentity: flag("command"), title: flag("title"), connected: true, writable: true, preview: "", lastOutputAt: now,
    phase: "booting", startedAt: now, until: now + 1500, lines: [] });
  wrap("terminal")({ handle: `term_${n}`, worktreeId: `repo1::/w/${branch}`, title: flag("title"), tabId: `tab-${n}` });
}
else if (a === "worktree" && b === "create") {
  const name = flag("name"); const n = ++st.seq;
  st.terminals.push({ handle: `term_${n}`, leafId: `leaf-${n}`, tabId: `tab-${n}`, worktreeId: `repo1::/w/${name}`, worktreePath: `/w/${name}`, branch: name,
    executionHostId: "local", agentIdentity: flag("agent"), title: flag("agent"), connected: true, writable: true, preview: "", lastOutputAt: now,
    phase: "busy", startedAt: now, until: now + 2500, reply: `Answer to: ${flag("prompt")}`, lines: [`> ${flag("prompt")}`] });
  out({ worktree: { path: `/w/${name}`, startupTerminal: { spawned: true, handle: `term_${n}` } } });
}
else fail("unknown_command", argv.join(" "));
if ((a === "terminal" && (b === "send" || b === "create")) || (a === "worktree" && b === "create") || !fs.existsSync(STATE)) save();
