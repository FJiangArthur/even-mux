# even-mux

One Even app pairing, many `even-terminal` servers. Pair the G2 once with even-mux; it fans the
session list out across your laptop and any number of remote hosts, and routes every prompt,
permission response, interrupt and SSE stream to whichever host owns that session.

```
 Even app ──► even-mux :3456 ──┬──► even-terminal (laptop)            127.0.0.1:3457
                               ├──► ssh -L 13456 ─► even-terminal (gpu-box)   :3456
                               └──► ssh -L 13457 ─► even-terminal (ec2-dev)   :3456
```

Two programs live here:

- **even-orca** — drives your **Orca** agent terminals from the glasses through the `orca` CLI.
  Orca already federates SSH targets and paired Orca servers, so local *and* remote agents show up
  with no tunnels. This is the Orca GUI → CLI migration path. See [even-orca](#even-orca) below.
- **even-mux** — aggregates several servers behind one pairing: plain even-terminal instances,
  even-orca, or both.

Full background, architecture, every change and why: **[docs/DESIGN_AND_CHANGELOG.md](docs/DESIGN_AND_CHANGELOG.md)** (中文).

Quick reference:

```bash
npm install && npm install -g .     # both: -g links the folder but doesn't install deps
even-mux qr                         # pairing QR for the Even app
even-mux ui                         # web page: choose which sessions reach the glasses
even-mux sessions                   # same from the terminal; then hide|show|pin|unpin|auto <# or id>
even-mux host <name> on|off         # whole host on/off
```

---

# even-orca

even-orca speaks the even-terminal HTTP/SSE API the Even app already uses, and translates each
call into `orca` CLI commands:

| Glasses action | Orca CLI |
|---|---|
| Session list | `orca terminal list --json`, then once per `hostScope.omittedHostSelectors` entry (`--host ssh:…`) so every host is covered |
| Prompt an existing session | `orca terminal send --terminal <h> --text … --enter --wait-submit 3` |
| New session in a worktree | `orca terminal create --worktree <sel> --command claude\|codex`, wait for the TUI, then send |
| New worktree + agent | `orca worktree create --name <n> --agent <a> --prompt …` |
| Busy / idle / needs approval | `orca terminal wait --for tui-idle --timeout-ms 700` → `satisfied` / timeout / `blockedReason` |
| Answer text | `orca terminal read --screen` at turn end, trimmed to the latest reply (tool lines and TUI chrome stripped) |
| Approve / deny | the menu's numbered options are shown on the glasses; the choice is sent as the digit keystroke (deny = Esc) |
| Interrupt | Esc keystroke |

A "session" is an Orca terminal running an agent TUI (Claude Code, Codex, …). Plain shells are
hidden unless `includeAllTerminals` is set. Session IDs are derived from host + worktree + pane, so
they survive the runtime-scoped handle changes Orca makes on restart. Turns you start from the Orca
GUI or keyboard are picked up too: an attached viewer sees busy → tools → result → idle.

### Setup

```bash
# 1. Orca → Settings → General → Orca CLI → register. Then:
orca status --json
# 2. Start even-orca (writes ~/.even-orca/config.json on first run)
node even-orca.mjs doctor      # lists what it sees: ✓ = shown on glasses
node even-orca.mjs             # prints the pair QR
```

`~/.even-orca/config.json`:

```json
{
  "port": 3458,
  "host": "0.0.0.0",
  "token": "<generated>",
  "name": "orca",
  "orcaCommand": null,
  "defaultAgent": "claude",
  "defaultWorktree": "path:/Users/art/code/app",
  "includeAllTerminals": false,
  "pollBusyMs": 1500,
  "pollIdleMs": 5000
}
```

- `orcaCommand` null → `$ORCA_CLI_COMMAND`, else `orca` (`orca-ide` on Linux, where bare `orca` is the
  GNOME screen reader).
- `host`: `0.0.0.0` to pair the app directly; `127.0.0.1` when it sits behind even-mux.

### Starting new sessions from the glasses

Start the prompt with a target:

| Prompt | Effect |
|---|---|
| `@train profile the dataloader` | new agent terminal in the worktree whose branch/folder/host is `train` |
| `@branch:feat/x …`, `@path:/abs/wt …`, `@id:<repo>::<path> …` | raw Orca selectors |
| `@new:fix-login fix the redirect` | new worktree `fix-login` with the agent started on that prompt |
| no `@` | `defaultWorktree`, else the app's cwd if it exists locally, else a 400 asking for a target |

The agent is Codex when the app's provider is `codex`, otherwise `defaultAgent`. Remote worktrees are
matched by name like local ones, so `@train` lands on the SSH host that owns `train`.

### Using it with even-mux

Run even-orca on loopback and add it as a backend (`"tag": ""` avoids a double prefix, since even-orca
titles already carry `[host·branch]`):

```json
"orca": { "url": "http://127.0.0.1:3458", "token": "<even-orca token>", "tag": "" }
```

### Limits worth knowing

- Output comes from the rendered screen at turn end, so a reply longer than the visible terminal is
  cut to what's on screen. For the glasses this is usually what you want; open the terminal in Orca
  for the full scrollback.
- No token/cost numbers — the TUI doesn't expose them through the CLI.
- Busy/idle and approvals rely on Orca's `tui-idle` detection, which covers Claude Code, Codex,
  Gemini, OMP, Pi and Grok.
- Polling runs only for sessions with an open viewer or a turn in flight.

---

# even-mux
## Why this works

even-terminal's app protocol is plain HTTP + SSE, and everything is keyed by `sessionId`
(`/api/sessions`, `/api/prompt`, `/api/events`, `/api/permission-response`, …). Session IDs are
UUIDs, so they're globally unique — the mux passes them through untouched and keeps a
`sessionId → backend` table (persisted to `~/.even-mux/routes.json`). Nothing in the app changes;
titles just get a `[tag]` prefix so you can tell hosts apart on the glasses.

## Setup

1. **Each host** runs its own even-terminal as usual (already configured via its wizard).
   On the laptop, move it off 3456 so the mux can take it:
   ```bash
   even-terminal --port 3457
   ```
   On remotes, run it in tmux (or set `"autostart": true` and the mux does it for you):
   ```bash
   tmux new -d -s even-terminal even-terminal
   ```
   `even-terminal claude` / `even-terminal codex` on each host still attach to that host's server,
   so you can keep using the CLI over SSH and hand off to the glasses.

2. **Install and configure the mux** (laptop):
   ```bash
   npm install -g ./even-mux        # or: npm i && node even-mux.mjs
   even-mux init                    # writes ~/.even-mux/config.json
   ```
   ```json
   {
     "port": 3456,
     "host": "0.0.0.0",
     "token": "<generated>",
     "default": "local",
     "backends": {
       "local": { "url": "http://127.0.0.1:3457", "token": "auto", "tag": "mac" },
       "gpu":   { "ssh": "gpu-box", "remotePort": 3456, "localPort": 13456,
                  "token": "auto", "tag": "gpu", "cwd": "/data/proj", "autostart": false }
     }
   }
   ```
   - `token: "auto"` reads `~/.even-terminal/config.json` locally, or on the remote via `ssh`.
   - `ssh` is any `~/.ssh/config` Host. Needs key auth (BatchMode). Tunnels reconnect on drop.
   - `cwd` (optional) is the project dir for new sessions on that backend. For SSH backends
     without `cwd`, the app's local cwd is dropped so the remote's configured project dir applies.
   - A backend can also be a direct `url` (e.g. a remote reachable over Tailscale) instead of `ssh`.

3. **Start it and pair**:
   ```bash
   even-mux
   ```
   Scan the printed QR in the Even app (it prefers a Tailscale IP, then LAN;
   `EVEN_MUX_PREFER=lan` flips that).

## Switching

- **Existing sessions:** just pick them from the session list — the list is merged and sorted by
  recency across all hosts; `[gpu] …` vs `[mac] …` tells you where each lives. Switching back and
  forth is just switching sessions.
- **New session on a specific host:** start the first prompt with `@<backend>`:
  `@gpu run the eval and summarize failures`. Without a prefix it goes to the default.
- **Change the default** from any terminal on the laptop:
  ```bash
  even-mux use gpu
  even-mux status
  ```
  ```
    UP   local        [mac] http://127.0.0.1:3457
  * UP   gpu          [gpu] ssh gpu-box → http://127.0.0.1:13456
    41 routed sessions
  ```

## Behavior notes

- Global calls (`/api/info`, `/api/update-check`, `/api/metrics`) go to the default backend.
- A session the mux hasn't seen yet is located by probing `/api/status` on each live backend, then
  re-listing sessions; the result is cached.
- A backend that's down just disappears from the list; its sessions come back when it does.
- `/mux/status` and `/mux/use` are loopback-only and don't need the token.
- Codex sessions work the same way (each host's even-terminal runs its own Codex app-server).
