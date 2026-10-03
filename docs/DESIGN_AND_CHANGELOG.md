# even-mux / even-orca：来龙去脉、架构与全部改动记录

> 适用版本：even-mux 0.1.0 · even-orca 0.1.0 · 上游 `@evenrealities/even-terminal` 0.10.4–0.10.5 · Orca 1.4.212
> 最后更新：2026-09-28
> 读者：想在自己机器上复用这套方案、或者要维护它的人

---

## 1. 一句话概述

**用一副 Even Realities G2 眼镜，在同一个配对下，切换并操作分布在多台机器（本机 + 远程 SSH 主机）上的多个 AI coding agent 会话（Claude Code / Codex / Pi …），并且直接接管 Orca 里已经在跑的 agent 终端。**

实现方式是两个小程序：

| 程序 | 作用 | 端口（默认部署） |
|---|---|---|
| **even-mux** | 多路复用代理。对 Even App 伪装成“一个 even-terminal 服务器”，背后把请求路由到多个后端；带会话可见性控制（Web UI + CLI） | 3456（Tailscale IP + 127.0.0.1） |
| **even-orca** | 适配器。把 Orca CLI（`orca terminal …` / `orca worktree ps`）翻译成 even-terminal 的 HTTP/SSE 协议，让 Orca 里的 agent 终端出现在眼镜上 | 3458（仅 127.0.0.1） |
| even-terminal（上游，未修改） | 官方本机服务器，管理本机 Claude/Codex 会话 | 3457（Tailscale IP + 127.0.0.1） |

---

## 2. 背景：为什么要做这个

### 2.1 起点
- 官方 `even-terminal` 让 G2 眼镜 + R1 戒指通过 Even App 操作电脑上的 Claude Code / Codex。
- **问题一：只能 local。** 一个 even-terminal 进程只管理它所在机器上的 agent；Even App 一次只配对一个服务器（URL + token）。我经常在远程机器（EC2 `artekne`、GPU 机器等）上跑 agent，想在眼镜上和本机会话之间来回切换，官方方案做不到。
- **问题二：工作流在 Orca 里。** 日常大量 agent 是在 Orca（agent 开发环境）里通过 GUI 起的，包括 Orca 自带的 SSH 远程 worktree。希望从 GUI 迁移到 Orca CLI，并让这些 agent 也能在眼镜上操作。

### 2.2 调研结论（决定了架构）

**even-terminal 的 App 协议是纯 HTTP + SSE，而且一切都按 `sessionId` 寻址**（阅读 npm 包 0.10.5 `dist/` 源码得出）：

| 接口 | 用途 |
|---|---|
| `GET /api/sessions?limit&provider&cwd` | 会话列表（`{sessions:[{id,title,timestamp,cwd,provider,status}]}`） |
| `POST /api/prompt {text, sessionId?, provider?, cwd?}` | 发送提示；无 sessionId 时新建会话 |
| `GET /api/events?sessionId&needReplay` | SSE 事件流 |
| `GET /api/messages?sessionId&after` | 拉取缓存事件 |
| `GET /api/status?sessionId` | 会话状态 |
| `POST /api/permission-response {sessionId, decision}` | 批准/拒绝工具调用（`allow`/`allowAlways`/`deny`） |
| `POST /api/question-response {sessionId, answer}` | 回答 agent 提问 |
| `POST /api/interrupt {sessionId}` | 中断 |
| `GET /api/sessions/:id/history` | 最近几轮对话 |
| `GET /api/info`、`/api/update-check`、`/api/metrics` | 全局信息 |

鉴权：`Authorization: Bearer <token>` 或 `?token=`。SSE 事件类型：`status`（busy/idle/…）、`user_prompt`、`text_delta`、`tool_start`、`tool_end`、`permission_request`、`permission_result`、`user_question`、`result`、`error`、`notification`。

关键推论：**session ID 是 UUID，全局唯一** → 可以做一个“代理”，把 ID 原样透传，只需记住“哪个 ID 属于哪个后端”。App 完全无感。

**Orca 本身已经支持 SSH 远程主机和配对的远程 Orca 服务器**（`orca host list`、`--host ssh:<id>`），并且 CLI 暴露了：

- `orca terminal list/read/send/wait/create`：终端级操作（`wait --for tui-idle` 判断 agent 是否空闲）
- `orca worktree ps`：**每个 agent pane 的 hook 状态**（`working|blocked|waiting|done`）、`lastAssistantMessage`（完整回复）、`toolName/toolInput`、`prompt`、worktree `displayName`
- `orca worktree create --agent <a> --prompt …`：新建 worktree 并启动 agent

→ 所以 Orca 这一侧**不需要自己做 SSH 隧道**，Orca 已经把远程主机统一了。

---

## 3. 架构

```
                       ┌──────────────────────────── Mac ────────────────────────────┐
 G2 + R1 ─BLE─ Even App │                                                              │
      (手机, Tailscale) ─┼─HTTP/SSE─► even-mux :3456 ──┬──► even-orca :3458 ──► orca CLI ─┼─► Orca.app ──SSH──► artekne / h200 / …
                        │   (Tailscale IP + loopback)   │     (loopback only)              │     (本地 + 远程 agent 终端)
                        │                               └──► even-terminal :3457 ──────────┼─► 本机 Claude / Codex
                        │                               └──► (可选) ssh -L 隧道 ──► 远程 even-terminal
                        │   /mux/ui  (浏览器, 仅 loopback) —— 会话显示/隐藏/置顶
                        └──────────────────────────────────────────────────────────────┘
```

### 3.1 even-mux（`even-mux.mjs`）
- **协议兼容**：对外完全就是 even-terminal 的 `/api/*`，Even App 扫码配对即可。
- **路由表**：`sessionId → backend`，持久化到 `~/.even-mux/routes.json`。未知 ID 先对各后端 `GET /api/status` 探测，再全量拉列表补齐。
- **会话列表合并**：并行请求所有在线后端，按时间合并，套用可见性规则（第 6 节），标题前加 `[tag]`。
- **新会话**：发往默认后端；提示词以 `@<backend> ` 开头则发往指定后端。远程后端会丢弃 App 传来的本机 `cwd`（或用后端配置的 `cwd`）。
- **SSE**：原样管道转发（`res.on("close")` 时关闭上游）。
- **后端类型**：`url`（直连，如本机 even-terminal / even-orca / Tailscale 上的远程）或 `ssh`（自动 `ssh -N -L` 隧道，断线 5s 重连，`token: "auto"` 通过 ssh 读取远程 `~/.even-terminal/config.json`，`autostart` 可在远程 tmux 里拉起 even-terminal）。
- **健康检查**：每后端 `GET /api/update-check`，在线 15s / 离线 3s。
- **控制面**：`/mux/*` 只允许 127.0.0.1，免 token（status、use、sessions、visibility、backend、ui）。

### 3.2 even-orca（`even-orca.mjs`）
- **会话 = Orca 里跑着 agent TUI 的终端 pane。** session ID 由 `host|worktreeId|leafId` 做 SHA-1 生成 UUID 形式，**Orca 重启后 handle 变了 ID 也不变**。
- **列表**：`orca terminal list --limit 200`，再按 `hostScope.omittedHostSelectors` 逐个补 `--host …` 查询，覆盖所有主机。默认只列 agent 终端（`includeAllTerminals` 可改）。
- **状态（首选）**：`orca worktree ps` 的 hook 状态，按 pane key `tabId:leafId` 对应：`working→busy`、`blocked/waiting→awaiting`、`done→idle`。
- **状态（兜底）**：没有 hook 记录的终端用 `terminal wait --for tui-idle --timeout-ms 700`；超时则读屏幕判断是否有 “esc to interrupt / Working (” 等忙碌标记。
- **回复文本**：优先 `lastAssistantMessage`（完整、不受屏幕高度限制）；兜底读 `terminal read --screen` 并裁剪出最后一轮回答。
- **工具事件**：`toolName/toolInput` 变化即发 `tool_start/tool_end`。
- **审批**：`blocked` 时读屏幕解析编号菜单（“1. Yes / 2. Yes, don't ask again / 3. No…”），原样显示在眼镜上；选择以数字键发送，拒绝/中断发送 Esc。
- **发送提示**：`terminal send --text … --enter --wait-submit 3`。
- **新会话**：`@<分支|worktree 显示名|文件夹|主机> 提示` → `terminal create --command claude|codex` 后等待 TUI 就绪再发送；`@new:<名字> 提示` → `worktree create --agent … --prompt …`。
- **标题**：`[主机名·worktree 显示名] 终端标题`；终端标题无意义（`pi`、`Pi ready`、`user@host:` 等）时改用 agent 的 `taskTitle/displayName/prompt`。

---

## 4. 部署现状（本机）

| 项 | 值 |
|---|---|
| 代码目录 | `~/develop/even-mux`（`npm install -g .` 以符号链接方式全局安装，改代码即生效） |
| 进程管理 | tmux 会话 `even`：窗口 `terminal`（even-terminal）、`orca`（even-orca）、`mux`（even-mux） |
| 日志 | `~/.even-mux/logs/{even-terminal,even-orca,even-mux}.log` |
| even-terminal | `~/.even-terminal/config.json`：port 改为 **3457**，network 仍为 tailscale |
| even-orca | `~/.even-orca/config.json`：port 3458，host 127.0.0.1，`orcaCommand=/Applications/Orca.app/Contents/Resources/bin/orca` |
| even-mux | `~/.even-mux/config.json`：port 3456，host = 本机 Tailscale IP，后端 `orca`（默认）+ `local` |
| 可见性 | `~/.even-mux/visibility.json` |
| 配对信息 | `~/.even-mux/pair.txt`（URL、token、二维码；权限 600） |

启动 / 重启：

```bash
L=~/.even-mux/logs; mkdir -p $L
tmux new-session -d -s even -n terminal "zsh -lc 'even-terminal 2>&1 | tee $L/even-terminal.log'"
tmux new-window  -t even -n orca     "zsh -lc 'even-orca 2>&1 | tee $L/even-orca.log'"
tmux new-window  -t even -n mux      "zsh -lc 'even-mux 2>&1 | tee $L/even-mux.log'"
# 只重启某一个：
tmux respawn-window -k -t even:mux "zsh -lc 'even-mux 2>&1 | tee $HOME/.even-mux/logs/even-mux.log'"
```

---

## 5. 从零安装（给其他人）

```bash
git clone <本仓库> ~/develop/even-mux && cd ~/develop/even-mux
npm install && npm install -g .          # 两步都要：-g 装的是符号链接，不会装依赖
npm install -g @evenrealities/even-terminal
even-terminal                            # 首次运行完成向导后 Ctrl+C
even-terminal config port 3457           # 把 3456 让给 even-mux

# even-orca（需要 Orca：Settings → General → Orca CLI 注册）
mkdir -p ~/.even-orca
cat > ~/.even-orca/config.json <<'EOF'
{ "port": 3458, "host": "127.0.0.1",
  "orcaCommand": "/Applications/Orca.app/Contents/Resources/bin/orca",
  "defaultAgent": "claude" }
EOF
even-orca doctor                         # 列出能看到的 agent 终端（✓ = 会上眼镜）

# even-mux
even-mux init                            # 生成 ~/.even-mux/config.json，然后按第 7 节编辑 backends
```

然后按第 4 节用 tmux 启动三者，`even-mux qr` 显示二维码，用 Even App 扫描（手机需开 Tailscale）。

---

## 6. 会话可见性（决定眼镜上显示哪些会话）

### 6.1 规则顺序
1. **主机开关**关闭 → 该主机全部隐藏
2. **你的手动选择**：`hide` → 隐藏；`show` / `pin` → 显示（pin 额外置顶）
3. **自动规则**：后端 `exclude` 正则命中标题 → 隐藏；超过后端 `max` 数量 → 隐藏
4. 其余按时间倒序；置顶的永远排在最前

眼镜请求 `limit=10` 时，even-mux 会向每个后端多要（`max(limit*3, 30)`），避免过滤后列表不满。

### 6.2 Web UI
`even-mux ui` 或浏览器打开 `http://127.0.0.1:3456/mux/ui`（仅本机）：主机开关、“眼镜现在看到的列表”预览、每个会话的显示开关与置顶 ★、搜索 + All/Visible/Hidden 过滤、批量“Hide listed / Show listed”、手动改过的会话可一键 Reset。20 秒自动刷新，支持深色模式和窄屏。

### 6.3 CLI
```bash
even-mux sessions                 # 编号列表：● 显示 ○ 隐藏 ★ 置顶，括号内是原因
even-mux hide 3 5                 # 按编号（编号会随新会话变化）
even-mux pin ce4e7626             # 按 id 前缀（推荐）
even-mux show 8c15068e            # 强制显示被规则隐藏的
even-mux auto 8c15068e            # 恢复自动
even-mux host local off|on        # 整个主机开关
```

---

## 7. 配置参考

### 7.1 `~/.even-mux/config.json`
```jsonc
{
  "port": 3456,
  "host": "<tailscale-ip>",        // 指定地址时会额外监听 127.0.0.1；0.0.0.0 = 所有网卡
  "token": "<生成的配对 token>",
  "name": "artjiang-mux",
  "default": "orca",               // 新会话默认后端
  "defaultProvider": "claude",     // 写进二维码；UI 预览按此 provider 计算
  "backends": {
    "orca":  { "url": "http://127.0.0.1:3458", "token": "<even-orca token>", "tag": "",
               "allProviders": true },          // 不把 App 的 provider 过滤传给 even-orca
    "local": { "url": "http://127.0.0.1:3457", "token": "auto", "tag": "mac",
               "max": 3,                         // 最多占 3 个位置
               "exclude": ["^Review this change for security vulnerabilities"] },
    "gpu":   { "ssh": "gpu-box", "remotePort": 3456, "localPort": 13456,
               "token": "auto", "tag": "gpu", "cwd": "/data/proj", "autostart": false }
  }
}
```

| 后端字段 | 含义 |
|---|---|
| `url` / `ssh` | 直连地址 / `~/.ssh/config` 里的 Host（需免密钥登录） |
| `token` | 字符串，或 `"auto"`（读本机或远程 `~/.even-terminal/config.json`） |
| `tag` | 标题前缀；`""` 表示不加（even-orca 自己已带 `[主机·worktree]`） |
| `max` | 自动显示的最大数量（手动显示/置顶不计入） |
| `exclude` | 标题正则数组（不区分大小写），命中即自动隐藏 |
| `allProviders` | 请求该后端时去掉 `provider` 参数 |
| `cwd` / `remotePort` / `localPort` / `autostart` | SSH 后端专用 |

### 7.2 `~/.even-orca/config.json`
| 字段 | 默认 | 含义 |
|---|---|---|
| `port` / `host` | 3458 / 0.0.0.0 | 放在 even-mux 后面时用 `127.0.0.1` |
| `token` | 自动生成 | even-mux 用它访问 even-orca |
| `orcaCommand` | `$ORCA_CLI_COMMAND` → `orca`（Linux 为 `orca-ide`） | macOS 上 `/usr/local/bin/orca` 是 root 权限链接，直接指向 app 内的 CLI |
| `defaultAgent` | `claude` | 新建会话用的 agent |
| `defaultWorktree` | null | 无 `@` 目标时新会话的 worktree 选择器 |
| `includeAllTerminals` | false | true 时普通 shell 也列出 |
| `pollBusyMs` / `pollIdleMs` | 1500 / 5000 | 有人在看或有回合进行时才轮询 |

---

## 8. 全部改动记录（按时间）

### 阶段 A — 调研 even-terminal（2026-09-26）
- 下载并阅读 `@evenrealities/even-terminal@0.10.5` 源码，确认：单进程只管本机 agent；App 协议是 HTTP+SSE、按 sessionId 寻址；配对二维码内容为 `http://<addr>:<port>?token=…&defaultProvider=…&name=…`。
- 结论：做一个协议兼容的多路代理，而不是修改上游。

### 阶段 B — even-mux 初版
- 实现代理、路由表持久化、合并列表、`@backend` 前缀、远程丢弃本机 cwd、SSH 隧道后端（自动重连、自动取 token、可选 tmux autostart）、健康检查、`status/use` CLI。
- 用两个 mock 后端 + 真实 even-terminal 0.10.5 做端到端测试（鉴权、列表、状态、消息、SSE、prompt 全部透传正常）。
- **Bug 修复**：SSE 转发最初在 `req.on("close")` 时销毁上游连接——Node 在请求体读完时就会触发，导致事件丢失。改为 `res.on("close")`。

### 阶段 C — 调研 Orca CLI
- 阅读 Orca 文档与源码（`src/cli`、`src/shared/runtime-terminal-contracts.ts`、内置 `orca-cli` skill guide），确认 `terminal list/read/send/wait/create`、`host list`、SSH/远程主机选择器、`send` 在 CLI 路径下不会被 permission guard 拦截（可以用按键回答审批菜单）。

### 阶段 D — even-orca 初版（基于读屏）
- 用 `terminal wait --for tui-idle` 判断忙/闲/被审批阻塞，`terminal read --screen` 解析回答、工具行、审批菜单。
- 写了有状态的 mock Orca CLI（`test/mock-orca.mjs`）和解析单测（`test/parse.test.mjs`）。
- 迭代修正：回答中去掉工具行和 TUI 装饰；Codex 审批菜单的问题行识别；工具只统计最新一轮；回合结束时补报漏掉的工具；新建会话遇到启动菜单（trust 提示等）时先排队、处理完再发真正的提示词。

### 阶段 E — 本机安装
- 通过 Desktop 桥把代码分块传到 `~/develop/even-mux`（中途连接断开一次，按字节数核对后续传，未重复写入），sha256 校验一致，`npm install -g .`。

### 阶段 F — 接入真实 Orca 后的修正（重要）
真实 Orca 与文档/mock 的差异，逐条修复：
1. **返回值多包一层**：`result.terminal` / `result.wait` / `result.send` → 统一 `unwrap()`。
2. **`tui-idle` 对空闲的 Codex 永远超时** → 改为以 `orca worktree ps` 的 hook 状态为主，`wait` + 读屏兜底。
3. **回复被屏幕高度截断** → 改用 `lastAssistantMessage`。
4. **主机显示为内部 ID**（`ssh-1790373539803-…`）→ 用 `orca host list` 映射成名字（`artekne`）。
5. **分支带 `refs/heads/`** → 去掉；worktree 优先用 Orca 的 `displayName`。
6. **标题无意义**（spinner 字符、`Pi ready`、`user@host:`）→ 清洗，回退到 agent prompt。
7. **新 prompt 后误把上一轮 `done` 当作本轮结果** → 发送前记录 hook 时间戳基线，时间戳变化才算本轮完成。
8. GUI/键盘里发起的回合也会被跟踪（事件顺序修正为先 `busy` 再工具）。

### 阶段 G — 端口与进程
- even-terminal 端口 3456 → **3457**（`even-terminal config port 3457`），3456 给 even-mux。
- even-mux 绑定到 Tailscale IP（与原 even-terminal 的 tailscale 模式一致），**额外监听 127.0.0.1**，否则本机 CLI/UI 无法访问。
- 三个进程放进 tmux 会话 `even`，日志 tee 到 `~/.even-mux/logs/`。
- 说明：手动再运行一次 `even-orca` 会报 `EADDRINUSE`——因为 tmux 里已经在跑，不是故障。

### 阶段 H — 二维码
- **原因**：`npm install -g <目录>` 只建符号链接、不装依赖，缺 `qrcode-terminal`，只打印了 URL。
- **修复**：二维码渲染按顺序尝试：`qrcode-terminal` → `qrencode` 命令 → 自动在包目录 `npm install` 后重试；新增 `even-mux qr`（不依赖服务运行）；每次启动写 `~/.even-mux/pair.txt`。

### 阶段 I — 眼镜列表被刷屏
- **现象**：列表里大量 `[mac] Review this change for security vulnerabilities…`，Orca 会话被挤掉。
- **原因**：本机 even-terminal 会列出 `~/.claude/projects` 里所有 Claude 会话，包括 `obsidian-knowledge-system` 里自动化安全审查产生的 `claude -p` 会话；App 只要 10 条，按时间合并后被占满。
- **修复**：后端级 `exclude`（标题正则）和 `max`（最多占位）。本机设为 `max: 3` 并排除该标题。

### 阶段 J — 可见性 UI / CLI
- 新增 `~/.even-mux/visibility.json`（手动显示/隐藏、置顶、主机开关），`/mux/sessions|visibility|backend|ui` 接口，`ui.html`，CLI `sessions/hide/show/pin/unpin/auto/host/ui`。
- Orca 后端 `allProviders: true`：App 按 `provider=claude` 请求时，Orca 里的 Codex/Pi 会话也能显示。
- 选择器对只按 provider 返回的后端（even-terminal）分别查询 claude 和 codex 并去重——否则本机只显示默认 provider（codex）的 2 条，无法隐藏 Claude 会话。
- UI 修正：开关用 `<label>` 包裹 checkbox，点击才生效；用 headless Chromium 验证桌面浅色 / 手机深色两种布局无横向滚动。

---

## 9. 测试

```bash
npm test                                   # 读屏解析单测（Claude / Codex 回答、审批菜单、工具行）
# 端到端（不需要真实 Orca）：
EVEN_ORCA_DIR=/tmp/eo MOCK_ORCA_STATE=/tmp/mock.json \
  node even-orca.mjs    # 配置里 orcaCommand 指向 test/mock-orca.mjs
node test/mock-backend.mjs 4001 t1 LOCAL   # 模拟一个 even-terminal 后端
```
`test/mock-orca.mjs` 模拟了真实 Orca 的返回包装、`worktree ps` hook 状态、`host list`、审批菜单、GUI 发起的回合。

已在真实环境验证：Orca 17 个 agent 终端的列表/状态/标题、even-terminal 0.10.5 全部接口透传、眼镜端会话列表经由 even-mux 返回。

---

## 10. 安全说明
- 所有 `token` 都在 `~/.even-*/config.json`（权限 600），**不入库**；`pair.txt` 同样 600。
- even-mux 对外只监听 Tailscale 地址，需 token；`/mux/*`（含 UI）**只接受 127.0.0.1**，不需要 token，所以不要把 even-mux 放在会被他人登录的共享机器上。
- even-orca 只监听 127.0.0.1。
- 眼镜上的审批是把选项数字原样发给 agent，等同于你在终端里按键；“don't ask again” 类选项请谨慎。

---

## 11. 已知限制 / 待办
- **尚未在真实会话上做过发送测试**（避免打扰正在工作的 agent）；首次从眼镜发送时留意 `~/.even-mux/logs/even-orca.log`。
- **SSH 隧道后端未在真实环境验证**（开发沙箱无 ssh）；Orca 已覆盖远程主机，目前实际部署没有用到 SSH 后端。
- 会话列表延迟约 1–4.5 秒（even-orca 每次要调多次 Orca CLI），可加缓存。
- 端口被占用时进程直接抛 `EADDRINUSE` 退出，提示不友好。
- Pi 会话在 App 里标为 `claude` provider（App 只认 claude/codex）。
- 没有开机自启（LaunchAgent）；Mac 重启后需要重新执行第 4 节的 tmux 命令。
- 置顶/隐藏按 session ID 记录；Orca 里关闭再重建的终端会得到新 ID。

---

## 12. 文件清单
| 文件 | 说明 |
|---|---|
| `even-mux.mjs` | 多路代理 + 可见性 + CLI |
| `even-orca.mjs` | Orca CLI 适配器 |
| `ui.html` | 可见性 Web UI（由 even-mux 在 `/mux/ui` 提供） |
| `package.json` | bin：`even-mux`、`even-orca`；依赖 `qrcode-terminal` |
| `test/parse.test.mjs` | 读屏解析单测 |
| `test/mock-orca.mjs` | 有状态的 Orca CLI 模拟 |
| `test/mock-backend.mjs` | even-terminal 后端模拟 |
| `docs/DESIGN_AND_CHANGELOG.md` | 本文档 |
| `README.md` | 快速上手 |
