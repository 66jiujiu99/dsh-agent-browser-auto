/**
 * DSH Agent 浏览器桥 —— MV3 service worker（扩展侧主控）。
 *
 * 与 Host 的唯一契约是插件仓库的 PROTOCOL.md §8：WS 消息 `{type:'ready'|'command'|'result'|'ping'|'pong'|…}`。
 *
 * 连接模型（详见 EXTENSION_BACKEND.md）：
 * - **主路径**：本 service worker 直接持有 `ws://127.0.0.1:<hostPort>` 连接，每 20s 发应用层
 *   `ping`；Chrome/Edge 116+ 起 WS 活动会重置 SW 的 30s 休眠计时器，因此连接常驻不断线。
 * - **兜底**：offscreen 文档（offscreen.js）每 15s 探测本 SW；连续无响应（SW 被杀、旧版浏览器）
 *   时由 offscreen 接管同一条 WS，消息经 chrome.runtime 转交并唤醒本 SW；SW 稳定复活后
 *   offscreen 交还所有权。所有权写在 chrome.storage.session 的 `bridgeOwner`。
 *
 * 页面操作：`chrome.scripting.executeScript({ world:'MAIN', func: pageAgent, args })`
 * 执行与 client.js 共享的 pageAgent（`./page-agent.js` 是逐字节契约源）。
 * chrome.scripting 无法注入受保护页面（chrome://、Web Store 等），这类标签会得到可读错误。
 *
 * 与 client.js 的语义差异（刻意的，README 有说明）：
 * - `open` 永远操作「agent 自己的标签页」：newTab:false 复用上次 agent 标签，绝不去改写
 *   用户手头的其它标签页；
 * - 点击/输入没有真实输入管线（无 CDP），走 pageAgent 的 DOM 合成路径（clickDom/typeFallback 等）；
 * - `screenshot` 用 captureVisibleTab，PNG 以 base64 放进命令结果由 Host 落盘。
 */

import { pageAgent } from './page-agent.js'

/** 与 lib/extension-bridge.js 的 EXTENSION_BRIDGE_PROTOCOL_VERSION 对齐。 */
const PROTOCOL_VERSION = 1

/** 心跳间隔：Chrome 116+ 起 WS 活动重置 SW 30s 休眠计时器，20s 足够安全。 */
const HEARTBEAT_MS = 20_000

/** offscreen 探测本 SW 的间隔与超时。 */
const PROBE_INTERVAL_MS = 15_000
const PROBE_TIMEOUT_MS = 5_000

/** 重连退避：1s → 2s → 4s → … 上限 30s（SW 活着时用 setTimeout，死了用 alarms 兜底）。 */
const BACKOFF_BASE_MS = 1_000
const BACKOFF_MAX_MS = 30_000

/** 默认 Host 端口（与插件配置 extensionBridge.port 默认值一致；配对时可改）。 */
const DEFAULT_HOST_PORT = 9335

// ────────────────────────────── 基础设施 ──────────────────────────────

/** @type {'offline'|'connecting'|'online'|'backoff'} */
let state = 'offline'
/** @type {WebSocket|undefined} */
let ws
let backoffMs = BACKOFF_BASE_MS
let reconnectTimer = 0
let heartbeatTimer = 0
let lastError = ''
let disposedForPair = false
/** agent 自己的标签页（open 的默认目标；绝不动用户其它标签）。 */
let agentTabId = 0
/** offscreen 是否持有 WS（storage.session `bridgeOwner` 的内存缓存）。 */
let ownerOffscreen = false

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function storageGet(keys) {
  return chrome.storage.local.get(keys)
}

async function storageSet(values) {
  await chrome.storage.local.set(values)
}

function log(...args) {
  console.log('[dsh-bridge]', ...args)
}

/** 经当前所有权路径把一条 JSON 消息发给 Host。 */
async function sendToHost(message) {
  if (ownerOffscreen) {
    try {
      await chrome.runtime.sendMessage({ target: 'offscreen', type: 'ws-send', payload: message })
      return true
    } catch {
      return false
    }
  }
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(message))
    return true
  }
  return false
}

// ────────────────────────────── offscreen 兜底 ──────────────────────────────

/** 确保 offscreen 文档存在（幂等；不存在才创建）。 */
async function ensureOffscreen() {
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })
    if (contexts && contexts.length > 0) return
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['KEEP_ALIVE'],
      justification: '持有到 DSH Host 的 WebSocket 兜底连接，在 service worker 被浏览器休眠后保持通道不断线。',
    })
    log('offscreen document created')
  } catch (error) {
    // 已存在（竞态）等情况不算失败。
    log('ensureOffscreen skipped:', String(error && error.message ? error.message : error))
  }
}

/** 读所有权标记。 */
async function refreshOwner() {
  try {
    const values = await chrome.storage.session.get({ bridgeOwner: 'sw' })
    ownerOffscreen = values.bridgeOwner === 'offscreen'
  } catch {
    ownerOffscreen = false
  }
  return ownerOffscreen
}

// ────────────────────────────── 连接状态机 ──────────────────────────────

/**
 * 建立连接。token 有两种形态：配对码（首次）或长效 token（重连），
 * Host 在 upgrade 阶段统一校验，扩展无需区分。
 */
async function connect() {
  if (disposedForPair) return
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return
  const store = await storageGet({ clientId: '', bridgeToken: '', hostPort: 0 })
  if (!store.bridgeToken) {
    state = 'offline'
    lastError = '未配对：点扩展图标输入配对码'
    return
  }
  const port = Number(store.hostPort) || DEFAULT_HOST_PORT
  state = 'connecting'
  lastError = ''
  await refreshOwner()
  if (ownerOffscreen) {
    // offscreen 正持有连接；不重复开第二条，等它交还（offscreen-release）再连。
    log('ownership is offscreen; standby')
    state = 'online'
    return
  }
  await ensureOffscreen()
  try {
    ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(store.bridgeToken)}`)
  } catch (error) {
    state = 'backoff'
    lastError = `无法创建 WebSocket：${String(error && error.message ? error.message : error)}`
    scheduleReconnect()
    return
  }
  ws.onopen = () => {
    state = 'online'
    backoffMs = BACKOFF_BASE_MS
    lastError = ''
    const hello = { type: 'hello', clientId: store.clientId || undefined, version: PROTOCOL_VERSION }
    ws.send(JSON.stringify(hello))
    startHeartbeat()
    log('connected to host on port', port)
  }
  ws.onmessage = (event) => {
    let message
    try {
      message = JSON.parse(String(event.data))
    } catch {
      return
    }
    void handleHostMessage(message)
  }
  ws.onerror = () => {
    // onclose 会跟在后面；这里只记录一次可读原因。
    if (state === 'connecting') {
      lastError = '连接被拒绝或端口不通：token 失效时请重新配对，并检查端口是否与插件配置一致'
    }
  }
  ws.onclose = (event) => {
    stopHeartbeat()
    if (ws === event.target) ws = undefined
    if (disposedForPair) {
      state = 'offline'
      return
    }
    if (event.code === 4001) {
      // 被同 clientId 的新连接顶掉：offscreen 接管或另一处重连了，本 SW 待命。
      state = 'online'
      return
    }
    state = 'backoff'
    scheduleReconnect()
  }
}

/** 断线退避重连；SW 可能被杀，所以同时挂一个 chrome.alarms 兜底。 */
function scheduleReconnect() {
  if (disposedForPair) return
  clearTimeout(reconnectTimer)
  reconnectTimer = setTimeout(() => {
    void connect()
  }, backoffMs)
  backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS)
  try {
    chrome.alarms.create('bridge-reconnect', { delayInMinutes: 0.5 })
  } catch {
    // alarms 不可用时不兜底（SW 活着时 setTimeout 已足够）。
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'bridge-reconnect') return
  if (state === 'online' && (ws || ownerOffscreen)) return
  void connect()
})

function startHeartbeat() {
  stopHeartbeat()
  heartbeatTimer = setInterval(() => {
    if (!ws || ws.readyState !== 1) return
    ws.send(JSON.stringify({ type: 'ping', t: Date.now() }))
    // 应用层 ping 之外再补一个协议层 ping，双保险（Host 侧 ws 会自动回 pong 帧）。
    try { ws.ping?.() } catch { /* 浏览器 WebSocket 没有 ping 方法，忽略 */ }
  }, HEARTBEAT_MS)
}

function stopHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  heartbeatTimer = 0
}

// ────────────────────────────── Host 消息处理 ──────────────────────────────

async function handleHostMessage(message) {
  if (!message || typeof message.type !== 'string') return
  switch (message.type) {
    case 'ready': {
      if (typeof message.token === 'string' && message.token !== '') {
        // 首次配对成功：长效 token 落盘，之后重连不再依赖一次性配对码。
        const store = await storageGet({ clientId: '' })
        const patch = { bridgeToken: message.token, pairedAt: Date.now() }
        if (!store.clientId) patch.clientId = `ext-${crypto.randomUUID().slice(0, 8)}`
        await storageSet(patch)
        log('paired; token stored')
      }
      state = 'online'
      return
    }
    case 'sessionReady': {
      state = 'online'
      return
    }
    case 'pong': {
      return
    }
    case 'command': {
      const { id, op, args } = message
      try {
        const value = await executeCommand(String(op || ''), args && typeof args === 'object' ? args : {})
        await sendToHost({ type: 'result', id, ok: true, value })
      } catch (error) {
        const code = error && typeof error.bhCode === 'string' ? error.bhCode : 'INTERNAL'
        await sendToHost({
          type: 'result',
          id,
          ok: false,
          error: { code, message: String(error && error.message ? error.message : error) },
        })
      }
      return
    }
    case 'superseded': {
      if (ws) { try { ws.close(4001, 'superseded') } catch { /* 忽略 */ } }
      return
    }
    default: {
      // helloAck 等未知消息静默忽略，保证向前兼容。
    }
  }
}

// ────────────────────────────── 标签页管理 ──────────────────────────────

/** 取 agent 自己的标签页；不存在或已被用户关掉时返回 null。 */
async function getAgentTab() {
  if (!agentTabId) return null
  try {
    return await chrome.tabs.get(agentTabId)
  } catch {
    agentTabId = 0
    return null
  }
}

/** 把某个标签设为 agent 当前目标。 */
function bindTab(tabId) {
  agentTabId = tabId
}

/**
 * 在指定标签页的 MAIN world 执行 pageAgent 的一个 op。
 * chrome.scripting 会把 func 序列化后注入，pageAgent 自包含、无闭包引用。
 */
async function runPageAgent(tabId, op, args) {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: pageAgent,
    args: [op, args],
  })
  return injection ? injection.result : null
}

/** 受保护页面（chrome://、Web Store 等）给出可读错误，而不是裸异常。 */
function failInjection(tab, error) {
  const url = typeof tab?.url === 'string' ? tab.url : ''
  if (/^(chrome|edge|about|devtools|view-source|chrome-extension):/i.test(url)) {
    return err('NOT_INJECTABLE', `无法在浏览器内部页面（${url}）注入脚本：请先打开普通网页再操作`)
  }
  return err('INTERNAL', `注入页面脚本失败：${String(error && error.message ? error.message : error)}`)
}

function err(code, message) {
  const error = new Error(message)
  error.bhCode = code
  return error
}

/** 动作后等页面稳定（client.js settle 的轻量版：只看 DOM mutations 安静窗口）。 */
async function settle(tabId) {
  const deadline = Date.now() + 5000
  try {
    await sleep(120)
    let previous = -1
    let quietSince = Date.now()
    while (Date.now() < deadline) {
      let stateNow = null
      try {
        stateNow = await runPageAgent(tabId, 'state', {})
      } catch {
        stateNow = null
      }
      const now = Date.now()
      const mutations = stateNow && typeof stateNow.mutations === 'number' ? stateNow.mutations : -2
      if (mutations !== previous) {
        quietSince = now
        previous = mutations
      } else if (now - quietSince >= 300 && previous >= 0) {
        return
      }
      await sleep(Math.min(120, Math.max(1, deadline - now)))
    }
  } catch {
    // settle 只是优化，任何失败都不影响命令结果。
  }
}

/** 等待标签加载完成（chrome.tabs status === 'complete'），超时不算失败。 */
async function waitForComplete(tabId, budgetMs) {
  const deadline = Date.now() + Math.max(1000, budgetMs || 8000)
  while (Date.now() < deadline) {
    try {
      const tab = await chrome.tabs.get(tabId)
      if (tab.status === 'complete') {
        await sleep(200)
        return
      }
    } catch {
      return
    }
    await sleep(120)
  }
}

/** 快照参数整理（pageAgent 只认 maxElements/textLimit/scope/text/pageId）。 */
function snapshotArgs(args, pageId) {
  const out = { scope: args?.scope === 'document' ? 'document' : 'viewport' }
  if (typeof args?.maxElements === 'number' && args.maxElements > 0) out.maxElements = Math.floor(args.maxElements)
  if (typeof args?.textLimit === 'number' && args.textLimit > 0) out.textLimit = Math.floor(args.textLimit)
  if (args?.text === true) out.text = true
  if (pageId) out.pageId = pageId
  return out
}

/** 动作后的默认快照值（client.js 的 fullSnapshot 对应物）。 */
async function snapshotValue(tab, args) {
  const pageId = String(tab.id)
  const raw = await runPageAgent(tab.id, 'snapshot', snapshotArgs(args, pageId))
  if (!raw || typeof raw !== 'object') throw err('INTERNAL', '页面快照失败')
  return raw
}

// ────────────────────────────── 命令执行 ──────────────────────────────

/**
 * 执行一条 Host 命令，返回 PROTOCOL §2 形状的 value（抛错时由调用方转 error result）。
 * 支持 op 与 client.js dispatch 一一对应；扩展模式不支持的 op 明确 NOT_SUPPORTED。
 */
async function executeCommand(op, args) {
  switch (op) {
    case 'open': {
      const url = String(args.url || '')
      if (!/^https?:/i.test(url)) throw err('NAV_BLOCKED', `扩展模式只打开 http/https 页面，收到 ${url.slice(0, 120)}`)
      let tab = args.newTab === true ? null : await getAgentTab()
      if (tab) {
        await chrome.tabs.update(tab.id, { url, active: true })
        await chrome.windows.update(tab.windowId, { focused: true })
      } else {
        tab = await chrome.tabs.create({ url, active: true })
        bindTab(tab.id)
      }
      await waitForComplete(tab.id, args.waitMs)
      const fresh = await chrome.tabs.get(tab.id)
      const snapshot = await snapshotValue(fresh, args)
      return { pageId: String(fresh.id), url: fresh.url || url, title: fresh.title || '', snapshot }
    }
    case 'snapshot': {
      const tab = await requireAgentTab(args)
      const snapshot = await snapshotValue(tab, args)
      return { snapshot }
    }
    case 'find': {
      const tab = await requireAgentTab(args)
      const value = await runPageAgent(tab.id, 'find', { text: String(args.text || ''), limit: args.limit })
      if (!value || value.ok !== true) throw err((value && value.code) || 'INTERNAL', (value && value.message) || '查找失败')
      return { query: value.query, matches: value.matches }
    }
    case 'click': {
      const tab = await requireAgentTab(args)
      const before = await runPageAgent(tab.id, 'state', {})
      let value
      if (args.ref) {
        value = await runPageAgent(tab.id, 'clickDom', { ref: String(args.ref) })
        if (!value || value.ok !== true) throw err((value && value.code) || 'NO_REF', (value && value.message) || `元素 ${args.ref} 已失效，请先重新快照`)
      } else if (typeof args.x === 'number' && typeof args.y === 'number') {
        value = await runPageAgent(tab.id, 'clickAt', { x: Math.round(args.x), y: Math.round(args.y) })
        if (!value || value.ok !== true) throw err((value && value.code) || 'NO_REF', (value && value.message) || '该坐标没有元素')
      } else {
        throw err('INTERNAL', 'click 需要 ref 或 x/y')
      }
      await settle(tab.id)
      const after = await runPageAgent(tab.id, 'state', {})
      const changed = !!after && !!before && (after.url !== before.url || after.mutations !== before.mutations)
      const out = { action: 'click', changed, url: after?.url || tab.url || '', title: tab.title || '' }
      if (args.snapshot !== false) out.snapshot = await snapshotValue(tab, args)
      return out
    }
    case 'type': {
      const tab = await requireAgentTab(args)
      const ref = String(args.ref || '')
      const before = await runPageAgent(tab.id, 'state', {})
      const focus = await runPageAgent(tab.id, 'focus', { ref, clear: args.clear === true })
      if (!focus || focus.ok !== true) throw err('NO_REF', `输入框 ${ref} 已失效，请先重新快照`)
      const text = typeof args.text === 'string' ? args.text : ''
      const typed = await runPageAgent(tab.id, 'typeFallback', { ref, text, clear: args.clear !== false })
      if (!typed || typed.ok !== true) throw err((typed && typed.code) || 'INTERNAL', (typed && typed.message) || '输入失败')
      if (args.submit === true) {
        const submitted = await runPageAgent(tab.id, 'submit', { ref })
        if (!submitted || submitted.ok !== true) {
          await runPageAgent(tab.id, 'keyFallback', { key: 'Enter', code: 'Enter', keyCode: 13 })
        }
      }
      await settle(tab.id)
      const after = await runPageAgent(tab.id, 'state', {})
      const changed = !!after && !!before && (after.url !== before.url || after.mutations !== before.mutations)
      const out = { action: 'type', changed, url: after?.url || tab.url || '', title: tab.title || '' }
      if (args.snapshot !== false) out.snapshot = await snapshotValue(tab, args)
      return out
    }
    case 'select': {
      const tab = await requireAgentTab(args)
      const ref = String(args.ref || '')
      const before = await runPageAgent(tab.id, 'state', {})
      const result = await runPageAgent(tab.id, 'selectOption', { ref, value: args.value, label: args.label, index: args.index })
      if (!result || result.ok !== true) throw err((result && result.code) || 'INTERNAL', (result && result.message) || '选择选项失败')
      await settle(tab.id)
      const after = await runPageAgent(tab.id, 'state', {})
      const selected = result.selected || {}
      const out = {
        action: 'select',
        ref: result.ref || ref,
        selected: { value: String(selected.value ?? ''), label: String(selected.label ?? ''), index: Number(selected.index) },
        changed: result.changed === true || (!!after && !!before && (after.url !== before.url || after.mutations !== before.mutations)),
        url: after?.url || tab.url || '',
        title: tab.title || '',
      }
      if (args.snapshot !== false) out.snapshot = await snapshotValue(tab, args)
      return out
    }
    case 'upload': {
      const tab = await requireAgentTab(args)
      const ref = String(args.ref || '')
      const before = await runPageAgent(tab.id, 'state', {})
      const result = await runPageAgent(tab.id, 'uploadFiles', { ref, files: args.files })
      if (!result || result.ok !== true) throw err((result && result.code) || 'UPLOAD_FAILED', (result && result.message) || '上传失败')
      await settle(tab.id)
      const after = await runPageAgent(tab.id, 'state', {})
      const files = Array.isArray(result.files) ? result.files.map((file) => ({
        name: String(file && file.name ? file.name : '').split(/[\\/]/).pop() || '',
        size: Number(file && file.size) || 0,
      })) : []
      const out = {
        action: 'upload',
        ref: result.ref || ref,
        files,
        changed: result.changed === true || (!!after && !!before && (after.url !== before.url || after.mutations !== before.mutations)),
        url: after?.url || tab.url || '',
        title: tab.title || '',
      }
      if (args.snapshot !== false) out.snapshot = await snapshotValue(tab, args)
      return out
    }
    case 'press': {
      const tab = await requireAgentTab(args)
      const key = String(args.key || 'Enter')
      await runPageAgent(tab.id, 'keyFallback', { key, code: key, keyCode: 0 })
      await settle(tab.id)
      const out = { action: 'press', key, url: tab.url || '', title: tab.title || '' }
      if (args.snapshot !== false) out.snapshot = await snapshotValue(tab, args)
      return out
    }
    case 'scroll': {
      const tab = await requireAgentTab(args)
      const before = await runPageAgent(tab.id, 'state', {})
      const dom = await runPageAgent(tab.id, 'scrollDom', { dx: Number(args.dx || 0), dy: Number(args.dy || 0) })
      await settle(tab.id)
      const after = await runPageAgent(tab.id, 'state', {})
      const out = {
        action: 'scroll',
        scroll: dom && dom.ok ? dom.scroll : null,
        changed: !!after && !!before && after.scrollY !== before.scrollY,
        url: after?.url || tab.url || '',
      }
      if (args.snapshot !== false) out.snapshot = await snapshotValue(tab, args)
      return out
    }
    case 'wait': {
      const tab = await requireAgentTab(args)
      return await waitPage(tab, args)
    }
    case 'nav': {
      const tab = await requireAgentTab(args)
      const action = String(args.action || 'reload')
      if (action === 'goto') {
        const url = String(args.url || '')
        if (!/^https?:/i.test(url)) throw err('NAV_BLOCKED', `扩展模式只导航到 http/https 页面`)
        await chrome.tabs.update(tab.id, { url })
        await waitForComplete(tab.id, args.waitMs || 15000)
      } else if (action === 'back' || action === 'forward') {
        // history 导航是一次性小操作，不值得进共享 pageAgent 契约（两份副本都要动）；
        // 用内联 func 注入即可，且同样在 MAIN world。
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: 'MAIN',
          func: (where) => {
            if (where === 'back') history.back();
            else history.forward();
          },
          args: [action],
        })
        await waitForComplete(tab.id, 8000)
      } else {
        await chrome.tabs.reload(tab.id)
        await waitForComplete(tab.id, 15000)
      }
      const fresh = await chrome.tabs.get(tab.id)
      const out = { action, url: fresh.url || '', title: fresh.title || '' }
      if (args.snapshot !== false) out.snapshot = await snapshotValue(fresh, args)
      return out
    }
    case 'dialog': {
      const tab = await requireAgentTab(args)
      const result = await runPageAgent(tab.id, 'dialogArm', { action: args.action, promptText: args.promptText })
      if (!result || result.ok !== true) throw err((result && result.code) || 'INTERNAL', (result && result.message) || '预置对话框响应失败')
      return { action: 'dialog', armed: result.armed, url: tab.url || '', title: tab.title || '' }
    }
    case 'rect': {
      const tab = await requireAgentTab(args)
      const value = await runPageAgent(tab.id, 'rect', { ref: String(args.ref || '') })
      if (!value || value.ok !== true) throw err('NO_REF', `元素 ${args.ref} 已失效，请先重新快照`)
      return value
    }
    case 'tabFront': {
      return await tabFront(args)
    }
    case 'screenshot': {
      return await screenshotCommand(args)
    }
    case 'close': {
      const tab = await getAgentTab()
      let pages = 0
      if (tab) {
        pages = 1
        bindTab(0)
        await chrome.tabs.remove(tab.id)
      }
      return { closed: true, pages }
    }
    case 'ping': {
      return { pong: true, pageCount: (await getAgentTab()) ? 1 : 0 }
    }
    case 'tabs':
    case 'console':
    case 'network':
    case 'eval': {
      throw err('NOT_SUPPORTED', `扩展桥接后端不支持 ${op}${op === 'tabs' ? '（用 browser_tab_front 管理标签）' : ''}；请切换到内嵌或真实后端完成该操作`)
    }
    default: {
      throw err('INTERNAL', `未知命令: ${op}`)
    }
  }
}

/** 取 agent 目标标签；pageId 显式给出时按它找。 */
async function requireAgentTab(args) {
  if (args && typeof args.pageId === 'string' && /^-?\d+$/.test(args.pageId)) {
    const id = Number(args.pageId)
    try {
      return await chrome.tabs.get(id)
    } catch {
      throw err('NO_PAGE', `标签页 ${args.pageId} 已关闭，请用 browser_open 重新打开`)
    }
  }
  const tab = await getAgentTab()
  if (!tab) throw err('NO_PAGE', '还没有 agent 标签页：请先用 browser_open 打开一个页面')
  return tab
}

/** 条件等待（client.js waitPage 对应物；探测循环在 SW 里跑）。 */
async function waitPage(tab, args) {
  const startedAt = Date.now()
  const timeoutMs = typeof args.timeoutMs === 'number' && Number.isFinite(args.timeoutMs) ? Math.max(0, args.timeoutMs) : 10000
  const stateWanted = args.state === 'hidden' ? 'hidden' : 'visible'
  const condition = {}
  if (typeof args.text === 'string') condition.text = args.text
  else if (typeof args.selector === 'string') condition.selector = args.selector
  else condition.url = String(args.url ?? '')
  condition.state = stateWanted
  const deadline = startedAt + timeoutMs
  for (;;) {
    let probe = null
    try {
      probe = await runPageAgent(tab.id, 'waitProbe', { text: args.text, selector: args.selector, url: args.url, state: stateWanted })
    } catch (error) {
      if (error && (error.bhCode === 'INVALID_SELECTOR' || error.code === 'INVALID_SELECTOR')) {
        throw err('INVALID_SELECTOR', String(error.message || error))
      }
    }
    if (probe && probe.ok === false && probe.code === 'INVALID_SELECTOR') {
      throw err('INVALID_SELECTOR', probe.message || '无效的 CSS selector')
    }
    const now = Date.now()
    if (probe && probe.ok === true && probe.matched) {
      const value = { action: 'wait', condition, waitedMs: now - startedAt, url: tab.url || '', title: tab.title || '' }
      if (args.snapshot !== false) value.snapshot = await snapshotValue(tab, args)
      return value
    }
    if (now >= deadline) {
      throw err('WAIT_TIMEOUT', `等待条件 ${JSON.stringify(condition)} 在 ${timeoutMs}ms 内未满足`)
    }
    await sleep(Math.min(120, Math.max(1, deadline - now)))
  }
}

/** 标签管理：list 列全浏览器窗口的标签，activate 切前台并把 agent 目标重绑过去。 */
async function tabFront(args) {
  const action = String(args.action || 'list')
  const tabs = await chrome.tabs.query({})
  const ordered = tabs
    .filter((tab) => typeof tab.url === 'string')
    .sort((a, b) => (a.windowId - b.windowId) || (a.index - b.index))
    .map((tab, index) => ({
      index,
      pageId: String(tab.id),
      url: tab.url || '',
      title: tab.title || '',
      active: tab.active === true,
    }))
  if (action === 'list') {
    const active = ordered.find((tab) => tab.active === true)
    return { tabs: ordered, activeId: active ? active.pageId : null, count: ordered.length }
  }
  if (action === 'activate') {
    const hasIndex = args.index !== undefined && args.index !== null
    const hasMatch = typeof args.urlMatch === 'string' && args.urlMatch !== ''
    if (hasIndex === hasMatch) throw err('BAD_ARGUMENTS', 'activate 需要恰好提供 index 或 urlMatch 之一')
    let target = null
    if (hasIndex) {
      target = ordered[Number(args.index)] || null
      if (!target) throw err('NO_PAGE', `index ${args.index} 越界（共 ${ordered.length} 个标签）`)
    } else {
      const needle = args.urlMatch.toLowerCase()
      const hits = ordered.filter((tab) => tab.url.toLowerCase().includes(needle))
      if (hits.length === 0) throw err('NO_PAGE', `没有 URL 包含 ${args.urlMatch} 的标签`)
      if (hits.length > 1) throw err('BAD_ARG', `urlMatch 命中 ${hits.length} 个标签，需要唯一命中`)
      target = hits[0]
    }
    const tabId = Number(target.pageId)
    await chrome.tabs.update(tabId, { active: true })
    const tab = await chrome.tabs.get(tabId)
    await chrome.windows.update(tab.windowId, { focused: true })
    bindTab(tabId)
    return { activated: true, pageId: target.pageId, url: target.url, title: target.title, index: target.index }
  }
  throw err('BAD_ARGUMENTS', `tabFront 的 action 只能是 list/activate，收到 ${action}`)
}

/** 截图：captureVisibleTab 只能截「窗口当前激活标签」，agent 标签不在前台时明确报错。 */
async function screenshotCommand(args) {
  const tab = await requireAgentTab(args)
  if (tab.active !== true) {
    throw err('SCREENSHOT_NEEDS_FRONT', '截图只能截取当前前台标签：先 browser_tab_front {action:"activate", index} 把 agent 标签切到前台')
  }
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })
  const comma = dataUrl.indexOf(',')
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
  if (!base64) throw err('INTERNAL', '截图内容为空')
  let fullPage = false
  if (args?.fullPage === true) {
    // 整页截图先量高度再分步滚动拼接过于脆弱：扩展模式仅支持视口截图，如实说明。
    fullPage = true
  }
  const value = {
    action: 'screenshot',
    pngBase64: base64,
    pageId: String(tab.id),
    url: tab.url || '',
    note: fullPage ? '扩展模式仅支持视口截图（fullPage 请求已忽略）' : '',
  }
  return value
}

// ────────────────────────────── offscreen 转交与探活 ──────────────────────────────

/** offscreen 探活：SW 活着就报告当前所有权与状态。 */
async function handleProbe() {
  await refreshOwner()
  return { alive: true, state, owner: ownerOffscreen ? 'offscreen' : 'sw' }
}

/** offscreen 交还所有权：重置标记并重连自己的 WS。 */
async function handleRelease() {
  await chrome.storage.session.set({ bridgeOwner: 'sw' })
  ownerOffscreen = false
  state = 'backoff'
  scheduleReconnect()
  return { ok: true }
}

/** offscreen 转发来的 Host 消息（offscreen 持有 WS 时）——与本地消息同一处理。 */
async function handleInbound(payload) {
  await refreshOwner()
  await handleHostMessage(payload)
  return { ok: true }
}

// ────────────────────────────── runtime 消息入口 ──────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.target !== 'string' || message.target !== 'sw') return false
  void (async () => {
    try {
      switch (message.type) {
        case 'sw-probe': {
          sendResponse(await handleProbe())
          return
        }
        case 'ws-inbound': {
          sendResponse(await handleInbound(message.payload))
          return
        }
        case 'offscreen-release': {
          sendResponse(await handleRelease())
          return
        }
        case 'state-query': {
          const store = await storageGet({ clientId: '', bridgeToken: '', hostPort: 0 })
          sendResponse({
            state,
            paired: !!store.bridgeToken,
            clientId: store.clientId || '',
            hostPort: Number(store.hostPort) || DEFAULT_HOST_PORT,
            owner: ownerOffscreen ? 'offscreen' : 'sw',
            lastError,
          })
          return
        }
        case 'pair': {
          // 弹窗提交配对码：存端口 → 用配对码当 token 连接（Host 认证后回 ready+长效 token）。
          const port = Number(message.port) || DEFAULT_HOST_PORT
          await storageSet({ hostPort: port })
          if (ws) { try { ws.close(4000, 're-pairing') } catch { /* 忽略 */ } ws = undefined }
          stopHeartbeat()
          const code = String(message.code || '').trim()
          if (!code) {
            sendResponse({ ok: false, message: '缺少配对码' })
            return
          }
          disposedForPair = false
          state = 'connecting'
          await refreshOwner()
          if (ownerOffscreen) {
            // offscreen 持有连接期间不接受配对：交还所有权后（SW 复活）再试一次即可。
            sendResponse({ ok: false, message: 'offscreen 正持有连接，请关闭重开弹窗后再试' })
            return
          }
          await ensureOffscreen()
          connectWithToken(code)
          sendResponse({ ok: true })
          return
        }
        case 'unpair': {
          disposedForPair = true
          stopHeartbeat()
          clearTimeout(reconnectTimer)
          try { chrome.alarms.clear('bridge-reconnect') } catch { /* 忽略 */ }
          if (ws) { try { ws.close(4000, 'unpair') } catch { /* 忽略 */ } ws = undefined }
          await storageSet({ bridgeToken: '' })
          state = 'offline'
          lastError = ''
          sendResponse({ ok: true })
          return
        }
        case 'connect-now': {
          disposedForPair = false
          sendResponse({ ok: true })
          void connect()
          return
        }
        default: {
          sendResponse({ ok: false, message: `未知消息类型 ${String(message.type)}` })
        }
      }
    } catch (error) {
      lastError = String(error && error.message ? error.message : error)
      sendResponse({ ok: false, message: lastError })
    }
  })()
  return true // 异步 sendResponse
})

/**
 * 用给定 token（配对码或长效 token）直接开一条连接（配对流程专用）。
 * @param {string} token - token。
 * @returns {void} 无返回。
 */
function connectWithToken(token) {
  void (async () => {
    const store = await storageGet({ hostPort: 0, clientId: '' })
    const port = Number(store.hostPort) || DEFAULT_HOST_PORT
    state = 'connecting'
    try {
      ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`)
    } catch (error) {
      state = 'backoff'
      lastError = `无法创建 WebSocket：${String(error && error.message ? error.message : error)}`
      sendPairFailed(lastError)
      return
    }
    ws.onopen = () => {
      state = 'online'
      backoffMs = BACKOFF_BASE_MS
      lastError = ''
      const hello = { type: 'hello', clientId: store.clientId || undefined, version: PROTOCOL_VERSION }
      ws.send(JSON.stringify(hello))
      startHeartbeat()
      sendPairOk()
      log('pairing connection open on port', port)
    }
    ws.onmessage = (event) => {
      let message
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return
      }
      void handleHostMessage(message)
      if (message && message.type === 'ready') sendPairOk()
    }
    ws.onerror = () => {
      lastError = '配对失败：配对码可能已过期或端口不一致，请在插件里重新 browser_ext_pair'
      sendPairFailed(lastError)
    }
    ws.onclose = (event) => {
      stopHeartbeat()
      if (ws === event.target) ws = undefined
      if (disposedForPair) {
        state = 'offline'
        return
      }
      if (event.code === 4001) {
        state = 'online'
        return
      }
      state = 'backoff'
      scheduleReconnect()
    }
  })()
}

let lastPairNotice = 0

/** 通知弹窗配对结果（弹窗可能已关，失败也无所谓）。 */
function sendPairOk() {
  const now = Date.now()
  if (now - lastPairNotice < 200) return
  lastPairNotice = now
  chrome.runtime.sendMessage({ target: 'popup', type: 'pair-result', ok: true }).catch(() => {})
}

function sendPairFailed(message) {
  const now = Date.now()
  if (now - lastPairNotice < 200) return
  lastPairNotice = now
  chrome.runtime.sendMessage({ target: 'popup', type: 'pair-result', ok: false, message }).catch(() => {})
}

// ────────────────────────────── 启动 ──────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  void (async () => {
    const store = await storageGet({ clientId: '' })
    if (!store.clientId) await storageSet({ clientId: `ext-${crypto.randomUUID().slice(0, 8)}` })
    await connect()
  })()
})

chrome.runtime.onStartup.addListener(() => {
  void connect()
})

// SW 被事件唤醒（无 onStartup/onInstalled）时也要恢复连接。
void (async () => {
  const store = await storageGet({ clientId: '', bridgeToken: '' })
  if (!store.clientId) await storageSet({ clientId: `ext-${crypto.randomUUID().slice(0, 8)}` })
  await refreshOwner()
  if (ownerOffscreen) {
    await ensureOffscreen()
    return
  }
  await connect()
})()
