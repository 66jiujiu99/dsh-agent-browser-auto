# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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
