#!/usr/bin/env node
// even-mux — one pairing for the Even app, many even-terminal backends.
//
// The Even app pairs with exactly one even-terminal server. even-mux speaks the
// same HTTP/SSE API, so the app pairs with it instead; every call is routed to
// the backend that owns the session (local even-terminal, or a remote one
// reached through an auto-managed SSH tunnel). Session IDs are passed through
// unchanged (they are UUIDs, globally unique), so the app sees nothing unusual
// except a host tag on session titles.
//
// Usage:
//   even-mux                     start the mux (reads ~/.even-mux/config.json)
//   even-mux init                write a starter config
//   even-mux status              show backends + default
//   even-mux use <backend>       set the default backend for new sessions
//
// New sessions go to the default backend. Prefix the first prompt with
// "@<backend> " to target another one, e.g. "@gpu run the eval script".

import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawn, execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const MUX_DIR = process.env.EVEN_MUX_DIR || path.join(os.homedir(), ".even-mux");
const CONFIG_PATH = path.join(MUX_DIR, "config.json");
const ROUTES_PATH = path.join(MUX_DIR, "routes.json");
const ET_CONFIG = path.join(os.homedir(), ".even-terminal", "config.json");
const VERSION = "0.1.0";

// ── config ──────────────────────────────────────────────────────────────
function starterConfig() {
  return {
    port: 3456,
    host: "0.0.0.0",
    token: randomBytes(16).toString("hex"),
    name: "even-mux",
    default: "local",
    backends: {
      local: { url: "http://127.0.0.1:3457", token: "auto", tag: "mac" },
      gpu: {
        ssh: "gpu-box",            // any Host from ~/.ssh/config, or user@host
        remotePort: 3456,          // even-terminal port on the remote host
        localPort: 13456,          // local end of the tunnel
        token: "auto",             // read from remote ~/.even-terminal/config.json
        tag: "gpu",
        autostart: false,          // start even-terminal in tmux on the remote if down
      },
    },
  };
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.mkdirSync(MUX_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(starterConfig(), null, 2) + "\n", { mode: 0o600 });
    console.log(`[mux] wrote starter config to ${CONFIG_PATH} — edit backends, then rerun`);
    process.exit(0);
  }
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  if (!cfg.backends || !Object.keys(cfg.backends).length) throw new Error("config.backends is empty");
  cfg.port ??= 3456;
  cfg.host ??= "0.0.0.0";
  cfg.default ??= Object.keys(cfg.backends)[0];
  if (!cfg.token) {
    cfg.token = randomBytes(16).toString("hex");
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  }
  return cfg;
}

function saveDefault(name) {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  if (!cfg.backends[name]) throw new Error(`unknown backend "${name}" (have: ${Object.keys(cfg.backends).join(", ")})`);
  cfg.default = name;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
}

// ── helpers ─────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function sshRun(target, cmd, timeout = 15000) {
  return new Promise((resolve, reject) => {
    execFile("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", target, cmd],
      { timeout }, (err, stdout, stderr) => err ? reject(new Error(stderr.trim() || err.message)) : resolve(stdout));
  });
}

/** Buffered request to a backend. Returns { status, json, text }. */
function call(b, method, pathAndQuery, body, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const u = new URL(pathAndQuery, b.base);
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(u, {
      method,
      timeout,
      headers: {
        authorization: `Bearer ${b.token}`,
        ...(data ? { "content-type": "application/json", "content-length": data.length } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── backends ────────────────────────────────────────────────────────────
class Backend {
  constructor(name, spec) {
    this.name = name;
    this.spec = spec;
    this.tag = spec.tag === undefined ? name : spec.tag;
    this.isSsh = !!spec.ssh;
    this.base = this.isSsh ? `http://127.0.0.1:${spec.localPort}` : spec.url;
    this.token = spec.token && spec.token !== "auto" ? spec.token : null;
    this.up = false;
    this.tunnel = null;
    this.stopped = false;
  }

  async resolveToken() {
    if (this.token) return;
    if (this.isSsh) {
      const raw = await sshRun(this.spec.ssh, "cat ~/.even-terminal/config.json");
      this.token = JSON.parse(raw).token;
    } else {
      this.token = JSON.parse(fs.readFileSync(ET_CONFIG, "utf8")).token;
    }
    if (!this.token) throw new Error("no token found in even-terminal config");
  }

  async autostart() {
    if (!this.isSsh || !this.spec.autostart) return;
    const port = this.spec.remotePort ?? 3456;
    const cmd = `tmux has-session -t even-terminal 2>/dev/null || tmux new-session -d -s even-terminal 'even-terminal --port ${port}'`;
    await sshRun(this.spec.ssh, cmd).catch((e) => log(`[${this.name}] autostart failed: ${e.message}`));
  }

  openTunnel() {
    if (!this.isSsh || this.stopped) return;
    const args = [
      "-N", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=3", "-o", "BatchMode=yes",
      "-L", `127.0.0.1:${this.spec.localPort}:127.0.0.1:${this.spec.remotePort ?? 3456}`,
      this.spec.ssh,
    ];
    const p = spawn("ssh", args, { stdio: ["ignore", "ignore", "pipe"] });
    this.tunnel = p;
    p.stderr.on("data", (d) => log(`[${this.name}] ssh: ${d.toString().trim()}`));
    p.on("exit", (code) => {
      this.up = false;
      if (this.stopped) return;
      log(`[${this.name}] tunnel exited (${code}); reconnecting in 5s`);
      setTimeout(() => this.openTunnel(), 5000);
    });
  }

  async start() {
    try {
      await this.resolveToken();
    } catch (e) {
      log(`[${this.name}] token: ${e.message} — retrying in 15s`);
      setTimeout(() => this.start(), 15000);
      return;
    }
    await this.autostart();
    this.openTunnel();
    this.healthLoop();
  }

  async healthLoop() {
    while (!this.stopped) {
      let ok = false;
      try { ok = (await call(this, "GET", "/api/update-check", undefined, 5000)).status === 200; } catch {}
      if (ok !== this.up) log(`[${this.name}] ${ok ? "UP" : "DOWN"} (${this.base})`);
      this.up = ok;
      await sleep(ok ? 15000 : 3000);
    }
  }

  stop() {
    this.stopped = true;
    this.tunnel?.kill();
  }
}

// ── session → backend routing table (persisted) ────────────────────────
class Routes {
  constructor() {
    this.map = new Map();
    try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(ROUTES_PATH, "utf8")))) this.map.set(k, v); } catch {}
    this.dirty = false;
    setInterval(() => this.flush(), 5000).unref();
  }
  get(id) { return this.map.get(id); }
  set(id, backend) {
    if (!id || this.map.get(id) === backend) return;
    this.map.set(id, backend);
    this.dirty = true;
  }
  flush() {
    if (!this.dirty) return;
    // keep the file bounded
    const entries = [...this.map.entries()].slice(-5000);
    fs.writeFileSync(ROUTES_PATH, JSON.stringify(Object.fromEntries(entries)));
    this.dirty = false;
  }
}

// ── mux server ──────────────────────────────────────────────────────────
// ── visibility: which sessions reach the glasses ───────────────────────
const VIS_PATH = path.join(MUX_DIR, "visibility.json");
class Visibility {
  constructor() {
    let d = {};
    try { d = JSON.parse(fs.readFileSync(VIS_PATH, "utf8")); } catch {}
    this.force = new Map(Object.entries(d.force ?? {}));   // id → "show" | "hide"
    this.pinned = new Set(d.pinned ?? []);
    this.disabled = new Set(d.disabledBackends ?? []);
  }
  save() {
    fs.writeFileSync(VIS_PATH, JSON.stringify({
      force: Object.fromEntries(this.force), pinned: [...this.pinned], disabledBackends: [...this.disabled],
    }, null, 2) + "\n");
  }
  apply(ids, action) {
    for (const id of ids) {
      if (action === "hide") { this.force.set(id, "hide"); this.pinned.delete(id); }
      else if (action === "show") this.force.set(id, "show");
      else if (action === "pin") { this.pinned.add(id); this.force.delete(id); }
      else if (action === "unpin") this.pinned.delete(id);
      else if (action === "auto") { this.force.delete(id); this.pinned.delete(id); }
      else throw new Error(`unknown action "${action}"`);
    }
    this.save();
  }
}

function main() {
  const cfg = loadConfig();
  const backends = new Map(Object.entries(cfg.backends).map(([n, s]) => [n, new Backend(n, s)]));
  const routes = new Routes();
  let defaultName = cfg.default;

  const liveBackends = () => [...backends.values()].filter((b) => b.up);
  const defaultBackend = () => {
    const d = backends.get(defaultName);
    return d?.up ? d : liveBackends()[0] ?? d;
  };

  const vis = new Visibility();

  /** Every session from every live backend (unfiltered), newest first. */
  async function collect(query, perBackend, { everyProvider = false } = {}) {
    const rows = [];
    await Promise.all(liveBackends().map(async (b) => {
      const base = new URLSearchParams(query);
      base.delete("token");
      base.set("limit", String(perBackend));
      if (b.spec.allProviders) base.delete("provider");
      // For the picker, ask provider-scoped backends (even-terminal) for each provider it serves.
      const variants = everyProvider && !b.spec.allProviders ? ["claude", "codex"] : [null];
      const seen = new Set();
      const exclude = (b.spec.exclude ?? []).map((re) => new RegExp(re, "i"));
      await Promise.all(variants.map(async (prov) => {
        const q = new URLSearchParams(base);
        if (prov) q.set("provider", prov);
        try {
          const r = await call(b, "GET", `/api/sessions?${q}`, undefined, 20000);
          for (const s of r.json?.sessions ?? []) {
            if (seen.has(s.id)) continue;
            seen.add(s.id);
            routes.set(s.id, b.name);
            rows.push({ s: { ...s, provider: s.provider ?? prov }, b, rule: exclude.some((re) => re.test(s.title ?? "")) });
          }
        } catch (e) {
          log(`[${b.name}] sessions failed: ${e.message}`);
        }
      }));
    }));
    rows.sort((x, y) => String(y.s.timestamp).localeCompare(String(x.s.timestamp)));
    return rows;
  }

  /** Apply host switches, user choices, exclude rules and per-host max, in that order. */
  function decide(rows) {
    const used = new Map();
    for (const r of rows) {
      const id = r.s.id;
      const f = vis.force.get(id);
      r.pinned = vis.pinned.has(id);
      r.forced = r.pinned || !!f;
      if (vis.disabled.has(r.b.name)) { r.visible = false; r.why = "host off"; continue; }
      if (f === "hide") { r.visible = false; r.why = "hidden"; continue; }
      if (r.pinned || f === "show") { r.visible = true; r.why = r.pinned ? "pinned" : "shown"; continue; }
      if (r.rule) { r.visible = false; r.why = "rule"; continue; }
      const n = used.get(r.b.name) ?? 0;
      if (n >= (r.b.spec.max ?? Infinity)) { r.visible = false; r.why = "over max"; continue; }
      used.set(r.b.name, n + 1);
      r.visible = true;
      r.why = "auto";
    }
    return rows;
  }

  const display = (r) => (backends.size > 1 && r.b.tag ? `[${r.b.tag}] ${r.s.title ?? ""}` : (r.s.title ?? ""));

  /** The list the glasses get: pinned first, then newest visible. */
  async function glassesRows(query, limit) {
    const rows = decide(await collect(query, Math.max(limit * 3, 30))).filter((r) => r.visible);
    const pinned = rows.filter((r) => r.pinned);
    return [...pinned, ...rows.filter((r) => !r.pinned)].slice(0, Math.max(limit, pinned.length));
  }

  /** Find the backend that owns a session. */
  async function resolve(sessionId, provider) {
    const known = routes.get(sessionId);
    if (known && backends.get(known)) return backends.get(known);
    // Probe: live in-memory status, then session listings.
    const live = liveBackends();
    const q = provider ? `&provider=${encodeURIComponent(provider)}` : "";
    for (const b of live) {
      try {
        const r = await call(b, "GET", `/api/status?sessionId=${encodeURIComponent(sessionId)}${q}`, undefined, 5000);
        if (r.status === 200) { routes.set(sessionId, b.name); return b; }
      } catch {}
    }
    for (const b of live) {
      try {
        const r = await call(b, "GET", `/api/sessions?limit=100${q}`, undefined, 10000);
        for (const s of r.json?.sessions ?? []) routes.set(s.id, b.name);
      } catch {}
    }
    const found = routes.get(sessionId);
    return found ? backends.get(found) : defaultBackend();
  }

  function send(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
    res.end(body);
  }

  function readBody(req) {
    return new Promise((resolve) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const t = Buffer.concat(chunks).toString("utf8");
        try { resolve(t ? JSON.parse(t) : {}); } catch { resolve({}); }
      });
    });
  }

  /** Stream an SSE (or any) response from backend to client, untouched. */
  function pipe(b, req, res, u) {
    const headers = { authorization: `Bearer ${b.token}` };
    if (req.headers["last-event-id"]) headers["last-event-id"] = req.headers["last-event-id"];
    const up = http.request(new URL(u.pathname + stripToken(u.search), b.base), { method: "GET", headers }, (ur) => {
      res.writeHead(ur.statusCode, {
        "content-type": ur.headers["content-type"] ?? "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      res.flushHeaders?.();
      ur.pipe(res);
      ur.on("end", () => res.end());
    });
    up.on("error", (e) => {
      if (!res.headersSent) send(res, 502, { error: `backend ${b.name}: ${e.message}` });
      else res.end();
    });
    res.on("close", () => up.destroy());
    up.end();
  }

  function stripToken(search) {
    const p = new URLSearchParams(search);
    p.delete("token");
    const s = p.toString();
    return s ? `?${s}` : "";
  }

  async function forward(b, req, res, u, body) {
    if (!b) return send(res, 503, { error: "no backend available" });
    try {
      const r = await call(b, req.method, u.pathname + stripToken(u.search), req.method === "GET" ? undefined : body);
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(r.text);
      return r;
    } catch (e) {
      send(res, 502, { error: `backend ${b.name}: ${e.message}` });
    }
  }

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    const t0 = Date.now();
    res.on("finish", () => log(`${res.statusCode} ${req.method} ${u.pathname} ${Date.now() - t0}ms`));

    // Mux control (loopback only, no token needed)
    if (u.pathname.startsWith("/mux/")) {
      const addr = req.socket.remoteAddress ?? "";
      if (!/^(::ffff:)?127\.|^::1$/.test(addr)) return send(res, 403, { error: "loopback only" });
      if (u.pathname === "/mux/status") {
        return send(res, 200, {
          default: defaultName,
          backends: [...backends.values()].map((b) => ({ name: b.name, tag: b.tag, up: b.up, base: b.base, ssh: b.spec.ssh ?? null })),
          routedSessions: routes.map.size,
        });
      }
      if (u.pathname === "/mux/use" && req.method === "POST") {
        const { name } = await readBody(req);
        if (!backends.has(name)) return send(res, 400, { error: `unknown backend "${name}"` });
        defaultName = name;
        try { saveDefault(name); } catch {}
        log(`[mux] default backend → ${name}`);
        return send(res, 200, { ok: true, default: name });
      }
      if (u.pathname === "/mux/ui" || u.pathname === "/mux/") {
        try {
          const html = fs.readFileSync(path.join(PKG_DIR, "ui.html"));
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
          return res.end(html);
        } catch { return send(res, 500, { error: "ui.html missing next to even-mux.mjs" }); }
      }
      if (u.pathname === "/mux/sessions" && req.method === "GET") {
        const previewQuery = `provider=${encodeURIComponent(cfg.previewProvider ?? cfg.defaultProvider ?? "claude")}`;
        const [rows, preview] = await Promise.all([collect("", 100, { everyProvider: true }).then(decide), glassesRows(previewQuery, 10)]);
        return send(res, 200, {
          backends: [...backends.values()].map((b) => ({
            name: b.name, tag: b.tag, up: b.up, enabled: !vis.disabled.has(b.name),
            max: b.spec.max ?? null, exclude: b.spec.exclude ?? [], allProviders: !!b.spec.allProviders,
          })),
          sessions: rows.map((r) => ({
            id: r.s.id, title: r.s.title ?? "", display: display(r), backend: r.b.name, tag: r.b.tag,
            timestamp: r.s.timestamp, status: r.s.status ?? null, provider: r.s.provider ?? null, cwd: r.s.cwd ?? "",
            visible: r.visible, why: r.why, pinned: r.pinned, forced: r.forced,
          })),
          preview: preview.map((r) => r.s.id),
        });
      }
      if (u.pathname === "/mux/visibility" && req.method === "POST") {
        const { ids, action } = await readBody(req);
        if (!Array.isArray(ids) || !ids.length) return send(res, 400, { error: "ids required" });
        try { vis.apply(ids, action); } catch (e) { return send(res, 400, { error: e.message }); }
        log(`[mux] ${action} ${ids.length} session(s)`);
        return send(res, 200, { ok: true });
      }
      if (u.pathname === "/mux/backend" && req.method === "POST") {
        const { name, enabled } = await readBody(req);
        if (!backends.has(name)) return send(res, 400, { error: `unknown backend "${name}"` });
        if (enabled) vis.disabled.delete(name); else vis.disabled.add(name);
        vis.save();
        log(`[mux] host ${name} ${enabled ? "on" : "off"}`);
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: "not found" });
    }

    if (!u.pathname.startsWith("/api/")) return send(res, 404, { error: "not found" });

    // Auth — same scheme as even-terminal
    const h = req.headers.authorization;
    const provided = h?.startsWith("Bearer ") ? h.slice(7) : u.searchParams.get("token");
    if (provided !== cfg.token) return send(res, 401, { error: { code: "auth_failed", message: "Unauthorized" } });

    const body = req.method === "GET" ? {} : await readBody(req);
    const sessionId = u.searchParams.get("sessionId") ?? body.sessionId
      ?? u.pathname.match(/^\/api\/(?:sessions|debug\/(?:thread|status))\/([^/]+)/)?.[1];
    const provider = u.searchParams.get("provider") ?? body.provider;

    // ── merged session list (filtered by the visibility settings) ──
    if (u.pathname === "/api/sessions" && req.method === "GET") {
      const limit = Number(u.searchParams.get("limit")) || 10;
      const rows = await glassesRows(stripToken(u.search).slice(1), limit);
      return send(res, 200, { sessions: rows.map((r) => ({ ...r.s, title: display(r) })) });
    }

    // ── new or existing prompt ──
    if (u.pathname === "/api/prompt" && req.method === "POST") {
      let target;
      if (body.sessionId) {
        target = await resolve(body.sessionId, provider);
      } else {
        // "@name rest of prompt" picks the backend for a new session
        const m = typeof body.text === "string" && body.text.match(/^\s*@([\w.-]+)\s+([\s\S]+)$/);
        if (m && backends.has(m[1])) {
          target = backends.get(m[1]);
          body.text = m[2];
        } else {
          target = defaultBackend();
        }
        // Client cwd is a local path; meaningless on a remote host.
        if (target?.spec.cwd) body.cwd = target.spec.cwd;
        else if (target?.isSsh) delete body.cwd;
      }
      const r = await forward(target, req, res, u, body);
      if (r?.json?.sessionId) routes.set(r.json.sessionId, target.name);
      return;
    }

    // ── SSE ──
    if (u.pathname === "/api/events") {
      if (!sessionId) return send(res, 400, { error: "Missing 'sessionId' query parameter" });
      const b = await resolve(sessionId, provider);
      if (!b) return send(res, 503, { error: "no backend available" });
      return pipe(b, req, res, u);
    }

    // ── everything session-scoped ──
    if (sessionId) return forward(await resolve(sessionId, provider), req, res, u, body);

    // ── global endpoints (/info, /update-check, /metrics, …) → default backend ──
    return forward(defaultBackend(), req, res, u, body);
  });

  for (const b of backends.values()) b.start();

  server.listen(cfg.port, cfg.host, async () => {
    printBanner(cfg);
  });
  // Bound to a specific address (e.g. Tailscale): also serve loopback so local tools and
  // `even-mux status` keep working, as even-terminal does.
  if (!["0.0.0.0", "127.0.0.1", "::", "localhost"].includes(cfg.host)) {
    const loop = http.createServer((req, res) => server.emit("request", req, res));
    loop.on("error", (e) => log(`[mux] loopback listener: ${e.message}`));
    loop.listen(cfg.port, "127.0.0.1");
  }

  const shutdown = () => {
    routes.dirty = true;
    routes.flush();
    for (const b of backends.values()) b.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function pickAddress(host) {
  if (host && host !== "0.0.0.0") return host;
  const addrs = Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === "IPv4" && !a.internal);
  // Prefer Tailscale (100.64/10), then private LAN
  const ts = addrs.find((a) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address));
  const lan = addrs.find((a) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address));
  return (process.env.EVEN_MUX_PREFER === "lan" ? lan ?? ts : ts ?? lan)?.address ?? "localhost";
}

// Directory even-mux really lives in (the global bin is a symlink into it).
const PKG_DIR = path.dirname(fs.realpathSync(fileURLToPath(import.meta.url)));

function pairUrl(cfg) {
  const params = new URLSearchParams({ token: cfg.token, defaultProvider: cfg.defaultProvider ?? "claude", name: cfg.name ?? "even-mux" });
  return `http://${pickAddress(cfg.host)}:${cfg.port}?${params}`;
}

async function qrFromModule(text) {
  const qr = (await import("qrcode-terminal")).default;
  return new Promise((resolve) => qr.generate(text, { small: true }, resolve));
}

/** Terminal QR code for `text`; never gives up silently on a missing dependency. */
async function renderQr(text) {
  try { return await qrFromModule(text); } catch {}
  try { return execFileSync("qrencode", ["-t", "UTF8", "-m", "2", text], { encoding: "utf8", timeout: 5000 }); } catch {}
  // Self-heal: `npm install -g <folder>` links the folder without installing its deps.
  try {
    console.log("  installing qrcode-terminal for the pairing QR…");
    execFileSync("npm", ["install", "--no-audit", "--no-fund", "--silent"], { cwd: PKG_DIR, stdio: "ignore", timeout: 120000 });
    return await qrFromModule(text);
  } catch {}
  return null;
}

async function printBanner(cfg, { listening = true } = {}) {
  const url = pairUrl(cfg);
  if (listening) console.log(`\n  even-mux v${VERSION}  listening on ${cfg.host}:${cfg.port}`);
  console.log(`  backends: ${Object.keys(cfg.backends).join(", ")}   default: ${cfg.default}`);
  console.log(`  pair URL: ${url}\n`);
  const qr = await renderQr(url);
  console.log(qr ?? `  (no QR renderer: run \`cd ${PKG_DIR} && npm install\` or \`brew install qrencode\`, then \`even-mux qr\`)`);
  try {
    fs.writeFileSync(path.join(MUX_DIR, "pair.txt"),
      `even-mux pairing (${new Date().toISOString()})\n\nURL:   http://${pickAddress(cfg.host)}:${cfg.port}\nToken: ${cfg.token}\n\n${url}\n\n${qr ?? ""}\n`, { mode: 0o600 });
  } catch {}
}

// ── CLI ─────────────────────────────────────────────────────────────────
async function control(pathname, body) {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  const r = await call({ base: `http://127.0.0.1:${cfg.port ?? 3456}`, token: "" }, body ? "POST" : "GET", pathname, body, 60000);
  if (r.status >= 400) throw Object.assign(new Error(r.json?.error ?? `HTTP ${r.status}`), { http: true });
  return r.json;
}

const WHY_TEXT = { auto: "", pinned: "pinned", shown: "shown by you", hidden: "hidden by you", rule: "rule", "over max": "over max", "host off": "host off" };
const age = (ts) => {
  const d = (Date.now() - new Date(ts).getTime()) / 1000;
  return !isFinite(d) ? "" : d < 3600 ? `${Math.max(1, Math.floor(d / 60))}m` : d < 86400 ? `${Math.floor(d / 3600)}h` : `${Math.floor(d / 86400)}d`;
};
const notRunning = (e) => {
  console.error(e?.http ? e.message : "even-mux is not running (start it, then retry)");
  process.exit(1);
};

async function listSessions(which) {
  const d = await control("/mux/sessions");
  const rows = d.sessions.filter((s) => which === "all" || (which === "hidden" ? !s.visible : s.visible));
  console.log(`hosts: ${d.backends.map((b) => `${b.name}${b.enabled ? "" : " (off)"}${b.up ? "" : " (down)"}`).join(", ")}`);
  console.log(`glasses list now: ${d.preview.length} session(s)\n`);
  console.log("  #  on  id        host    age  title");
  d.sessions.forEach((s, i) => {
    if (!rows.includes(s)) return;
    const mark = `${s.visible ? "●" : "○"}${s.pinned ? "★" : " "}`;
    const why = WHY_TEXT[s.why] ? `  (${WHY_TEXT[s.why]})` : "";
    console.log(`${String(i + 1).padStart(3)}  ${mark}  ${s.id.slice(0, 8)}  ${s.backend.padEnd(6).slice(0, 6)}  ${age(s.timestamp).padStart(3)}  ${s.title.replace(/\s+/g, " ").slice(0, 60)}${why}`);
  });
  console.log("\n● shown  ○ hidden  ★ pinned    even-mux hide|show|pin|unpin|auto <# or id-prefix>…    even-mux ui");
}

async function changeSessions(action, refs) {
  if (!refs.length) { console.error(`usage: even-mux ${action} <# or id-prefix>…`); process.exit(1); }
  const d = await control("/mux/sessions");
  const ids = [];
  for (const ref of refs) {
    let hit = [];
    if (/^\d+$/.test(ref) && Number(ref) >= 1 && Number(ref) <= d.sessions.length && ref.length < 5) hit = [d.sessions[Number(ref) - 1]];
    else hit = d.sessions.filter((s) => s.id === ref || s.id.startsWith(ref));
    if (hit.length !== 1) { console.error(`${ref}: ${hit.length ? "ambiguous" : "no such session"}`); process.exit(1); }
    ids.push(hit[0].id);
    console.log(`${action.padEnd(5)} ${hit[0].id.slice(0, 8)}  ${hit[0].title.replace(/\s+/g, " ").slice(0, 60)}`);
  }
  await control("/mux/visibility", { ids, action });
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "init") {
  if (fs.existsSync(CONFIG_PATH)) { console.log(`${CONFIG_PATH} already exists`); process.exit(0); }
  fs.mkdirSync(MUX_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(starterConfig(), null, 2) + "\n", { mode: 0o600 });
  console.log(`wrote ${CONFIG_PATH}`);
} else if (cmd === "status") {
  control("/mux/status").then((s) => {
    for (const b of s.backends) console.log(`${b.name === s.default ? "*" : " "} ${b.up ? "UP  " : "DOWN"} ${b.name.padEnd(12)} [${b.tag}] ${b.ssh ? `ssh ${b.ssh} → ` : ""}${b.base}`);
    console.log(`  ${s.routedSessions} routed sessions`);
  }).catch(() => { console.error("even-mux is not running"); process.exit(1); });
} else if (cmd === "use") {
  if (!arg) { console.error("usage: even-mux use <backend>"); process.exit(1); }
  control("/mux/use", { name: arg }).then((r) => console.log(r.error ?? `default → ${r.default}`))
    .catch(() => { saveDefault(arg); console.log(`default → ${arg} (mux not running; saved to config)`); });
} else if (cmd === "sessions" || cmd === "ls") {
  listSessions(arg === "--all" || arg === "all" ? "all" : arg === "hidden" ? "hidden" : "all").catch(notRunning);
} else if (["hide", "show", "pin", "unpin", "auto"].includes(cmd)) {
  changeSessions(cmd, process.argv.slice(3)).catch(notRunning);
} else if (cmd === "host") {
  const on = process.argv[4];
  if (!arg || !["on", "off"].includes(on)) { console.error("usage: even-mux host <name> on|off"); process.exit(1); }
  control("/mux/backend", { name: arg, enabled: on === "on" }).then(() => console.log(`host ${arg} ${on}`)).catch(notRunning);
} else if (cmd === "ui") {
  const port = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")).port ?? 3456;
  const url = `http://127.0.0.1:${port}/mux/ui`;
  console.log(url);
  try { execFileSync(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore" }); } catch {}
} else if (cmd === "qr") {
  if (!fs.existsSync(CONFIG_PATH)) { console.error(`no config at ${CONFIG_PATH}; run even-mux init`); process.exit(1); }
  printBanner(JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")), { listening: false });
} else if (!cmd || cmd === "start") {
  main();
} else {
  console.log("usage: even-mux [start|init|status|qr|ui|sessions|hide|show|pin|unpin|auto|host <name> on|off|use <backend>]");
  process.exit(1);
}
