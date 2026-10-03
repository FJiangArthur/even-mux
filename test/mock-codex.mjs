#!/usr/bin/env node
// Fake `codex app-server --listen stdio://` for testing even-codex (newline JSON-RPC).
// Threads: one Codex UI thread waiting on the user, one CLI thread, one readiness probe (hidden).
// A prompt containing "rm" triggers a command approval request before the turn completes.
import readline from "node:readline";

const now = () => Math.floor(Date.now() / 1000);
const threads = [
  { id: "th-ui-1", name: "Review GCP migration maps", preview: "", originator: "Codex Desktop", source: "vscode", cwd: "/w/gcp", updatedAt: now() - 60, createdAt: now() - 900,
    turns: [{ id: "t1", status: "completed", items: [{ type: "userMessage", id: "u1", content: [{ type: "text", text: "Map the GCP migration" }] }, { type: "agentMessage", id: "a1", text: "Draft map done. Shall I continue with the network section?" }] }] },
  { id: "th-cli-1", name: null, preview: "Fix flaky test", originator: "codex-tui", source: "cli", cwd: "/w/app", updatedAt: now() - 300, createdAt: now() - 1000,
    turns: [{ id: "t2", status: "completed", items: [{ type: "agentMessage", id: "a2", text: "Fixed. 12 tests pass." }] }] },
  { id: "th-probe", name: "Reply READY", preview: "", originator: "codex-tui", source: "cli", cwd: "/", updatedAt: now() - 30, createdAt: now() - 30, turns: [] },
];
const out = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const pendingApprovals = new Map();
let nextServerId = 1000;

function runTurn(th, text) {
  const turn = { id: `turn-${Date.now()}`, status: "inProgress", items: [{ type: "userMessage", id: "u" + Date.now(), content: [{ type: "text", text }] }] };
  th.turns.unshift(turn);
  th.updatedAt = now();
  const finish = () => {
    setTimeout(() => out({ method: "item/started", params: { threadId: th.id, turnId: turn.id, item: { type: "commandExecution", id: "c1", command: "npm test" } } }), 100);
    setTimeout(() => out({ method: "item/completed", params: { threadId: th.id, turnId: turn.id, item: { type: "commandExecution", id: "c1", command: "npm test", aggregatedOutput: "ok" } } }), 200);
    const reply = `Done: ${text}`;
    setTimeout(() => out({ method: "item/agentMessage/delta", params: { threadId: th.id, turnId: turn.id, itemId: "m1", delta: reply } }), 300);
    setTimeout(() => {
      const msg = { type: "agentMessage", id: "m1", text: reply };
      turn.items.push(msg);
      out({ method: "item/completed", params: { threadId: th.id, turnId: turn.id, item: msg } });
      turn.status = "completed";
      th.updatedAt = now();
      out({ method: "turn/completed", params: { threadId: th.id, turn: { id: turn.id, status: "completed" } } });
    }, 500);
  };
  setTimeout(() => out({ method: "turn/started", params: { threadId: th.id, turn: { id: turn.id, status: "inProgress" } } }), 50);
  if (/\brm\b/.test(text)) {
    const sid = nextServerId++;
    pendingApprovals.set(sid, finish);
    setTimeout(() => out({ id: sid, method: "item/commandExecution/requestApproval", params: { threadId: th.id, turnId: turn.id, itemId: "c0", command: "rm -rf build", cwd: th.cwd, reason: "clean build", startedAtMs: Date.now() } }), 150);
  } else finish();
  return turn;
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === undefined && m.id !== undefined) {           // response to our approval request
    const fin = pendingApprovals.get(m.id);
    if (fin) { pendingApprovals.delete(m.id); if (m.result?.decision === "accept" || m.result?.decision === "acceptForSession") fin(); else {
      const th = threads.find((t) => t.turns[0]?.status === "inProgress");
      if (th) { th.turns[0].status = "interrupted"; out({ method: "turn/completed", params: { threadId: th.id, turn: { id: th.turns[0].id, status: "interrupted" } } }); }
    } }
    return;
  }
  const { id, method, params = {} } = m;
  const ok = (result) => out({ id, result });
  const th = threads.find((t) => t.id === params.threadId);
  switch (method) {
    case "initialize": return ok({ userAgent: "mock-codex/0.0.1", codexHome: "/tmp/codex" });
    case "initialized": return;
    case "thread/list": {
      const kinds = params.sourceKinds ?? ["cli", "vscode"];
      return ok({ data: threads.filter((t) => kinds.includes(t.source)).sort((a, b) => b.updatedAt - a.updatedAt).map(({ turns, ...t }) => ({ ...t, status: { type: "notLoaded" } })), nextCursor: null });
    }
    case "thread/turns/list": return th ? ok({ data: th.turns.slice(0, params.limit ?? 10), nextCursor: null }) : out({ id, error: { code: -1, message: "no thread" } });
    case "thread/resume": return th ? ok({ thread: { id: th.id } }) : out({ id, error: { code: -1, message: "no thread" } });
    case "thread/start": { const t = { id: `th-new-${Date.now()}`, name: null, preview: "", originator: "even-codex", source: "appServer", cwd: params.cwd, updatedAt: now(), createdAt: now(), turns: [] }; threads.unshift(t); return ok({ thread: { id: t.id } }); }
    case "turn/start": { const text = params.input?.[0]?.text ?? ""; t0: { if (th) { th.preview ||= text; } } const turn = runTurn(th, text); return ok({ turn: { id: turn.id, status: "inProgress" } }); }
    case "turn/interrupt": return ok({});
    default: return out({ id, error: { code: -32601, message: `mock: ${method}` } });
  }
});
