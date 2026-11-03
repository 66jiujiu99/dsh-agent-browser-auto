/**
 * Playwright Chrome / Edge 真实浏览器后端。
 *
 * 安全边界：
 * - launch 只使用 Agent 专用 profile；temporary 由 Playwright 创建并清理临时 profile。
 * - CDP 只连接 loopback；已有标签必须靠 pageUrl 精确匹配才会共享。
 * - 不读取日常 profile，不注入 stealth，不添加禁用浏览器安全机制的参数。
 *
 * @module dsh-agent-browser-auto/real-driver
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import path from 'node:path'
import { chromium } from 'playwright-core'

const CLIENT_ID = 'playwright'
const MAX_CONSOLE_ENTRIES = 300
const MAX_NETWORK_ENTRIES = 400
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024
const MAX_UPLOAD_FILES = 5

/**
 * 构造带稳定错误码的 Error。
 * @param {string} code - 协议错误码。
 * @param {string} message - 可读原因。
 * @param {unknown} [cause] - 原始错误。
 * @returns {Error & { code: string, cause?: unknown }} 错误。
 */
function driverError(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause })
  error.code = code
  return error
}

/** @param {unknown} value - 任意值。 @returns {boolean} 是否普通对象。 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @param {number} ms - 毫秒。 @returns {Promise<void>} 等待。 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 给命令加最后期限；具体等待条件仍会先转成 WAIT_TIMEOUT。
 * @template T
 * @param {Promise<T>} promise - 执行 Promise。
 * @param {number} timeoutMs - 总期限。
 * @param {string} op - 操作名。
 * @returns {Promise<T>} 结果。
 */
async function withTimeout(promise, timeoutMs, op) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(driverError('TIMEOUT', `真实浏览器命令 ${op} 在 ${timeoutMs}ms 后超时`)), timeoutMs)
        timer.unref?.()
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 把 Playwright 错误翻成现有工具层认识的 Error.code。
 * @param {unknown} raw - 原始错误。
 * @returns {Error & { code: string, clientId: string }} 归一化错误。
 */
function normalizeError(raw) {
  const error = raw instanceof Error ? raw : new Error(String(raw))
  if (typeof error.code !== 'string' || error.code === '') {
    const message = String(error.message || error)
    if (error.name === 'TimeoutError' || /Timeout .*exceeded|TimeoutError/i.test(message)) {
      error.code = 'TIMEOUT'
    } else if (/invalid selector|unknown selector|unexpected token.*selector/i.test(message)) {
      error.code = 'INVALID_SELECTOR'
    } else if (/target (?:page, context or browser )?(?:has been )?closed|page has been closed|browser has been closed/i.test(message)) {
      error.code = 'NO_PAGE'
    } else {
      error.code = 'INTERNAL'
    }
  }
  error.clientId = CLIENT_ID
  return error
}

/**
 * 只接受无内嵌凭据的绝对 http(s) 导航地址。Host guard 仍会再做 allowed/blockedHosts 校验。
 * @param {unknown} value - 原始 URL。
 * @returns {string} href。
 */
function requireNavUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') throw driverError('BAD_ARG', 'url 必须是非空的绝对 http(s) URL')
  let parsed
  try { parsed = new URL(value) } catch { throw driverError('BAD_ARG', `无效的绝对 URL: ${value}`) }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw driverError('BAD_ARG', '只允许 http(s) URL')
  if (parsed.username !== '' || parsed.password !== '') throw driverError('BAD_ARG', 'URL 不允许内嵌用户名或密码')
  return parsed.href
}

/**
 * 校验 CDP endpoint，拒绝远程调试端口与内嵌凭据。
 * @param {unknown} value - endpoint。
 * @returns {string} 原样 endpoint（去掉末尾斜杠）。
 */
function requireLoopbackEndpoint(value) {
  if (typeof value !== 'string' || value.trim() === '') throw driverError('BAD_ARG', 'CDP endpoint 必须是非空字符串')
  let parsed
  try { parsed = new URL(value) } catch { throw driverError('BAD_ARG', 'CDP endpoint 必须是绝对 URL') }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) {
    throw driverError('BAD_ARG', 'CDP endpoint 只允许 http(s) 或 ws(s)')
  }
  if (parsed.username !== '' || parsed.password !== '') throw driverError('BAD_ARG', 'CDP endpoint 不允许内嵌凭据')
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const family = isIP(hostname)
  const loopback = hostname === 'localhost'
    || (family === 4 && hostname.split('.')[0] === '127')
    || (family === 6 && hostname === '::1')
  if (!loopback) throw driverError('BAD_ARG', `CDP endpoint 只允许 loopback（127.0.0.0/8、localhost、::1），收到 ${parsed.hostname}`)
  return value.replace(/\/+$/, '')
}

/**
 * 有界日志队列。
 * @param {Array<object>} list - 队列。
 * @param {object} entry - 新项。
 * @param {number} cap - 上限。
 * @returns {void}
 */
function pushBounded(list, entry, cap) {
  list.push(entry)
  if (list.length > cap) list.splice(0, list.length - cap)
}

/**
 * 在单个 Playwright Frame 内收集元素。该函数会被序列化进页面，必须自包含。
 * 用会话私有 data 属性把 @ref 接到可操作 Locator；Playwright CSS 会穿透 open shadow root。
 * @param {object} options - 收集参数。
 * @returns {object} 原始 frame 数据。
 */
function harvestFrame(options) {
  let state = window[options.stateKey]
  if (!state) {
    state = window[options.stateKey] = {
      seq: 0,
      byEl: new WeakMap(),
      generation: Math.random().toString(36).slice(2) + Date.now().toString(36),
    }
  }
  const interactive = [
    'a[href]', 'button', 'input:not([type=hidden])', 'select', 'textarea', 'summary',
    '[role=button]', '[role=link]', '[role=tab]', '[role=menuitem]', '[role=menuitemcheckbox]',
    '[role=checkbox]', '[role=radio]', '[role=combobox]', '[role=switch]', '[role=slider]',
    '[role=option]', '[role=searchbox]', '[contenteditable=""]', '[contenteditable=true]',
    '[tabindex]:not([tabindex="-1"])', 'audio[controls]', 'video[controls]', 'label[for]', '[onclick]',
  ].join(',')
  const clean = (value) => String(value == null ? '' : value)
    .replace(/[\uE000-\uF8FF\u200B-\u200F\u2028\u2029\uFEFF]/g, '').replace(/\s+/g, ' ').trim()
  const textOf = (node) => clean(node && node.textContent)
  const visible = (el) => {
    if (!el || typeof el.getBoundingClientRect !== 'function') return false
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return false
    if (typeof el.checkVisibility === 'function') {
      return el.checkVisibility({ opacityProperty: true, visibilityProperty: true, checkOpacity: false })
    }
    const style = window.getComputedStyle(el)
    return style.visibility !== 'hidden' && style.display !== 'none'
  }
  const nameOf = (el) => {
    for (const key of ['aria-label', 'placeholder', 'alt', 'title']) {
      const value = clean(el.getAttribute && el.getAttribute(key))
      if (value !== '') return value.slice(0, 100)
    }
    if (el.tagName === 'INPUT' && ['submit', 'button', 'reset'].includes(String(el.type).toLowerCase())) {
      const value = clean(el.value)
      if (value !== '') return value.slice(0, 100)
    }
    if (el.id) {
      try {
        const label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]')
        const value = clean(label && label.textContent)
        if (value !== '') return value.slice(0, 100)
      } catch { /* 非法 id 不影响其它命名路径 */ }
    }
    const parentLabel = el.closest && el.closest('label')
    if (parentLabel && parentLabel !== el) {
      const value = textOf(parentLabel)
      if (value !== '') return value.slice(0, 100)
    }
    const text = textOf(el)
    if (text !== '') return text.slice(0, 100)
    return typeof el.value === 'string' ? clean(el.value).slice(0, 100) : ''
  }
  const roleOf = (el) => {
    const explicit = el.getAttribute && el.getAttribute('role')
    if (explicit) return explicit.trim().split(/\s+/)[0] || 'other'
    const tag = el.tagName
    if (tag === 'A') return 'link'
    if (tag === 'BUTTON') return 'button'
    if (tag === 'SELECT') return 'combobox'
    if (tag === 'TEXTAREA') return 'textarea'
    if (tag === 'SUMMARY') return 'button'
    if (tag === 'INPUT') {
      const type = String(el.type || 'text').toLowerCase()
      if (type === 'checkbox') return 'checkbox'
      if (type === 'radio') return 'radio'
      if (['submit', 'button', 'reset', 'image'].includes(type)) return 'button'
      if (type === 'search') return 'searchbox'
      if (type === 'range') return 'slider'
      return 'textbox'
    }
    return 'other'
  }
  const tokenFor = (el) => {
    let token = state.byEl.get(el)
    if (!token) {
      state.seq += 1
      token = 'r' + state.seq
      state.byEl.set(el, token)
      el.setAttribute(options.attr, token)
    }
    return token
  }
  const nodes = []
  const opaqueNodes = []
  let shadowRoots = 0
  const scan = (root) => {
    if (!root || !root.querySelectorAll) return
    nodes.push(...root.querySelectorAll(interactive))
    opaqueNodes.push(...root.querySelectorAll('canvas,embed,object'))
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) {
        shadowRoots += 1
        scan(el.shadowRoot)
      }
    }
  }
  scan(document)
  const elements = []
  for (const el of nodes) {
    if (!visible(el)) continue
    const rect = el.getBoundingClientRect()
    const role = roleOf(el)
    const item = {
      token: tokenFor(el), role, name: nameOf(el),
      rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
    }
    if (role === 'link') {
      const href = el.getAttribute('href') || ''
      if (href !== '') item.href = href.slice(0, 100)
    }
    if (['textbox', 'searchbox', 'textarea', 'combobox'].includes(role)) {
      const value = typeof el.value === 'string' && String(el.type).toLowerCase() !== 'file' ? el.value : ''
      if (value !== '') item.value = value.slice(0, 200)
      const placeholder = el.getAttribute && el.getAttribute('placeholder')
      if (placeholder) item.placeholder = String(placeholder).slice(0, 120)
    }
    if (['checkbox', 'radio', 'switch'].includes(role)) item.checked = !!el.checked
    if (el.disabled) item.disabled = true
    elements.push(item)
  }
  const opaque = []
  for (const el of opaqueNodes) {
    if (!visible(el)) continue
    const rect = el.getBoundingClientRect()
    opaque.push({
      kind: el.tagName.toLowerCase(), x: Math.round(rect.left), y: Math.round(rect.top),
      width: Math.round(rect.width), height: Math.round(rect.height),
      name: String(el.getAttribute('title') || el.getAttribute('name') || el.getAttribute('aria-label') || '').slice(0, 60),
    })
  }
  let text = ''
  let truncatedText = false
  if (options.text === true) {
    try { text = String(document.body ? document.body.innerText || '' : '') } catch { text = '' }
    text = text.replace(/[ \t\u00a0]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim()
    truncatedText = text.length > options.textLimit
    if (truncatedText) text = text.slice(0, options.textLimit) + '\n…'
  }
  return {
    generation: state.generation,
    elements,
    opaque,
    shadowRoots,
    text,
    truncatedText,
    scroll: {
      y: Math.round(window.scrollY),
      height: Math.round(document.documentElement ? document.documentElement.scrollHeight : 0),
      viewport: window.innerHeight,
    },
    viewport: { width: window.innerWidth, height: window.innerHeight },
  }
}

/**
 * 无语义元素命中时，在单 frame 找文字匹配的最小可见元素并给可点击坐标。
 * @param {object} options - 查询参数。
 * @returns {object|null} 坐标结果。
 */
function findFrameFallback(options) {
  let state = window[options.stateKey]
  if (!state) return null
  const needle = options.text.toLowerCase()
  const visible = (el) => {
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return false
    const style = window.getComputedStyle(el)
    return style.visibility !== 'hidden' && style.display !== 'none'
  }
  const nodes = []
  const scan = (root) => {
    if (!root || !root.querySelectorAll) return
    const all = [...root.querySelectorAll('*')]
    nodes.push(...all)
    for (const el of all) if (el.shadowRoot) scan(el.shadowRoot)
  }
  scan(document)
  let best = null
  let bestArea = Infinity
  for (const el of nodes) {
    if (!visible(el)) continue
    const text = String(el.textContent || '').replace(/\s+/g, ' ').trim()
    if (text === '' || !text.toLowerCase().includes(needle)) continue
    const rect = el.getBoundingClientRect()
    const area = rect.width * rect.height
    if (area <= 0 || area > 400000 || area >= bestArea) continue
    best = el
    bestArea = area
  }
  if (!best) return null
  let token = state.byEl.get(best)
  if (!token) {
    state.seq += 1
    token = 'r' + state.seq
    state.byEl.set(best, token)
    best.setAttribute(options.attr, token)
  }
  best.scrollIntoView({ block: 'center', inline: 'center' })
  const rect = best.getBoundingClientRect()
  return {
    generation: state.generation,
    token,
    name: String(best.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
    rect: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width: rect.width, height: rect.height },
  }
}

/**
 * 页面变化探针；MutationObserver 只用于 changed/settle，不承担快照。
 * @param {string} stateKey - 会话私有键。
 * @returns {object} 当前状态。
 */
function pageProbe(stateKey) {
  let state = window[stateKey]
  if (!state) {
    state = window[stateKey] = { mutations: 0, installed: false }
  }
  if (!state.installed && document.documentElement) {
    state.installed = true
    try {
      const observer = new MutationObserver((records) => { state.mutations += records.length })
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true })
    } catch { /* 页面权限或销毁阶段不阻塞命令 */ }
  }
  return {
    url: location.href,
    title: document.title || '',
    mutations: state.mutations,
    scrollY: Math.round(window.scrollY),
    scrollX: Math.round(window.scrollX),
  }
}

/**
 * 创建真实浏览器驱动。
 * @param {object} options - 依赖。
 * @param {object} options.config - ResolvedConfig；需要 realBrowser 与 auditDir。
 * {object} [options.log] - 可选日志器。
 * @returns {object} 驱动 API。
 */
export function createRealDriver({ config, log } = {}) {
  if (!isRecord(config)) throw driverError('BAD_ARG', 'createRealDriver 需要 config')
  const realConfig = isRecord(config.realBrowser) ? config.realBrowser : {}
  const startupTimeoutMs = Number.isSafeInteger(realConfig.startupTimeoutMs) ? realConfig.startupTimeoutMs : 30_000
  const commandTimeoutMs = Number.isSafeInteger(config.commandTimeoutMs) ? config.commandTimeoutMs : 45_000
  const sessions = new Map()
  let pageSequence = 0
  let disposed = false

  const writeLog = (level, message, data) => {
    try {
      if (typeof log === 'function') log(level, message, data)
      else if (log && typeof log[level] === 'function') log[level](message, data)
    } catch { /* 日志不能影响浏览器生命周期 */ }
  }

  const assertActiveDriver = () => {
    if (disposed) throw driverError('NO_PAGE', '真实浏览器驱动已释放')
  }

  /**
   * 会话页面对象的同步诊断。
   * @param {object} session - 会话。
   * @returns {object} 状态。
   */
  function statusOf(session) {
    return {
      sessionId: session.id,
      connected: session.connected === true,
      clientId: CLIENT_ID,
      mode: session.mode,
      browser: session.browser,
      temporary: session.temporary,
      profileDir: session.profileDir,
      endpoint: session.endpoint,
      pageCount: session.pages.size,
      activeId: session.activeId,
    }
  }

  /**
   * 将 Frame 内坐标换算到顶层视口。
   * @param {import('playwright-core').Frame} frame - frame。
   * @returns {Promise<{x:number,y:number}>} 偏移。
   */
  async function frameOffset(frame) {
    let x = 0
    let y = 0
    let current = frame
    while (current.parentFrame()) {
      const owner = await current.frameElement()
      try {
        const own = await owner.evaluate((el) => {
          const rect = el.getBoundingClientRect()
          return { x: rect.left + (el.clientLeft || 0), y: rect.top + (el.clientTop || 0) }
        })
        x += own.x
        y += own.y
      } finally {
        await owner.dispose().catch(() => {})
      }
      current = current.parentFrame()
    }
    return { x, y }
  }

  /**
   * 给 harvest 的 token 分配会话稳定 @ref。
   * @param {object} record - 页面记录。
   * @param {import('playwright-core').Frame} frame - frame。
   * @param {object} raw - harvest 项。
   * @returns {string} @ref。
   */
  function refFor(record, frame, raw) {
    let frameId = record.frameIds.get(frame)
    if (!frameId) {
      record.frameSequence += 1
      frameId = `f${record.frameSequence}`
      record.frameIds.set(frame, frameId)
    }
    const key = `${frameId}:${raw.generation}:${raw.token}`
    let ref = record.refByKey.get(key)
    if (!ref) {
      record.refSequence += 1
      ref = `@e${record.refSequence}`
      record.refByKey.set(key, ref)
      record.refs.set(ref, { frame, token: raw.token, role: raw.role, name: raw.name })
      if (record.refs.size > 5000) {
        const oldest = record.refs.keys().next().value
        if (oldest) record.refs.delete(oldest)
      }
    }
    return ref
  }

  /**
   * 拍当前页快照，并更新可操作 ref 表。
   * @param {object} record - 页面记录。
   * @param {object} [args] - 快照参数。
   * @returns {Promise<object>} 与 client pageAgent 相同的主要 schema。
   */
  async function snapshotOf(record, args = {}) {
    if (!record || record.page.isClosed()) throw driverError('NO_PAGE', '页面已关闭')
    const scope = args.scope === 'document' ? 'document' : 'viewport'
    const maxElements = Number.isFinite(args.maxElements) && args.maxElements > 0 ? Math.floor(args.maxElements) : 80
    const textLimit = Number.isFinite(args.textLimit) && args.textLimit > 0 ? Math.floor(args.textLimit) : 3000
    const frames = record.page.frames()
    const mainFrame = record.page.mainFrame()
    const mainOrigin = (() => { try { return new URL(mainFrame.url()).origin } catch { return 'null' } })()
    const output = []
    const opaque = []
    let offscreen = 0
    let truncatedElements = false
    let truncatedText = false
    let text = ''
    let scroll = { y: 0, height: 0, viewport: 0 }
    let topViewport = { width: 0, height: 0 }
    const frameStats = { shadowRoots: 0, sameOrigin: 0, crossOrigin: 0 }

    for (const frame of frames) {
      if (truncatedElements) break
      let harvested
      let offset
      try {
        harvested = await frame.evaluate(harvestFrame, {
          attr: record.attr,
          stateKey: record.stateKey,
          text: frame === mainFrame && args.text === true,
          textLimit,
        })
        offset = await frameOffset(frame)
      } catch (error) {
        writeLog('debug', 'real-driver frame snapshot skipped', { error: String(error) })
        continue
      }
      if (frame === mainFrame) {
        text = harvested.text
        truncatedText = harvested.truncatedText
        scroll = harvested.scroll
        topViewport = harvested.viewport
      }
      frameStats.shadowRoots += harvested.shadowRoots
      if (frame !== mainFrame) {
        const origin = (() => { try { return new URL(frame.url()).origin } catch { return 'null' } })()
        if (origin === mainOrigin || origin === 'null') frameStats.sameOrigin += 1
        else frameStats.crossOrigin += 1
      }
      for (const raw of harvested.elements) {
        if (output.length >= maxElements) {
          truncatedElements = true
          break
        }
        const rect = {
          x: raw.rect.x + offset.x,
          y: raw.rect.y + offset.y,
          width: raw.rect.width,
          height: raw.rect.height,
        }
        const inViewport = rect.y + rect.height > 0 && rect.y < topViewport.height
          && rect.x + rect.width > 0 && rect.x < topViewport.width
        if (scope === 'viewport' && !inViewport) {
          offscreen += 1
          continue
        }
        const { token, generation, rect: ignored, ...element } = raw
        element.ref = refFor(record, frame, { ...raw, generation })
        element.inViewport = inViewport
        output.push(element)
      }
      for (const item of harvested.opaque) {
        opaque.push({ ...item, x: Math.round(item.x + offset.x), y: Math.round(item.y + offset.y) })
      }
    }
    return {
      pageId: record.id,
      url: record.page.url(),
      title: await record.page.title(),
      scope,
      offscreen: scope === 'viewport' ? offscreen : 0,
      scroll,
      text,
      elements: output,
      opaque,
      frames: frameStats,
      truncated: { text: truncatedText, elements: truncatedElements },
    }
  }

  /**
   * 把 @ref 解析成 Playwright Locator。
   * @param {object} record - 页面记录。
   * @param {unknown} ref - @ref。
   * @returns {Promise<import('playwright-core').Locator>} locator。
   */
  async function locatorFor(record, ref) {
    const key = typeof ref === 'string' ? ref : ''
    const entry = record.refs.get(key)
    if (!entry || entry.frame.isDetached()) {
      throw driverError('NO_REF', `元素 ${key || '(empty)'} 已失效，请先重新快照`)
    }
    const locator = entry.frame.locator(`[${record.attr}="${entry.token}"]`).first()
    let count = 0
    try { count = await locator.count() } catch (error) { throw normalizeError(error) }
    if (count === 0) throw driverError('NO_REF', `元素 ${key} 已失效（页面可能已跳转或重渲染），请先重新快照`)
    return locator
  }

  /**
   * 注册一个属于本 session 的 Page。其它 CDP 会话/用户已有页不会被自动登记。
   * @param {object} session - 会话。
   * @param {import('playwright-core').Page} page - Playwright Page。
   * @param {object} [options] - 是否明确共享。
   * @returns {object} 页面记录。
   */
  function adoptPage(session, page, { shared = false } = {}) {
    const existing = session.pageRecords.get(page)
    if (existing) {
      session.activeId = existing.id
      return existing
    }
    pageSequence += 1
    const id = `p${pageSequence}`
    const nonce = randomUUID().replaceAll('-', '').slice(0, 16)
    const record = {
      id,
      page,
      session,
      shared,
      attr: `data-dsh-rd-${nonce}`,
      stateKey: `__dshRealRefs_${nonce}`,
      probeKey: `__dshRealProbe_${nonce}`,
      refs: new Map(),
      refByKey: new Map(),
      refSequence: 0,
      frameSequence: 0,
      frameIds: new WeakMap(),
      consoleEntries: [],
      networkEntries: [],
      lastDialog: null,
    }
    session.pages.set(id, record)
    session.pageRecords.set(page, record)
    session.activeId = id

    page.on('close', () => {
      session.pages.delete(id)
      if (session.activeId === id) {
        const remaining = [...session.pages.keys()]
        session.activeId = remaining.length > 0 ? remaining[remaining.length - 1] : null
      }
    })
    page.on('console', (message) => {
      const location = message.location()
      pushBounded(record.consoleEntries, {
        level: message.type(),
        text: message.text().slice(0, 500),
        url: location.url ? location.url.slice(0, 200) : undefined,
        line: location.lineNumber,
      }, MAX_CONSOLE_ENTRIES)
    })
    page.on('pageerror', (error) => {
      pushBounded(record.consoleEntries, { level: 'error', text: String(error.message || error).slice(0, 500) }, MAX_CONSOLE_ENTRIES)
    })
    page.on('response', (response) => {
      const request = response.request()
      pushBounded(record.networkEntries, {
        url: response.url().slice(0, 300),
        method: request.method(),
        status: response.status(),
        ok: response.ok(),
      }, MAX_NETWORK_ENTRIES)
    })
    page.on('requestfailed', (request) => {
      pushBounded(record.networkEntries, {
        url: request.url().slice(0, 300),
        method: request.method(),
        ok: false,
        failure: String(request.failure()?.errorText || 'request failed').slice(0, 300),
      }, MAX_NETWORK_ENTRIES)
    })
    page.on('dialog', (dialog) => {
      void (async () => {
        const armed = session.armedDialog || null
        session.armedDialog = null
        const action = armed ? armed.action : 'dismiss'
        try {
          if (action === 'accept') await dialog.accept(armed.promptText)
          else await dialog.dismiss()
          record.lastDialog = {
            type: dialog.type(), message: dialog.message().slice(0, 1000), action,
            promptText: dialog.type() === 'prompt' && action === 'accept' ? armed.promptText ?? dialog.defaultValue() : null,
            automatic: armed === null,
            at: Date.now(),
          }
        } catch (error) {
          writeLog('warn', 'real-driver dialog handling failed', { error: String(error) })
        }
      })()
    })
    return record
  }

  /**
   * 新建并登记会话页面。
   * @param {object} session - 会话。
   * @returns {Promise<object>} 页面记录。
   */
  async function newPage(session) {
    assertActiveDriver()
    if (!session.connected) throw driverError('NO_PAGE', '真实浏览器会话未连接')
    try {
      const page = await session.context.newPage()
      return adoptPage(session, page)
    } catch (error) {
      throw normalizeError(error)
    }
  }

  /**
   * 取活动页，缺页时按现有 client.ensurePage 语义创建。
   * @param {object} session - 会话。
   * @param {boolean} [create=true] - 是否允许创建。
   * @returns {Promise<object|null>} 页面记录。
   */
  async function activePage(session, create = true) {
    if (!session.connected) throw driverError('NO_PAGE', '真实浏览器会话未连接')
    const active = session.pages.get(session.activeId)
    if (active && !active.page.isClosed()) return active
    session.activeId = null
    if (create) return await newPage(session)
    return null
  }

  /** @param {object} record - 页面。 @returns {Promise<object>} 探针。 */
  async function probe(record) {
    try {
      return await record.page.evaluate(pageProbe, record.probeKey)
    } catch (error) {
      throw normalizeError(error)
    }
  }

  /** @param {object} record - 页面。 @returns {Promise<void>} 短稳定等待。 */
  async function settle(record) {
    await sleep(120)
    try { await record.page.waitForLoadState('domcontentloaded', { timeout: 1500 }) } catch { /* 慢加载由快照呈现 */ }
    await sleep(120)
  }

  /** @param {object} record - 页面。 @param {object} [args] - 参数。 @returns {Promise<object>} tabs 快照之外的 action 结果。 */
  async function pageHeader(record, args) {
    const value = { url: record.page.url(), title: await record.page.title() }
    if (args?.snapshot !== false) value.snapshot = await snapshotOf(record, args)
    return value
  }

  /** @param {object} session - 会话。 @param {object} value - 返回值。 @returns {void} */
  function rememberUrl(session, value) {
    const direct = isRecord(value) && typeof value.url === 'string' ? value.url : undefined
    const nested = isRecord(value) && isRecord(value.snapshot) && typeof value.snapshot.url === 'string' ? value.snapshot.url : undefined
    const url = direct || nested
    if (url) session.lastUrl = url
  }

  /**
   * 多标签返回值；只列 session.pages，不读 context.pages 里的未共享页。
   * @param {object} session - 会话。
   * @returns {Promise<object>} tabs value。
   */
  async function tabsValue(session) {
    const tabs = []
    for (const record of session.pages.values()) {
      if (record.page.isClosed()) continue
      tabs.push({
        id: record.id,
        url: record.page.url(),
        title: await record.page.title().catch(() => ''),
        active: record.id === session.activeId,
      })
    }
    return { tabs, activeId: session.activeId || null }
  }

  /**
   * 原生 select 选择。
   * @param {object} record - 页面。
   * @param {import('playwright-core').Locator} locator - select locator。
   * @param {object} args - 选择参数。
   * @param {number} timeoutMs - 动作超时。
   * @returns {Promise<object>} selected 与 changed。
   */
  async function selectNative(record, locator, args, timeoutMs) {
    const before = await locator.evaluate((el) => el.selectedIndex)
    const candidates = await locator.locator('option').evaluateAll((options) => options.map((option, index) => ({
      value: String(option.value ?? ''), label: String(option.label || option.text || '').replace(/\s+/g, ' ').trim(), index,
    })))
    const key = ['value', 'label', 'index'].find((name) => Object.hasOwn(args, name))
    let picked
    if (key === 'index') picked = candidates[args.index]
    else if (key === 'value') picked = candidates.find((option) => option.value === String(args.value))
    else picked = candidates.find((option) => option.label === String(args.label).replace(/\s+/g, ' ').trim())
    if (!picked) {
      const shown = candidates.slice(0, 8).map((option) => `[${option.index}] ${JSON.stringify(option.label)} value=${JSON.stringify(option.value)}`).join(' | ')
      throw driverError('OPTION_NOT_FOUND', `找不到匹配选项；候选（最多 8 个）: ${shown || '（无）'}`)
    }
    try {
      await locator.selectOption({ [key]: args[key] }, { timeout: timeoutMs })
    } catch (error) {
      throw driverError('OPTION_NOT_FOUND', `设置原生 select 失败：${String(error.message || error)}`, error)
    }
    return { selected: picked, changed: before !== picked.index }
  }

  /**
   * 常见自定义下拉选择。
   * @param {object} record - 页面。
   * @param {object} entry - ref entry（含 frame）。
   * @param {import('playwright-core').Locator} locator - trigger。
   * @param {object} args - 参数。
   * @param {number} timeoutMs - 动作超时。
   * @returns {Promise<object>} selected/changed。
   */
  async function selectCustom(record, entry, locator, args, timeoutMs) {
    const expanded = await locator.evaluate((el) => ({
      combobox: el.getAttribute('role') === 'combobox' || el.tagName === 'SELECT',
      popup: el.getAttribute('aria-haspopup') || '',
    }))
    await locator.click({ timeout: timeoutMs })
    await sleep(180)
    const base = entry.frame.locator('[role=option],[role=menuitem],[role=menuitemradio],[role=menuitemcheckbox],li')
    const count = await base.count()
    const candidates = []
    for (let index = 0; index < count; index += 1) {
      const option = base.nth(index)
      if (!await option.isVisible().catch(() => false)) continue
      const data = await option.evaluate((el) => {
        const role = el.getAttribute('role')
        if (el.tagName === 'LI' && !role && !el.closest('[role=listbox],[role=menu]')) return null
        return {
          label: String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200),
          value: el.getAttribute('value') ?? el.getAttribute('data-value') ?? '',
        }
      })
      if (data) candidates.push({ ...data, index: candidates.length, locator: option })
    }
    if (candidates.length === 0) {
      if (expanded.combobox || ['listbox', 'menu', 'true'].includes(expanded.popup)) throw driverError('OPTION_NOT_FOUND', '下拉框打开后没有可见选项')
      throw driverError('NOT_SELECT', '目标不是原生 select，点击后也没有可见下拉选项')
    }
    const key = ['value', 'label', 'index'].find((name) => Object.hasOwn(args, name))
    let picked
    if (key === 'index') picked = candidates[args.index]
    else if (key === 'value') picked = candidates.find((option) => String(option.value) === String(args.value))
    else {
      const wanted = String(args.label).replace(/\s+/g, ' ').trim()
      picked = candidates.find((option) => option.label === wanted)
      if (!picked && wanted !== '') {
        const partial = candidates.filter((option) => option.label.includes(wanted))
        if (partial.length === 1) picked = partial[0]
      }
    }
    if (!picked) {
      const shown = candidates.slice(0, 8).map((option) => `[${option.index}] ${JSON.stringify(option.label)} value=${JSON.stringify(option.value)}`).join(' | ')
      throw driverError('OPTION_NOT_FOUND', `找不到匹配选项；候选（最多 8 个）: ${shown}`)
    }
    await picked.locator.click({ timeout: timeoutMs })
    return {
      selected: { value: String(picked.value), label: picked.label, index: picked.index },
      changed: true,
    }
  }

  /**
   * 命令分发。返回值刻意复用 client.js dispatch 的 value 形状。
   * @param {object} session - 会话。
   * @param {string} op - 操作。
   * @param {object} args - 参数。
   * @param {number} timeoutMs - 命令期限。
   * @returns {Promise<object>} value。
   */
  async function dispatch(session, op, args, timeoutMs) {
    const actionTimeout = Math.max(1000, Math.min(timeoutMs || commandTimeoutMs, 15_000))
    if (op === 'tabs') {
      const action = String(args.action || 'list')
      if (action === 'new') {
        await newPage(session)
      } else if (action === 'switch') {
        const target = session.pages.get(String(args.id || ''))
        if (!target || target.page.isClosed()) throw driverError('NO_PAGE', `没有这个页面: ${args.id}`)
        session.activeId = target.id
        await target.page.bringToFront().catch(() => {})
      } else if (action === 'close') {
        const id = args.id ? String(args.id) : session.activeId
        const target = session.pages.get(id)
        if (target) await target.page.close({ runBeforeUnload: false })
      } else if (action !== 'list') {
        throw driverError('BAD_ARG', `未知 tabs action: ${action}`)
      }
      return await tabsValue(session)
    }
    if (op === 'close') {
      const records = [...session.pages.values()]
      for (const record of records) await record.page.close({ runBeforeUnload: false }).catch(() => {})
      session.activeId = null
      return { closed: true, pages: records.length }
    }
    if (op === 'ping') return { pong: true, pageCount: session.pages.size }
    if (op === 'console' || op === 'network') {
      const record = await activePage(session, false)
      if (!record) return { entries: [] }
      const fallback = op === 'console' ? 50 : 60
      const limit = Number.isFinite(args.limit) && args.limit > 0 ? Math.min(200, Math.floor(args.limit)) : fallback
      const entries = op === 'console' ? record.consoleEntries : record.networkEntries
      return { entries: entries.slice(-limit) }
    }

    const record = await activePage(session)
    const page = record.page
    switch (op) {
      case 'open': {
        const target = args.newTab === true ? await newPage(session) : record
        const url = requireNavUrl(args.url)
        try {
          await target.page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.max(3000, Number(args.waitMs) || 15_000) })
        } catch (error) {
          if (error.name === 'TimeoutError') throw driverError('TIMEOUT', `页面在指定期限内未加载完: ${url}`, error)
          throw driverError('LOAD_FAILED', `页面加载失败: ${String(error.message || error)}`, error)
        }
        await settle(target)
        return { pageId: target.id, ...(await pageHeader(target, args)) }
      }
      case 'snapshot':
        return { snapshot: await snapshotOf(record, args) }
      case 'click': {
        const before = await probe(record)
        if (args.ref !== undefined) {
          const locator = await locatorFor(record, args.ref)
          await locator.click({ timeout: actionTimeout })
        } else if (Number.isFinite(args.x) && Number.isFinite(args.y)) {
          await page.mouse.click(args.x, args.y)
        } else {
          throw driverError('BAD_ARG', 'click 需要 ref 或有限的 x/y 坐标')
        }
        await settle(record)
        const after = await probe(record)
        return { action: 'click', changed: before.url !== after.url || before.mutations !== after.mutations, ...(await pageHeader(record, args)) }
      }
      case 'type': {
        const locator = await locatorFor(record, args.ref)
        if (typeof args.text !== 'string') throw driverError('BAD_ARG', 'type.text 必须是字符串')
        const editable = await locator.evaluate((el) => ({
          ok: el.isContentEditable || ['INPUT', 'TEXTAREA'].includes(el.tagName),
          readOnly: !!el.readOnly,
          value: el.isContentEditable ? String(el.textContent || '') : String(el.value || ''),
        }))
        if (!editable.ok || editable.readOnly) throw driverError('BAD_ARG', '目标不是可编辑的 input/textarea/contenteditable')
        const before = await probe(record)
        await locator.focus()
        if (args.clear === true) await locator.fill('')
        if (args.text !== '') await locator.pressSequentially(args.text, { timeout: actionTimeout })
        if (args.submit === true) await locator.press('Enter', { timeout: actionTimeout })
        await settle(record)
        const after = await probe(record)
        const finalValue = await locator.evaluate((el) => el.isContentEditable ? String(el.textContent || '') : String(el.value || '')).catch(() => editable.value)
        return {
          action: 'type',
          changed: before.url !== after.url || before.mutations !== after.mutations || editable.value !== finalValue,
          ...(await pageHeader(record, args)),
        }
      }
      case 'press': {
        if (typeof args.key !== 'string' || args.key === '') throw driverError('BAD_ARG', 'press.key 必须是非空字符串')
        const before = await probe(record)
        await page.keyboard.press(args.key, { timeout: actionTimeout })
        await settle(record)
        const after = await probe(record)
        return { action: 'press', key: args.key, changed: before.url !== after.url || before.mutations !== after.mutations, ...(await pageHeader(record, args)) }
      }
      case 'scroll': {
        if (!Number.isFinite(args.dy) || (args.dx !== undefined && !Number.isFinite(args.dx))) throw driverError('BAD_ARG', 'scroll 需要有限的 dy/dx')
        const dx = Number(args.dx || 0)
        const dy = Number(args.dy)
        const before = await probe(record)
        const viewport = page.viewportSize() || { width: 1280, height: 720 }
        await page.mouse.move(Math.min(120, Math.max(1, viewport.width - 1)), Math.round(viewport.height / 2))
        await page.mouse.wheel(dx, dy)
        await sleep(200)
        let after = await probe(record)
        if (before.scrollY === after.scrollY && before.scrollX === after.scrollX && (dx !== 0 || dy !== 0)) {
          await page.evaluate(({ dx: x, dy: y }) => window.scrollBy(x, y), { dx, dy })
          await sleep(120)
          after = await probe(record)
        }
        await settle(record)
        after = await probe(record)
        const dimensions = await page.evaluate(() => ({ height: Math.round(document.documentElement?.scrollHeight || 0), viewport: window.innerHeight }))
        return {
          action: 'scroll',
          changed: before.scrollY !== after.scrollY || before.scrollX !== after.scrollX,
          scroll: { y: after.scrollY, height: dimensions.height, viewport: dimensions.viewport },
          ...(await pageHeader(record, args)),
        }
      }
      case 'nav': {
        const action = String(args.action || 'reload')
        const beforeUrl = page.url()
        try {
          if (action === 'goto') await page.goto(requireNavUrl(args.url), { waitUntil: 'domcontentloaded', timeout: actionTimeout })
          else if (action === 'back') {
            const response = await page.goBack({ waitUntil: 'domcontentloaded', timeout: actionTimeout })
            if (!response && page.url() === beforeUrl) throw driverError('NAV_BLOCKED', '没有可后退的历史')
          } else if (action === 'forward') {
            const response = await page.goForward({ waitUntil: 'domcontentloaded', timeout: actionTimeout })
            if (!response && page.url() === beforeUrl) throw driverError('NAV_BLOCKED', '没有可前进的历史')
          } else if (action === 'reload') await page.reload({ waitUntil: 'domcontentloaded', timeout: actionTimeout })
          else throw driverError('BAD_ARG', `未知 nav action: ${action}`)
        } catch (error) {
          if (error.code) throw error
          if (error.name === 'TimeoutError') throw driverError('TIMEOUT', `导航 ${action} 超时`, error)
          throw driverError('LOAD_FAILED', `导航 ${action} 失败：${String(error.message || error)}`, error)
        }
        await settle(record)
        return { action, ...(await pageHeader(record, args)) }
      }
      case 'find': {
        const needle = typeof args.text === 'string' ? args.text.trim() : ''
        if (needle === '') throw driverError('BAD_ARG', 'find 需要非空 text')
        const limit = Number.isFinite(args.limit) && args.limit > 0 ? Math.min(50, Math.floor(args.limit)) : 20
        const snapshot = await snapshotOf(record, { scope: 'document', maxElements: 5000 })
        const folded = needle.toLowerCase()
        const matches = snapshot.elements.filter((element) => `${element.name || ''} ${element.value || ''}`.toLowerCase().includes(folded))
          .slice(0, limit).map((element) => ({
            ref: element.ref, role: element.role, name: element.name, inViewport: element.inViewport,
          }))
        if (matches.length > 0) {
          const first = await locatorFor(record, matches[0].ref)
          await first.scrollIntoViewIfNeeded({ timeout: actionTimeout }).catch(() => {})
          matches[0].inViewport = true
        } else {
          for (const frame of page.frames()) {
            let found
            try {
              found = await frame.evaluate(findFrameFallback, { text: needle, attr: record.attr, stateKey: record.stateKey })
            } catch { continue }
            if (!found) continue
            const offset = await frameOffset(frame)
            matches.push({
              ref: '', role: 'element', name: found.name, inViewport: true,
              x: Math.round(found.rect.x + offset.x), y: Math.round(found.rect.y + offset.y), fallback: true,
            })
            break
          }
        }
        return { query: args.text, matches }
      }
      case 'wait': {
        const supplied = ['text', 'selector', 'url'].filter((key) => args[key] !== undefined && args[key] !== null)
        if (supplied.length !== 1) throw driverError('BAD_ARG', 'wait 必须在 text / selector / url 中恰好提供一个')
        const key = supplied[0]
        if (typeof args[key] !== 'string' || args[key] === '') throw driverError('BAD_ARG', `wait.${key} 必须是非空字符串`)
        const waitMs = Number.isFinite(args.timeoutMs) ? Math.max(0, Math.floor(args.timeoutMs)) : 10_000
        const state = args.state === 'hidden' ? 'hidden' : 'visible'
        const condition = { [key]: args[key], state }
        const startedAt = Date.now()
        try {
          if (key === 'url') {
            await page.waitForURL((url) => url.href.includes(args.url), { timeout: waitMs })
          } else if (key === 'selector') {
            await page.waitForSelector(args.selector, { state, timeout: waitMs })
          } else {
            await page.waitForFunction(({ text, state: wanted }) => {
              const body = String(document.body ? document.body.innerText || '' : '')
              const found = body.includes(text)
              return wanted === 'hidden' ? !found : found
            }, { text: args.text, state }, { timeout: waitMs })
          }
        } catch (error) {
          if (/selector/i.test(String(error.message || '')) && error.name !== 'TimeoutError') {
            throw driverError('INVALID_SELECTOR', String(error.message || error), error)
          }
          if (error.name === 'TimeoutError' || /Timeout/i.test(String(error.message || ''))) {
            throw driverError('WAIT_TIMEOUT', `等待条件 ${JSON.stringify(condition)} 在 ${waitMs}ms 内未满足`, error)
          }
          throw error
        }
        return {
          action: 'wait', condition, waitedMs: Date.now() - startedAt,
          ...(await pageHeader(record, args)),
        }
      }
      case 'select': {
        const keys = ['value', 'label', 'index'].filter((key) => Object.hasOwn(args, key))
        if (keys.length !== 1) throw driverError('BAD_ARG', 'select 必须在 value / label / index 中恰好提供一个')
        if (keys[0] === 'index' && (!Number.isSafeInteger(args.index) || args.index < 0)) throw driverError('BAD_ARG', 'select.index 必须是零基非负整数')
        const entry = record.refs.get(String(args.ref || ''))
        const locator = await locatorFor(record, args.ref)
        const tag = await locator.evaluate((el) => el.tagName)
        const before = await probe(record)
        const result = tag === 'SELECT'
          ? await selectNative(record, locator, args, actionTimeout)
          : await selectCustom(record, entry, locator, args, actionTimeout)
        await settle(record)
        const after = await probe(record)
        return {
          action: 'select', ref: String(args.ref), selected: result.selected,
          changed: result.changed || before.url !== after.url || before.mutations !== after.mutations,
          ...(await pageHeader(record, args)),
        }
      }
      case 'upload': {
        if (Object.hasOwn(args, 'paths')) throw driverError('BAD_ARG', '真实驱动 upload 不接收真实路径，只接受 Host 转换后的 base64 files')
        if (!Array.isArray(args.files) || args.files.length < 1 || args.files.length > MAX_UPLOAD_FILES) {
          throw driverError('UPLOAD_FAILED', `files 必须包含 1~${MAX_UPLOAD_FILES} 个 base64 文件`)
        }
        const locator = await locatorFor(record, args.ref)
        const input = await locator.evaluate((el) => ({ file: el.tagName === 'INPUT' && String(el.type).toLowerCase() === 'file', multiple: !!el.multiple }))
        if (!input.file) throw driverError('NOT_FILE_INPUT', '目标元素不是 input[type=file]')
        if (!input.multiple && args.files.length > 1) throw driverError('UPLOAD_FAILED', '该文件输入框不允许多选')
        let total = 0
        const payloads = args.files.map((file, index) => {
          if (!isRecord(file) || typeof file.base64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.base64)) {
            throw driverError('UPLOAD_FAILED', `第 ${index + 1} 个文件缺少有效的纯 base64 内容`)
          }
          const buffer = Buffer.from(file.base64, 'base64')
          total += buffer.length
          if (total > MAX_UPLOAD_BYTES) throw driverError('UPLOAD_TOO_LARGE', '上传文件总大小不能超过 8 MiB')
          const rawName = typeof file.name === 'string' && file.name !== '' ? file.name : 'upload.bin'
          return {
            name: rawName.split(/[\\/]/).pop() || 'upload.bin',
            mimeType: typeof file.type === 'string' && file.type !== '' ? file.type : 'application/octet-stream',
            buffer,
          }
        })
        const before = await locator.evaluate((el) => [...(el.files || [])].map((file) => `${file.name}:${file.size}`).join('|'))
        await locator.setInputFiles(payloads, { timeout: actionTimeout })
        const files = await locator.evaluate((el) => [...(el.files || [])].map((file) => ({ name: file.name, size: file.size })))
        const after = [...files].map((file) => `${file.name}:${file.size}`).join('|')
        await settle(record)
        return { action: 'upload', ref: String(args.ref), files, changed: before !== after, ...(await pageHeader(record, args)) }
      }
      case 'dialog': {
        if (!['accept', 'dismiss'].includes(args.action)) throw driverError('BAD_ARG', 'dialog.action 必须是 accept 或 dismiss')
        if (args.promptText !== undefined && typeof args.promptText !== 'string') throw driverError('BAD_ARG', 'dialog.promptText 必须是字符串')
        if (args.action === 'dismiss' && args.promptText !== undefined) throw driverError('BAD_ARG', 'dismiss 不需要 promptText')
        session.armedDialog = { action: args.action }
        if (typeof args.promptText === 'string') session.armedDialog.promptText = args.promptText
        return { action: 'dialog', armed: { ...session.armedDialog }, url: page.url(), title: await page.title() }
      }
      case 'eval': {
        if (typeof args.code !== 'string' || args.code === '') throw driverError('BAD_ARG', 'eval.code 必须是非空字符串')
        try {
          const result = await page.evaluate((code) => {
            const value = (0, eval)(code)
            try { return JSON.parse(JSON.stringify(value)) } catch { return String(value) }
          }, args.code)
          return { value: result }
        } catch (error) {
          throw driverError('INTERNAL', `页面求值失败：${String(error.message || error)}`, error)
        }
      }
      case 'screenshot': {
        const directory = path.join(path.resolve(config.auditDir || process.cwd()), 'shots')
        await mkdir(directory, { recursive: true })
        const filePath = path.join(directory, `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}.png`)
        const buffer = await page.screenshot({ fullPage: args.fullPage === true, type: 'png', timeout: actionTimeout })
        await writeFile(filePath, buffer)
        const info = await stat(filePath)
        return {
          path: filePath,
          bytes: info.size,
          width: buffer.length >= 24 ? buffer.readUInt32BE(16) : 0,
          height: buffer.length >= 24 ? buffer.readUInt32BE(20) : 0,
          pageId: record.id,
          url: page.url(),
        }
      }
      default:
        throw driverError('INTERNAL', `未知真实浏览器命令: ${op}`)
    }
  }

  /**
   * 关闭 session 页面并处理浏览器连接。
   * @param {object} session - 会话。
   * @param {boolean} closeBrowser - 是否关闭自有浏览器/共享页。
   * @param {boolean} remove - 是否从注册表删除。
   * @param {boolean} [disposing=false] - 是否驱动总清理；CDP 总清理只断开，绝不关外部页。
   * @returns {Promise<object>} 清理结果。
   */
  async function teardown(session, closeBrowser, remove, disposing = false) {
    session.connected = false
    // 默认 disconnect 只是解除路由：保留页面，launch 可重连，CDP 外部页绝不动。
    // 只有用户显式 closeBrowser:true 才关目标页；dispose 对 CDP 仍然只断开。
    const shouldClosePages = closeBrowser && !(disposing && session.mode === 'cdp')
    const targets = shouldClosePages ? [...session.pages.values()] : []
    for (const record of targets) await record.page.close({ runBeforeUnload: false }).catch(() => {})
    let browserClosed = false
    if (session.mode === 'launch') {
      if (closeBrowser || remove) {
        await session.context.close().catch((error) => writeLog('warn', 'real-driver context close failed', { error: String(error) }))
        browserClosed = true
      }
    } else if (session.browserHandle) {
      // connectOverCDP 的 browser.close 断开 Playwright 连接；不会读取或改写日常 profile。
      await session.browserHandle.close().catch((error) => writeLog('warn', 'real-driver CDP disconnect failed', { error: String(error) }))
      browserClosed = false
    }
    session.activeId = null
    session.armedDialog = null
    if (remove || session.mode === 'cdp' || closeBrowser) sessions.delete(session.id)
    return { disconnected: true, closedPages: targets.length, browserClosed }
  }

  return {
    /**
     * 连接或启动一个会话。已有连接幂等返回；disconnected 的 launch 会话可复用其专用浏览器。
     * @param {string} sessionId - 会话 id。
     * @param {object} [options] - 启动/连接参数。
     * @returns {Promise<object>} 状态。
     */
    async connectSession(sessionId, options = {}) {
      assertActiveDriver()
      if (typeof sessionId !== 'string' || sessionId.trim() === '') throw driverError('BAD_ARG', 'sessionId 必须是非空字符串')
      const id = sessionId.trim()
      const browserOption = options.browser ?? realConfig.browser ?? 'auto'
      const temporary = options.temporary === true
      const pageUrl = options.pageUrl
      if (pageUrl !== undefined && (typeof pageUrl !== 'string' || pageUrl === '')) throw driverError('BAD_ARG', 'pageUrl 必须是非空精确 URL')
      const existing = sessions.get(id)
      if (existing?.connected) return statusOf(existing)

      if (existing && existing.mode === 'launch') {
        existing.connected = true
        try {
          if (pageUrl !== undefined) {
            const matches = existing.context.pages().filter((page) => page.url() === pageUrl)
            if (matches.length === 0) throw driverError('NO_PAGE', `没有精确匹配 pageUrl 的已有页面: ${pageUrl}`)
            if (matches.length > 1) throw driverError('BAD_ARG', `pageUrl 匹配到 ${matches.length} 个页面，无法安全选择`)
            adoptPage(existing, matches[0], { shared: true })
          } else {
            const alive = [...existing.pages.values()].filter((record) => !record.page.isClosed())
            if (alive.length === 0) await newPage(existing)
            else existing.activeId = existing.pages.has(existing.activeId) ? existing.activeId : alive[alive.length - 1].id
          }
          return statusOf(existing)
        } catch (error) {
          existing.connected = false
          throw normalizeError(error)
        }
      }

      const session = {
        id,
        connected: false,
        mode: options.endpoint !== undefined ? 'cdp' : 'launch',
        browser: null,
        browserHandle: null,
        context: null,
        temporary,
        profileDir: null,
        endpoint: null,
        pages: new Map(),
        pageRecords: new WeakMap(),
        activeId: null,
        armedDialog: null,
        lastUrl: undefined,
      }
      try {
        if (session.mode === 'cdp') {
          const endpoint = requireLoopbackEndpoint(options.endpoint)
          session.endpoint = endpoint
          session.browser = 'cdp'
          session.browserHandle = await chromium.connectOverCDP(endpoint, { timeout: startupTimeoutMs })
          const context = session.browserHandle.contexts()[0]
          if (!context) throw driverError('NO_PAGE', 'CDP 浏览器没有可用 BrowserContext')
          session.context = context
          session.browserHandle.on('disconnected', () => { session.connected = false })
        } else {
          if (!['auto', 'chrome', 'edge', 'msedge'].includes(browserOption)) throw driverError('BAD_ARG', `browser 只能是 auto/chrome/edge，收到 ${browserOption}`)
          const channels = browserOption === 'auto' ? ['chrome', 'msedge'] : [browserOption === 'edge' ? 'msedge' : browserOption]
          const failures = []
          for (const channel of channels) {
            let userDataDir = ''
            if (!temporary) {
              const base = typeof realConfig.profileDir === 'string' && realConfig.profileDir !== '' ? path.resolve(realConfig.profileDir) : ''
              if (!base) throw driverError('BAD_ARG', '非 temporary 模式需要 config.realBrowser.profileDir')
              const hash = createHash('sha256').update(id).digest('hex').slice(0, 24)
              userDataDir = path.join(base, hash)
              await mkdir(base, { recursive: true })
            }
            try {
              session.context = await chromium.launchPersistentContext(userDataDir, {
                headless: false,
                channel,
                timeout: startupTimeoutMs,
                viewport: null,
              })
              session.browser = channel
              session.profileDir = temporary ? null : userDataDir
              break
            } catch (error) {
              failures.push(`${channel}: ${String(error.message || error)}`)
              writeLog('warn', 'real-browser launch failed', { channel, error: String(error) })
            }
          }
          if (!session.context) throw driverError('BROWSER_LAUNCH_FAILED', `Chrome/Edge 启动失败：${failures.join('；')}`)
          session.context.on('close', () => { session.connected = false })
        }

        sessions.set(id, session)
        session.connected = true
        session.context.on('page', (page) => {
          if (session.pageRecords.get(page)) return
          void Promise.resolve(page.opener()).then((opener) => {
            // 只有本会话页面打开的 popup 才归入本会话；其它 CDP 新页仍不可见。
            if (opener && session.pageRecords.get(opener)) adoptPage(session, page)
          }).catch((error) => writeLog('debug', 'real-driver popup ownership probe failed', { error: String(error) }))
        })

        if (pageUrl !== undefined) {
          const matches = session.context.pages().filter((page) => page.url() === pageUrl)
          if (matches.length === 0) throw driverError('NO_PAGE', `没有精确匹配 pageUrl 的已有页面: ${pageUrl}`)
          if (matches.length > 1) throw driverError('BAD_ARG', `pageUrl 匹配到 ${matches.length} 个页面，无法安全选择`)
          adoptPage(session, matches[0], { shared: true })
        } else {
          // 即使 launch/CDP 已有 about:blank 或恢复页，也只控制本会话新建页。
          await newPage(session)
        }
        return statusOf(session)
      } catch (error) {
        // 启动失败可清理自己刚 launch 的 context；CDP 失败只断开，绝不关外部 context/page。
        await teardown(session, session.mode === 'launch', true, session.mode === 'cdp').catch(() => {})
        throw normalizeError(error)
      }
    },

    /**
     * 断开一个会话。默认只解除路由并保留页面；launch 可重连，CDP 直接断开连接。
     * @param {string} sessionId - 会话 id。
     * @param {object} [options] - closeBrowser 是否显式关闭目标页及自有浏览器。
     * @returns {Promise<object>} 清理结果。
     */
    async disconnectSession(sessionId, { closeBrowser = false } = {}) {
      const session = sessions.get(sessionId)
      if (!session) return { disconnected: true, closedPages: 0, browserClosed: false }
      return await teardown(session, closeBrowser === true, false)
    },

    /** @param {string} sessionId - 会话 id。 @returns {object|null} 状态；未知会话为 null。 */
    status(sessionId) {
      const session = sessions.get(sessionId)
      return session ? statusOf(session) : null
    },

    /** @param {string} sessionId - 会话 id。 @returns {string|undefined} 活动或最近 URL。 */
    knownUrl(sessionId) {
      const session = sessions.get(sessionId)
      if (!session) return undefined
      const active = session.pages.get(session.activeId)
      return active && !active.page.isClosed() ? active.page.url() : session.lastUrl
    },

    /**
     * 执行协议操作。
     * @param {string} sessionId - 会话 id。
     * @param {string} op - op。
     * @param {object} args - 参数。
     * @param {number} [timeoutMs] - 总期限。
     * @returns {Promise<{value:object,clientId:'playwright'}>} 命令结果。
     */
    async sendCommand(sessionId, op, args = {}, timeoutMs = commandTimeoutMs) {
      assertActiveDriver()
      const session = sessions.get(sessionId)
      if (!session || !session.connected) throw driverError('NO_PAGE', `真实浏览器会话未连接: ${sessionId}`)
      const rawArgs = isRecord(args) ? args : {}
      const budget = Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : commandTimeoutMs
      try {
        const value = await withTimeout(dispatch(session, String(op || ''), rawArgs, budget), budget, String(op || ''))
        rememberUrl(session, value)
        return { value, clientId: CLIENT_ID }
      } catch (error) {
        throw normalizeError(error)
      }
    },

    /** @returns {Promise<void>} 释放全部页面、连接与自有浏览器。 */
    async dispose() {
      if (disposed) return
      disposed = true
      const all = [...sessions.values()]
      for (const session of all) await teardown(session, true, true, true).catch((error) => writeLog('warn', 'real-driver dispose failed', { error: String(error) }))
      sessions.clear()
    },
  }
}
