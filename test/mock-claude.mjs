#!/usr/bin/env node
// Fake `claude -p --output-format json` for testing even-pmo. Decides from keywords in stdin.
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const sys = process.argv[process.argv.indexOf("--system-prompt") + 1] ?? "";
  let r;
  if (/Owner says:/.test(input)) {
    const line = input.split("\n").find((l) => /^- \S+ \|.*GCP/.test(l));
    const id = line?.slice(2).split(" | ")[0];
    r = { answer: "好的，已经让 GCP 那个先停下。", actions: id && /停|pause|stop/.test(input.split("Owner says:")[1]) ? [{ sessionId: id, text: "Pause here, wait for me." }] : [] };
  } else {
    const latest = input.split("Agent's latest message")[1] ?? "";
    if (/deploy/i.test(latest)) r = { action: "reply", reply: "Yes, deploy it to production.", reason: "agent asked to deploy", confidence: 0.95, summary: "ready to deploy" };
    else if (/continue|proceed|Shall I/i.test(latest)) r = { action: "reply", reply: "Yes, continue.", reason: "scoped work, asked to continue", confidence: 0.9, summary: "mid-task" };
    else r = { action: "none", reply: "", reason: "only a report", confidence: 0.9, summary: "done" };
  }
  process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: JSON.stringify(r), total_cost_usd: 0.01, sysLen: sys.length }));
});
