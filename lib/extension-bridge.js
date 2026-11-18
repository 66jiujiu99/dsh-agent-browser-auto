/**
 * 扩展桥接后端（0.8.0）：Host 侧 loopback WebSocket 服务。
 *
 * 用户日常浏览器（Edge/Chrome 默认 profile）装上 `extension/` 里的 MV3 扩展后，
 * 扩展主动连到 `ws://127.0.0.1:<extensionBridge.port>?token=<token>`，命令与结果
 * 经这条常驻连接往返——不开 CDP 调试端口、没有 --remote-debugging、没有授权弹窗。
 *
 * 认证（PROTOCOL §8）：
 * - `browser_ext_pair` 生成**一次性配对码**（8 位无歧义字符，默认 5 分钟过期，单次使用）；
 * - 扩展首次用配对码连接，Host 回 `{type:'ready', token}` 下发**长效 token**；
 * - 扩展把 token 存 `chrome.storage.local`，之后每次重连都带它；
 * - Host 只存 token 的 SHA-256（`<auditDir>/extension-paired.json`），文件泄露不等于授权泄露。
 *
 * 安全边界（与 deepMode/专用实例同一套硬约束）：
 * - HTTP/WS 只绑 `127.0.0.1`，不接受远程地址；
 * - token 校验失败在 HTTP upgrade 阶段直接 401，不升级到 WebSocket；
 * - `port` 只来自插件配置，工具参数不能覆盖（防提示注入）；
 * - 消息里绝不记录 token 原文，审计只写哈希前 8 位。
 *
 * 会话模型：扩展的 clientId 是「安装 id」（storage.local 里的随机串）。同一个
 * clientId 的新连接会**顶掉**旧连接（断网重连 / SW 被杀后 offscreen 接管都会触发）。
 * 多个浏览器（Edge + Chrome 都装了扩展）时，命令发给最近心跳的那一个。
 *
 * 可测试性：时钟、token/配对码生成、文件 IO 全部可注入；单测用真实 ws 服务
 * 绑端口 0（内核随机端口）+ Node 内建 WebSocket 客户端跑完整往返。
 *
 * @module dsh-agent-browser-auto/extension-bridge
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import { BridgeError } from './bridge.js'
import { DEFAULT_EXTENSION_PORT } from './config.js'

/** 协议版本（PROTOCOL §8；不兼容改动时递增）。 */
export const EXTENSION_BRIDGE_PROTOCOL_VERSION = 1

/** 配对码字母表：去掉 0/O/1/I/L 等易混字符。 */
const PAIR_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

/** 配对码长度。 */
const PAIR_CODE_LENGTH = 8

/** 扩展多久没有任何消息就判定掉线（扩展每 20s ping 一次）。 */
const EXTENSION_TTL_MS = 45_000

/** 掉线/过期扫描间隔。 */
const SWEEP_INTERVAL_MS = 15_000

/** 端口被占用时的重试次数与间隔（「退避」：给短暂占用者让路，随后如实报错）。 */
const PORT_RETRY_ATTEMPTS = 3
const PORT_RETRY_DELAY_MS = 2_000

/** 配对状态文件名（auditDir 下）。 */
const PAIRED_FILE = 'extension-paired.json'

/** 过期配对码清理定时器间隔。 */
const PAIR_SWEEP_INTERVAL_MS = 15_000

/**
 * 是否是普通对象。
 * @param {unknown} value - 任意值。
 * @returns {boolean} 结论。
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 默认随机长效 token（base64url，32 字节熵）。
 * @returns {string} token。
 */
function defaultRandomToken() {
  return randomBytes(32).toString('base64url')
}

/**
 * 默认配对码生成：8 位无歧义大写字母数字。
 * @returns {string} 配对码。
 */
function defaultRandomPairCode() {
  let code = ''
  const bytes = randomBytes(PAIR_CODE_LENGTH)
  for (let index = 0; index < PAIR_CODE_LENGTH; index += 1) {
    code += PAIR_ALPHABET[bytes[index] % PAIR_ALPHABET.length]
  }
  return code
}

/**
 * token 的 SHA-256 十六进制摘要（存储与比对都用它，原文不落盘）。
 * @param {string} token - 原文。
 * @returns {string} 摘要。
 */
export function tokenDigest(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/**
 * 审计里可安全展示的 token 指纹（前 8 位）。
 * @param {string} digest - SHA-256 摘要。
 * @returns {string} 指纹。
 */
function digestHint(digest) {
  return digest.slice(0, 8)
}

/**
 * 常量时间比较两个等长字符串；不等长直接 false。
 * @param {string} a - 左值。
 * @param {string} b - 右值。
 * @returns {boolean} 是否相同。
 */
function safeEqual(a, b) {
  if (a.length !== b.length) return false
  try {
    return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
  } catch {
    return false
  }
}

/**
 * 从 upgrade 请求 URL 里取 token 查询参数。
 * @param {string|undefined} rawUrl - `req.url`。
 * @returns {string} token（可能为空串）。
 */
function tokenOf(rawUrl) {
  try {
    return new URL(rawUrl ?? '/', 'http://127.0.0.1.invalid').searchParams.get('token') ?? ''
  } catch {
    return ''
  }
}

/**
 * 建扩展桥接服务。
 * @param {object} deps - 依赖。
 * @param {import('./config.js').ResolvedConfig} deps.config - 已解析配置。
 * @param {ReturnType<import('./audit.js').createAudit>} deps.audit - 审计器（含 saveShot）。
 * @param {(level: 'debug'|'info'|'warn'|'error', message: string) => void} [deps.log] - 日志出口。
 * @param {object} [io] - 注入实现（测试用）。
 * @param {() => number} [io.now] - 时钟。
 * @param {() => string} [io.randomToken] - 长效 token 生成。
 * @param {() => string} [io.randomPairCode] - 配对码生成。
 * @param {(ms: number) => Promise<void>} [io.delay] - 端口重试等待。
 * @param {typeof readFile} [io.readFile] - 配对状态读取。
 * @param {typeof writeFile} [io.writeFile] - 配对状态写入。
 * @param {typeof mkdir} [io.mkdir] - 审计目录创建。
 * @returns {object} 扩展桥接服务（driver 接口 + beginPairing/status）。
 */
export function createExtensionBridge({ config, audit, log = () => {}, io = {} }) {
  const now = io.now ?? Date.now
  const randomToken = io.randomToken ?? defaultRandomToken
  const randomPairCode = io.randomPairCode ?? defaultRandomPairCode
  const delay = io.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const readFileImpl = io.readFile ?? readFile
  const writeFileImpl = io.writeFile ?? writeFile
  const mkdirImpl = io.mkdir ?? mkdir
  const pairedFile = join(config.auditDir, PAIRED_FILE)

  /** @type {Map<string, { code: string, token: string, digest: string, expiresAt: number }>} 配对码 → 待换取记录（key=code）。 */
  const pendingPairs = new Map()

  /** @type {Array<{ clientId: string, digest: string, pairedAt: number }>} 已配对客户端（持久化到 pairedFile）。 */
  let pairedClients = []

  /** 配对状态是否已从磁盘加载（懒加载一次；读失败按空处理，只在配对写入时报错）。 */
  let pairedLoaded = false

  /** @type {Map<string, { clientId: string, ws: import('ws').WebSocket, lastSeen: number, pairedAt: number }>} clientId → 在线会话。 */
  const sessions = new Map()

  /** @type {Map<string, { op: string, clientId: string, resolveValue: (value: unknown) => void, rejectWith: (error: Error) => void }>} 在途命令。 */
  const pending = new Map()

  let commandSequence = 0
  let disposed = false
  /** @type {import('node:http').Server|undefined} */
  let server
  /** @type {import('ws').WebSocketServer|undefined} */
  let wss
  let listening = false
  let portError = ''

  /** 最近一次已知 URL（按 session 记，供审计 urlBefore）。 @type {Map<string, string>} */
  const lastUrl = new Map()

  const sweepTimer = setInterval(() => sweep(), SWEEP_INTERVAL_MS)
  sweepTimer.unref?.()
  const pairSweepTimer = setInterval(() => sweepPairs(), PAIR_SWEEP_INTERVAL_MS)
  pairSweepTimer.unref?.()

  /**
   * 写一条日志（warn 级别向上，debug 只进 debug.jsonl）。
   * @param {string} message - 正文。
   * @returns {void}
   */
  function warn(message) {
    log('warn', `agent-browser-auto: ${message}`)
    audit.debug('extension-warn', { message })
  }

  /**
   * 惰性加载已配对客户端列表；失败按空列表处理（丢配对 = 用户重新 pair 一次）。
   * @returns {Promise<void>} 完成。
   */
  async function loadPaired() {
    if (pairedLoaded) return
    pairedLoaded = true
    try {
      const raw = await readFileImpl(pairedFile, 'utf8')
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed?.clients)) {
        pairedClients = parsed.clients.filter((entry) => isRecord(entry)
          && typeof entry.clientId === 'string' && typeof entry.digest === 'string')
      }
    } catch {
      pairedClients = []
    }
    audit.debug('extension-paired-loaded', { count: pairedClients.length })
  }

  /**
   * 持久化已配对客户端列表（写失败只告警，不阻塞本次配对）。
   * @returns {Promise<void>} 完成。
   */
  async function savePaired() {
    try {
      await mkdirImpl(config.auditDir, { recursive: true })
      await writeFileImpl(pairedFile, `${JSON.stringify({ version: 1, clients: pairedClients }, null, 2)}\n`, 'utf8')
    } catch (error) {
      warn(`写配对状态失败（${pairedFile}）：${String(error?.message ?? error)}`)
    }
  }

  /**
   * 清理过期的一次性配对码。
   * @returns {void} 无返回。
   */
  function sweepPairs() {
    const stamp = now()
    for (const [code, pair] of [...pendingPairs.entries()]) {
      if (pair.expiresAt > stamp) continue
      pendingPairs.delete(code)
      audit.debug('extension-pair-expired', { fingerprint: digestHint(pair.digest) })
    }
  }

  /**
   * 关闭超时无消息的扩展连接。
   * @returns {void} 无返回。
   */
  function sweep() {
    if (disposed) return
    const stamp = now()
    for (const [clientId, session] of [...sessions.entries()]) {
      if (stamp - session.lastSeen <= EXTENSION_TTL_MS) continue
      audit.debug('extension-timeout', { clientId })
      try {
        session.ws.close(4008, 'heartbeat-timeout')
      } catch {
        // socket 已经死了，忽略。
      }
      removeSession(clientId, 'heartbeat-timeout')
    }
  }

  /**
   * 摘除一个会话并让它的在途命令失败。
   * @param {string} clientId - 客户端 id。
   * @param {string} reason - 摘除原因。
   * @returns {boolean} 是否真的摘除了。
   */
  function removeSession(clientId, reason) {
    const session = sessions.get(clientId)
    if (session === undefined) return false
    sessions.delete(clientId)
    for (const [id, entry] of [...pending.entries()]) {
      if (entry.clientId !== clientId) continue
      audit.debug('extension-command-aborted', { id, op: entry.op, clientId, reason })
      entry.rejectWith(new BridgeError('EXTENSION_OFFLINE', '扩展连接已断开，命令已取消；等待扩展重连后重试。', clientId))
      pending.delete(id)
    }
    audit.debug('extension-offline', { clientId, reason, sessions: sessions.size })
    return true
  }

  /**
   * 挑最近心跳的在线会话。
   * @returns {{ clientId: string, ws: import('ws').WebSocket, lastSeen: number, pairedAt: number }|undefined} 会话。
   */
  function pickSession() {
    let best
    for (const session of sessions.values()) {
      if (best === undefined || session.lastSeen > best.lastSeen) best = session
    }
    return best
  }

  /**
   * 校验 upgrade 阶段的 token。返回配对模式或 null（拒绝）。
   * @param {string} token - 查询参数里的 token（配对码或长效 token）。
   * @returns {Promise<{ mode: 'pair', pair: { code: string, token: string, digest: string, expiresAt: number } }|{ mode: 'auth', digest: string }|null>} 结论。
   */
  async function authenticate(token) {
    if (typeof token !== 'string' || token === '') return null
    const pair = pendingPairs.get(token)
    if (pair !== undefined) {
      if (pair.expiresAt <= now()) {
        pendingPairs.delete(token)
        return null
      }
      return { mode: 'pair', pair }
    }
    await loadPaired()
    const digest = tokenDigest(token)
    const known = pairedClients.find((entry) => safeEqual(entry.digest, digest))
    if (known !== undefined) return { mode: 'auth', digest }
    return null
  }

  /**
   * HTTP 阶段直接拒绝升级（不升级成 WebSocket，扩展侧 onerror+onclose）。
   * @param {import('node:net').Socket} socket - TCP socket。
   * @param {number} status - HTTP 状态码。
   * @param {string} reason - 短原因。
   * @returns {void} 无返回。
   */
  function rejectUpgrade(socket, status, reason) {
    try {
      socket.write(`HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : 'Rejected'}\r\nconnection: close\r\ncontent-type: text/plain; charset=utf-8\r\nx-content-type-options: nosniff\r\n\r\n${reason}\n`)
    } catch {
      // 写失败就当对端已断。
    }
    socket.destroy()
    audit.debug('extension-auth-rejected', { status })
  }

  /**
   * 组装发给扩展的消息（统一走这里，便于审计与防 undefined）。
   * @param {import('ws').WebSocket} ws - 目标连接。
   * @param {Record<string, unknown>} message - 消息体（不能含 undefined 值字段）。
   * @returns {void} 无返回。
   */
  function sendTo(ws, message) {
    if (ws.readyState !== 1) return
    try {
      ws.send(JSON.stringify(message))
    } catch (error) {
      audit.debug('extension-send-failed', { message: String(error?.message ?? error) })
    }
  }

  /**
   * 处理一条扩展消息。
   * @param {object} session - 会话记录。
   * @param {unknown} raw - 解析后的消息。
   * @returns {void} 无返回。
   */
  function onMessage(session, raw) {
    if (!isRecord(raw) || typeof raw.type !== 'string') {
      audit.debug('extension-bad-message', { clientId: session.clientId })
      return
    }
    session.lastSeen = now()
    switch (raw.type) {
      case 'ping': {
        sendTo(session.ws, { type: 'pong', t: typeof raw.t === 'number' ? raw.t : 0 })
        return
      }
      case 'hello': {
        // hello 在 upgrade 后到来；重复 hello（重连竞态）按幂等处理。
        audit.debug('extension-hello', { clientId: session.clientId })
        sendTo(session.ws, { type: 'helloAck', version: EXTENSION_BRIDGE_PROTOCOL_VERSION })
        return
      }
      case 'result': {
        const id = typeof raw.id === 'string' ? raw.id : ''
        const entry = pending.get(id)
        if (entry === undefined) {
          audit.debug('extension-result-orphan', { id, ok: raw.ok === true })
          return
        }
        pending.delete(id)
        if (raw.ok === true) {
          const value = raw.value === undefined ? {} : raw.value
          audit.debug('extension-result', { id, op: entry.op, clientId: entry.clientId, ok: true })
          entry.resolveValue(value)
        } else {
          const code = isRecord(raw.error) && typeof raw.error.code === 'string' && raw.error.code !== ''
            ? raw.error.code
            : 'INTERNAL'
          const message = isRecord(raw.error) && typeof raw.error.message === 'string' && raw.error.message !== ''
            ? raw.error.message
            : '扩展返回了未标注原因的错误'
          audit.debug('extension-result', { id, op: entry.op, clientId: entry.clientId, ok: false, code })
          entry.rejectWith(new BridgeError(code, message, entry.clientId))
        }
        return
      }
      case 'log': {
        const level = typeof raw.level === 'string' ? raw.level : 'info'
        const message = typeof raw.message === 'string' ? raw.message.slice(0, 4000) : ''
        if (message === '') return
        audit.debug('extension-log', { clientId: session.clientId, level, message, data: raw.data })
        return
      }
      default: {
        audit.debug('extension-unknown-message', { clientId: session.clientId, type: raw.type })
      }
    }
  }

  /**
   * 启动 loopback HTTP + WS 服务（端口被占用时退避重试，最终失败只报状态不抛）。
   * @returns {Promise<{ ok: boolean, port: number, listening: boolean, error: string }>} 启动结果。
   */
  async function start() {
    if (disposed) return { ok: false, port: config.extensionBridge.port, listening: false, error: 'disposed' }
    if (listening) return { ok: true, port: actualPort(), listening: true, error: '' }
    const wantedPort = config.extensionBridge.port
    let lastError = ''
    for (let attempt = 1; attempt <= PORT_RETRY_ATTEMPTS; attempt += 1) {
      const outcome = await listenOnce(wantedPort)
      if (outcome.ok) {
        listening = true
        portError = ''
        audit.debug('extension-listen', { port: actualPort(), attempts: attempt })
        log('info', `agent-browser-auto: 扩展桥接 WS 服务已监听 ws://127.0.0.1:${actualPort()}（第 ${attempt} 次尝试）`)
        return { ok: true, port: actualPort(), listening: true, error: '' }
      }
      lastError = outcome.error
      audit.debug('extension-listen-retry', { port: wantedPort, attempt, error: lastError })
      if (attempt < PORT_RETRY_ATTEMPTS) await delay(PORT_RETRY_DELAY_MS)
      if (disposed) break
    }
    portError = lastError
    warn(`扩展桥接端口 ${wantedPort} 监听失败（重试 ${PORT_RETRY_ATTEMPTS} 次）：${lastError}。`
      + '请在插件配置里换 extensionBridge.port，或释放被占用的端口；扩展桥接在恢复前不可用。')
    return { ok: false, port: wantedPort, listening: false, error: lastError }
  }

  /**
   * 单次监听尝试（绑 127.0.0.1，挂 upgrade 与普通请求处理）。
   * @param {number} port - 目标端口（0 = 内核随机分配，测试用）。
   * @returns {Promise<{ ok: boolean, error: string }>} 结果。
   */
  function listenOnce(port) {
    return new Promise((resolve) => {
      let settled = false
      const httpServer = http.createServer((req, res) => {
        // 非 upgrade 请求（浏览器手滑访问端口）：不给页面内容，只说明用途。
        res.writeHead(426, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ ok: false, error: { code: 'UPGRADE_REQUIRED', message: '此端口是扩展桥接 WebSocket 端点（loopback），不接受普通 HTTP 请求。' } }))
      })
      /**
       * 收尾：只取第一次结论；失败时关掉残骸再返回。
       * @param {{ ok: boolean, error: string }} outcome - 结果。
       * @returns {void} 无返回。
       */
      const finish = (outcome) => {
        if (settled) return
        settled = true
        resolve(outcome)
      }
      httpServer.on('error', (error) => {
        // 只有仍是当前实例的错误才归这次尝试（重试会替换 server）。
        if (httpServer !== server) return
        try { httpServer.close() } catch { /* 忽略 */ }
        try { httpServer.closeAllConnections?.() } catch { /* 忽略 */ }
        finish({ ok: false, error: String(error?.message ?? error) })
      })
      httpServer.on('upgrade', (req, socket, head) => {
        void handleUpgrade(req, socket, head)
      })
      server = httpServer
      wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 })
      httpServer.listen(port, '127.0.0.1', () => finish({ ok: true, error: '' }))
    })
  }

  /**
   * 处理一次 WebSocket upgrade：先在 HTTP 层认证 token，通过才升级。
   * @param {import('node:http').IncomingMessage} req - 请求。
   * @param {import('node:net').Socket} socket - TCP socket。
   * @param {Buffer} head - 首包。
   * @returns {Promise<void>} 完成。
   */
  async function handleUpgrade(req, socket, head) {
    const token = tokenOf(req.url)
    const auth = await authenticate(token)
    if (auth === null) {
      rejectUpgrade(socket, 401, 'token 无效或配对码已过期：请先用 browser_ext_pair 生成新的配对码。')
      return
    }
    audit.debug('extension-auth', {
      mode: auth.mode,
      fingerprint: digestHint(auth.mode === 'pair' ? auth.pair.digest : auth.digest),
    })
    wss.handleUpgrade(req, socket, head, (ws) => {
      void onConnection(ws, auth)
    })
  }

  /**
   * 一条已认证连接的生命周期：ready → hello → 命令往返。
   * @param {import('ws').WebSocket} ws - 连接。
   * @param {{ mode: 'pair', pair: { code: string, token: string, digest: string, expiresAt: number } }|{ mode: 'auth', digest: string }} auth - 认证结论。
   * @returns {Promise<void>} 完成。
   */
  async function onConnection(ws, auth) {
    let clientId = ''
    let generatedId = ''
    /** @type {number|undefined} */
    let pairedAt
    if (auth.mode === 'pair') {
      // 一次性：立刻烧掉配对码，换发长效 token。clientId 由扩展的 hello 提供
      // （安装 id 归扩展所有），Host 生成的占位 id 只在丢失 hello 时兜底。
      pendingPairs.delete(auth.pair.code)
      generatedId = `ext-${randomBytes(4).toString('hex')}`
      clientId = generatedId
      pairedAt = now()
      await loadPaired()
      pairedClients = pairedClients.filter((entry) => entry.digest !== auth.pair.digest)
      pairedClients.push({ clientId: generatedId, digest: auth.pair.digest, pairedAt })
      await savePaired()
      audit.debug('extension-paired', { clientId: generatedId, fingerprint: digestHint(auth.pair.digest) })
      sendTo(ws, { type: 'ready', version: EXTENSION_BRIDGE_PROTOCOL_VERSION, token: auth.pair.token })
    } else {
      const known = pairedClients.find((entry) => safeEqual(entry.digest, auth.digest))
      clientId = typeof known?.clientId === 'string' && known.clientId !== '' ? known.clientId : `ext-${randomBytes(4).toString('hex')}`
      sendTo(ws, { type: 'ready', version: EXTENSION_BRIDGE_PROTOCOL_VERSION })
    }

    /**
     * 等待扩展的 hello 才注册会话；在此之前它的命令不能被路由。
     * @param {number} timeoutMs - 上限。
     * @returns {Promise<string>} 注册成功的 clientId；失败抛 BridgeError。
     */
    const waitForHello = () => new Promise((resolveHello, rejectHello) => {
      const timer = setTimeout(() => {
        cleanup()
        rejectHello(new BridgeError('BAD_REQUEST', '扩展连接后 10s 内没有发送 hello'))
      }, 10_000)
      timer.unref?.()
      /**
       * 清掉监听。
       * @returns {void} 无返回。
       */
      function cleanup() {
        clearTimeout(timer)
        ws.off('message', onHelloMessage)
        ws.off('close', onEarlyClose)
      }
      /**
       * 解析第一条消息。
       * @param {Buffer} data - 原始帧。
       * @returns {void} 无返回。
       */
      function onHelloMessage(data) {
        let parsed
        try {
          parsed = JSON.parse(String(data))
        } catch {
          return
        }
        if (!isRecord(parsed) || parsed.type !== 'hello') return
        if (typeof parsed.clientId === 'string' && parsed.clientId.trim() !== '') clientId = parsed.clientId.trim().slice(0, 200)
        cleanup()
        resolveHello(clientId)
      }
      /**
       * hello 之前就断线。
       * @returns {void} 无返回。
       */
      function onEarlyClose() {
        cleanup()
        rejectHello(new BridgeError('NO_CLIENT', '扩展在 hello 之前断开'))
      }
      ws.on('message', onHelloMessage)
      ws.on('close', onEarlyClose)
    })

    try {
      await waitForHello()
    } catch (error) {
      audit.debug('extension-hello-failed', { message: String(error?.message ?? error) })
      try { ws.close(4002, 'hello-timeout') } catch { /* 忽略 */ }
      return
    }
    // hello 带来的安装 id 是权威：把配对记录里的占位 id 换成它。
    if (generatedId !== '' && clientId !== generatedId) {
      pairedClients = pairedClients.map((entry) => (entry.digest === auth.pair?.digest ? { ...entry, clientId } : entry))
      await savePaired()
      audit.debug('extension-client-id-bound', { clientId, placeholder: generatedId })
    }

    // 同一 clientId 的旧连接被新连接顶掉（断网重连 / offscreen 接管都会走这里）。
    const previous = sessions.get(clientId)
    if (previous !== undefined) {
      audit.debug('extension-superseded', { clientId })
      sendTo(previous.ws, { type: 'superseded', reason: 'same-client-reconnect' })
      try { previous.ws.close(4001, 'superseded') } catch { /* 忽略 */ }
    }

    /** @type {{ clientId: string, ws: import('ws').WebSocket, lastSeen: number, pairedAt: number }} */
    const session = { clientId, ws, lastSeen: now(), pairedAt: pairedAt ?? sessions.get(clientId)?.pairedAt ?? 0 }
    sessions.set(clientId, session)
    audit.debug('extension-online', { clientId, sessions: sessions.size })
    sendTo(ws, { type: 'sessionReady', clientId })

    ws.on('message', (data) => {
      let parsed
      try {
        parsed = JSON.parse(String(data))
      } catch {
        audit.debug('extension-bad-json', { clientId })
        return
      }
      onMessage(session, parsed)
    })
    ws.on('pong', () => {
      session.lastSeen = now()
    })
    ws.on('close', () => {
      // 只有仍登记为当前会话的那条连接断开才算下线（被顶掉的旧连接不再登记）。
      if (sessions.get(clientId)?.ws === ws) removeSession(clientId, 'ws-close')
    })
    ws.on('error', (error) => {
      audit.debug('extension-socket-error', { clientId, message: String(error?.message ?? error) })
    })
  }

  /**
   * 服务当前实际监听的端口（配置端口被占退避时保持一致）。
   * @returns {number} 端口。
   */
  function actualPort() {
    const address = server?.address?.()
    return typeof address === 'object' && address !== null && typeof address.port === 'number' ? address.port : config.extensionBridge.port
  }

  /**
   * 生成一次性配对码（browser_ext_pair 的执行体）。
   * @returns {{ ok: true, code: string, expiresAt: number, port: number, wsUrl: string }|{ ok: false, error: { code: string, message: string } }} 结果。
   */
  function beginPairing() {
    if (config.extensionBridge.enabled !== true) {
      return {
        ok: false,
        error: {
          code: 'EXTENSION_DISABLED',
          message: '扩展桥接未启用（extensionBridge.enabled=false）：请让用户在 cordis.patch.yml 的 agent-browser-auto 配置里打开 extensionBridge.enabled 并重新 apply 插件。',
        },
      }
    }
    sweepPairs()
    const code = randomPairCode()
    const token = randomToken()
    const expiresAt = now() + config.extensionBridge.pairTimeoutMs
    pendingPairs.set(code, { code, token, digest: tokenDigest(token), expiresAt })
    audit.debug('extension-pair-begin', { port: actualPort(), ttlMs: config.extensionBridge.pairTimeoutMs })
    const port = listening ? actualPort() : config.extensionBridge.port
    return {
      ok: true,
      code,
      expiresAt,
      port,
      wsUrl: `ws://127.0.0.1:${port}`,
    }
  }

  /**
   * 当前状态（browser_ext_status / backend status 用；lossless JSON，无 undefined）。
   * @returns {{ enabled: boolean, listening: boolean, port: number, portError: string, paired: boolean, connected: boolean, clientId: string|null, sessions: number, lastHeartbeatMs: number|null, pairPending: boolean }} 状态。
   */
  function status() {
    const session = pickSession()
    const stamp = now()
    const lastHeartbeatMs = session === undefined ? null : Math.max(0, stamp - session.lastSeen)
    return {
      enabled: config.extensionBridge.enabled === true,
      listening,
      port: listening ? actualPort() : config.extensionBridge.port,
      portError,
      paired: pairedClients.length > 0 || pendingPairs.size > 0,
      connected: session !== undefined,
      clientId: session?.clientId ?? null,
      sessions: sessions.size,
      lastHeartbeatMs,
      pairPending: pendingPairs.size > 0,
    }
  }

  /**
   * 是否至少有一个扩展在线（backend router 切换前置检查）。
   * @returns {boolean} 结论。
   */
  function connected() {
    return sessions.size > 0
  }

  /**
   * 下发一条命令给扩展并等结果；截图结果的 pngBase64 在这里落盘并摘除。
   * @param {string|undefined} sessionId - 调用方会话（扩展后端不按会话分流，但 URL 记账按会话）。
   * @param {string} op - 协议 op。
   * @param {Record<string, unknown>} args - 参数。
   * @param {number} timeoutMs - 等待上限。
   * @returns {Promise<{ value: unknown, clientId: string }>} 结果。
   */
  async function sendCommand(sessionId, op, args, timeoutMs) {
    const session = pickSession()
    if (session === undefined) {
      throw new BridgeError(
        'EXTENSION_OFFLINE',
        '扩展桥接后端没有在线的扩展：请先用 browser_ext_pair 生成配对码，'
          + '让用户在日常浏览器里加载 extension/ 目录的扩展并输入配对码；已配对过的话等扩展自动重连。',
      )
    }
    if (disposed) throw new BridgeError('NO_CHANNEL', '插件正在卸载，扩展桥接命令已不可用。')
    commandSequence += 1
    const id = `ext-${commandSequence}`
    audit.debug('extension-command', { id, op, clientId: session.clientId, sessionId, args: summarizeArgs(args) })
    const value = await new Promise((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        pending.delete(id)
        audit.debug('extension-command-timeout', { id, op, clientId: session.clientId, timeoutMs })
        reject(new BridgeError(
          'TIMEOUT',
          `命令 ${op} 在 ${timeoutMs}ms 内没有从扩展返回（${id}）；扩展可能正被浏览器休眠或页面过慢，重试一次通常可唤醒。`,
          session.clientId,
        ))
      }, timeoutMs)
      timer.unref?.()
      pending.set(id, { op, clientId: session.clientId, resolveValue: resolve, rejectWith: reject })
      sendTo(session.ws, { type: 'command', id, op, args })
    })
    rememberUrl(sessionId, value)
    return { value: await materializeScreenshot(value), clientId: session.clientId }
  }

  /**
   * 记录最近一次已知 URL（审计 urlBefore）。
   * @param {string|undefined} sessionId - 会话 id。
   * @param {unknown} value - 命令返回值。
   * @returns {void} 无返回。
   */
  function rememberUrl(sessionId, value) {
    if (typeof sessionId !== 'string' || sessionId === '' || !isRecord(value)) return
    const direct = typeof value.url === 'string' ? value.url : undefined
    const nested = isRecord(value.snapshot) && typeof value.snapshot.url === 'string' ? value.snapshot.url : undefined
    const url = direct ?? nested
    if (url !== undefined && url !== '') lastUrl.set(sessionId, url)
  }

  /**
   * 把扩展带回的截图 PNG 落盘（复用 audit.saveShot），并从结果里摘除 base64。
   * @param {unknown} value - 命令返回值。
   * @returns {Promise<unknown>} 处理后的返回值。
   */
  async function materializeScreenshot(value) {
    if (!isRecord(value) || typeof value.pngBase64 !== 'string' || value.pngBase64 === '') return value
    const base64 = value.pngBase64
    /** @type {Record<string, unknown>} */
    const rest = { ...value }
    delete rest.pngBase64
    try {
      const binary = Buffer.from(base64, 'base64')
      if (binary.length === 0) throw new Error('PNG 内容为空')
      const saved = await audit.saveShot(new Uint8Array(binary), {
        pageId: typeof value.pageId === 'string' ? value.pageId : undefined,
        url: typeof value.url === 'string' ? value.url : undefined,
      })
      return { ...rest, path: saved.path, bytes: saved.bytes }
    } catch (error) {
      warn(`扩展截图落盘失败：${String(error?.message ?? error)}`)
      return { ...rest, ok: false, error: { code: 'SCREENSHOT_SAVE_FAILED', message: `截图已捕获但写入磁盘失败：${String(error?.message ?? error)}` } }
    }
  }

  /**
   * 会话最近一次已知 URL。
   * @param {string|undefined} sessionId - 会话 id。
   * @returns {string|undefined} URL。
   */
  function knownUrl(sessionId) {
    return typeof sessionId === 'string' ? lastUrl.get(sessionId) : undefined
  }

  /**
   * 卸载：关服务、让在途命令失败、清定时器。
   * @returns {Promise<void>} 关闭完成（端口已释放）。
   */
  async function dispose() {
    if (disposed) return
    disposed = true
    clearInterval(sweepTimer)
    clearInterval(pairSweepTimer)
    for (const [id, entry] of [...pending.entries()]) {
      entry.rejectWith(new BridgeError('NO_CHANNEL', '插件正在卸载/重载，扩展桥接命令已中断。', entry.clientId))
      pending.delete(id)
    }
    pending.clear()
    for (const [clientId, session] of [...sessions.entries()]) {
      try {
        session.ws.close(4000, 'host-disposing')
      } catch {
        // 忽略。
      }
      sessions.delete(clientId)
      audit.debug('extension-offline', { clientId, reason: 'dispose', sessions: 0 })
    }
    listening = false
    if (server !== undefined) {
      const closing = new Promise((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections?.()
      })
      await closing
      server = undefined
      wss = undefined
    }
  }

  /** 审计里只保留参数的精简形状（与 bridge.js 同一套规则）。 */
  function summarizeArgs(args) {
    if (!isRecord(args)) return args ?? null
    /** @type {Record<string, unknown>} */
    const summary = {}
    for (const [key, value] of Object.entries(args)) {
      if (typeof value === 'string') summary[key] = value.length > 200 ? `${value.slice(0, 200)}…` : value
      else if (typeof value === 'number' || typeof value === 'boolean' || value === null) summary[key] = value
      else summary[key] = '[object]'
    }
    return summary
  }

  return {
    /** 协议版本。 */
    protocolVersion: EXTENSION_BRIDGE_PROTOCOL_VERSION,
    start,
    beginPairing,
    status,
    connected,
    sendCommand,
    knownUrl,
    dispose,
    /** 测试观察用：当前在线会话数。 */
    sessionCount: () => sessions.size,
  }
}
