# agent-browser-auto 插件内部协议（Host ⇄ Client）

本文件是 Host 半边（`index.js`）与 Client 半边（`client.js`）之间的**唯一契约**。
两边都按本文件实现，不允许各自发明字段。

## 0. 运行环境事实（已取证，不要重新假设）

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
响应：`{"ok":true,"version":1,"config":{"enableEval":false,"maxSnapshotBytes":8192}}`
Host 记录 client 的 `sessionId`（每次 hello 覆盖）。Client **每 10s** 发一次 hello 保活。

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
| `click` | `{ref?} \| {x?,y?}, snapshot?:boolean, scope?:("viewport"\|"document")}` | `{action:"click", changed:boolean, snapshot?}` |
| `type` | `{ref, text, clear?:boolean, submit?:boolean, snapshot?:boolean, scope?:("viewport"\|"document")}` | `{action:"type", changed:boolean, snapshot?}` |
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
- `snapshot` 默认 `true`（除非显式 `false`），即动作后回一张新快照。
- `changed`：动作是否让页面发生了变化（URL 变化、DOM 变更计数增加、或 input 值变化）。
- `click` 的坐标路径：`{x,y}` 是 webview **视口内**坐标（左上为原点）。
- `screenshot` 的 `path` 是 Host 可读的**绝对路径**：Client 通过 `POST /agent-browser-auto/shot` 上传 PNG 二进制，
  Host 落盘到 `<auditDir>/shots/<ts>.png` 并把路径回给工具。**这一条是本协议唯一的多余端点**：
  `POST /agent-browser-auto/shot?pageId=…&url=…`，body 为 `image/png` 原始字节，响应 `{ok:true, path, bytes}`。

### 2.3 错误码（Client → Host，写在 result.error.code）
`NO_PAGE`（没有页面）、`NO_REF`（ref 不存在/已失效）、`NAV_BLOCKED`（URL 不合法或被策略拒绝）、
`TIMEOUT`（页面在 waitMs 内未加载完）、`LOAD_FAILED`（did-fail-load）、`EVAL_DISABLED`、
`NOT_DESKTOP`（web 客户端）、`INTERNAL`（其它，必须带 message 与 data.error）。

## 3. Host 侧工具（模型看到的）

| 工具 | 参数 | 说明 |
|---|---|---|
| `browser_open` | `url`, `newTab?`, `waitMs?`, `scope?` | 打开并回快照 |
| `browser_snapshot` | `maxElements?`, `text?`, `textLimit?`, `scope?` | 回快照（`text` 默认 false，最省 token） |
| `browser_click` | `ref?` 或 `x`+`y`, `snapshot?` | 点击 |
| `browser_type` | `ref`, `text`, `clear?`, `submit?`, `snapshot?` | 输入 |
| `browser_press` | `key`, `snapshot?` | 按键 |
| `browser_scroll` | `dy`, `dx?`, `snapshot?` | 滚动 |
| `browser_nav` | `action`(back/forward/reload/goto), `url?` | 导航 |
| `browser_screenshot` | `fullPage?` | 回 PNG 落盘路径 |
| `browser_tabs` | `action`(list/new/switch/close), `id?` | 多页管理 |
| `browser_console` | `limit?` | 控制台近况 |
| `browser_network` | `limit?` | 请求近况 |
| `browser_eval` | `code` | 默认关闭 |
| `browser_close` | — | 关闭页面 |

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
- 没有 Client 连着目标会话时：`NO_CLIENT`，message 写清楚「请先在 PC 上打开该会话」。

## 4. 审计与日志（Host 写文件）

目录：`<config.auditDir>`，默认 `$HOME/.dsh/storages/agent-browser-auto`。

- `audit.jsonl`：每条工具调用一行
  `{"ts":"ISO","sessionId":"…","tool":"browser_open","op":"open","args":{…精简…},"urlBefore":"…","urlAfter":"…","ok":true,"error":null,"ms":812,"clientId":"…"}`
- `debug.jsonl`：路由命中、client 上下线、命令下发/超时、Client log 转发，一行一条。
  字段至少 `{"ts","kind","…}`。`config.debug=false` 时关闭。
- `shots/`：截图落盘。

写文件用 `node:fs/promises`，追加失败只打日志，**不**影响工具调用。

## 5. 成本主线（省 token，§6 快照/delta 字段）

默认每次工具调用都走「视口优先 + 不上送正文」：动作类工具（`open/click/type/press/scroll/nav`）
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

### 6.2 增量 delta（动作后同 URL 的「变化」）
动作类工具在 **同一 URL** 的后续调用里走 delta（首帧/URL 变/找不到上一帧则降级全量）：
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
> Client 只回全量 snapshot；Host 用 `lib/snapshot.js::renderDelta` 对比，URL 变 / 首帧 /
> 无上一帧时自动降级为全量。已实现。

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
