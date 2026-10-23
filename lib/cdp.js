/**
 * 深度模式（CDP）：零依赖的 Chrome DevTools Protocol 客户端 + 深度快照编排。
 *
 * 背景：渲染进程拿不到 `webContents.debugger`，唯一现实通道是 Electron 的
 * `--remote-debugging-port`。端口只在用户显式用 `tools/start-dsh-debug.cmd`
 * 重启后才存在；本模块所有入口在端口不可达时都必须**优雅失败**（由上层转成
 * `DEEP_UNAVAILABLE`），绝不拖垮插件加载。
 *
 * 依赖约定：只用 `node:` 内置（net/http/https/crypto），不 import 任何
 * `@deepseek-ai/*`，也不 import `client.js`。
 *
 * 分层：
 *   - 纯函数（好单测）：`matchTarget` / `quadToBox` / `flattenAxTree` / `framePathOf`
 *   - 网络：`discover`（HTTP /json/*）、`connect`（手写 WebSocket）、`attachTo`
 *   - 编排：`deepSnapshot`（a11y 或 DOM 路线，含跨源 iframe 会话）
 *
 * @module dsh-plugin-browser-hands/cdp
 */

import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { ELEMENT_ROLES, estimateTokens } from './snapshot.js'

/** 深度模式的固定操作提示（端口没开/没启用时原样给模型看）。 */
export const DEEP_HELP = '没找到调试端口：请用 tools\\start-dsh-debug.cmd 重启 DSH 并在设置里打开 deepMode'

/** 读端口文件的缓存时长：5 秒内复用，超过则重读（用户可能重启换了端口）。 */
const ENDPOINT_CACHE_TTL_MS = 5_000

/** `connect()` / `deepSnapshot()` 默认单条命令超时。 */
const DEFAULT_COMMAND_TIMEOUT_MS = 8_000

/** 跨源 iframe（OOPIF）逐层 auto-attach 的上限：最多几轮 / 最多几个子会话。 */
const MAX_ATTACH_ROUNDS = 4
const MAX_CHILD_SESSIONS = 32

/**
 * 收 `Target.attachedToTarget` 的节奏：首事件最多等 300ms；
 * 收到事件后再静默 100ms 认为收完；单轮最长 900ms（防止页面无限 attach）。
 */
const ATTACH_FIRST_WAIT_MS = 300
const ATTACH_QUIET_MS = 100
const ATTACH_BURST_CAP_MS = 900

/** `portFile` 解析结果缓存（key = 配置里的 portFile）。 */
const endpointCache = new Map()

/** WebSocket 握手用的固定 GUID（RFC 6455）。 */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** a11y 树的噪声 role：不展示（但仍在 total 里计数）。 */
const ROLE_SKIP = new Set([
  'none', 'generic', 'InlineTextBox', 'LineBreak', 'RootWebArea', 'Ignored', 'presentation',
])

/** 即使 name 为空也值得展示的 role。 */
const ROLE_KEEP_EMPTY_NAME = new Set([
  ...ELEMENT_ROLES,
  'img', 'image', 'heading', 'cell', 'row', 'listitem', 'treeitem', 'document', 'dialog', 'alert',
])

/** DOM 路线里值得展示的标签。 */
const DOM_TAGS = new Set([
  'a', 'button', 'input', 'select', 'textarea', 'option', 'label', 'summary', 'form',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'img', 'nav', 'main', 'dialog', 'table', 'tr', 'td', 'th',
])

/**
 * 深度模式统一错误。
 */
export class CdpError extends Error {
  /**
   * @param {string} code - 稳定的错误码（CDP_UNREACHABLE / CDP_TIMEOUT / CDP_TARGET_GONE …）。
   * @param {string} message - 给人看的中文说明。
   * @param {unknown} [cause] - 原始错误（可选）。
   */
  constructor(code, message, cause) {
    super(message)
    this.name = 'CdpError'
    this.code = code
    if (cause !== undefined) this.cause = cause
  }
}

/**
 * 是否是普通对象。
 * @param {unknown} value - 任意值。
 * @returns {boolean} 结论。
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 安全转文本。
 * @param {unknown} value - 任意值。
 * @returns {string} 文本。
 */
function text(value) {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  return String(value)
}

/**
 * 把 CDP 的 error 回包映射成稳定错误码。
 * @param {{ code?: number, message?: string }} error - CDP error 对象。
 * @returns {CdpError} 映射后的错误。
 */
export function mapCdpError(error) {
  const message = text(error?.message) || 'CDP 命令失败'
  if (/No target with given id|Target closed|target.*not found/i.test(message)) {
    return new CdpError('CDP_TARGET_GONE', `目标页面已消失（可能被关闭或跳转）：${message}`)
  }
  if (/No node with given id|Could not find node|Node with given id/i.test(message)) {
    return new CdpError('CDP_STALE_NODE', `DOM 节点已失效：${message}`)
  }
  if (/Cannot find context|Execution context was destroyed|Inspected target navigated/i.test(message)) {
    return new CdpError('CDP_NAVIGATED', `页面已跳转/重载，请重试：${message}`)
  }
  return new CdpError('CDP_ERROR', message, error)
}

/**
 * 从 AXNode 里取字符串值（`{type,value}` 形状）。
 * @param {unknown} field - AXNode 的 role/name 等字段。
 * @returns {string} 文本。
 */
function axValue(field) {
  if (isRecord(field)) return text(field.value)
  return text(field)
}

/**
 * 计算 quad → `{x,y,width,height}`（取外接矩形并取整）。
 * @param {unknown} quad - CDP 的 content quad（8 个数）。
 * @returns {{x:number,y:number,width:number,height:number}|null} 盒子；非法输入为 null。
 */
export function quadToBox(quad) {
  if (!Array.isArray(quad) || quad.length < 8) return null
  const nums = quad.slice(0, 8).map((value) => Number(value))
  if (nums.some((value) => !Number.isFinite(value))) return null
  const xs = [nums[0], nums[2], nums[4], nums[6]]
  const ys = [nums[1], nums[3], nums[5], nums[7]]
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(Math.max(...xs) - x),
    height: Math.round(Math.max(...ys) - y),
  }
}

/**
 * 把盒子平移一个 frame 偏移（跨源 iframe 换算到顶层视口坐标）。
 * @param {{x:number,y:number,width:number,height:number}|null} box - 本 frame 空间里的盒子。
 * @param {{x:number,y:number}|null} offset - frame 在顶层视口里的偏移；null 表示换算不了。
 * @returns {{x:number,y:number,width:number,height:number}|null} 顶层视口盒子；换算不了为 null。
 */
export function offsetBox(box, offset) {
  if (box === null || box === undefined) return null
  if (offset === null || offset === undefined) return null
  if (!Number.isFinite(offset.x) || !Number.isFinite(offset.y)) return null
  return {
    x: Math.round(box.x + offset.x),
    y: Math.round(box.y + offset.y),
    width: box.width,
    height: box.height,
  }
}

/**
 * frame 的展示路径：`main`、`main > #1`、`main > #1 > #2`（`#n` 是父 frame 里的子序号）。
 * 拿不到父链时才回 `#?`（正常 OOPIF 也会通过 attached 事件补进索引，不应出现 `#?`）。
 * @param {string} frameId - 目标 frame。
 * @param {Map<string, {parentId: string|null, index: number}>} frameIndex - frame 关系表。
 * @returns {string} 路径文本。
 */
export function framePathOf(frameId, frameIndex) {
  const parts = []
  let cursor = frameId
  let guard = 0
  while (cursor && guard < 32) {
    const info = frameIndex.get(cursor)
    if (info === undefined) return parts.length === 0 ? '#?' : ['#?', ...parts.reverse()].join(' > ')
    if (info.parentId === null || info.parentId === undefined) {
      parts.push('main')
      return parts.reverse().join(' > ')
    }
    parts.push(`#${info.index}`)
    cursor = info.parentId
    guard += 1
  }
  return parts.length === 0 ? 'main' : ['#?', ...parts.reverse()].join(' > ')
}

/**
 * 把 AX 树扁平化成一行一节点的紧凑结构。
 *
 * @param {unknown[]} axNodes - `Accessibility.getFullAXTree` 的 nodes。
 * @param {object} [options] - 入参。
 * @param {number} [options.maxNodes=200] - 最多返回多少行。
 * @param {(node: object) => ({x:number,y:number,width:number,height:number}|null)} [options.boxOf] - 取盒子。
 * @param {(node: object) => string} [options.pathOf] - 取 frame 路径。
 * @returns {{ nodes: object[], total: number, truncated: boolean }} 扁平结果。
 */
export function flattenAxTree(axNodes, options = {}) {
  const maxNodes = Number.isSafeInteger(options.maxNodes) && options.maxNodes > 0 ? options.maxNodes : 200
  const boxOf = typeof options.boxOf === 'function' ? options.boxOf : () => null
  const pathOf = typeof options.pathOf === 'function' ? options.pathOf : () => 'main'
  const rows = []
  let total = 0
  for (const raw of Array.isArray(axNodes) ? axNodes : []) {
    const node = isRecord(raw) ? raw : {}
    if (node.ignored === true) continue
    const role = axValue(node.role) || 'generic'
    if (ROLE_SKIP.has(role)) continue
    const name = axValue(node.name).replace(/\s+/g, ' ').trim()
    if (name === '' && !ROLE_KEEP_EMPTY_NAME.has(role)) continue
    total += 1
    if (rows.length >= maxNodes) continue
    let box = null
    try {
      box = boxOf(node)
    } catch {
      box = null
    }
    rows.push({
      role,
      name: name.length > 160 ? `${name.slice(0, 160)}…` : name,
      framePath: pathOf(node),
      box: box ?? null,
    })
  }
  return { nodes: rows, total, truncated: total > rows.length }
}

/**
 * 在一组 target 里按 URL 找页面（多页时必须给 url）。
 * @param {unknown} targets - `discover()` 的 targets。
 * @param {object} [options] - 入参。
 * @param {string} [options.url] - 期望的页面 URL（精确匹配）。
 * @returns {object} 命中的 target。
 * @throws {CdpError} `CDP_TARGET_NOT_FOUND` / `CDP_NO_PAGE`。
 */
export function matchTarget(targets, options = {}) {
  const list = (Array.isArray(targets) ? targets : []).filter((item) => {
    if (!isRecord(item)) return false
    const type = text(item.type)
    return type === 'page' || type === 'webview'
  })
  const wanted = text(options.url)
  if (wanted !== '') {
    const exact = list.find((item) => text(item.url) === wanted)
    if (exact !== undefined) return exact
    const noHash = wanted.split('#')[0]
    const loose = list.find((item) => text(item.url).split('#')[0] === noHash)
    if (loose !== undefined) return loose
    throw new CdpError(
      'CDP_TARGET_NOT_FOUND',
      `没有 URL 为 ${wanted} 的页面（当前页面：${list.map((item) => text(item.url)).join(', ') || '无'}）`,
    )
  }
  if (list.length === 1) return list[0]
  if (list.length === 0) throw new CdpError('CDP_NO_PAGE', 'CDP 里没有任何 page/webview target，请先在侧边栏打开页面')
  throw new CdpError(
    'CDP_TARGET_MULTIPLE',
    `有 ${list.length} 个页面，请用 url 指定：${list.map((item) => text(item.url)).join(', ')}`,
  )
}

/**
 * 带超时的 HTTP GET（只用于 /json/*，body 很小）。
 * @param {string} url - 绝对 http(s) URL。
 * @param {number} timeoutMs - 超时。
 * @returns {Promise<unknown>} 解析后的 JSON。
 */
function getJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    let parsed
    try {
      parsed = new URL(url)
    } catch (error) {
      reject(new CdpError('CDP_BAD_ENDPOINT', `CDP 端点不是合法 URL：${url}`, error))
      return
    }
    const client = parsed.protocol === 'https:' ? https : http
    const request = client.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port === '' ? undefined : Number(parsed.port),
      path: `${parsed.pathname}${parsed.search}`,
      method: 'GET',
      timeout: timeoutMs,
      headers: { accept: 'application/json' },
    }, (response) => {
      const chunks = []
      let size = 0
      response.on('data', (chunk) => {
        size += chunk.length
        if (size <= 4 * 1024 * 1024) chunks.push(chunk)
      })
      response.on('end', () => {
        const status = Number(response.statusCode ?? 0)
        if (status < 200 || status >= 300) {
          reject(new CdpError('CDP_HTTP', `CDP 端点返回 HTTP ${status}：${url}`))
          return
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch (error) {
          reject(new CdpError('CDP_BAD_JSON', `CDP 端点返回的不是 JSON：${url}`, error))
        }
      })
      response.on('error', reject)
    })
    request.on('timeout', () => {
      request.destroy(new CdpError('CDP_TIMEOUT', `CDP 端点 ${timeoutMs}ms 未响应：${url}`))
    })
    request.on('error', (error) => {
      if (error instanceof CdpError) {
        reject(error)
        return
      }
      const code = error?.code === 'ECONNREFUSED' || error?.code === 'EHOSTUNREACH' || error?.code === 'ENOTFOUND'
        ? 'CDP_UNREACHABLE'
        : 'CDP_NETWORK'
      reject(new CdpError(code, `连不上 CDP 端点 ${url}（${text(error?.message)}）`, error))
    })
    request.end()
  })
}

/**
 * 解析 CDP 端点：显式 `endpoint` 优先；否则读 Chromium 的 `DevToolsActivePort`
 * （第一行是端口，第二行是 ws 路径），拼 `http://127.0.0.1:<port>`。
 *
 * 结果缓存 5 秒：用户重启后随机端口会变，超过缓存时间会重读文件自愈。
 *
 * @param {object} [options] - 入参。
 * @param {string} [options.endpoint] - 显式端点（非空时直接使用）。
 * @param {string} [options.portFile] - `DevToolsActivePort` 绝对路径。
 * @param {number} [options.now] - 测试注入的当前时间。
 * @param {number} [options.ttlMs] - 测试注入的缓存时长（默认 5000）。
 * @returns {Promise<string>} 端点 URL。
 * @throws {CdpError} `DEEP_UNAVAILABLE`：没配 portFile / 文件不存在 / 内容非法。
 */
export async function resolveEndpoint(options = {}) {
  const explicit = text(options.endpoint).replace(/\/+$/, '')
  if (explicit !== '') return explicit
  const portFile = text(options.portFile)
  if (portFile === '') {
    throw new CdpError('DEEP_UNAVAILABLE', `${DEEP_HELP}（既没有 deepMode.portFile，也没有显式 deepMode.endpoint）`)
  }
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs >= 0 ? options.ttlMs : ENDPOINT_CACHE_TTL_MS
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const cached = endpointCache.get(portFile)
  if (cached !== undefined && now - cached.at < ttlMs) return cached.endpoint
  let content
  try {
    content = await fs.readFile(portFile, 'utf8')
  } catch (error) {
    endpointCache.delete(portFile)
    if (error?.code === 'ENOENT') {
      throw new CdpError('DEEP_UNAVAILABLE', `${DEEP_HELP}（端口文件不存在：${portFile}）`)
    }
    throw new CdpError('DEEP_UNAVAILABLE', `${DEEP_HELP}（读端口文件失败：${text(error?.message)}）`)
  }
  const firstLine = String(content).split(/\r?\n/, 1)[0]?.trim() ?? ''
  const port = Number(firstLine)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    endpointCache.delete(portFile)
    throw new CdpError('DEEP_UNAVAILABLE', `${DEEP_HELP}（端口文件内容非法：${JSON.stringify(firstLine)}）`)
  }
  const endpoint = `http://127.0.0.1:${port}`
  endpointCache.set(portFile, { endpoint, at: now })
  return endpoint
}

/**
 * 清空端口缓存（测试/排障用）。
 * @returns {void}
 */
export function clearEndpointCache() {
  endpointCache.clear()
}

/**
 * 发现 CDP 端点：版本信息 + 全部 target。
 *
 * @param {string} endpoint - 端点，如 `http://127.0.0.1:54321`（由 {@link resolveEndpoint} 得到）。
 * @param {object} [options] - 入参。
 * @param {number} [options.timeoutMs=2000] - 单次 HTTP 超时。
 * @returns {Promise<{ endpoint: string, version: object, browserWSUrl: string, targets: object[] }>} 发现结果。
 * @throws {CdpError} 端口不可达/超时/响应非法。
 */
export async function discover(endpoint, options = {}) {
  const base = text(endpoint).replace(/\/+$/, '')
  if (base === '') {
    throw new CdpError('DEEP_UNAVAILABLE', `${DEEP_HELP}（端点为空）`)
  }
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 2_000
  const [version, list] = await Promise.all([
    getJson(`${base}/json/version`, timeoutMs),
    getJson(`${base}/json/list`, timeoutMs),
  ])
  const browserWSUrl = isRecord(version) ? text(version.webSocketDebuggerUrl) : ''
  if (browserWSUrl === '') {
    throw new CdpError('CDP_BAD_ENDPOINT', `CDP 端点 ${base}/json/version 没有 webSocketDebuggerUrl`)
  }
  const targets = (Array.isArray(list) ? list : []).map((item) => ({
    id: text(item.id),
    type: text(item.type),
    url: text(item.url),
    title: text(item.title),
    wsUrl: text(item.webSocketDebuggerUrl),
  }))
  return { endpoint: base, version: isRecord(version) ? version : {}, browserWSUrl, targets }
}

/**
 * 手写 WebSocket 客户端（RFC 6455 最小实现：文本帧 + ping/pong/close）。
 *
 * 为什么不用全局 `WebSocket`：不同 Node/Electron 版本暴露情况不一致，而 CDP
 * 只需要文本帧；自己实现 60 行反而更可控、可单测。
 *
 * @param {string} wsUrl - `ws://host:port/path`。
 * @param {object} [options] - 入参。
 * @param {number} [options.timeoutMs=5000] - 握手超时。
 * @returns {Promise<object>} 连接对象。
 */
function openWebSocket(wsUrl, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 5_000
  return new Promise((resolve, reject) => {
    let parsed
    try {
      parsed = new URL(wsUrl)
    } catch (error) {
      reject(new CdpError('CDP_BAD_ENDPOINT', `不是合法的 WebSocket URL：${wsUrl}`, error))
      return
    }
    const host = parsed.hostname
    const port = parsed.port === '' ? (parsed.protocol === 'wss:' ? 443 : 80) : Number(parsed.port)
    const path = `${parsed.pathname || '/'}${parsed.search}`
    const socket = net.connect({ host, port })
    let buffer = Buffer.alloc(0)
    let handshakeDone = false
    let closed = false
    const listeners = { message: [], close: [] }
    let fragmentOpcode = 0
    let fragmentParts = []

    /**
     * 触发事件。
     * @param {'message'|'close'} name - 事件名。
     * @param {unknown} payload - 负载。
     * @returns {void}
     */
    const emit = (name, payload) => {
      for (const handler of listeners[name].slice()) {
        try {
          handler(payload)
        } catch {
          // 订阅者异常不影响连接。
        }
      }
    }

    /**
     * 发一帧（客户端必须加掩码）。
     * @param {number} opcode - 操作码。
     * @param {Buffer} payload - 负载。
     * @returns {void}
     */
    const sendFrame = (opcode, payload) => {
      if (closed || socket.destroyed) return
      const length = payload.length
      let header
      if (length < 126) {
        header = Buffer.from([0x80 | opcode, 0x80 | length])
      } else if (length < 65_536) {
        header = Buffer.alloc(4)
        header[0] = 0x80 | opcode
        header[1] = 0x80 | 126
        header.writeUInt16BE(length, 2)
      } else {
        header = Buffer.alloc(10)
        header[0] = 0x80 | opcode
        header[1] = 0x80 | 127
        header.writeBigUInt64BE(BigInt(length), 2)
      }
      const maskKey = crypto.randomBytes(4)
      const masked = Buffer.alloc(length)
      for (let index = 0; index < length; index += 1) masked[index] = payload[index] ^ maskKey[index % 4]
      socket.write(Buffer.concat([header, maskKey, masked]))
    }

    /**
     * 解析缓冲区里的完整帧。
     * @returns {void}
     */
    const parseFrames = () => {
      for (;;) {
        if (buffer.length < 2) return
        const first = buffer[0]
        const second = buffer[1]
        const fin = (first & 0x80) !== 0
        const opcode = first & 0x0f
        const masked = (second & 0x80) !== 0
        let length = second & 0x7f
        let offset = 2
        if (length === 126) {
          if (buffer.length < 4) return
          length = buffer.readUInt16BE(2)
          offset = 4
        } else if (length === 127) {
          if (buffer.length < 10) return
          length = Number(buffer.readBigUInt64BE(2))
          if (!Number.isSafeInteger(length)) {
            socket.destroy()
            return
          }
          offset = 10
        }
        let maskKey = null
        if (masked) {
          if (buffer.length < offset + 4) return
          maskKey = buffer.subarray(offset, offset + 4)
          offset += 4
        }
        if (buffer.length < offset + length) return
        let payload = buffer.subarray(offset, offset + length)
        buffer = buffer.subarray(offset + length)
        if (masked && maskKey !== null) {
          const unmasked = Buffer.alloc(length)
          for (let index = 0; index < length; index += 1) unmasked[index] = payload[index] ^ maskKey[index % 4]
          payload = unmasked
        }
        if (opcode === 0x8) {
          // close
          if (!closed) {
            closed = true
            sendFrame(0x8, Buffer.alloc(0))
            socket.end()
            emit('close', null)
          }
          return
        }
        if (opcode === 0x9) {
          sendFrame(0xA, payload)
          continue
        }
        if (opcode === 0xA) continue
        if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
          if (opcode !== 0x0) {
            fragmentOpcode = opcode
            fragmentParts = []
          }
          fragmentParts.push(payload)
          if (fin) {
            const data = Buffer.concat(fragmentParts)
            fragmentParts = []
            if (fragmentOpcode === 0x1) emit('message', data.toString('utf8'))
          }
          continue
        }
      }
    }

    const cleanupAndReject = (error) => {
      if (closed) return
      closed = true
      socket.destroy()
      reject(error)
    }

    const timer = setTimeout(() => {
      cleanupAndReject(new CdpError('CDP_TIMEOUT', `WebSocket 握手 ${timeoutMs}ms 超时：${wsUrl}`))
    }, timeoutMs)

    let handshakeKey = ''

    socket.on('connect', () => {
      const key = crypto.randomBytes(16).toString('base64')
      handshakeKey = key
      const lines = [
        `GET ${path} HTTP/1.1`,
        `Host: ${host}:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ]
      socket.write(lines.join('\r\n'))
    })

    socket.on('data', (chunk) => {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
      if (!handshakeDone) {
        const end = buffer.indexOf('\r\n\r\n')
        if (end < 0) return
        const head = buffer.subarray(0, end).toString('latin1')
        buffer = buffer.subarray(end + 4)
        const statusLine = head.split('\r\n')[0] ?? ''
        if (!/\s101\s/.test(statusLine)) {
          cleanupAndReject(new CdpError('CDP_HANDSHAKE', `WebSocket 握手被拒绝：${statusLine}`))
          return
        }
        const headers = new Map()
        for (const line of head.split('\r\n').slice(1)) {
          const colon = line.indexOf(':')
          if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim())
        }
        const expected = crypto.createHash('sha1').update(`${handshakeKey}${WS_GUID}`).digest('base64')
        if (headers.get('sec-websocket-accept') !== expected) {
          cleanupAndReject(new CdpError('CDP_HANDSHAKE', 'WebSocket 握手缺少合法的 Sec-WebSocket-Accept'))
          return
        }
        clearTimeout(timer)
        handshakeDone = true
        resolve({
          /**
           * 发一条文本消息。
           * @param {string} data - 文本。
           * @returns {void}
           */
          send(data) {
            sendFrame(0x1, Buffer.from(String(data), 'utf8'))
          },
          /**
           * 订阅消息/关闭。
           * @param {'message'|'close'} name - 事件名。
           * @param {Function} handler - 回调。
           * @returns {() => void} 取消订阅。
           */
          on(name, handler) {
            if (listeners[name] === undefined) return () => {}
            listeners[name].push(handler)
            return () => {
              listeners[name] = listeners[name].filter((entry) => entry !== handler)
            }
          },
          /**
           * 关闭连接。
           * @returns {void}
           */
          close() {
            if (closed) return
            closed = true
            try {
              sendFrame(0x8, Buffer.alloc(0))
            } catch {
              // 忽略。
            }
            socket.end()
            socket.destroy()
          },
          /** 是否已关闭。 */
          get closed() {
            return closed
          },
        })
        return
      }
      parseFrames()
    })

    socket.on('close', () => {
      clearTimeout(timer)
      const wasClosed = closed
      closed = true
      if (!handshakeDone) {
        reject(new CdpError('CDP_NETWORK', `WebSocket 连接被关闭：${wsUrl}`))
        return
      }
      if (!wasClosed) emit('close', null)
    })

    socket.on('error', (error) => {
      clearTimeout(timer)
      if (error instanceof CdpError) {
        cleanupAndReject(error)
        return
      }
      const code = error?.code === 'ECONNREFUSED' ? 'CDP_UNREACHABLE' : 'CDP_NETWORK'
      cleanupAndReject(new CdpError(code, `WebSocket 连接失败：${text(error?.message)}`, error))
    })
  })
}

/**
 * 连接一个 CDP WebSocket，返回可 `send` / `on` / `close` 的通道。
 *
 * @param {string} wsUrl - 浏览器级或页面级 WebSocket URL。
 * @param {object} [options] - 入参。
 * @param {number} [options.timeoutMs] - 单条命令默认超时 + 握手超时。
 * @returns {Promise<object>} 通道对象。
 */
export async function connect(wsUrl, options = {}) {
  const defaultTimeout = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_COMMAND_TIMEOUT_MS
  const socket = await openWebSocket(wsUrl, { timeoutMs: Math.min(defaultTimeout, 5_000) })
  let nextId = 0
  const pending = new Map()
  const handlers = new Map()
  let closed = false

  /**
   * 关闭并把所有等待中的命令失败掉。
   * @param {CdpError} error - 原因。
   * @returns {void}
   */
  const failAll = (error) => {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
      pending.delete(id)
    }
  }

  socket.on('close', () => {
    closed = true
    failAll(new CdpError('CDP_CLOSED', 'CDP 连接已关闭'))
  })

  socket.on('message', (raw) => {
    let message
    try {
      message = JSON.parse(String(raw))
    } catch {
      return
    }
    if (!isRecord(message)) return
    if (typeof message.id === 'number') {
      const entry = pending.get(message.id)
      if (entry === undefined) return
      pending.delete(message.id)
      clearTimeout(entry.timer)
      if (isRecord(message.error)) {
        entry.reject(mapCdpError(message.error))
        return
      }
      entry.resolve(isRecord(message.result) ? message.result : {})
      return
    }
    const method = text(message.method)
    if (method === '') return
    const sessionId = text(message.sessionId)
    const list = handlers.get(method)
    if (list === undefined) return
    for (const entry of list.slice()) {
      if (entry.sessionId !== undefined && entry.sessionId !== sessionId) continue
      try {
        entry.handler({ params: isRecord(message.params) ? message.params : {}, sessionId })
      } catch {
        // 订阅者异常不影响其他订阅者。
      }
    }
  })

  return {
    /**
     * 发一条 CDP 命令。
     * @param {string} method - 方法名。
     * @param {Record<string, unknown>} [params] - 参数。
     * @param {object} [callOptions] - 入参。
     * @param {string} [callOptions.sessionId] - 扁平会话 id。
     * @param {number} [callOptions.timeoutMs] - 单条超时。
     * @returns {Promise<Record<string, unknown>>} result。
     */
    send(method, params = {}, callOptions = {}) {
      if (closed) return Promise.reject(new CdpError('CDP_CLOSED', 'CDP 连接已关闭'))
      nextId += 1
      const id = nextId
      const timeoutMs = Number.isFinite(callOptions.timeoutMs) && callOptions.timeoutMs > 0
        ? callOptions.timeoutMs
        : defaultTimeout
      const message = { id, method, params }
      if (typeof callOptions.sessionId === 'string' && callOptions.sessionId !== '') {
        message.sessionId = callOptions.sessionId
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new CdpError('CDP_TIMEOUT', `CDP ${method} 超时（${timeoutMs}ms）`))
        }, timeoutMs)
        pending.set(id, { resolve, reject, timer })
        try {
          socket.send(JSON.stringify(message))
        } catch (error) {
          clearTimeout(timer)
          pending.delete(id)
          reject(new CdpError('CDP_NETWORK', `CDP 消息发送失败：${text(error?.message)}`, error))
        }
      })
    },
    /**
     * 订阅 CDP 事件。
     * @param {string} method - 事件名（如 `Target.attachedToTarget`）。
     * @param {(event: { params: object, sessionId: string }) => void} handler - 回调。
     * @param {object} [subOptions] - 入参。
     * @param {string} [subOptions.sessionId] - 只收该会话的事件。
     * @returns {() => void} 取消订阅。
     */
    on(method, handler, subOptions = {}) {
      const name = text(method)
      const list = handlers.get(name) ?? []
      list.push({ handler, sessionId: subOptions.sessionId })
      handlers.set(name, list)
      return () => {
        const current = handlers.get(name) ?? []
        handlers.set(name, current.filter((entry) => entry.handler !== handler))
      }
    },
    /**
     * 等一个事件（可带谓词）。
     * @param {string} method - 事件名。
     * @param {(event: { params: object, sessionId: string }) => boolean} [predicate] - 谓词。
     * @param {number} [timeoutMs] - 超时。
     * @returns {Promise<{ params: object, sessionId: string }>} 事件。
     */
    once(method, predicate, timeoutMs = defaultTimeout) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          off()
          reject(new CdpError('CDP_TIMEOUT', `等待事件 ${method} 超时（${timeoutMs}ms）`))
        }, timeoutMs)
        const off = this.on(method, (event) => {
          let matched = true
          try {
            matched = typeof predicate === 'function' ? predicate(event) === true : true
          } catch {
            matched = false
          }
          if (!matched) return
          clearTimeout(timer)
          off()
          resolve(event)
        })
      })
    },
    /**
     * 关闭连接。
     * @returns {void}
     */
    close() {
      closed = true
      failAll(new CdpError('CDP_CLOSED', 'CDP 连接已关闭'))
      socket.close()
    },
    /** 是否已关闭。 */
    get closed() {
      return closed
    },
  }
}

/**
 * 把浏览器级连接附着到一个 target 上（flatten 模式，后续命令带 sessionId）。
 *
 * @param {object} connection - `connect()` 的返回值。
 * @param {object} target - `discover()` 的某个 target。
 * @param {object} [options] - 入参。
 * @param {number} [options.timeoutMs] - 超时。
 * @returns {Promise<{sessionId: string, targetId: string}>} 会话信息。
 * @throws {CdpError} target 已消失时 `CDP_TARGET_GONE`。
 */
export async function attachTo(connection, target, options = {}) {
  const targetId = text(target?.id)
  if (targetId === '') throw new CdpError('CDP_TARGET_GONE', 'target 没有 id，无法附着')
  try {
    const result = await connection.send('Target.attachToTarget', { targetId, flatten: true }, {
      timeoutMs: options.timeoutMs,
    })
    const sessionId = text(result.sessionId)
    if (sessionId === '') throw new CdpError('CDP_ERROR', 'Target.attachToTarget 没有返回 sessionId')
    return { sessionId, targetId }
  } catch (error) {
    if (error instanceof CdpError && error.code === 'CDP_ERROR' && /No target with given id/i.test(error.message)) {
      throw new CdpError('CDP_TARGET_GONE', `目标页面已消失（可能被关闭）：${targetId}`)
    }
    throw error
  }
}

/**
 * 解析 frame 树为扁平列表 + 父子索引。
 * @param {unknown} frameTree - `Page.getFrameTree` 的 frameTree。
 * @returns {{ frames: object[], index: Map<string, {parentId: string|null, index: number, url: string}> }} 结果。
 */
function collectFrames(frameTree) {
  const frames = []
  const index = new Map()
  const visit = (node, parentId, childIndex) => {
    if (!isRecord(node)) return
    const frame = isRecord(node.frame) ? node.frame : {}
    const frameId = text(frame.id)
    if (frameId === '') return
    const url = text(frame.url)
    const name = text(frame.name)
    index.set(frameId, { parentId, index: childIndex, url })
    frames.push({ frameId, parentId, index: childIndex, url, name })
    const children = Array.isArray(node.childFrames) ? node.childFrames : []
    for (let i = 0; i < children.length; i += 1) visit(children[i], frameId, i + 1)
  }
  visit(frameTree, null, 0)
  return { frames, index }
}

/**
 * 把 `Target.attachedToTarget` 事件补进 frame 表。
 *
 * 为什么需要：根 `Page.getFrameTree` **不含**跨源 iframe（OOPIF）的子 frame，
 * 只有 attached 事件里才有；而 `params.targetInfo.targetId` 就是子 frameId
 * （真机验证过），`event.sessionId`（发事件的会话）就是父 frame 的会话。
 *
 * `index` 用「父 frame 下的子序号」：先由根 frame 树播种（`seedChildCount`），
 * 再对 attached 子 frame 递增，于是路径稳定成 `main > #1 > #2`。
 *
 * @param {object} args - 入参。
 * @param {object[]} args.frames - frame 列表（会被 push）。
 * @param {Map<string, {parentId: string|null, index: number, url: string}>} args.frameIndex - frame 索引（会被 set）。
 * @param {Map<string, number>} args.childCount - 父 frameId（根用 `__root__`）→ 已见子 frame 数（会被改）。
 * @param {string} args.childFrameId - 子 frame id（= attached 事件的 `targetInfo.targetId`）。
 * @param {string|null} [args.parentFrameId] - 父 frame id；空表示父链未知（当根 frame）。
 * @param {string} [args.url] - 子 frame 的 url。
 * @returns {{frameId: string, parentId: string|null, index: number, url: string, name: string}|null}
 *   新 frame；已存在（重复事件）返回 null。
 */
export function mergeAttachedFrame({ frames, frameIndex, childCount, childFrameId, parentFrameId, url = '' }) {
  const frameId = text(childFrameId)
  if (frameId === '' || frameIndex.has(frameId)) return null
  const parentId = text(parentFrameId) === '' ? null : text(parentFrameId)
  const key = parentId ?? '__root__'
  const childIndex = (childCount.get(key) ?? 0) + 1
  childCount.set(key, childIndex)
  const frame = { frameId, parentId, index: childIndex, url: text(url), name: '' }
  frames.push(frame)
  frameIndex.set(frameId, { parentId, index: childIndex, url: frame.url })
  return frame
}

/**
 * 每一层 frame 已有的子数量（从根 frame 树播种），供 `mergeAttachedFrame` 续号。
 * @param {object[]} frames - `collectFrames` 的 frames。
 * @returns {Map<string, number>} 父 frameId（根用 `__root__`）→ 子数量。
 */
export function seedChildCount(frames) {
  const childCount = new Map()
  for (const frame of Array.isArray(frames) ? frames : []) {
    const key = frame?.parentId ?? '__root__'
    childCount.set(key, (childCount.get(key) ?? 0) + 1)
  }
  return childCount
}

/**
 * 等一轮 attached 事件收完：来第一个事件前最多等 `ATTACH_FIRST_WAIT_MS`，
 * 之后静默 `ATTACH_QUIET_MS` 即返回；总体不超过 `ATTACH_BURST_CAP_MS`。
 *
 * @param {object[]} events - 事件累积数组（只读、看 length）。
 * @param {number} since - 已处理到的下标。
 * @param {object} [options] - 入参。
 * @param {number} [options.firstWaitMs] - 首事件等待。
 * @param {number} [options.quietMs] - 静默判定。
 * @param {number} [options.capMs] - 单轮上限。
 * @returns {Promise<void>} 收完。
 */
function collectBurst(events, since, options = {}) {
  const firstWaitMs = Number.isFinite(options.firstWaitMs) ? options.firstWaitMs : ATTACH_FIRST_WAIT_MS
  const quietMs = Number.isFinite(options.quietMs) ? options.quietMs : ATTACH_QUIET_MS
  const capMs = Number.isFinite(options.capMs) ? options.capMs : ATTACH_BURST_CAP_MS
  return new Promise((resolve) => {
    const startedAt = Date.now()
    let lastCount = events.length
    let lastChangeAt = startedAt
    const timer = setInterval(() => {
      const now = Date.now()
      if (events.length !== lastCount) {
        lastCount = events.length
        lastChangeAt = now
      }
      const grew = events.length > since
      const settled = grew ? now - lastChangeAt >= quietMs : now - startedAt >= firstWaitMs
      if (!settled && now - startedAt < capMs) return
      clearInterval(timer)
      resolve()
    }, 25)
  })
}

/**
 * 逐层解析 frame 在顶层视口里的偏移（换算不了就标 null，绝不编造）。
 *
 * @param {object} args - 入参。
 * @param {object} args.connection - CDP 连接。
 * @param {Map<string, string>} args.sessionOfFrame - frameId → 会话 id（根 frame 用根会话）。
 * @param {object[]} args.frames - `collectFrames` 的 frames。
 * @param {Map<string, {parentId: string|null, index: number}>} args.index - 父子索引。
 * @param {number} args.timeoutMs - 单条命令超时。
 * @returns {Promise<Map<string, {x:number,y:number}|null>>} frameId → 偏移。
 */
async function resolveFrameOffsets({ connection, sessionOfFrame, frames, index, timeoutMs }) {
  const offsets = new Map()
  const byDepth = [...frames].sort((a, b) => depthOf(a.frameId, index) - depthOf(b.frameId, index))
  for (const frame of byDepth) {
    if (frame.parentId === null || frame.parentId === undefined) {
      offsets.set(frame.frameId, { x: 0, y: 0 })
      continue
    }
    const parentOffset = offsets.get(frame.parentId)
    if (parentOffset === null || parentOffset === undefined) {
      offsets.set(frame.frameId, null)
      continue
    }
    const sessionId = sessionOfFrame.get(frame.parentId) ?? sessionOfFrame.get('__root__')
    if (typeof sessionId !== 'string' || sessionId === '') {
      offsets.set(frame.frameId, null)
      continue
    }
    try {
      const owner = await connection.send('DOM.getFrameOwner', { frameId: frame.frameId }, { sessionId, timeoutMs })
      const backendNodeId = Number(owner.backendNodeId)
      if (!Number.isSafeInteger(backendNodeId) || backendNodeId <= 0) {
        offsets.set(frame.frameId, null)
        continue
      }
      const model = await connection.send('DOM.getBoxModel', { backendNodeId }, { sessionId, timeoutMs })
      const content = Array.isArray(model?.model?.content) ? model.model.content : null
      const box = quadToBox(content)
      offsets.set(frame.frameId, box === null ? null : { x: box.x + parentOffset.x, y: box.y + parentOffset.y })
    } catch {
      offsets.set(frame.frameId, null)
    }
  }
  return offsets
}

/**
 * frame 深度（根为 0）。
 * @param {string} frameId - frame id。
 * @param {Map<string, {parentId: string|null}>} index - 父子索引。
 * @returns {number} 深度。
 */
function depthOf(frameId, index) {
  let depth = 0
  let cursor = frameId
  let guard = 0
  while (guard < 32) {
    const info = index.get(cursor)
    if (info === undefined || info.parentId === null || info.parentId === undefined) return depth
    depth += 1
    cursor = info.parentId
    guard += 1
  }
  return depth
}

/**
 * 取 AX 节点的 backendDOMNodeId（跳过没有对应 DOM 节点的节点）。
 * @param {object} node - AXNode。
 * @returns {number|undefined} backendNodeId。
 */
function backendIdOf(node) {
  const value = Number(node?.backendDOMNodeId)
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/**
 * 深度快照：直连 CDP，读 a11y 树（或 DOM 树），返回顶层视口坐标的紧凑节点表。
 *
 * @param {object} options - 入参。
 * @param {string} [options.endpoint] - 显式 CDP 端点；为空时读 `portFile`。
 * @param {string} [options.portFile] - Chromium 的 `DevToolsActivePort` 路径。
 * @param {string} [options.url] - 目标页面 URL；缺省时要求只有一个页面。
 * @param {number} [options.maxNodes=200] - 最多返回节点数。
 * @param {'a11y'|'dom'} [options.scope='a11y'] - 读取路线。
 * @param {boolean} [options.includeFrames=true] - 是否深入跨源 iframe。
 * @param {number} [options.timeoutMs=8000] - 单条命令超时。
 * @returns {Promise<{ ok:true, target:{url:string,type:string,title:string}, nodes:object[], stats:object }>} 结果值。
 * @throws {CdpError} 端口不可达/命令失败/target 消失等。
 */
export async function deepSnapshot(options) {
  const endpoint = await resolveEndpoint({
    endpoint: text(options?.endpoint),
    portFile: text(options?.portFile),
  })
  const maxNodes = Number.isSafeInteger(options?.maxNodes) && options.maxNodes > 0 ? options.maxNodes : 200
  const scope = options?.scope === 'dom' ? 'dom' : 'a11y'
  const includeFrames = options?.includeFrames !== false
  const timeoutMs = Number.isFinite(options?.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_COMMAND_TIMEOUT_MS

  const discovery = await discover(endpoint, { timeoutMs: Math.min(timeoutMs, 2_000) })
  const target = matchTarget(discovery.targets, { url: text(options?.url) })
  const connection = await connect(discovery.browserWSUrl, { timeoutMs })
  const startedAt = Date.now()
  try {
    const { sessionId } = await attachTo(connection, target, { timeoutMs })
    const call = (method, params = {}, session = sessionId) => connection.send(method, params, { sessionId: session, timeoutMs })

    // 两个域都 best-effort：某域不可用时退化为「无盒子」而不是整体失败。
    try {
      await call('Accessibility.enable')
    } catch {
      // 继续：getFullAXTree 仍可能可用。
    }
    try {
      await call('DOM.enable')
    } catch {
      // DOM 域不可用 → 后续 getBoxModel 失败会标 box:null。
    }
    let boxes = new Map()
    let frameIndex = new Map()
    let frameOffsets = new Map()
    const sessionOfFrame = new Map()
    const parentFrameOfSession = new Map()
    let rows = []
    let total = 0
    let framesSeen = 1

    if (scope === 'dom') {
      const doc = await call('DOM.getDocument', { depth: -1, pierce: true })
      const flat = flattenDomTree(doc, maxNodes)
      total = flat.total
      rows = []
      for (const item of flat.nodes) {
        const box = await boxOfDomNode(call, item.nodeId)
        rows.push({
          role: item.tag,
          name: item.name,
          framePath: 'main',
          box,
        })
      }
    } else {
      // 1) 根 frame 树：同源 iframe 在里面；跨源 iframe（OOPIF）的子 frame 不在，靠 attached 事件补。
      let frameTree = null
      try {
        frameTree = await call('Page.getFrameTree')
      } catch {
        frameTree = null
      }
      const collected = collectFrames(frameTree?.frameTree)
      const frames = collected.frames
      frameIndex = collected.index
      const childCount = seedChildCount(frames)
      const rootFrameId = frames[0]?.frameId
      if (rootFrameId !== undefined) {
        sessionOfFrame.set(rootFrameId, sessionId)
        parentFrameOfSession.set(sessionId, rootFrameId)
      }
      sessionOfFrame.set('__root__', sessionId)

      // 2) 逐层 auto-attach：每个新子会话也要再开 autoAttach（OOPIF 可以嵌套），
      //    直到没有新会话；最多 4 轮 / 32 个子会话，防止无限嵌套把预算耗光。
      const childSessions = []
      if (includeFrames) {
        const attached = []
        const off = connection.on('Target.attachedToTarget', (event) => {
          if (isRecord(event.params) && isRecord(event.params.targetInfo)) {
            attached.push({ params: event.params, parentSessionId: text(event.sessionId) })
          }
        })
        const knownSessions = new Set([sessionId])
        const queue = [{ sessionId, frameId: rootFrameId }]
        let cursor = 0
        try {
          for (let round = 0; round < MAX_ATTACH_ROUNDS && queue.length > 0; round += 1) {
            const batch = queue.splice(0, queue.length)
            for (const parent of batch) {
              try {
                await connection.send('Target.setAutoAttach', {
                  autoAttach: true,
                  waitForDebuggerOnStart: false,
                  flatten: true,
                }, { sessionId: parent.sessionId, timeoutMs })
              } catch {
                // 该会话不支持 auto-attach：跳过，不影响主 frame。
              }
            }
            await collectBurst(attached, cursor)
            const fresh = attached.slice(cursor)
            cursor = attached.length
            for (const item of fresh) {
              const params = item.params
              const childSessionId = text(params.sessionId)
              const info = isRecord(params.targetInfo) ? params.targetInfo : {}
              const childFrameId = text(info.targetId)
              if (childSessionId === '' || childFrameId === '') continue
              if (knownSessions.has(childSessionId)) continue
              knownSessions.add(childSessionId)
              if (childSessions.length >= MAX_CHILD_SESSIONS) continue
              try {
                await connection.send('Runtime.runIfWaitingForDebugger', {}, { sessionId: childSessionId, timeoutMs })
              } catch {
                // waitForDebuggerOnStart:false 时本来就不暂停，这条失败属正常。
              }
              const parentFrameId = parentFrameOfSession.get(item.parentSessionId) ?? rootFrameId ?? null
              const merged = mergeAttachedFrame({
                frames,
                frameIndex,
                childCount,
                childFrameId,
                parentFrameId,
                url: text(info.url),
              })
              if (merged === null) continue
              sessionOfFrame.set(merged.frameId, childSessionId)
              parentFrameOfSession.set(childSessionId, merged.frameId)
              childSessions.push({ sessionId: childSessionId, frameId: merged.frameId })
              queue.push({ sessionId: childSessionId, frameId: merged.frameId })
            }
          }
        } finally {
          off()
        }
      }
      framesSeen = frames.length

      // 3) 解析 frame 偏移（跨源加偏移；换算不了为 null）。
      if (includeFrames) {
        try {
          frameOffsets = await resolveFrameOffsets({
            connection,
            sessionOfFrame,
            frames,
            index: frameIndex,
            timeoutMs,
          })
        } catch {
          frameOffsets = new Map()
        }
      }

      // 4) 主 frame 的 AX 树（同源 iframe 的节点也会在这个树里，带 frameId）。
      const ax = await call('Accessibility.getFullAXTree')
      const axNodes = Array.isArray(ax.nodes) ? ax.nodes : []

      // 5) 需要盒子的 backendNodeId → 取一次（带 frame 偏移）。
      const wanted = new Map()
      for (const node of axNodes) {
        const backendId = backendIdOf(node)
        if (backendId === undefined) continue
        const frameId = text(node.frameId) || rootFrameId || ''
        wanted.set(backendId, frameId)
      }
      for (const [backendId, frameId] of wanted) {
        const session = sessionOfFrame.get(frameId) ?? sessionOfFrame.get('__root__')
        if (typeof session !== 'string') continue
        const offset = frameOffsets.get(frameId)
        if (offset === null) {
          boxes.set(backendId, null)
          continue
        }
        try {
          const model = await connection.send('DOM.getBoxModel', { backendNodeId: backendId }, { sessionId: session, timeoutMs: Math.min(timeoutMs, 2_000) })
          const box = quadToBox(model?.model?.content)
          boxes.set(backendId, offsetBox(box, offset ?? null))
        } catch {
          boxes.set(backendId, null)
        }
      }

      const flat = flattenAxTree(axNodes, {
        maxNodes,
        boxOf: (node) => {
          const backendId = backendIdOf(node)
          if (backendId === undefined) return null
          return boxes.get(backendId) ?? null
        },
        pathOf: (node) => framePathOf(text(node.frameId) || rootFrameId || '', frameIndex),
      })
      rows = flat.nodes
      total = flat.total

      // 6) 跨源 iframe 自己的 AX 树（每个子会话单独取；frameId/路径来自 attached 事件）。
      if (includeFrames) {
        for (const child of childSessions) {
          if (rows.length >= maxNodes && total > rows.length) break
          let childAx
          try {
            childAx = await connection.send('Accessibility.getFullAXTree', {}, { sessionId: child.sessionId, timeoutMs })
          } catch {
            continue
          }
          const childNodes = Array.isArray(childAx.nodes) ? childAx.nodes : []
          const remaining = Math.max(0, maxNodes - rows.length)
          const offset = frameOffsets.get(child.frameId)
          const childBoxes = new Map()
          for (const node of childNodes) {
            const backendId = backendIdOf(node)
            if (backendId === undefined) continue
            if (offset === null || offset === undefined) {
              childBoxes.set(backendId, null)
              continue
            }
            try {
              const model = await connection.send('DOM.getBoxModel', { backendNodeId: backendId }, { sessionId: child.sessionId, timeoutMs: Math.min(timeoutMs, 2_000) })
              childBoxes.set(backendId, offsetBox(quadToBox(model?.model?.content), offset))
            } catch {
              childBoxes.set(backendId, null)
            }
          }
          const childFlat = flattenAxTree(childNodes, {
            maxNodes: remaining,
            boxOf: (node) => {
              const backendId = backendIdOf(node)
              if (backendId === undefined) return null
              return childBoxes.get(backendId) ?? null
            },
            pathOf: () => framePathOf(child.frameId, frameIndex),
          })
          total += childFlat.total
          rows.push(...childFlat.nodes)
        }
      }
    }

    const sample = rows.map((row) => `${row.role} ${row.name} ${row.framePath}`).join('\n')
    return {
      ok: true,
      target: { url: target.url, type: target.type, title: target.title },
      nodes: rows,
      stats: {
        nodes: rows.length,
        total,
        truncated: total > rows.length,
        frames: framesSeen,
        scope,
        estTokens: estimateTokens(sample),
        ms: Date.now() - startedAt,
      },
    }
  } finally {
    connection.close()
  }
}

/**
 * 在 DOM 树里挑出值得展示的节点（含 shadow root 穿透结果）。
 * @param {unknown} document - `DOM.getDocument` 结果。
 * @param {number} maxNodes - 上限。
 * @returns {{ nodes: {nodeId:number, tag:string, name:string}[], total:number }} 结果。
 */
function flattenDomTree(document, maxNodes) {
  const nodes = []
  let total = 0
  const visit = (raw) => {
    if (!isRecord(raw)) return
    const node = raw
    const nodeName = text(node.nodeName).toLowerCase()
    if (DOM_TAGS.has(nodeName)) {
      const attributes = Array.isArray(node.attributes) ? node.attributes : []
      const pick = (name) => {
        for (let index = 0; index + 1 < attributes.length; index += 2) {
          if (text(attributes[index]).toLowerCase() === name) return text(attributes[index + 1])
        }
        return ''
      }
      const name = pick('aria-label') || pick('title') || pick('placeholder') || pick('alt') || pick('name') || nodeName
      total += 1
      if (nodes.length < maxNodes) {
        nodes.push({ nodeId: Number(node.nodeId), tag: nodeName, name: name.slice(0, 160) })
      }
    }
    for (const child of Array.isArray(node.children) ? node.children : []) visit(child)
    const shadow = Array.isArray(node.shadowRoots) ? node.shadowRoots : []
    for (const child of shadow) visit(child)
    if (isRecord(node.contentDocument)) visit(node.contentDocument)
  }
  visit(isRecord(document) ? document.root : null)
  return { nodes, total }
}

/**
 * 取一个 DOM 节点的盒子（顶层视口坐标；失败为 null）。
 * @param {Function} call - 绑定根会话的 send。
 * @param {number} nodeId - DOM nodeId。
 * @returns {Promise<object|null>} 盒子。
 */
async function boxOfDomNode(call, nodeId) {
  if (!Number.isSafeInteger(nodeId) || nodeId <= 0) return null
  try {
    const model = await call('DOM.getBoxModel', { nodeId })
    return quadToBox(model?.model?.content)
  } catch {
    return null
  }
}
