/**
 * 命令总线：客户端注册表 + 长轮询投递 + 命令/结果配对。
 *
 * 数据流（与 PROTOCOL §1/§2 一一对应）：
 *
 *   Client ──hello(10s 心跳)──▶ 注册表（clientId → sessionId）
 *   Client ──poll(挂起)───────▶ 命令队列；Host 有命令就当作 poll 的响应写回
 *   Host 工具 ─sendCommand()─▶ 命令入队 → 等 result；超时 reject TIMEOUT
 *   Client ──result──────────▶ 唤醒对应的 pending Promise
 *   Client ──log─────────────▶ debug.jsonl
 *   Client ──bye─────────────▶ 注销并让在途命令立即失败
 *
 * 一个会话（tab）可能同时开着多个桌面窗口，因此按 `sessionId` 找「最近心跳」
 * 的那个客户端投递；命令只投给 sessionId 匹配的 poll。
 *
 * @module dsh-plugin-browser-hands/bridge
 */

import { MAX_SNAPSHOT_BYTES } from './config.js'

/** 客户端多久没有 hello/poll 就判定掉线（毫秒）。Client 每 10s 发一次 hello。 */
const CLIENT_TTL_MS = 60_000

/** 扫描掉线客户端的间隔。 */
const SWEEP_INTERVAL_MS = 15_000

/** 单个客户端最多积压多少条命令。 */
const MAX_QUEUE = 128

/** 同时在途的命令上限。 */
const MAX_PENDING = 256

/** 命令 id 的自增起点。 */
let commandSequence = 0

/**
 * 总线错误：携带协议错误码，工具层原样转成 `{ok:false,error}`。
 */
export class BridgeError extends Error {
  /**
   * @param {string} code - 协议错误码（NO_CLIENT/TIMEOUT/…）。
   * @param {string} message - 中文说明，模型能照着处理。
   * @param {string} [clientId] - 相关的客户端，放进审计。
   */
  constructor(code, message, clientId) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
    this.clientId = clientId
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
 * 截短会话 id，用于报错文案与日志。
 * @param {unknown} sessionId - 会话 id。
 * @returns {string} 短形式。
 */
function shortId(sessionId) {
  const text = typeof sessionId === 'string' ? sessionId : ''
  return text.length > 12 ? `${text.slice(0, 12)}…` : text
}

/**
 * 建命令总线。
 * @param {object} options - 依赖。
 * @param {import('./config.js').ResolvedConfig} options.config - 已解析配置。
 * @param {ReturnType<import('./audit.js').createAudit>} options.audit - 审计器。
 * @returns {object} 总线 API。
 */
export function createBridge({ config, audit }) {
  /** @type {Map<string, {
   *   clientId: string, sessionId: string|undefined, desktop: boolean, lastSeen: number,
   *   queue: Array<{ id: string, op: string, args: unknown, sessionId: string|undefined }>,
   *   waiter: { res: import('node:http').ServerResponse, timer: ReturnType<typeof setTimeout>, sessionId: string|undefined }|undefined,
   * }>} */
  const clients = new Map()

  /** @type {Map<string, {
   *   id: string, op: string, clientId: string, sessionId: string|undefined,
   *   resolveValue: (value: unknown) => void, rejectWith: (error: Error) => void,
   * }>} */
  const pending = new Map()

  /** 各会话最近一次已知 URL，用于审计里的 `urlBefore`。 @type {Map<string, string>} */
  const lastUrl = new Map()

  let available = false

  /**
   * 写一条 200 JSON 响应。
   * @param {import('node:http').ServerResponse} res - 响应对象。
   * @param {unknown} body - JSON 内容。
   * @returns {void}
   */
  function respondJson(res, body) {
    if (res.writableEnded || res.destroyed) return
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    res.end(JSON.stringify(body))
  }

  /**
   * 回 204（长轮询无命令）。
   * @param {import('node:http').ServerResponse} res - 响应对象。
   * @returns {void}
   */
  function respondNoContent(res) {
    if (res.writableEnded || res.destroyed) return
    res.writeHead(204, { 'cache-control': 'no-store' })
    res.end()
  }

  /**
   * 注册或刷新一个客户端。
   * @param {string} clientId - 客户端 id。
   * @param {string|undefined} sessionId - 屏幕上的会话。
   * @param {boolean} desktop - 是否桌面版。
   * @returns {object} 客户端记录。
   */
  function touchClient(clientId, sessionId, desktop = false) {
    const now = Date.now()
    let client = clients.get(clientId)
    if (client === undefined) {
      client = { clientId, sessionId, desktop, lastSeen: now, queue: [], waiter: undefined }
      clients.set(clientId, client)
      audit.debug('client-online', { clientId, sessionId, desktop, total: clients.size })
      return client
    }
    client.lastSeen = now
    client.desktop = desktop || client.desktop
    if (sessionId !== undefined) client.sessionId = sessionId
    return client
  }

  /**
   * 挑出该会话最近心跳的客户端。
   * @param {string|undefined} sessionId - 目标会话。
   * @returns {object|undefined} 客户端记录。
   */
  function pickClient(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return undefined
    let best
    for (const client of clients.values()) {
      if (client.sessionId !== sessionId) continue
      if (best === undefined || client.lastSeen > best.lastSeen) best = client
    }
    return best
  }

  /**
   * 释放一个挂起的 poll（回 204）。
   * @param {object} client - 客户端记录。
   * @returns {void} 无返回。
   */
  function releaseWaiter(client) {
    const waiter = client.waiter
    if (waiter === undefined) return
    client.waiter = undefined
    clearTimeout(waiter.timer)
    respondNoContent(waiter.res)
  }

  /**
   * 若客户端正在挂起且会话匹配，就把命令直接写进它的 poll 响应。
   * @param {object} client - 客户端记录。
   * @param {{ id: string, op: string, args: unknown, sessionId: string|undefined }} command - 命令。
   * @returns {boolean} 是否已投递。
   */
  function deliver(client, command) {
    const waiter = client.waiter
    if (waiter === undefined) return false
    if (waiter.sessionId !== command.sessionId) return false
    client.waiter = undefined
    clearTimeout(waiter.timer)
    respondJson(waiter.res, { command: { id: command.id, op: command.op, args: command.args } })
    return true
  }

  /**
   * 取出队列里第一条属于该会话、且仍在等待结果的命令。
   * @param {object} client - 客户端记录。
   * @param {string|undefined} sessionId - poll 声明的会话。
   * @returns {{ id: string, op: string, args: unknown, sessionId: string|undefined }|undefined} 命令。
   */
  function takeQueued(client, sessionId) {
    for (let index = 0; index < client.queue.length; index += 1) {
      const command = client.queue[index]
      if (pending.has(command.id) === false) {
        client.queue.splice(index, 1)
        index -= 1
        continue
      }
      if (command.sessionId !== sessionId) continue
      client.queue.splice(index, 1)
      return command
    }
    return undefined
  }

  /**
   * 从队列里丢弃一条命令（已超时/已失败）。
   * @param {object} client - 客户端记录。
   * @param {string} id - 命令 id。
   * @returns {void}
   */
  function dropQueued(client, id) {
    const index = client.queue.findIndex((command) => command.id === id)
    if (index >= 0) client.queue.splice(index, 1)
  }

  /**
   * 让某个客户端的所有在途命令立即失败。
   * @param {string} clientId - 客户端 id。
   * @param {string} message - 失败原因。
   * @returns {void}
   */
  function failPendingOf(clientId, message) {
    for (const [id, entry] of pending) {
      if (entry.clientId !== clientId) continue
      audit.debug('command-aborted', { id, op: entry.op, clientId, reason: message })
      entry.rejectWith(new BridgeError('NO_CLIENT', message, clientId))
    }
  }

  /**
   * 移除客户端并回收它持有的一切。
   * @param {string} clientId - 客户端 id。
   * @param {string} reason - 移除原因（写日志）。
   * @returns {boolean} 是否真的移除了。
   */
  function removeClient(clientId, reason) {
    const client = clients.get(clientId)
    if (client === undefined) return false
    releaseWaiter(client)
    client.queue.length = 0
    clients.delete(clientId)
    failPendingOf(clientId, '客户端已断开连接，命令已取消；请确认 PC 上的浏览器面板仍然打开。')
    audit.debug('client-offline', { clientId, reason, total: clients.size })
    return true
  }

  /** 掉线扫描。 */
  const sweepTimer = setInterval(() => {
    const now = Date.now()
    for (const [clientId, client] of [...clients.entries()]) {
      if (now - client.lastSeen <= CLIENT_TTL_MS) continue
      removeClient(clientId, 'heartbeat-timeout')
    }
  }, SWEEP_INTERVAL_MS)
  sweepTimer.unref?.()

  /**
   * 记住最近一次已知 URL（审计 `urlBefore` 用）。
   * @param {string|undefined} sessionId - 会话 id。
   * @param {unknown} value - 命令返回值。
   * @returns {void}
   */
  function rememberUrl(sessionId, value) {
    if (typeof sessionId !== 'string' || sessionId === '' || !isRecord(value)) return
    const direct = typeof value.url === 'string' ? value.url : undefined
    const nested = isRecord(value.snapshot) && typeof value.snapshot.url === 'string' ? value.snapshot.url : undefined
    const url = direct ?? nested
    if (url !== undefined && url !== '') lastUrl.set(sessionId, url)
  }

  /**
   * 把 Client 回的错误体转成 BridgeError。
   * @param {unknown} raw - `result.error`。
   * @param {string} clientId - 回结果的客户端。
   * @returns {BridgeError} 错误。
   */
  function clientError(raw, clientId) {
    const code = isRecord(raw) && typeof raw.code === 'string' && raw.code !== '' ? raw.code : 'INTERNAL'
    const message = isRecord(raw) && typeof raw.message === 'string' && raw.message !== ''
      ? raw.message
      : '客户端返回了未标注原因的错误'
    return new BridgeError(code, message, clientId)
  }

  return {
    /**
     * 路由是否已挂载（工具据此决定直接报错还是下发命令）。
     * @param {boolean} flag - 是否可用。
     * @returns {void}
     */
    setAvailable(flag) {
      available = flag === true
    },

    /**
     * 客户端注册/心跳（PROTOCOL §1.1）。
     * @param {unknown} body - 请求体。
     * @returns {object} 响应体。
     */
    hello(body) {
      if (!isRecord(body)) throw new BridgeError('BAD_REQUEST', 'hello 的 body 必须是 JSON 对象')
      const clientId = typeof body.clientId === 'string' ? body.clientId.trim() : ''
      if (clientId === '') throw new BridgeError('BAD_REQUEST', 'hello 缺少 clientId')
      if (clientId.length > 200) throw new BridgeError('BAD_REQUEST', 'hello 的 clientId 过长')
      const sessionId = typeof body.sessionId === 'string' && body.sessionId !== '' ? body.sessionId : undefined
      touchClient(clientId, sessionId, body.desktop === true)
      audit.debug('hello', { clientId, sessionId, desktop: body.desktop === true })
      return {
        ok: true,
        version: 1,
        config: { enableEval: config.enableEval, maxSnapshotBytes: MAX_SNAPSHOT_BYTES },
      }
    },

    /**
     * 长轮询取命令（PROTOCOL §1.2）。该函数接管 `res` 的生命周期。
     * @param {object} options - 请求上下文。
     * @param {string} options.clientId - 客户端 id。
     * @param {string|undefined} options.sessionId - 屏幕上的会话。
     * @param {number|undefined} options.wait - 请求的挂起毫秒数。
     * @param {import('node:http').IncomingMessage} options.req - 请求。
     * @param {import('node:http').ServerResponse} options.res - 响应。
     * @returns {void}
     */
    poll({ clientId, sessionId, wait, req, res }) {
      const client = touchClient(clientId, sessionId, false)
      // 同一客户端只保留一个挂起的 poll：新来的顶掉旧的，旧的回 204 释放。
      if (client.waiter !== undefined) releaseWaiter(client)

      const immediate = takeQueued(client, sessionId)
      if (immediate !== undefined) {
        audit.debug('poll-deliver', { clientId, sessionId, id: immediate.id, op: immediate.op })
        respondJson(res, { command: { id: immediate.id, op: immediate.op, args: immediate.args } })
        return
      }

      const requested = typeof wait === 'number' && Number.isFinite(wait) && wait > 0 ? wait : config.pollWaitMs
      const ms = Math.min(Math.max(0, Math.floor(requested)), config.pollWaitMs)
      audit.debug('poll-wait', { clientId, sessionId, ms })
      /** @type {{ res: import('node:http').ServerResponse, timer: ReturnType<typeof setTimeout>, sessionId: string|undefined }} */
      const waiter = {
        res,
        sessionId,
        timer: setTimeout(() => {
          if (client.waiter !== waiter) return
          client.waiter = undefined
          audit.debug('poll-timeout', { clientId, sessionId })
          respondNoContent(res)
        }, ms),
      }
      waiter.timer.unref?.()
      client.waiter = waiter
      // 客户端断开时清理挂起项。这里监听 `res` 而不是 `req`：Node 的
      // `IncomingMessage` 在请求体收完时就会发 `close`（GET 无体，几乎立即），
      // 只有响应侧的 `close` 才可靠地区分「已回包」与「连接被掐断」。
      res.on('close', () => {
        if (client.waiter !== waiter) return
        client.waiter = undefined
        clearTimeout(waiter.timer)
        audit.debug('poll-closed', { clientId, sessionId })
      })
    },

    /**
     * 命令结果（PROTOCOL §1.3）。
     * @param {unknown} body - 请求体。
     * @returns {object} 响应体。
     */
    result(body) {
      if (!isRecord(body)) throw new BridgeError('BAD_REQUEST', 'result 的 body 必须是 JSON 对象')
      const id = typeof body.id === 'string' ? body.id : ''
      const entry = pending.get(id)
      if (entry === undefined) {
        audit.debug('result-orphan', { id, ok: body.ok === true })
        return { ok: true }
      }
      if (body.ok === true) {
        const value = body.value === undefined ? {} : body.value
        audit.debug('result', { id, op: entry.op, clientId: entry.clientId, ok: true })
        entry.resolveValue(value)
      } else {
        const error = clientError(body.error, entry.clientId)
        audit.debug('result', {
          id,
          op: entry.op,
          clientId: entry.clientId,
          ok: false,
          code: error.code,
          message: error.message,
        })
        entry.rejectWith(error)
      }
      return { ok: true }
    },

    /**
     * 客户端日志（PROTOCOL §1.4）→ debug.jsonl。
     * @param {unknown} body - 请求体。
     * @returns {object} 响应体。
     */
    log(body) {
      if (!isRecord(body)) throw new BridgeError('BAD_REQUEST', 'log 的 body 必须是 JSON 对象')
      const level = typeof body.level === 'string' ? body.level : 'info'
      const message = typeof body.message === 'string' ? body.message.slice(0, 4000) : ''
      const data = body.data === undefined ? undefined : body.data
      if (message === '') throw new BridgeError('BAD_REQUEST', 'log 缺少 message')
      audit.debug('client-log', { level, message, data })
      return { ok: true }
    },

    /**
     * 客户端注销（PROTOCOL §1.5）。
     * @param {unknown} body - 请求体。
     * @returns {object} 响应体。
     */
    bye(body) {
      if (!isRecord(body)) throw new BridgeError('BAD_REQUEST', 'bye 的 body 必须是 JSON 对象')
      const clientId = typeof body.clientId === 'string' ? body.clientId.trim() : ''
      if (clientId === '') throw new BridgeError('BAD_REQUEST', 'bye 缺少 clientId')
      removeClient(clientId, 'bye')
      return { ok: true }
    },

    /**
     * 下发一条命令并等待结果。
     * @param {string|undefined} sessionId - 目标会话。
     * @param {string} op - 协议 §2.2 的操作名。
     * @param {Record<string, unknown>} args - 操作参数。
     * @param {number} timeoutMs - 等待上限。
     * @returns {Promise<{ value: unknown, clientId: string }>} 结果值。
     */
    sendCommand(sessionId, op, args, timeoutMs) {
      if (available !== true) {
        throw new BridgeError(
          'NO_CHANNEL',
          'Host 侧的 /browser-hands 路由不可用（webServer 服务未挂载），无法向浏览器面板下发命令。',
        )
      }
      if (pending.size >= MAX_PENDING) {
        throw new BridgeError('BUSY', '浏览器命令队列已满，请稍后重试。')
      }
      const client = pickClient(sessionId)
      if (client === undefined) {
        throw new BridgeError(
          'NO_CLIENT',
          `没有连接到会话 ${shortId(sessionId)} 的桌面客户端；请先在 PC 上打开该会话，`
          + '并让右侧边栏的「浏览器眼睛与手」面板保持打开。',
        )
      }
      if (client.queue.length >= MAX_QUEUE) {
        throw new BridgeError('BUSY', '该客户端的命令积压过多（面板可能已卡住），请稍后重试。', client.clientId)
      }

      commandSequence += 1
      const id = `cmd-${commandSequence}`
      /** @type {{ id: string, op: string, args: unknown, sessionId: string|undefined }} */
      const command = { id, op, args, sessionId }
      audit.debug('command', { id, op, clientId: client.clientId, sessionId, args: summarizeArgs(args) })

      return new Promise((resolve, reject) => {
        let settled = false
        const timer = setTimeout(() => {
          if (settled) return
          settled = true
          pending.delete(id)
          dropQueued(client, id)
          audit.debug('command-timeout', { id, op, clientId: client.clientId, sessionId, timeoutMs })
          reject(new BridgeError(
            'TIMEOUT',
            `命令 ${op} 在 ${timeoutMs}ms 内没有返回（${id} 超时）；`
            + '页面可能加载过慢，或浏览器面板已关闭。',
            client.clientId,
          ))
        }, timeoutMs)
        timer.unref?.()

        pending.set(id, {
          id,
          op,
          clientId: client.clientId,
          sessionId,
          resolveValue(value) {
            if (settled) return
            settled = true
            clearTimeout(timer)
            pending.delete(id)
            rememberUrl(sessionId, value)
            resolve({ value, clientId: client.clientId })
          },
          rejectWith(error) {
            if (settled) return
            settled = true
            clearTimeout(timer)
            pending.delete(id)
            reject(error)
          },
        })

        if (deliver(client, command) === false) client.queue.push(command)
      })
    },

    /**
     * 该会话最近一次已知 URL（审计 `urlBefore`）。
     * @param {string|undefined} sessionId - 会话 id。
     * @returns {string|undefined} URL。
     */
    knownUrl(sessionId) {
      return typeof sessionId === 'string' ? lastUrl.get(sessionId) : undefined
    },

    /**
     * 当前总线规模（诊断用）。
     * @returns {{ clients: number, pending: number }} 计数。
     */
    stats() {
      return { clients: clients.size, pending: pending.size }
    },

    /** 卸载：清定时器、释放挂起的 poll、让在途命令失败。 */
    dispose() {
      clearInterval(sweepTimer)
      for (const client of clients.values()) releaseWaiter(client)
      for (const entry of [...pending.values()]) {
        entry.rejectWith(new BridgeError('NO_CHANNEL', '插件正在卸载/重载，命令已中断。', entry.clientId))
      }
      pending.clear()
      clients.clear()
      available = false
    },
  }
}

/**
 * 审计里只保留参数的精简形状。
 * @param {unknown} args - 命令参数。
 * @returns {unknown} 精简后的参数。
 */
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
