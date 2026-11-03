# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## 0.6.0 — 2026-11-03

### 新增

- **Playwright 双后端**：默认保留轻量 Electron `<webview>`；`browser_backend` 可显式启动可见 Chrome/Edge、
  连接 loopback CDP、切回内嵌或断开真实连接。工具总数由 19 增至 20。
- **按会话隔离的真实浏览器 profile**：持久与临时两种模式；不读取/复制日常浏览器凭证，
  已有浏览器页仅在 `pageUrl` 精确匹配时显式共享。
- **原生开发者体验**：真实窗口使用原生 F12；轻量侧边栏增加开发者工具入口与后端模式徽标。
- **真实后端完整操作链**：结构化快照、定位引用、点击/输入/按键/滚动、条件等待、标签、导航、
  选择、上传、对话框、控制台、网络、截图与受限 eval 复用现有 `browser_*` 工具契约。

### 安全与可靠性

- 启动/连接成功后才切换后端；任何真实浏览器错误都不会自动回退到轻量页面。
- `launch` 与 `connect` 是显式操作，不伪装 UA、不隐藏自动化、不承诺绕过网站风控。
- 配置新增 `realBrowser.browser/profileDir/startupTimeoutMs`；`playwright-core` 锁定版本且不下载浏览器。

### 验证与已知限制

- 全量自动化 **68 / 68 通过**；Edge 真实后端最终复测 **3 / 3 通过**，发布包 dry-run 检查通过。
- DSH 0.2.1-rc.5 desktop 实测真实 Chrome 的启动、状态、导航、选择、上传、prompt、等待与截图。
- rc.5 打包版主进程固定禁用 guest `devTools`，内嵌入口会明确显示 `DEVTOOLS_UNAVAILABLE`；可靠 DevTools 请使用真实浏览器原生 F12。

## 0.5.0 — 2026-11-03

### 新增

- **P2 侧边栏**：常驻可编辑地址栏（Enter 导航/无页时打开、Escape 还原）、后退/前进/刷新，
  以及新建、切换、独立关闭标签。
- **真实页面状态与同步**：展示真实 loading/failure 并支持重试；真人点击页面后，
  通过事件驱动同步地址栏 URL 与标签标题。

### 修复

- **`browser_tabs` 空态输出 schema**：没有标签时合法返回 `tabs:[]`、`activeId:null`。

### 验证

- 工具总数仍为 19；单元测试 **59 / 59 通过**（snapshot 20 · tools 17 · cdp 22）。
  此处仅记录单元测试结果，不表示 59 项真实网页 E2E 已通过。
- 真实 Electron webview 复测通过：原生/自定义下拉、单文件上传、三种对话框预置响应、
  刷新/后退/前进、加载失败后的恢复导航，以及失效 `@ref` 自动补现场快照。

## 0.4.0 — 2026-11-03

### 新增

- **`browser_select`**：按 `value` / `label` / 零基 `index` 三选一选择下拉项，支持原生 `<select>`
  与常见 `role=option/menuitem` 自定义下拉，返回 `selected` 与视口快照。
- **`browser_upload`**：向 `input[type=file]` 上传 1–5 个绝对本地路径，合计不超过 8MiB；
  结果只含文件名与大小，不回传路径或 base64；文件内容/实际路径不进入审计，`paths` 仅记为数组占位。
- **`browser_dialog`**：在触发动作前为下一次 `alert/confirm/prompt` 预置一次性 `accept/dismiss`
  响应；不能关闭已弹出的同步阻塞对话框，不支持 `beforeunload`，不附快照。

### 验证

- 工具总数由 16 增至 19；单元测试 **58 / 58 通过**（snapshot 20 · tools 16 · cdp 22）。
  此处仅记录单元测试结果，不声明新增工具已通过真实网页 E2E。

## 0.3.0 — 2026-11-03

### 新增

- **`browser_wait` 条件等待**：等待可见正文、主文档 CSS selector 或 URL 子串；text/selector 支持
  `state:"hidden"`，默认 10 秒、最长 120 秒，命中后直接回当前视口结构。
- **失败现场快照**：`NO_REF` 与 `WAIT_TIMEOUT` 默认自动补拍当前视口，错误与可恢复操作一次返回；
  显式 `snapshot:false` 时仍尊重省 token 选择。

### 改进

- **动作后智能稳定等待**：点击、输入、按键、滚动与导航不再只依赖固定 sleep；页面 loading 或
  DOM mutations 变化会重置安静窗口，连续约 300ms 稳定即返回，总上限 5 秒。慢渲染页面少拿到旧结构，
  持续动画也不会让动作失败。
- **空视口不再丢失屏外提示**：当可见元素恰好为零、但 Client 报告还有屏外元素时，保留
  `scope=viewport` 与「另有 N 个元素在视口外」，不再误降级成空白的 `document-fallback`。

## 0.2.0 — 2026-11-03

### 变更

- **动作后默认回全量视口结构**：`click / type / press / scroll / nav` 执行完直接返回完整的
  视口交互元素快照（与 `browser_open` 一致），模型一步看到「现在页面上有什么」，
  不必再补一次 `browser_snapshot`。
- **`[delta]` 增量降级为显式参数**：上述工具新增 `delta:true` 才走同 URL 增量渲染
  （只报 added/removed/changed，省 token）；默认 `false`。
  动机：增量只告诉模型「变了什么」，不告诉「现在有什么」——连续操作时模型脑内全貌
  靠叠加 delta，容易漂；且 `removed` 只给 ref、滚动场景增量反而更长。
  典型量级：全量视口 ≈300–1200 tokens，增量 ≈50–150，省下的抵不过一次补调 snapshot 的往返。

## 0.1.0 — 2026-10-23

首个可用版本，对齐 DSH 桌面版 0.2.1-rc.2（Electron 44.7.0）。

### 新增

- **15 个 `browser_*` 工具**：`open` / `snapshot` / `click` / `type` / `press` / `scroll` / `nav` /
  `find` / `deep_snapshot` / `screenshot` / `tabs` / `console` / `network` / `eval` / `close`。
- **用户可见的浏览器**：插件自己向主进程申请 webview lease，在右侧边栏开一个 `agent-browser` tab，
  模型点哪儿用户看得见；关掉 tab 即释放 guest。
- **省 token 的快照**：默认不发正文（`text:false`）、只列视口内元素（`scope:viewport`），
  每次带 `stats:{elements,chars,estTokens,scope}`；同一 URL 的动作走 `[delta]` 增量。
  实测 GitHub 首页：普通快照 ≈175 tokens，滚动增量 ≈16 tokens（改造前 ≈2300–2800）。
- **`browser_find`**：按名字/文字全文档定位（含 open shadow root 与同源 iframe，视口外也算），
  命中无 ref 的纯 JS 元素时返回坐标，改用 `browser_click x/y` 点击。
- **CDP 深度模式 `browser_deep_snapshot`**（可选，默认关闭）：走本机调试端口读无障碍树，
  能读到 **closed shadow root**、**`aria-label` 原生语义名**、**跨源 iframe**（含顶层视口坐标）。
  只发只读命令（Accessibility / DOM / Page / Target），不通过 CDP 点击或输入。
- **启动器 `tools/start-dsh-debug.cmd`**：随机调试端口 + `--remote-allow-origins` 限制 +
  读端口文件后主动 HTTP 探活，失败给出可执行的原因。
- **`tools/unblock-folder.cmd`**：一键清除 Windows 下载标记（Mark of the Web），
  解决「双击 .cmd 每次弹无法验证发布者」。

### 已知边界

- 仅桌面版可用（依赖 `dshDesktop` webview lease）。
- 深度模式读不到 canvas 像素与图片里的文字——这类要用 `browser_screenshot`。
- 调试端口无认证，仅绑 loopback；开启期间本机任意进程都能控制该 DSH 实例。
