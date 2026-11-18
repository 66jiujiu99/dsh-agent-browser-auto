# agent-browser-auto 插件内部协议（Host ⇄ Client / Host ⇄ 扩展）

本文件是 Host 半边（`index.js`）与 Client 半边（`client.js`）、扩展半边（`extension/`）之间的**唯一契约**。
两边都按本文件实现，不允许各自发明字段。0.6.0 起 Host 在工具前增加按 session 的后端路由：
默认仍走本文 Host ⇄ Client 协议；显式 `browser_backend launch/connect` 成功后，普通 `browser_*` op 改由
`lib/real-driver.js` 的 Playwright 后端执行，op/args/value 的工具契约保持一致；0.8.0 起显式
`browser_backend {action:"extension"}` 后同一套 op 改由 `lib/extension-bridge.js` 经扩展下发（§8）。
真实后端失败绝不自动回退到 Client；扩展离线也绝不自动回退——切换永远是显式的。

## 0.1 后端控制与专用实例（Host 直执行，不进 Client 队列）

`browser_backend` 支持：
- `status`：返回 `{backend,previousBackend,real?,extension?,message}`；`backend` 为 `embedded|real|extension`。
  `extensionBridge.enabled` 时必带 `extension`（`lib/extension-bridge.js` 的 `status()`，lossless）；未启用时不带该键。
- `launch`：可见系统 Chrome/Edge + 当前 session 专用持久 profile；`temporary:true` 使用临时 profile。
- `connect`：显式 loopback CDP `endpoint`；已有页只有提供精确 `pageUrl` 才共享，否则仅控制 Agent 新建页。
- `extension`（0.8.0）：切入扩展桥接后端（§8）。扩展离线回 `EXTENSION_OFFLINE`（附 `browser_ext_pair` 提示）；
  `extensionBridge.enabled=false` 回 `EXTENSION_DISABLED`。
- `embedded`：只切换路由，保留真实浏览器连接和页面。
- `disconnect`：释放真实后端并切回 embedded；`closeBrowser:true` 同时关闭本 session 启动的浏览器。

`browser_agent_ensure`（0.7.0，Host 直执行）：保障「专用浏览器实例」进程活着。TCP 探测
`127.0.0.1:<dedicatedBrowser.port>`（默认 9333）→ 已监听回 `{ok:true,ensured:true,spawned:false,port,endpoint}`；
未监听按配置拉起（参数数组 + `shell:false`，Windows `detached:true`+`unref`）并轮询端口（200ms 间隔，
`spawnTimeoutMs` 默认 15000）→ 成功回 `{ok:true,ensured:true,spawned:true,port,endpoint,pid}`。
**不做 CDP 连接**（连接仍由 `browser_backend connect` 完成）；`port`/`userDataDir` 只认配置，
工具不接受参数覆盖；失败回 `DEDICATED_DISABLED` / `EXECUTABLE_NOT_FOUND` / `SPAWN_FAILED` / `PORT_TIMEOUT`。

`browser_tab_front`（0.7.0，Host 直执行，真实/扩展后端）：`list` 列出已连接实例全部标签
`{tabs:[{index,pageId,url,title,active}],activeId,count}`；`activate`（`index`/`urlMatch` 二选一）
`bringToFront` 并**重绑会话活动页**，回 `{activated:true,pageId,url,title,index}`。
扩展模式下语义一致（chrome.tabs 实现，`pageId` 是 tabId 的字符串形式，activate 同时聚焦窗口并重绑 agent 标签）。
轻量内嵌回 `NOT_SUPPORTED`；真实后端未连接回 `REAL_BACKEND_REQUIRED`；扩展离线回 `EXTENSION_OFFLINE`。

`browser_ext_pair` / `browser_ext_status`（0.8.0，Host 直执行）：见 §8.5。
后端状态按 session 隔离；Cookie/localStorage 不在两端复制或同步。真实模式不伪装 UA、不隐藏自动化、不承诺规避网站风控。

## 0.2 运行环境事实（已取证，不要重新假设）

- 桌面版主窗口 `webviewTag: true`，主窗口主 frame 可 `document.createElement('webview')`。
- preload 暴露 `globalThis.dshDesktop = { protocolVersion: 1, browser: { acquire(workspaceKey), release(lease), onOpenRequested(lease, cb) } }`。
  `acquire` 返回 `{ lease, partition }`；一个 lease 只能 attach 一个 webview；`release` 销毁 guest。
- 主进程强制 guest：`nodeIntegration:false, contextIsolation:true, sandbox:true, plugins:false, disableDialogs:true`，
  下载全部 `preventDefault`，权限询问全部拒绝，弹窗全部 deny（会通过 `onOpenRequested` 通知宿主）。
- 导航只允许 `http:` / `https:`、无内嵌凭据、且不能是 DSH 自身 origin（同端口 + localhost/127.0.0.1/[::1]）。
  违反的导航会被主进程吞掉（不会报错给页面），所以 **Host 侧必须提前拒绝并把原因说清楚**。
- 渲染进程加载的是 `dsh-app://app`。非静态资源路径由主进程 `forwardWebRequest` 转发到 Host，
  并注入主进程持有的 cookie（Host/Origin 头被剥掉）。因此 **Client 直接 `fetch('/agent-browser-auto/…')` 就能到达 Host 路由**。
- Web（非桌面）客户端没有 `dshDesktop`；此时本插件的 tab 只显示「仅桌面版可用」。

## 1. HTTP 端点（Host 注册在 `ctx.webServer`，前缀 `/agent-browser-auto`）

统一 JSON。鉴权：每个请求都调用 `ctx.connection.requestRejection({ headers: req.headers })`，
返回 401/403 就原样回该状态码并结束请求。`connection` 用 `ctx.get('connection')` 取，取不到时**拒绝**
（fail-closed），不要放行。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/agent-browser-auto/hello` | 客户端注册/心跳 |
| GET | `/agent-browser-auto/poll?clientId=…&sessionId=…&wait=20000` | 长轮询取命令 |
| POST | `/agent-browser-auto/result` | 回传命令结果 |
| POST | `/agent-browser-auto/log` | 客户端日志（冒烟/排障用） |
| POST | `/agent-browser-auto/bye` | 客户端注销 |

响应体一律 `{"ok":true, …}` 或 `{"ok":false,"error":{"code","message"}}`；长轮询无命令时回 **204**（无 body）。

### 1.1 hello
请求：`{"clientId":"c-<uuid>","sessionId":"<sessionId|null>","desktop":true}`
响应：`{"ok":true,"version":1,"config":{"enableEval":false,"maxSnapshotBytes":8192},"backend":{"ok":true,"backend":"embedded","previousBackend":"embedded","real":{"connected":false}}}`
`backend` 由 Host 按 session 注入，Client 只用于模式徽标，不据此自行切换。Host 记录 client 的 `sessionId`（每次 hello 覆盖）。Client **每 10s** 发一次 hello 保活。

### 1.2 poll
Client 循环调用；Host 挂起最多 `wait` 毫秒。
- 有命令：`200 {"command":{"id":"cmd-7","op":"open","args":{…}}}`
- 超时无命令：`204`
Client 收到命令或 204 后**立刻**再发起下一次 poll（间隔 0，出错时退避 500ms→5s）。
`sessionId` 必须是该 Client 当前屏幕上的会话；Host 只把该会话的命令投递给它。

### 1.3 result
请求：`{"id":"cmd-7","ok":true,"value":{…}}` 或 `{"id":"cmd-7","ok":false,"error":{"code":"…","message":"…"}}`
响应：`{"ok":true}`（id 未知时也回 ok:true，Host 只记日志）

### 1.4 log
请求：`{"level":"debug|info|warn|error","message":"…","data":{…}?}` → `{"ok":true}`
Client 用它上报：webview 创建/销毁、dom-ready、did-fail-load、异常栈（`data.error`=String(err)）。
**Client 侧任何 catch 都必须走 log**，否则 Host 侧无从排障。

### 1.5 bye
请求：`{"clientId":"…"}` → `{"ok":true}`

## 2. 命令（op）与返回值（value）

命令对象：`{ id, op, args }`。`args` 由 Host 侧工具入参整理而成，Client 不信任其形状，必须自己兜底。

公共概念：
- **pageId**：Client 内每个 webview 页面的稳定 id，`p1`、`p2`…；一个会话（tab）内可有多页，`activePageId` 为当前页。
- **ref**：页面内可交互元素的引用，形如 `@e12`，由页面脚本维护（WeakMap，元素不变则 ref 不变）。

### 2.1 快照对象（snapshot）
```json
{
  "pageId": "p1",
  "url": "https://example.com/",
  "title": "Example Domain",
  "scope": "viewport",
  "offscreen": 7,
  "scroll": { "y": 0, "height": 1200, "viewport": 800 },
  "text": "可见正文，按块用 \\n 连接，已折叠空白",
  "elements": [
    {"ref":"@e1","role":"link","name":"More information...","href":"https://…","inViewport":true},
    {"ref":"@e2","role":"textbox","name":"搜索","value":"","inViewport":true},
    {"ref":"@e3","role":"button","name":"提交","disabled":false,"inViewport":true},
    {"ref":"@e4","role":"checkbox","name":"记住我","checked":true,"inViewport":true}
  ],
  "stats": { "elements": 4, "chars": 220, "estTokens": 60, "scope": "viewport" },
  "truncated": {"text": false, "elements": false}
}
```
约束：
- `text`：默认**不回送**（最省 token）。Host 显式传 `text:true` 才回；`text:false`/缺省时字段为**空字符串**（保持输出 schema 是单一 string 类型），模型不得假设里面有正文。
- `scope`：`viewport`（默认，只列视口内元素）或 `document`（列全部）。Host 传 `scope` 决定；Client 无几何信息（`inViewport` 缺失）时按 `document` 渲染并在 `stats.scope` 标 `document-fallback`。
- `offscreen`：视口外元素计数（viewport 模式下由 Host 汇总，末尾用一行 `另有 N 个元素在视口外…` 提示，不逐个列出）。
- `inViewport`：每个元素的布尔几何标记（视口优先过滤与降级判断的依据），由页面脚本算。
- `elements` 默认上限 150 个（`maxElements`），`text` 上限由 `textLimit`（默认 3000）控制；找不到可交互元素时 `elements: []`。
- `role` 取值：`link|button|textbox|searchbox|checkbox|radio|combobox|option|textarea|menuitem|tab|slider|switch|heading|other`。
- `stats`：每个快照结果都带 `{elements, chars, estTokens, scope}`，用于成本对比（chars 为 UTF-8 字节数，estTokens 为粗估：CJK 1、其余 /4）。

### 2.2 各 op

| op | args | value |
|---|---|---|
| `open` | `{url, newTab?:boolean, waitMs?:number, scope?:("viewport"\|"document")}` | `{pageId, url, title, snapshot}` |
| `snapshot` | `{maxElements?:number, text?:boolean, textLimit?:number, scope?:("viewport"\|"document")}` | `{snapshot}` |
| `wait` | `{text\|selector\|url, state?:("visible"\|"hidden"), timeoutMs?:number, snapshot?:boolean, scope?:"viewport"}` | `{action:"wait", condition, waitedMs, url, title, snapshot?}` |
| `click` | `{ref?} \| {x?,y?}, snapshot?:boolean, scope?:("viewport"\|"document")}` | `{action:"click", changed:boolean, snapshot?}` |
| `type` | `{ref, text, clear?:boolean, submit?:boolean, snapshot?:boolean, scope?:("viewport"\|"document")}` | `{action:"type", changed:boolean, snapshot?}` |
| `select` | `{ref, value?\|label?\|index?, snapshot?:boolean, delta?:boolean}` | `{action:"select", selected, snapshot?}` |
| `upload` | `{ref, paths:string[1..5], snapshot?:boolean, delta?:boolean}` | `{action:"upload", files:[{name,size}], snapshot?}` |
| `dialog` | `{action:"accept"\|"dismiss", promptText?:string}` | 预置一次性响应；不附 `snapshot` |
| `press` | `{key, snapshot?:boolean, scope?:("viewport"\|"document")}` | `{action:"press", changed:boolean, snapshot?}` |
| `scroll` | `{dy, dx?:number, snapshot?:boolean, scope?:("viewport"\|"document")}` | `{action:"scroll", scroll:{y,height,viewport}, snapshot?}` |
| `nav` | `{action:"back"\|"forward"\|"reload"\|"goto", url?, snapshot?:boolean, scope?:("viewport"\|"document")}` | `{action, url, title, snapshot?}` |
| `find` | `{text:string, limit?:number}` | `{query, matches:[{ref?,role,name,inViewport,x?,y?,fallback?}]}`（全文档含 shadow/同源 iframe；无语义元素命中时回 `fallback:true` + 中心坐标 x/y） |
| `screenshot` | `{fullPage?:boolean}` | `{path, bytes, width, height, pageId, url}` |
| `tabs` | `{action:"list"\|"new"\|"switch"\|"close", id?}` | `{tabs:[{id,url,title,active}], activeId}` |
| `console` | `{limit?:number}` | `{entries:[{level,text,url?,line?}]}` |
| `network` | `{limit?:number}` | `{entries:[{url,method?,status?,ok,failure?}]}` |
| `eval` | `{code}` | `{value}`（`enableEval=false` 时 Host 直接拒绝，不下发） |
| `close` | `{}` | `{closed:true}` |
| `ping` | `{}` | `{pong:true, pageCount:number}` |

补充约定：
- `tabs` 空态合法：没有标签时返回 `tabs:[]`、`activeId:null`。
- `snapshot` 默认 `true`（除非显式 `false`），即动作/等待后回一张新快照；`dialog` 不附快照。
- `select` 的 `value / label / index` 必须恰好一个，`index` 为零基；支持原生 `<select>` 及常见
  `role=option/menuitem` 自定义下拉，返回 `selected` 与视口快照。
- 动作后 `settle` 最长等待约 5 秒：页面 loading 或 DOM mutations 持续变化时重置安静计时，连续约 300ms 稳定即提前返回；持续动画到上限也正常回快照，不让动作失败。
- `wait` 的 `text / selector / url` 必须恰好一个；`text` 匹配可见正文，`selector` 匹配主文档 CSS，`url` 匹配 URL 子串。`state:hidden` 仅用于 text/selector 的消失或隐藏；`timeoutMs` 默认 10000。
- `changed`：动作是否让页面发生了变化（URL 变化、DOM 变更计数增加、或 input 值变化）。
- `click` 的坐标路径：`{x,y}` 是 webview **视口内**坐标（左上为原点）。
- `screenshot` 的 `path` 是 Host 可读的**绝对路径**：Client 通过 `POST /agent-browser-auto/shot` 上传 PNG 二进制，
  Host 落盘到 `<auditDir>/shots/<ts>.png` 并把路径回给工具。**这一条是本协议唯一的多余端点**：
  `POST /agent-browser-auto/shot?pageId=…&url=…`，body 为 `image/png` 原始字节，响应 `{ok:true, path, bytes}`。

### 2.3 错误码（Client → Host，写在 result.error.code）
`NO_PAGE`（没有页面）、`NO_REF`（ref 不存在/已失效）、`NAV_BLOCKED`（URL 不合法或被策略拒绝）、
`TIMEOUT`（页面在 waitMs 内未加载完）、`WAIT_TIMEOUT`（条件等待超时）、`INVALID_SELECTOR`（CSS 选择器无效）、
`LOAD_FAILED`（did-fail-load）、`OPTION_NOT_FOUND`、`NOT_SELECT`、`FILE_READ_FAILED`、`UPLOAD_TOO_LARGE`、
`NOT_FILE_INPUT`、`UPLOAD_FAILED`、`EVAL_DISABLED`、`NOT_DESKTOP`（web 客户端）、
`INTERNAL`（其它，必须带 message 与 data.error）。新增工具错误码的触发条件见 §5.1。

## 3. Host 侧工具（模型看到的）

| 工具 | 参数 | 说明 |
|---|---|---|
| `browser_agent_ensure` | —（无参数） | Host 直执行；保障专用实例在跑（探活/拉起/轮询端口），不做 CDP 连接 |
| `browser_backend` | `action:"status|launch|connect|extension|embedded|disconnect"`, `browser?`, `temporary?`, `endpoint?`, `pageUrl?`, `closeBrowser?` | Host 直执行；按 session 查询/切换后端，不进入 Client 队列 |
| `browser_open` | `url`, `newTab?`, `waitMs?`, `scope?` | 打开并回快照 |
| `browser_snapshot` | `maxElements?`, `text?`, `textLimit?`, `scope?` | 回快照（`text` 默认 false，最省 token） |
| `browser_wait` | `text`/`selector`/`url` 其一, `state?`, `timeoutMs?`, `snapshot?` | 条件等待并回现场视口 |
| `browser_click` | `ref?` 或 `x`+`y`, `snapshot?` | 点击 |
| `browser_type` | `ref`, `text`, `clear?`, `submit?`, `snapshot?` | 输入 |
| `browser_select` | `ref`, `value`/`label`/`index` 其一, `snapshot?`, `delta?` | 选择下拉项并回 `selected` 与视口快照 |
| `browser_upload` | `ref`, `paths`, `snapshot?`, `delta?` | 上传 1–5 个本地文件并回文件名/大小与视口快照 |
| `browser_dialog` | `action`(accept/dismiss), `promptText?` | 预置下一次对话框的一次性响应，不附快照 |
| `browser_press` | `key`, `snapshot?` | 按键 |
| `browser_scroll` | `dy`, `dx?`, `snapshot?` | 滚动 |
| `browser_nav` | `action`(back/forward/reload/goto), `url?` | 导航 |
| `browser_find` | `text`, `limit?` | 全文档查找元素 |
| `browser_deep_snapshot` | `url?`, `maxNodes?`, `scope?`, `includeFrames?` | Host 直连 CDP，默认关闭 |
| `browser_screenshot` | `fullPage?` | 回 PNG 落盘路径 |
| `browser_tabs` | `action`(list/new/switch/close), `id?` | 多页管理 |
| `browser_tab_front` | `action`(list/activate), `index?`/`urlMatch?` | Host 直执行；真实/扩展后端全部标签的列出与前台切换（activate 同时重绑会话活动页） |
| `browser_console` | `limit?` | 控制台近况 |
| `browser_network` | `limit?` | 请求近况 |
| `browser_eval` | `code` | 默认关闭 |
| `browser_close` | — | 关闭页面 |
| `browser_ext_pair` | —（无参数） | Host 直执行；生成一次性配对码 + 扩展安装指引（§8.5） |
| `browser_ext_status` | —（无参数） | Host 直执行；扩展桥接在线状态（§8.5） |

> 暴露顺序注意（0.6.0 实测）：宿主对每插件工具暴露存在**约 16 个**的截断，`BROWSER_TOOL_NAMES`
> 顺序即暴露优先级。`extensionBridge.enabled=true` 时 `browser_ext_pair`/`browser_ext_status`
> 换进第 15/16 位（`browser_find`/`browser_deep_snapshot` 顺延出窗口）；`enabled=false` 时两者在尾部。
> 详见 `lib/tools.js` 的 `toolOrder()` 与 `docs/EXTENSION_BACKEND.md`。

所有工具返回**文本**（`output.render` 里拼），统一格式：

```
<title> · <url>
--- 页面文本 ---
…
--- 可交互元素 (N) ---
@e1 link "More information"
@e2 textbox "搜索"
```
- 总长超过 `maxResultBytes`（默认 12000 字节）时截断，并追加 `… (truncated; use browser_snapshot with maxElements/textLimit)`。
- 出错时**不要抛异常**：返回 `{ok:false, error:{code,message}}`，render 成
  `browser_open failed: NAV_BLOCKED — 只允许 http/https 且不能是 DSH 自身地址`。
- `NO_REF` / `WAIT_TIMEOUT` 且未显式 `snapshot:false` 时，Host 用最长 3 秒的恢复命令补一张视口快照，
  render 为「错误行 + 当前现场」；补拍失败不覆盖原始错误。其它错误不做二次调用。
- 没有 Client 连着目标会话时：`NO_CLIENT`，message 写清楚「请先在 PC 上打开该会话」。

## 4. 审计与日志（Host 写文件）

目录：`<config.auditDir>`，默认 `$HOME/.dsh/storages/agent-browser-auto`。

- `audit.jsonl`：每条工具调用一行
  `{"ts":"ISO","sessionId":"…","tool":"browser_open","op":"open","args":{…精简…},"urlBefore":"…","urlAfter":"…","ok":true,"error":null,"ms":812,"clientId":"…"}`
- `debug.jsonl`：路由命中、client 上下线、命令下发/超时、Client log 转发，一行一条。
  字段至少 `{"ts","kind","…}`。`config.debug=false` 时关闭。
- `shots/`：截图落盘。

写文件用 `node:fs/promises`，追加失败只打日志，**不**影响工具调用。

## 5. 错误码、数据边界与成本主线

### 5.1 新增工具错误码

- `select`：未找到匹配项回 `OPTION_NOT_FOUND`；目标不是受支持的原生/自定义下拉回 `NOT_SELECT`。
- `upload`：Host 读取失败回 `FILE_READ_FAILED`；总大小超过 8MiB 回 `UPLOAD_TOO_LARGE`；
  目标不是 `input[type=file]` 回 `NOT_FILE_INPUT`；Client 设置文件或触发事件失败回 `UPLOAD_FAILED`。
- `browser_agent_ensure`（0.7.0）：功能关闭回 `DEDICATED_DISABLED`；找不到浏览器可执行文件回
  `EXECUTABLE_NOT_FOUND`；进程启动失败回 `SPAWN_FAILED`；拉起后端口超时未监听回 `PORT_TIMEOUT`。
- `browser_tab_front`（0.7.0）：轻量内嵌后端回 `NOT_SUPPORTED`；真实后端未连接回
  `REAL_BACKEND_REQUIRED`；index 越界或 urlMatch 无命中回 `NO_PAGE`；urlMatch 命中多个回 `BAD_ARG`。
- `browser_ext_pair`（0.8.0）：`extensionBridge.enabled=false` 回 `EXTENSION_DISABLED`。
- `browser_backend` / `browser_tab_front` 扩展路径（0.8.0）：功能未启用回 `EXTENSION_DISABLED`；
  WS 服务未监听或无扩展在线回 `EXTENSION_OFFLINE`；命令下发后扩展无响应回 `TIMEOUT`；
  截图落盘失败回 `SCREENSHOT_SAVE_FAILED`；扩展侧拒绝执行的页面回 `NOT_INJECTABLE`。

### 5.2 上传数据边界

`upload` 仅接受 **1–5 个绝对本地路径，总大小不超过 8MiB**。Host 逐个异步读取文件，以一次性
base64 命令下发；Client 用 `File` + `DataTransfer` 设置 `input[type=file]`，并触发 `input/change`。
结果只含文件名/大小，不返回路径或 base64；文件内容/实际路径不进入审计，`paths` 仅记为数组占位。

### 5.3 对话框限制

`dialog` **必须在触发动作前调用**，为下一次 `alert/confirm/prompt` 预置一次性响应；无法关闭
已经弹出的同步阻塞对话框，不支持 `beforeunload`。`confirm` 的 accept/dismiss 分别回 `true/false`；
`prompt` accept 依次使用 `promptText`/对话框默认值/空串，dismiss 回 `null`。不附快照。

### 5.4 成本主线（省 token，§6 快照/delta 字段）

默认每次工具调用都走「视口优先 + 不上送正文」：动作类工具（`open/click/type/press/scroll/nav/select/upload`）
下发快照时固定 `scope:viewport`、`text:false`；`browser_snapshot` 默认 `text:false`。只有
`browser_snapshot text:true` 才回正文。这样把默认每步成本从 ~2-3k token 压到 ~1.0-1.2k。

- 隐藏/零尺寸元素由 Client（`pageAgent.snapshot`）几何剔除，Host 不收。
- 视口外元素不逐个列出（见 §2.1 `offscreen`）。
- 每个快照结果都带 `stats`（见 §2.1），模型/宿主可据此对比成本。

## 6. 快照全量与增量返回（Host 渲染）

模型看到的快照文本一律由 Host 侧 `lib/snapshot.js` 渲染，两类形态：

### 6.1 全量 snapshot（首帧 / URL 变化 / `forceFull` / `scope:document` 显式要看全部）
```
<title> · <url>
---
@e1 link "More information" → https://…
@e2 textbox "搜索"
另有 3 个元素在视口外（用 browser_snapshot scope:document 看全部）
stats: 2 elements, 180 chars, ~50 tokens (scope=viewport)
```
- 末尾固定 `stats:` 行（`elements / chars / estTokens / scope`）。
- 视口优先：仅列视口内元素，视口外用 `另有 N 个元素…` 一行提示。

### 6.2 增量 delta（`delta:true` 且动作后同 URL 时的「变化」，默认关闭）
动作类工具带 `delta:true` 且 **同一 URL** 时走 delta（首帧/URL 变/找不到上一帧则降级全量；
不带 `delta:true` 时一律全量，见 0.2.0 变更）：
```
<title> · <url> [delta]
text changed: true
textSample: 登录成功，欢迎回来…
added (1):
  + @e5 button "退出"
changed (1):
  ~ @e2 button "提交中…"
stats: 1 elements, 220 chars, ~60 tokens (scope=viewport) +1 -0 ~1 textChanged total=5
```
- 只有变化行（`added` / `removed` / `changed`，分别用 `+` / ref / `~` 前缀）。
- `textChanged:true` 时给 `textSample`（截断到 `textSampleLimit`，默认 200）。
- `stats`：`elements/chars/estTokens` 按**这份增量文本自身**计（不是整页），
  另带 `+added -removed ~changed`、`textChanged`、`total=<整页可见元素数>`。

> 注：delta 由 Host 在动作工具里串联两帧（上一帧全量快照 + 动作后快照）实现，协议层面
> Client 只回全量 snapshot；Host 用 `lib/snapshot.js::renderDelta` 对比，且仅在工具参数
> `delta:true` 时启用（默认全量视口）。URL 变 / 首帧 / 无上一帧时自动降级为全量。已实现。

## 7. 深度模式（CDP）—— Host 直连，不经 Client 命令通道

`browser_deep_snapshot` **完全在 Host 进程内执行**：它不生成 `{id, op, args}` 命令、不走
`/agent-browser-auto/poll`、不需要 Client 在线。它直连 Chromium 的调试端口读数据，因此与 §1/§2
的命令通道是**两条独立路径**；Client 侧不需要为它新增任何 op。

### 7.1 端点解析

- `deepMode.endpoint` 非空 → 直接用它（只允许 loopback 的 http(s)，配置期强校验）。
- 为空 → 读 `deepMode.portFile`（默认 `%APPDATA%\@deepseek-ai\dsh-desktop\DevToolsActivePort`）
  的**第一行**作为端口，拼 `http://127.0.0.1:<port>`。
- 结果缓存 **5 秒**：用户重启后随机端口变了，超过缓存时间会自动重读文件（自愈）。
- 文件不存在 / 内容非法 → `DEEP_UNAVAILABLE`，message 带
  「没找到调试端口：请用 tools\start-dsh-debug.cmd 重启 DSH 并在设置里打开 deepMode」。

启动前提：用 `tools/start-dsh-debug.cmd` 以 `--remote-debugging-port=0` 重启 DSH；Chromium
把真实端口写进 `DevToolsActivePort`（第二行是 ws 路径，插件不使用）。

### 7.2 读取流程（只读）

1. `GET /json/version` + `GET /json/list`（各 2s 超时）→ browser ws + targets。
2. `Target.attachToTarget({targetId, flatten:true})` → `sessionId`；后续命令带 `sessionId`。
3. `Accessibility.enable` → `Accessibility.getFullAXTree`（a11y 路线，天然覆盖闭 shadow root
   与同源 iframe；跨源 iframe 通过 `Target.setAutoAttach({flatten:true})` 的子会话单独取树）。
4. 每个节点的 `backendDOMNodeId` → `DOM.getBoxModel` 取 content quad → 外接矩形；
   跨源 iframe 加上 owner frame 的偏移换算到**顶层视口坐标**。任一环节失败 → `box:null`
   （**绝不编造坐标**）。
5. `scope:'dom'` 时改用 `DOM.getDocument({depth:-1,pierce:true})` 走结构路线。

### 7.3 返回与错误

- value：`{ok:true, target:{url,type,title}, nodes:[{role,name,framePath,box}], stats:{nodes,total,truncated,frames,scope,estTokens,ms}}`。
- `framePath`：主 frame 为 `main`；子 frame 沿父链拼接，形如 `main > #1`、`main > #1 > #2`
  （`#n` 是该 frame 在父 frame 里的子序号）。拿不到父链才退化为 `#?`。
- `box`：`{x,y,width,height} | null`，**顶层视口坐标**（可直接喂给 `browser_click x/y`）；
  换算不了为 `null`，渲染成 `box:n/a`，绝不编造。
- 错误码：`DEEP_UNAVAILABLE`（未启用 / 端口文件缺失或非法）、`CDP_UNREACHABLE`（端口关闭）、
  `CDP_TIMEOUT`（命令超时）、`CDP_TARGET_GONE`（页面被关/跳转）、`CDP_TARGET_MULTIPLE`
  （多页时必须传 `url`）、`CDP_NO_PAGE`（没有 page/webview target）。
- 所有失败都**不抛到框架层**：工具回 `{ok:false,error:{code,message}}`，模型看到一行可读原因。

### 7.3.1 能力边界（实测）

深度模式读到的是**无障碍树**，所以：

- 能读到：closed shadow root 里的控件、`aria-label`/`aria-labelledby` 语义名、跨源 iframe 内容、
  视口坐标、role（button/link/heading/textbox…）。
- 读不到：**canvas 像素里画的文字**、图片里的文字、`aria-hidden="true"` 的装饰节点
  （后者是有意省略）。这些只能 `browser_screenshot` 看像素。
- 因此「CDP 能看一切」是错的：它补的是「DOM 里有、页面 JS 读不到」，补不了「DOM 里根本没有」。

### 7.4 安全

调试端口无认证、只绑 loopback；运行期间本机任意进程都能控制该 DSH 实例。因此默认
`deepMode.enabled=false`、端口随机（`--remote-debugging-port=0`），并用
`--remote-allow-origins=devtools://devtools` 阻断网页从浏览器内部连调试端口。插件只发只读命令。

## 8. 扩展桥接后端（0.8.0）—— Host ⇄ 扩展的常驻 WebSocket

用户日常浏览器（Edge/Chrome 默认 profile）装上 `extension/` 的 MV3 扩展后，扩展**主动**连到
`ws://127.0.0.1:<extensionBridge.port>?token=<token>`，命令与结果经这条常驻连接往返。
不开 CDP 调试端口、没有授权弹窗、连接常驻。实现：Host 侧 `lib/extension-bridge.js`，
扩展侧 `extension/background.js`（SW 主连接 + 20s 应用层心跳 + offscreen 兜底）。

### 8.1 认证（一次性配对码 → 长效 token）

1. agent 调 `browser_ext_pair` → Host 生成 8 位无歧义字符配对码（单次使用，
   `extensionBridge.pairTimeoutMs` 默认 300000ms 过期）+ 长效 token（32 字节 base64url）；
2. 用户把扩展加载进浏览器（load unpacked），点扩展图标输入配对码；
3. 扩展以 `?token=<配对码>` 连接 → Host 在 **HTTP upgrade 阶段**校验：无效/过期直接 401
   （不升级成 WebSocket）；
4. 通过后 Host 发 `{type:"ready", version:1, token:<长效token>}`，扩展把 token 存
   `chrome.storage.local`；之后每次重连都带这个 token；
5. Host 只持久化 token 的 **SHA-256**（`<auditDir>/extension-paired.json`：`{clientId, digest, pairedAt}`），
   原文不落盘。服务重启后长效 token 依然有效。

### 8.2 WS 消息（JSON，全双工）

| 方向 | type | 说明 |
|---|---|---|
| Host→扩展 | `ready` | 认证通过；配对连接额外携带 `token`（长效凭证） |
| 扩展→Host | `hello` | `{clientId, version}`；clientId 是扩展安装 id（storage.local 随机串），权威值以它为准 |
| Host→扩展 | `helloAck` / `sessionReady` | hello 确认 / 会话登记完成（`sessionReady` 回显权威 clientId） |
| 扩展→Host | `ping` | `{t}` 每 20s；Host 回 `pong`（协议层 ping/pong 帧也支持） |
| Host→扩展 | `command` | `{id, op, args}`，与 §2.2 同一套 op/args |
| 扩展→Host | `result` | `{id, ok, value}` 或 `{id, ok:false, error:{code,message}}`，错误码沿用 §2.3 + §8.6 |
| 扩展→Host | `log` | `{level, message, data?}` → debug.jsonl（扩展侧任何 catch 必须上报） |
| Host→扩展 | `superseded` | 同 clientId 的新连接顶掉旧连接（断网重连 / offscreen 接管）时发给旧连接 |

会话模型：同一 clientId 的重连会顶掉旧连接；多个浏览器同时在线时命令发给最近心跳的那个。
扩展超过 ~45s 无任何消息判定掉线。

### 8.3 SW 生命周期与 offscreen 兜底

- 主路径：SW 直接持有 WS，每 20s 发应用层 `ping`——Chrome/Edge 116+ 起 WS 活动重置 SW 的
  30s 休眠计时器，连接因此常驻（`minimum_chrome_version: 116`）。
- 兜底：offscreen 文档（`KEEP_ALIVE` 原因）每 15s 探活 SW（runtime 消息本身也会唤醒/保活 SW）；
  探活连续失败时 offscreen 用同一 token/clientId 接管 WS，消息经 `chrome.runtime` 转交并唤醒 SW；
  SW 探活连续 3 次成功后交还所有权。所有权记在 `chrome.storage.session` 的 `bridgeOwner`。
- SW 被事件唤醒（休眠后恢复）时会先从 storage 读取状态再重连，Host 侧按 §8.2 顶掉旧连接自愈。

### 8.4 扩展侧 op 语义（与 §2.2 的差异，都是刻意的）

- `open`：只操作「agent 自己的标签页」——`newTab:false` 复用上次 agent 标签（没有则新建），
  绝不导航用户手头的其它标签；`newTab:true` 新建。
- 点击/输入/按键没有真实输入管线（无 CDP），走共享 pageAgent 的 DOM 合成路径
  （`clickDom`/`typeFallback`/`keyFallback`/`scrollDom`）；`changed` 用 DOM mutations/URL 判定。
- `screenshot`：`captureVisibleTab`（要求 agent 标签在前台，否则 `SCREENSHOT_NEEDS_FRONT`）；
  PNG 以 `pngBase64` 放进 result，Host 落盘 `<auditDir>/shots/` 并摘除该字段（§1 的 /shot 端点不适用）。
  `fullPage` 不支持（结果带 note 说明）。
- `tabFront`：chrome.tabs 实现，`pageId` 是 tabId 字符串；`activate` 同时 `windows.update({focused:true})`。
- `tabs`/`console`/`network`/`eval`：`NOT_SUPPORTED`（内嵌面板专属；`browser_eval` 在扩展模式一律拒绝）。
- 页面注入：`chrome.scripting.executeScript({world:'MAIN', func: pageAgent})`；chrome://、Web Store 等
  受保护页面回 `NOT_INJECTABLE`。**快照契约与内嵌完全一致**：pageAgent 从 client.js 抽取到
  `extension/page-agent.js`，两份标记块逐字节一致（`test/page-agent-contract.test.mjs` 强制）。

### 8.5 Host 侧工具

- `browser_ext_pair`（无参数）：`{ok:true, code, expiresAt, port, wsUrl, instructions}`；instructions 是
  locale 驱动的安装指引（`{extensionDir}`/`{code}`/`{port}` 占位符）。`enabled=false` 回 `EXTENSION_DISABLED`。
- `browser_ext_status`（无参数）：`{ok:true, enabled, listening, port, paired, connected, clientId, lastHeartbeatMs, pairPending, message}`；
  未启用时 `enabled:false` + 提示语（不是错误——查询本身合法）。全部字段 lossless。

### 8.6 安全

- WS 只绑 `127.0.0.1`；`port` 只来自配置，工具参数不能覆盖；普通 HTTP 请求回 426。
- token 校验失败在 HTTP 层 401；配对码单次使用、短时效、8 位无歧义字符（≈31⁸ 空间）。
- Host 只存 token 哈希；审计/日志绝不记录 token 原文（只记哈希前 8 位指纹）。
- 扩展 token 存本机 `chrome.storage.local`，不出本机；扩展能力边界 = 用户给它加载的页面的
  executeScript 权限（manifest 声明 `<all_urls>` + tabs/scripting，README 明示用途）。
- 与 deepMode 不同：这条通道**有认证**且默认关闭（`extensionBridge.enabled=false`）。
