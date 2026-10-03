import { extractAnswer, extractMenu, toolLines } from "../even-orca.mjs";
import assert from "node:assert/strict";
const claudeDone = ["✻ Welcome", "", "> earlier", "⏺ old", "> run the tests", "⏺ Bash(npm test)", "  ⎿  12 passed", "", "⏺ All 12 tests pass.", "  Nothing else to do.",
  "────────", "> ", "────────", "  ? for shortcuts"];
const a = extractAnswer(claudeDone, "run the tests");
console.log("ANSWER:\n" + a); assert.match(a, /All 12 tests pass/); assert.doesNotMatch(a, /old|shortcuts|────|Bash\(|12 passed/);
const codexDone = ["› previous", "• prev answer", "› explain X", "• Ran rg foo", "• X works by doing Y.", "", "› ", "  ⏎ send   ⌃J newline"];
const c = extractAnswer(codexDone, "explain X"); console.log("CODEX:\n" + c); assert.match(c, /X works by/); assert.doesNotMatch(c, /prev answer/);
const approval = ["> clean up", "⏺ Bash(rm -rf build)", "╭──────╮", "│ Bash command │", "│   rm -rf build │", "│ Do you want to proceed? │", "│ ❯ 1. Yes │", "│   2. Yes, and don't ask again for rm │", "│   3. No, and tell Claude what to do │", "╰──────╯"];
const m = extractMenu(approval); console.log("MENU:", JSON.stringify(m));
assert.equal(m.question, "Do you want to proceed?"); assert.equal(m.options.length, 3); assert.equal(m.options[1].key, "2"); assert.match(m.detail, /rm -rf build/);
const codexApproval = ["› delete it", "  Would you like to run the following command?", "  $ rm -rf build", "› 1. Yes, proceed (y)", "  2. Yes, and don't ask again for this command (p)", "  3. No, and tell Codex what to do differently (esc)"];
const m2 = extractMenu(codexApproval); console.log("CODEX MENU:", JSON.stringify(m2)); assert.equal(m2.options[0].text, "Yes, proceed"); assert.match(m2.question, /Would you like/); assert.match(m2.detail, /rm -rf/); assert.equal(m2.options.length, 3);
const t = toolLines(claudeDone); console.log("TOOLS:", JSON.stringify(t)); assert.equal(t[0].name, "Bash");
console.log("parse tests OK");
