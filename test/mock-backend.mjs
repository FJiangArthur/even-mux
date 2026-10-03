import http from "node:http"; import { randomUUID } from "node:crypto";
const [port, token, label] = process.argv.slice(2);
const sessions = new Map([[`${label}-old-1`, { id: `${label}-old-1`, title: `${label} old`, timestamp: "2026-09-20T00:00:00Z" }]]);
const clients = new Map();
http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if ((req.headers.authorization ?? "") !== `Bearer ${token}`) { res.writeHead(401); return res.end("{}"); }
  let b = ""; req.on("data", c => b += c); req.on("end", () => {
    const body = b ? JSON.parse(b) : {};
    const j = (s, o) => { res.writeHead(s, {"content-type":"application/json"}); res.end(JSON.stringify(o)); };
    if (u.pathname === "/api/update-check") return j(200, { ok: 1 });
    if (u.pathname === "/api/info") return j(200, { label, cwdSeen: null });
    if (u.pathname === "/api/sessions") return j(200, { sessions: [...sessions.values()] });
    if (u.pathname === "/api/status") return sessions.has(u.searchParams.get("sessionId")) ? j(200, { state: "idle" }) : j(404, {});
    if (u.pathname === "/api/prompt") {
      const id = body.sessionId ?? randomUUID();
      sessions.set(id, { id, title: body.text, timestamp: new Date().toISOString(), cwd: body.cwd ?? "(none)" });
      setTimeout(() => { for (const c of clients.get(id) ?? []) c.write(`id: 1\ndata: ${JSON.stringify({ type: "result", text: `${label} got: ${body.text}`, cwd: body.cwd ?? null, sessionId: id })}\n\n`); }, 300);
      return j(202, { ok: true, sessionId: id, provider: "claude" });
    }
    if (u.pathname === "/api/events") {
      const id = u.searchParams.get("sessionId");
      res.writeHead(200, { "content-type": "text/event-stream" }); res.write(":ok\n\n");
      if (!clients.has(id)) clients.set(id, new Set()); clients.get(id).add(res);
      res.on("close", () => clients.get(id).delete(res)); return;
    }
    j(404, { path: u.pathname });
  });
}).listen(+port, "127.0.0.1");
