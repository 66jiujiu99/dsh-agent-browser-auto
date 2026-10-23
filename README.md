# dsh-agent-browser-auto · Agent 浏览器（自动）

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-0.2.1--rc.2-6f42c1.svg)](#兼容性)
[![Tests](https://img.shields.io/badge/tests-51%2F51%20pass-brightgreen.svg)](#验收状态2026-10-23-实测)

给 DSH 桌面版装上「看得见的手」：模型用 `browser_*` 工具**看见并操作**右侧边栏里一个**用户可见**的浏览器页面。
页面是本插件自己向主进程申请 lease 后创建的 Electron `<webview>`，不碰官方「浏览器」tab 的 DOM（合规、不随上游升级碎裂）。

- 版本：0.1.0 · 目标：DSH 桌面版 0.2.1-rc.2（Electron 44.7.0）
- 契约：`PROTOCOL.md`（Host ⇄ Client 的唯一协议，改字段两边一起改）

**为什么不是 Playwright / Puppeteer**：那两个库会自己启动一个**独立的无头浏览器**——它看不见、也点不了
DSH 右侧边栏里那个 `<webview>`，用户还看不到 Agent 在干什么；同时要额外背 150–300 MB 浏览器二进制和一个
Node 边车进程。本插件复用的是**用户眼前那个真实页面**，并且沿用主进程已经强制好的沙箱策略（见「安全边界」）。

## 它长什么样

右侧边栏多一个 tab 类型 **「Agent 浏览器」**（kind `agent-browser`）。模型调用工具时如果这个 tab 还没开，
插件会自己把它打开并把右侧栏展开——**用户全程看得见 Agent 在点什么**；关掉 tab 即停止（guest 被释放）。

```
模型 ──browser_open/click/type…──▶ Host 工具层（URL 策略 + 审计）
                                      │  命令进队列，长轮询下发
右侧边栏 tab（Client）◀───────────────┘
   └─ <webview>（自建 guest，sandbox、无 Node、无 preload）
        └─ executeJavaScript（快照/定位）+ sendInputEvent（真实输入）+ capturePage（截图）
```

## 安装

### 第 0 步：如果你是用「下载 ZIP」方式拿到的代码，先解除下载锁

从 GitHub 下载 ZIP 并解压后，Windows 会给每个文件打上 **Mark of the Web**（"来自 Internet"标记）。
对 `.cmd` 这类可执行文件，这个标记会让 Windows **每次双击都弹「无法验证发布者，你确定要运行此软件吗」**，
即使你已经点过"运行"——因为标记还在文件上。先跑一次把它清掉：

```
tools\unblock-folder.cmd
```

只删 `Zone.Identifier` 数据流，**不改内容、权限、所有者**；默认处理本插件目录（含子目录），
也可 `-Path "C:\某个解压目录"`；想先看会改什么而不动手就加 `-WhatIf`。

> **用 `git clone` 安装的话没有这一步**——git 不写 MOTW，不会弹窗。这也是推荐方式。

清除 MOTW 等于你**确认信任这份代码**，所以请顺手核一下源码：这个插件全是可读的 JavaScript，
没有编译产物、没有运行时下载执行。详细说明见文末「常见问题」。

### 第 1 步：拿到代码

```bash
# 推荐：git clone（不产生 MOTW，不会弹安全警告）
git clone https://github.com/66jiujiu99/dsh-agent-browser-auto.git
```

也可以 GitHub → **Code → Download ZIP** 解压（那就回到第 0 步先解除下载锁）。

本插件**不发布 npm 包，也不需要 `npm install`**——它零依赖，直接就是可加载的 DSH 插件目录。

### 第 2 步：装进 DSH

```bash
# 在 DSH 里（需要 danger-full-access 或逐次批准）
# target 传你 clone / 解压出来的那个目录的绝对路径
plugin_manager install_bundle target=C:\path\to\dsh-agent-browser-auto
```

> 以**本地目录**方式安装时，DSH 用的是 `link:`，`package.json` 的 `files` 字段在此模式下不生效
> （打包/发布时才生效）。因此目录里的 `tools/`、`test/` 会一起留在原地，属正常现象。

- 安装后 Host 半边立即生效；**Client 半边**在桌面窗口里按需加载（首次安装若没看到 tab，按 Ctrl+R 刷新窗口一次）。
- 改了 `index.js` / `lib/*.js` 之后：**Host 代码不会热更**（loader 不监听文件），需要重新 apply：
  `plugin_manager set_plugin include:agent-browser-auto enabled=false` → `enabled=true`。
- 改了 `client.js`：Client HMR 会自动热替换（可在 `~/.dsh/storages/agent-browser-auto/debug.jsonl` 里看到新 clientId）。

### 卸载

```bash
plugin_manager set_plugin include:agent-browser-auto enabled=false   # 先停用
plugin_manager remove_bundle target=dsh-agent-browser-auto     # 再移除
```

审计/调试数据不会自动删除，如需清理：删掉 `~/.dsh/storages/agent-browser-auto/` 即可。

## 工具面（15 个）

| 工具 | 作用 | 说明 |
|---|---|---|
| `browser_open` | 打开 URL 并回快照 | `newTab` 可在面板内新开一页 |
| `browser_snapshot` | 重拍快照 | `maxElements`（默认 80）/`text`（默认 false，最省 token）/`textLimit`（默认 3000）/`scope`（默认 `viewport`） |
| `browser_click` | 点 `@ref` 或视口坐标 | 先走真实输入管线，无反应才退回 DOM click |
| `browser_type` | 输入文本 | `clear` 先清空、`submit` 回车/提交表单 |
| `browser_press` | 按键 | Enter/Tab/Escape/方向键/PageUp/PageDown/Home/End/Space |
| `browser_scroll` | 滚动 | 先 wheel 事件，滚不动才 `scrollBy` |
| `browser_nav` | back/forward/reload/goto | |
| `browser_find` | 按名字/文字找元素 | 全文档（含 shadow / 同源 iframe，视口外也算）；命中无 ref 的纯 JS 元素时给坐标，用 `browser_click x/y` 点 |
| `browser_deep_snapshot` | **深度模式**：CDP 读 a11y 树 | 能看闭 shadow root / 跨源 iframe；需重启开调试端口（见下节），默认关闭 |
| `browser_screenshot` | PNG 落盘 | 返回绝对路径，可直接 `read_image` |
| `browser_tabs` | list/new/switch/close | 面板内多页，每个页面独立 guest |
| `browser_console` | 页面控制台近况 | `console-message` 事件 + 页面 error 钩子 |
| `browser_network` | 请求近况 | 主文档 navigation entry + fetch/XHR 包装 + Resource Timing 兜底 |
| `browser_eval` | 执行 JS | **默认关闭**（`enableEval`） |
| `browser_close` | 释放页面 | 同时销毁 guest |

快照形如（视口优先，默认不发正文）：

```
Example Domain · https://example.com/
---
@e1 link "Learn more" → https://iana.org/help/example-domains
另有 7 个元素在视口外（用 browser_snapshot scope:document 看全部）
stats: 1 elements, 74 chars, ~19 tokens (scope=viewport)
```

- **成本默认最低**：`browser_snapshot` 默认 `text:false`（不发正文，最大头）、`scope:viewport`（只列视口内元素）；
  要看正文传 `text:true`（`textLimit` 默认 3000），要看全部元素传 `scope:document`。动作类工具（`open/click/type/press/scroll/nav`）
  回快照时同样默认视口 + 无正文。隐藏/零尺寸元素由 Client 几何剔除，不占用 token。
- 每个快照都带 `stats: {elements, chars, estTokens, scope}`，可据此对比成本。
- 同一 URL 的动作后走**增量** `[delta]`：只报 `added/removed/changed`（+ `textChanged` 时短采样 + `textSample`），
  `stats` 按增量文本自身计并附 `+a -r ~c total=N`；URL 变化 / 首帧 / 找不到上一帧自动回全量。详见 `PROTOCOL.md` §6。
- `@ref` 稳定：同一元素在多次快照里保持同一个 ref；页面重渲染把节点换掉后，点击会按「角色 + 名字」
  自动找回语义相同的元素（并在结果里标 `recovered`），找不到才回 `NO_REF` 让你重拍快照。
- **穿透 Shadow DOM 与同源 iframe**：快照递归进入 open shadow root 与同源 iframe（含嵌套），
  点它们时坐标自动换算到顶层视口——实测 shadow / iframe 里的按钮都能被真实鼠标事件点中。
  **跨源 iframe** 受浏览器安全边界限制读不到，快照里会明确写「N 个跨源 iframe 的内容不可见」。
  纯 JS 绑事件、既无 role 也无 tabindex/onclick 的 `<div>` 仍抓不到（启发式的固有边界）。
- 结果按 UTF-8 字节截断到 `maxResultBytes`（默认 12000），超出会提示用 `browser_snapshot` 收窄。

## 配置（`cordis.patch.yml` 里 `agent-browser-auto` 行的 `config`）

| 键 | 默认 | 含义 |
|---|---|---|
| `allowedHosts` | `[]` | 非空时只放行这些主机（后缀匹配，`example.com` 命中 `a.example.com`） |
| `blockedHosts` | `[]` | 优先拒绝的主机 |
| `enableEval` | `false` | 是否允许 `browser_eval` |
| `commandTimeoutMs` | `45000` | 单条命令等待上限 |
| `pollWaitMs` | `20000` | 长轮询挂起上限 |
| `maxResultBytes` | `12000` | 工具结果上限 |
| `auditDir` | `""` | 审计目录，空 = `~/.dsh/storages/agent-browser-auto` |
| `debug` | `true` | 是否写 `debug.jsonl` |
| `deepMode.enabled` | `false` | 是否启用 CDP 深度模式（默认关闭，见下节） |
| `deepMode.portFile` | `""` | 空 = `%APPDATA%\@deepseek-ai\dsh-desktop\DevToolsActivePort` |
| `deepMode.endpoint` | `""` | 空 = 读 `portFile` 拼 `http://127.0.0.1:<port>`；非空直接用（仅允许 loopback） |
| `deepMode.maxNodes` | `200` | 深度快照默认最多返回节点数 |
| `deepMode.timeoutMs` | `8000` | 单条 CDP 命令超时 |

## 深度模式（CDP，可选，默认关闭）

普通快照只能看到 DOM 能读到的部分：**跨源 iframe** 和 **closed shadow root** 内容读不到
（浏览器安全边界）。深度模式改用本机 CDP 端口直连 Chromium，读**无障碍树（a11y）**，
因此能看到这些内容，并给出**顶层视口坐标**（可直接 `browser_click x/y`）。

**怎么打开**：启动器在 `tools/`。

```
tools\start-dsh-debug.cmd      ← 双击这个
tools\start-dsh-debug.ps1      ← 真正的逻辑（.cmd 只是纯 ASCII 转发）
```

它会：① 用 `--remote-debugging-port=0` 启动（端口随机，不是扫描器惯用的 9222）；
② 加 `--remote-allow-origins=devtools://devtools`，**阻断「你访问的网页从浏览器内部连本机调试端口」**这类攻击；
③ 从 `DevToolsActivePort` 读出真实端口，并**主动 HTTP 探活**确认端口真的在监听，再打印给你。

**启用前提（缺一不可）**

1. **完全退出** DSH（含托盘）。否则新参数会被已有实例吞掉、端口不会出现——脚本会替你检查并明确报错。
2. 在插件配置里打开 `deepMode.enabled: true`，重新 apply 插件。

用完关掉 DSH、用普通方式重启，端口就消失了。

> **为什么启动器是 `.ps1` + 一个纯 ASCII 的 `.cmd` 转发层？**
> `cmd.exe` 按系统 OEM 代码页（中文系统是 936）**逐字节**解析批处理文件。UTF-8 的中文注释会被解码错位，
> 把后面的 `REM` 和换行**一起吃掉**，于是 cmd 把中文当成命令执行，窗口刷一屏「不是内部或外部命令」
> 然后**瞬间闪退**。这就是最初那版启动器闪退的真实原因。
> 现在两个文件都是**纯 ASCII、无 BOM**：`.cmd` 只做一行转发，`.ps1` 承载全部逻辑，
> 因此在 Windows PowerShell 5.1 和 PowerShell 7 下、在任意代码页下解析结果都一样。中文文档写在这里（README），不进脚本。

端口没开 / 没启用时，`browser_deep_snapshot` 会**优雅失败**为
`DEEP_UNAVAILABLE`（message 里带「用 tools\start-dsh-debug.cmd 重启并在设置里打开 deepMode」的原话），
不会影响其他工具。插件启动时会在 `debug.jsonl` 记一条 `deep-mode`（enabled / 端口可达性）。

**它多看到什么（真机实测，非推测）**

| 页面里的东西 | 普通快照 | 深度模式（a11y） |
|---|---|---|
| closed shadow root 里的 `<button>闭封按钮` | 读不到 | 读到：`button "闭封按钮" @ (16,93 53x19)` |
| `aria-label="设置"` 的纯图标按钮 | 只剩符号 `⚙` | 读到：`button "设置"` |
| 跨源 iframe 里的按钮/链接 | 读不到（只有「不透明矩形」提示） | 读到，且坐标是顶层视口坐标：`[main > #1] button "iframe 按钮 1" @ (107,152 79x19)` |
| canvas 里画出来的文字 | 读不到 | **也读不到**（a11y 树里没有节点，只能靠截图兜底） |
| 整页成本 | 13 元素 ≈175 tokens | 6 节点 ≈41 tokens |

一句话：**深度模式补的是「DOM 里有、页面 JS 读不到」的那类**（closed shadow root、原生语义名、
跨源 iframe）；**补不了「DOM 里根本没有」的那类**（canvas 像素、图片里的文字）——那类请用
`browser_screenshot`。

跨源 iframe 的坐标靠逐层 frame 偏移换算（`main > #1 > #2`），任一环节换算不了就标 `box:n/a`，**不编造坐标**。

**安全代价（重要）**：调试端口**没有认证**，只绑 `127.0.0.1`。运行期间**本机任意进程**都能
通过它控制这个 DSH 实例（含执行任意 JS）。所以默认关闭、端口随机；不用时用普通方式重启 DSH
即可让端口消失。插件端只做**只读**命令（Accessibility/DOM/Page/Target），不通过 CDP 点击或输入。

**参数**：`url?`（默认用本会话最近打开的 URL）、`maxNodes?`（默认配置值 200）、
`scope?: 'a11y'|'dom'`（默认 a11y；dom 走 `DOM.getDocument({depth:-1,pierce:true})` 结构）、
`includeFrames?: boolean`（默认 true，深入跨源 iframe 会话）。

## 常见问题：双击 `.cmd` 弹「无法验证发布者 / 你确定要运行此软件吗」

这是 Windows 的 **Mark of the Web（MOTW）**，不是插件的问题，也不是病毒告警。

**触发条件**：你从 GitHub 下载 ZIP 并解压后，Windows 会给每个解压出来的文件写一个名为
`Zone.Identifier` 的备用数据流（`ZoneId=3`，表示"来自 Internet"）。对于 `.cmd`/`.bat`/`.ps1`/`.exe`
这类可执行文件，这个标记会让 Windows **每次打开都弹窗**——即使你已经点过"运行"，因为标记还留在文件上。
本插件里会命中的是 `tools\start-dsh-debug.cmd` 和 `tools\unblock-folder.cmd`。

**一键消除**：

```
tools\unblock-folder.cmd
```

它只删除 `Zone.Identifier` 这一个数据流，**不改文件内容、权限、所有者**；默认清理本插件目录（含子目录），
也可以传路径：`tools\unblock-folder.cmd -Path "C:\某个解压目录"`。先看会改什么而不实际改动：
`-WhatIf`。

手动做法（等价）：右键文件 → 属性 → 勾选「解除锁定」→ 确定。

**用人话讲清风险**：MOTW 存在的意义就是提醒你"这个文件来自网络、未经签名"。清除它就等于你**确认信任这份代码**。
请配合两点：① 只对你真正看过的发行版这么做；② 对照仓库里的源码核对——这个插件的全部代码都是可读的
JavaScript，没有任何编译产物或下载执行步骤。这也是本仓库不提供预编译二进制的原因。

> 提示：`git clone` 下来的文件**不带** MOTW，只有"浏览器下载 ZIP 再解压"这条路径才会带。
> 想完全避开这个弹窗，用 `git clone` 安装即可。

## 安全边界（都是硬事实，不是约定）

- guest 由主进程强制：`sandbox:true`、`contextIsolation:true`、`nodeIntegration:false`、`plugins:false`、`disableDialogs:true`；
  **权限询问全部拒绝**（摄像头/麦克风/地理位置/通知），**下载全部 `preventDefault`**，**弹窗全部 deny**。
- 导航只允许 `http:`/`https:`、无内嵌凭据、且不能指向 DSH 自身 origin —— Host 侧在命令下发前就拒绝并说明原因
  （否则主进程会静默吞掉导航，模型只会看到「点了没反应」）。
- Host 路由 `/agent-browser-auto/*` 走 `ctx.connection.requestRejection`（Host/Origin + 浏览器凭据），拿不到 `connection`
  服务时 **fail-closed 503**；渲染进程发来的请求由主进程注入 cookie，外部进程默认拿不到。
- 不做无头后台操作：状态只在**可见的** tab 里产生；关掉 tab 就释放 guest。

**安装即托管信任**：DSH 的插件安装在**宿主进程内、工作区沙箱之外**运行（安装动作有权限门禁，装上之后没有沙箱）。
也就是说，任何插件都拿得到和你同等的本机权限。请只安装你读过或信任的插件；本仓库全部是可读 JavaScript，
无编译产物、无运行时下载执行，便于你自行审阅。

## 兼容性

| 项目 | 要求 | 说明 |
|---|---|---|
| DSH 版本 | **0.2.1-rc.2**（实测） | 插件依赖 desktop 的 webview lease API 与 side-bar tab 槽位 |
| 运行形态 | **仅桌面版**（Electron） | Web 端没有 `dshDesktop` 桥，tab 内只显示提示 |
| 平台 | Windows（实测）· macOS / Linux 未验证 | 启动器是 Windows 专用；不用深度模式时无平台依赖 |
| Node | ≥ 20 | 与 DSH 自带运行时一致 |

## 审计与排障

`~/.dsh/storages/agent-browser-auto/`
- `audit.jsonl` —— 每次工具调用一行：`ts / sessionId / tool / op / args / urlBefore / urlAfter / ok / error / ms / clientId`
- `debug.jsonl` —— 路由命中、客户端上下线、命令下发/超时、**Client 侧日志与异常栈**、`deep-mode` 端口可达性
- `shots/` —— `browser_screenshot` 落盘的 PNG

出问题先看 `debug.jsonl` 里最后几条 `client-log` / `route-*`；Client 侧任何 catch 都会上报，不会静默。

## 已知限制

1. **仅桌面版**：Web 端没有 `dshDesktop` 桥，tab 里只显示「只在桌面版可用」。
2. **必须有一个屏幕上的会话**：浏览器 tab 按会话挂载；工具调用落在后台会话时回 `NO_CLIENT`（会提示先切过去）。
3. **关掉右栏/关掉 tab 后命令不可达**：会立刻回 `NO_CLIENT`，不会排队等到你打开。
4. **`browser_eval` 受页面 CSP 限制**（部分站点禁止 `eval`），失败会给可读错误。
5. **截图是视口截图**：`fullPage` 通过临时拉高元素高度实现，超长页面最多截 4000px。
6. **下载/上传/摄像头/地理位置**被主进程硬禁用，属于平台约束而非本插件遗留问题。
7. Client 半边热更会重建页面：HMR 之后原来的页面对象与 guest 会丢失，需要重新 `browser_open`（Host 会回 `NO_CLIENT`/`NO_PAGE` 提示重开）。
8. **深度模式需要重启**：随机调试端口只在用 `tools/start-dsh-debug.cmd` 启动的那次会话里存在；
   普通启动没有端口，`browser_deep_snapshot` 会回 `DEEP_UNAVAILABLE`。关闭 DSH 再正常启动即可恢复默认（无端口）。

## 验收状态（2026-10-23 实测）

| 需求 | 状态 | 证据 |
|---|---|---|
| R1.1 打开并拿到结构化快照 | ✅ | `example.com` / `baidu.com` 实测 |
| R1.2 ref 稳定 + 失效自愈 | ✅ | 提交搜索后点旧 ref 自动按「角色+名字」找回 |
| R1.3 点击/输入/按键/滚动/导航 | ✅ | 百度：输入「DeepSeek 官网」→ 提交 → 点「视频」→ 后退 → 滚动 600 |
| R1.4 截图 | ✅ | `shots/*.png` 817×880，`read_image` 能看到真实渲染 |
| R1.5 用户可见 | ✅ | 工具调用自动 `openTab` 打开右侧栏面板 |
| R1.6 会话绑定 | ✅ | 每个 session 一个控制器 + 独立 guest |
| R1.7 错误可读 | ✅ | `LOAD_FAILED`（维基百科被网络拦截时给出原因）、`NO_REF`、`EVAL_DISABLED`、`NO_CLIENT` |
| R1.8 审计 | ✅ | `audit.jsonl` 17+ 条，`debug.jsonl` 全链路 |
| P1 console/network/tabs/eval | ✅ | console 0→N 条、network 含主文档、多页 new/switch、eval 默认拒绝 |

**验证方法（可复现）**

```bash
# 单元测试：快照渲染 / 差分 / 工具参数 / CDP 错误映射（51 项）
ELECTRON_RUN_AS_NODE=1 "C:\Data\APP\dsh\DeepSeek Harness.exe" --test test/*.test.mjs

# CDP 集成测试：用真 Chrome（headless + 随机端口）当靶子，不碰你的 DSH
node C:\Data\deepseek\_probe-cdp\run.mjs
```

- 单元测试 **51 / 51 通过**（snapshot 19 · tools 10 · cdp 22）。
- CDP 集成测试 **17 / 17 通过**：端口文件发现与缓存、`DEEP_UNAVAILABLE` 文案、discover、
  a11y 与 dom 两条读取路线、跨源 iframe（含坐标换算）、各类不可达错误码。
- 能力边界 **4 / 4 通过**：closed shadow root 可读、canvas 文字不可读（如实记录，不夸大）。
- 启动器 **6 条路径**全部实测：文件缺失 / 已有实例 / 成功 / 探活失败 / 超时 / 残留端口文件清理。

> 说明：以上数字都来自本机实测，不是设计目标。未在 macOS / Linux 上验证过，因此不做声明。
