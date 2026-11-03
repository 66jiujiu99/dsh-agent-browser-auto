# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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
