# dsh-agent-browser-auto 0.8.0 设计任务书：扩展桥接后端（Extension Bridge）

> 目的：让 agent 通过装在**用户日常浏览器**（Edge/Chrome 默认 profile）里的 MV3 扩展操作浏览器——
> 不开 CDP 调试端口、不碰 --remote-debugging、没有授权弹窗、连接常驻不断线。
> 这是用户第一轮需求的最终形态："直接连接到用户的本地浏览器，和人用浏览器一样"。

## 背景（2026-11-18 会话实证）

- 用户日常 Edge 是默认 profile：Chrome/Edge 136+ 禁止默认 profile 用 --remote-debugging-port；
  唯一的 CDP 路径是 edge://inspect/#remote-debugging 开关模式 → 每次连接弹授权框（用户极反感）→
  被拒一次即 403 卡死 → 实测当天多次连接失败/超时/403。
- 0.7.0 已交付：browser_agent_ensure（专用实例 9333 保障）、browser_tab_front（标签 list/activate）、
  systemPrompt 注入。本任务书是第三块拼图。

## 架构

```
用户日常 Edge（默认 profile）
  └─ MV3 扩展（extension/）
       ├─ background service worker：WS 客户端 → Host
       ├─ WS 心跳保活（每 20s ping；Chrome 116+ 起 WS 活动重置 SW 30s 休眠计时器）
       ├─ offscreen document 兜底（SW 被杀时由 offscreen 持有 WS，消息经 chrome.runtime 转交）
       └─ 能力层：chrome.tabs（list/activate/create/close）+ chrome.scripting.executeScript（结构化快照/合成输入）
  ── ws://127.0.0.1:<extPort>?token=<pairToken> ──▶
Host（index.js + lib/extension-bridge.js）
  ├─ loopback-only WebSocket 服务（默认端口 9335，配置 extensionBridge.port）
  ├─ token 认证：browser_ext_pair 工具生成一次性配对码；扩展首次连接凭码换取长效 token（存 chrome.storage.local）
  └─ 命令路由：复用现有 PROTOCOL.md 命令集，新增 source:"extension" 的会话绑定
```

## Host 侧改动

1. `lib/extension-bridge.js`（新增）：WS 服务生命周期（启停/端口占用退避）、token 校验、
   扩展会话注册（clientId=扩展安装 id）、命令下发与结果回传（复用 lib/backend.js 的路由表结构）。
2. `lib/config.js`：`extensionBridge: { enabled:false, port:9335, pairTimeoutMs:300000 }`（默认关，显式开启）。
3. `lib/tools.js` 新工具：
   - `browser_ext_pair`：生成配对码并返回「扩展安装指引」文本（加载已解压扩展 → 点扩展图标 → 输码）。
     无参数。enabled=false 时返回 DEDICATED_DISABLED 风格的明确错误。
   - `browser_ext_status`：返回 { paired, connected, clientId, lastHeartbeatMs }。
4. 路由规则：显式 real（launch/connect）> extension > embedded（内嵌保持现状，绝不自动切换）。
   扩展在线且用户未显式选后端时，browser_open 等命令**不**自动路由（保持 0.7.0 的"绝不自动切换"原则）；
   由 agent 显式 `browser_backend {action:"extension"}` 进入。
5. `index.js`：systemPrompt 文案追加一行（仅 extensionBridge.enabled 时）：扩展桥接可用时的进入方式。

## 扩展侧（extension/ 目录，随包分发，files 字段加入 package.json）

- `manifest.json`（MV3）：permissions: tabs / scripting / storage / offscreen；host_permissions: <all_urls>
  （executeScript 需要向用户已打开的任意页面注入；在 README 明示权限用途）。
- `background.js`：WS 连接状态机（connecting/online/backoff）、心跳、命令分发、
  `chrome.scripting.executeScript` 执行 Host 下发的快照/点击/输入函数体。
- `offscreen.html/js`：WS 持有兜底（chrome.offscreen 文档型原因 KEEP_ALIVE）。
- 快照逻辑：与 Client（client.js）现有的结构化提取保持同一输出契约（@ref/角色/名字/坐标），
  从 client.js 抽取公共函数到共享文件，避免两份实现漂移（PROTOCOL.md 是契约源）。

## 工具行为（agent 视角）

- `browser_backend {action:"extension"}`：扩展在线 → 切换成功；离线 → EXTENSION_OFFLINE（附 browser_ext_pair 提示）。
- `browser_open/snapshot/click/type/...`：与真实后端同一套参数与返回（快照格式复用）。
- `browser_tab_front`：扩展模式下同样可用（chrome.tabs API 实现，语义一致）。

## 测试

- Host：WS 服务启停、token 认证（对/错/过期）、命令回传、lossless JSON、配置默认与覆盖 → node --test。
- 扩展端 js：node --check 语法；协议一致性用共享契约测试（同一命令表断言）。
- 真机验收（lead 执行）：装进日常 Edge → 配对 → browser_open 在日常 Edge 真实打开页面 →
  SW 休眠 5 分钟后发命令自动唤醒成功 → 断网重连 → 内嵌/real 后端回归不受影响。

## 明确不做

- 不做无头隐藏操作：扩展模式只在用户可见的真实标签页产生状态。
- 不自动装扩展（用户手动 load-unpacked，README 给步骤）。
- 不改变现有三种后端（embedded/real/extension）的隔离边界与凭证约定。

---

## 实施记录（0.8.0 交付，2026-11-18）

全部按任务书落地，实现层面有以下**决策与偏差**（均已写进 PROTOCOL §8 / README，供评审）：

### 工具暴露截断的处理（任务书已知坑）

- `BROWSER_TOOL_NAMES` 默认（`extensionBridge.enabled=false`，即存量用户默认态）把
  `browser_ext_pair`/`browser_ext_status` 排在**尾部**（23/24），对现有 16 窗口零影响。
- `enabled=true` 时 `lib/tools.js` 的 `toolOrder(config)` 把这两个工具**换进第 15/16 位**，
  `browser_find`/`browser_deep_snapshot` 顺延到 17/18（出窗口，不注册进 agent 工具表，但内嵌/真实
  后端仍可路由）。理由：配对必须靠这俩工具完成，不进窗口则功能不可用；牺牲的 find 可用
  `browser_snapshot scope:document` 部分替代，deep_snapshot 本就需要调试端口重启、日常不可用。
- `buildBrowserTools` 现在按 `toolOrder()` 统一输出（名字表与定义表一一对应，数量不符直接抛），
  杜绝「数组顺序」与「注册顺序」两套真相——此前 specs 数组字面量顺序与 BROWSER_TOOL_NAMES 并不一致，
  注册顺序才是宿主截断的实际依据，这次顺带修掉了这个隐患。

### 协议决策

- **WS 服务**：`ws@8.23.0`（锁定精确版本，与 playwright-core 同风格），HTTP upgrade 阶段认证，
  无效/过期 token 直接 401 不升级；非 upgrade 请求回 426；只绑 `127.0.0.1`；`port:0` 允许（内核随机
  端口，测试用；`browser_ext_pair` 返回实际绑定端口）。端口被占退避重试 3 次（间隔 2s）后如实报错，
  状态 `listening:false + portError`，插件不崩。
- **认证**：一次性配对码（8 位无歧义字符，单次使用，`pairTimeoutMs` 默认 300s）→ 长效 token
  （32 字节 base64url）。Host 只存 SHA-256（`<auditDir>/extension-paired.json`），原文不落盘、
  不进日志。`ready` 消息不携带 clientId——**clientId 归扩展所有**（hello 权威），Host 生成的占位 id
  仅在配对记录里兜底，hello 到达后回写为权威值。
- **消息集**：`ready/hello/helloAck/sessionReady/ping/pong/command/result/log/superseded`。
  同 clientId 重连顶掉旧连接（4001 superseded），断网/offscreen 接管自愈；多浏览器在线时发给
  最近心跳的那个；~45s 无消息判定掉线。
- **截图**：扩展 `captureVisibleTab` → result 带 `pngBase64` → Host `audit.saveShot` 落盘并摘除字段
  （扩展无法带 cookie 访问 Host HTTP，§1 的 /shot 端点不适用）。要求 agent 标签在前台，否则
  `SCREENSHOT_NEEDS_FRONT`。`fullPage` 不支持（结果 note 说明）。

### 扩展侧生命周期（任务书「心跳保活 + offscreen 兜底」的落地）

- 主路径：SW 持有 WS + 每 20s 应用层 ping（Chrome/Edge 116+ WS 活动重置 30s 休眠计时器，
  `minimum_chrome_version=116`），重连退避 1s→30s + `chrome.alarms` 兜底。
- offscreen 兜底：`KEEP_ALIVE` 文档每 15s 探活 SW（runtime 消息本身也保活 SW）——探测连续失败
  （SW 被杀且唤不醒的边缘情况）时以同一 token/clientId **接管** WS，命令经 `chrome.runtime` 转交并
  唤醒 SW；SW 探活连续 3 次成功后**交还**所有权。所有权记 `chrome.storage.session.bridgeOwner`。
  Host 侧顶掉旧连接的语义使接管/交还的瞬态双连接自愈。
- **快照契约单一来源**：pageAgent 整体从 client.js 抽到 `extension/page-agent.js`（canonical，
  ES module export），client.js 持有逐字节副本，两侧以 `[PAGE_AGENT_BEGIN/END]` 标记包裹，
  `test/page-agent-contract.test.mjs` 强制一致（并断言自包含性、扩展页面 op ⊆ 共享 switch、
  扩展命令表与内嵌 dispatch 对称、manifest 权限、offscreen 三段齐全）。扩展注入用
  `chrome.scripting.executeScript({world:'MAIN', func: pageAgent})`。
- `history` back/forward 用一次性内联 func（不值得为它改两份 pageAgent 契约）。

### Host 侧集成

- `backend.js` 路由：显式 `action:"extension"` 成功才切模式；离线回 `EXTENSION_OFFLINE`（附
  `browser_ext_pair` 提示）、未启用回 `EXTENSION_DISABLED`；`status` 在启用时必带 `extension` 对象
  （lossless）。`knownUrl` 按 mode 分流。`browser_tab_front` 支持 extension 模式（离线回
  `EXTENSION_OFFLINE`）。`index.js` 仅在 enabled 时创建服务（`ctx.effect` 挂 dispose）。
- systemPrompt：新增 `loadExtensionPrompt`（locale `systemPrompt.extensionBridge`，section
  `agent-browser-auto:extension-bridge`，order 871）；与专用浏览器约定共用同一注入框架。
- 配置：`extensionBridge {enabled:false, port:9335, pairTimeoutMs:300000}`（默认关，显式开启；
  校验拒绝未知键/非法区间）。

### 验证状态

- 全量 `node --test --test-concurrency=1` **111/111 通过**（旧 86 保持 + 新 25：extension-bridge 12、
  共享契约 6、tools 5、backend 2），含真实 Chrome/Edge 操作链回归。
- `node --check` 全部通过（client.js / lib/*.js / index.js / extension/*.js）；extension 文件无 BOM；
  manifest JSON 合法；`pnpm pack --dry-run` 通过（含 `extension/*`）。

### 待 lead 真机验证（代码+单测+语法+pack 层面之外的）

1. 扩展装入用户日常 Edge（load unpacked）→ `browser_ext_pair` 配对 → `browser_backend {action:"extension"}`
   → `browser_open` 在日常 Edge 真实打开页面、快照/点击/输入全链路。
2. SW 休眠 ≥5 分钟后发命令自动唤醒（验证 20s 心跳保活在目标 Edge 版本上生效）。
3. 断网重连、浏览器重启后 token 免配对重连；杀 SW 后 offscreen 接管与交还（`bridgeOwner` 状态流转）。
4. 多浏览器（Edge+Chrome 都装扩展）时命令路由到最近心跳的实例。
5. systemPrompt 扩展约定在活体 Host 上的实际注入效果；enabled 切换后 16 窗口工具的实测暴露情况
   （验证截断假设仍为 ~16 且注册顺序生效）。
