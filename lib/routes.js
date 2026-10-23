/**
 * `/agent-browser-auto` 前缀路由（PROTOCOL §1）：hello / poll / result / log / bye / shot。
 *
 * 处理链：定位端点 → 鉴权（安全解析 `connection` 后调 `requestRejection`，缺失即
 * fail-closed 503）→ 读 body（有上限）→ 交给命令总线 → 写回 JSON。
 * `poll` 是唯一接管响应生命周期的端点（长轮询，无命令时 204）。
 *
 * 注意：`ctx.webServer.register` 的 handler 收到的是 Node 原生
 * `IncomingMessage` / `ServerResponse`（同类插件 dsh-wsl-workspace 的写法证实，
 * `Inspect` 里 `ServerResponse` 名字与 connection RPC 的同名类型撞了，那是投影
 * 假象），所以这里用 `req.headers` / `req.url` / `res.writeHead` / `res.end`。
 *
 * @module dsh-agent-browser-auto/routes
 */

import { BridgeError } from './bridge.js'

/** 前缀路由路径。 */
export const ROUTE_PREFIX = '/agent-browser-auto'

/** 普通 JSON body 的上限：1 MiB（快照/结果都可能不小）。 */
const JSON_BODY_LIMIT = 1024 * 1024

/** 截图 body 的上限：16 MiB 原始 PNG。 */
const SHOT_BODY_LIMIT = 16 * 1024 * 1024

/** 端点 → 允许的方法。 */
const ENDPOINT_METHODS = Object.freeze({
  '/hello': 'POST',
  '/poll': 'GET',
  '/result': 'POST',
  '/log': 'POST',
  '/bye': 'POST',
  '/shot': 'POST',
})

/** 每个 JSON 响应都带上：不缓存、不嗅探类型。 */
const NO_STORE = Object.freeze({
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
})

/**
 * 是否是普通对象。
 * @param {unknown} value - 任意值。
 * @returns {boolean} 结论。
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 写一个 JSON 响应。
 * @param {import('node:http').ServerResponse} res - 响应。
 * @param {number} status - 状态码。
 * @param {unknown} body - JSON 内容。
 * @param {Record<string, string>} [extraHeaders] - 额外响应头。
 * @returns {void}
 */
function json(res, status, body, extraHeaders) {
  if (res.writableEnded || res.destroyed) return
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...NO_STORE, ...extraHeaders })
  res.end(JSON.stringify(body))
}

/**
 * 统一的失败响应体。
 * @param {string} code - 错误码。
 * @param {string} message - 中文说明。
 * @returns {{ ok: false, error: { code: string, message: string } }} 响应体。
 */
function failure(code, message) {
  return { ok: false, error: { code, message } }
}

/**
 * 解析请求路径。
 * @param {string|undefined} rawUrl - `req.url`。
 * @returns {{ url: URL, endpoint: string }|undefined} 命中前缀时的端点信息。
 */
function parseRoute(rawUrl) {
  let url
  try {
    url = new URL(rawUrl ?? '/', 'http://agent-browser-auto.invalid')
  } catch {
    return undefined
  }
  if (url.pathname !== ROUTE_PREFIX && !url.pathname.startsWith(`${ROUTE_PREFIX}/`)) return undefined
  const rest = url.pathname.slice(ROUTE_PREFIX.length).replace(/\/+$/, '')
  return { url, endpoint: rest === '' ? '/' : rest }
}

/**
 * 读取原始 body，超限立即失败。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @param {number} limit - 字节上限。
 * @returns {Promise<Buffer>} 完整 body。
 */
function readBytes(req, limit) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = []
    let size = 0
    let settled = false
    /**
     * 结束读取。
     * @param {Error} error - 失败原因。
     * @returns {void}
     */
    function abort(error) {
      if (settled) return
      settled = true
      req.removeAllListeners('data')
      req.removeAllListeners('end')
      req.removeAllListeners('error')
      req.removeAllListeners('aborted')
      req.pause()
      reject(error)
    }
    req.on('data', (chunk) => {
      if (settled) return
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > limit) {
        abort(new BridgeError('BODY_TOO_LARGE', `请求体超过 ${limit} 字节上限`))
        return
      }
      chunks.push(buffer)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks))
    })
    req.on('error', (error) => abort(new BridgeError('BAD_REQUEST', `读取请求体失败：${String(error?.message ?? error)}`)))
    req.on('aborted', () => abort(new BridgeError('BAD_REQUEST', '请求被客户端中断')))
  })
}

/**
 * 读并解析 JSON body。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @returns {Promise<Record<string, unknown>>} 解析后的对象。
 */
async function readJsonBody(req) {
  const buffer = await readBytes(req, JSON_BODY_LIMIT)
  const text = buffer.toString('utf8')
  if (text.trim() === '') return {}
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new BridgeError('BAD_JSON', `body 不是合法 JSON：${String(error?.message ?? error).slice(0, 200)}`)
  }
  if (!isRecord(parsed)) throw new BridgeError('BAD_JSON', 'body 必须是 JSON 对象')
  return parsed
}

/**
 * 安全解析 `connection` 服务。
 *
 * 传入的 ctx 是 `ctx.inject(['webServer'], …)` 的**子作用域**：它只声明了
 * `webServer`，而 Cordis 的上下文代理对「本作用域没声明、又不是普通属性」的
 * 名字会直接抛 `cannot get property "connection" without inject`；不同版本里
 * 沿 `parent` / `scope` / `root` 向上找的方式也不一样，所以这里对每一步都
 * try/catch：任何一次解析失败都只当「这一层没有」，绝不把异常放给请求线程
 * （webServer 会把 handler 的 rejection 变成裸 400，现场只剩一个空 body）。
 *
 * @param {unknown} ctx - 注册路由时拿到的上下文。
 * @returns {object|undefined} `connection` 服务（不可用时 undefined）。
 */
export function resolveConnection(ctx) {
  /** @type {unknown[]} */
  const chain = []
  const seen = new Set()
  let current = ctx
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current)
    chain.push(current)
    let next
    try {
      next = current.parent ?? current.scope
    } catch {
      next = undefined
    }
    if (next === undefined || next === null) {
      let root
      try {
        root = current.root
      } catch {
        root = undefined
      }
      next = root === current ? undefined : root
    }
    current = next
  }
  for (const scope of chain) {
    try {
      const get = /** @type {{ get?: (name: string) => unknown }} */ (scope)?.get
      if (typeof get !== 'function') continue
      const connection = get.call(scope, 'connection')
      if (connection !== undefined && connection !== null) return connection
    } catch {
      // 这一层不认 connection，继续往上找。
    }
  }
  return undefined
}

/**
 * 挂上 `/agent-browser-auto` 前缀路由。
 * @param {object} ctx - 携带 `webServer` 的 Cordis 上下文。
 * @param {object} deps - 依赖。
 * @param {ReturnType<import('./bridge.js').createBridge>} deps.bridge - 命令总线。
 * @param {ReturnType<import('./audit.js').createAudit>} deps.audit - 审计器。
 * @returns {() => void} 注销器。
 */
export function registerRoutes(ctx, { bridge, audit }) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined || typeof webServer.register !== 'function') {
    throw new Error('agent-browser-auto: webServer 服务不可用，无法注册 /agent-browser-auto 路由')
  }
  // 每次请求现取：connection 可能在插件挂载之后才就绪（也可能被热重载换掉）。
  const connectionOf = () => {
    try {
      return resolveConnection(ctx)
    } catch {
      return undefined
    }
  }
  return webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: (req, res) => {
      // 顶层兜底：webServer 是把 handler 的 rejection 变成裸 400 的，
      // 这里抢先把异常变成 500 JSON，并把栈写进 debug.jsonl。
      Promise.resolve(handle(req, res, { bridge, audit, connectionOf })).catch((error) => {
        const message = String(error?.message ?? error)
        audit.debug('route-crash', {
          url: req.url,
          method: req.method,
          message,
          stack: typeof error?.stack === 'string' ? error.stack.slice(0, 4000) : undefined,
        })
        try {
          json(res, 500, failure('INTERNAL', `路由处理异常：${message}`))
        } catch {
          // 响应已结束/连接已断开，不再二次处理。
        }
      })
    },
  })
}

/**
 * 一个请求的完整处理（外层再包一层 `handle` 兜住意外异常）。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @param {import('node:http').ServerResponse} res - 响应。
 * @param {object} deps - 依赖。
 * @param {ReturnType<import('./bridge.js').createBridge>} deps.bridge - 命令总线。
 * @param {ReturnType<import('./audit.js').createAudit>} deps.audit - 审计器。
 * @param {() => object|undefined} deps.connectionOf - 安全解析的 connection 取值器。
 * @returns {Promise<void>} 处理完成。
 */
async function dispatch(req, res, { bridge, audit, connectionOf }) {
  const startedAt = Date.now()
  const route = parseRoute(req.url)
  if (route === undefined) {
    json(res, 404, failure('NOT_FOUND', '未知端点'))
    return
  }
  const { endpoint, url } = route
  const method = (req.method ?? 'GET').toUpperCase()

  // 鉴权先行：每个进入本前缀的请求都过一遍 connection 检查。
  // fail-closed —— 拿不到 connection 就当拒绝，绝不因为「服务没起来」而放行。
  // 这里刻意用 connectionOf()（逐层 try/catch 的安全解析）而不是直接
  // ctx.get('connection')：子作用域里读未声明服务会抛异常。
  const connection = connectionOf()
  if (connection === undefined || typeof connection.requestRejection !== 'function') {
    audit.debug('route-no-connection', { endpoint, method })
    json(res, 503, failure('NO_CONNECTION', 'connection 服务未挂载，拒绝请求（fail-closed）'))
    return
  }
  let rejection
  try {
    rejection = connection.requestRejection({ headers: req.headers })
  } catch (error) {
    audit.debug('route-auth-error', { endpoint, message: String(error?.message ?? error) })
    json(res, 503, failure('NO_CONNECTION', 'connection 鉴权不可用，拒绝请求（fail-closed）'))
    return
  }
  if (rejection !== undefined && rejection !== null) {
    // 真实 connection 只会回 401/403；这里再兜一层，避免非数字状态码让 writeHead 抛异常
    // 变成裸 500（历史上出现过「空 body 400/500」的坑）。
    const status = typeof rejection === 'number' && rejection >= 400 && rejection <= 599 ? rejection : 401
    audit.debug('route-rejected', { endpoint, method, status })
    json(res, status, failure('UNAUTHORIZED', '请求未通过桌面连接鉴权（Host/Origin 或浏览器凭据不符）'))
    return
  }

  const allowed = ENDPOINT_METHODS[endpoint]
  if (allowed === undefined) {
    audit.debug('route', { endpoint, method, status: 404 })
    json(res, 404, failure('NOT_FOUND', `未知端点 ${endpoint}`))
    return
  }

  if (method !== allowed) {
    audit.debug('route', { endpoint, method, status: 405 })
    json(res, 405, failure('METHOD_NOT_ALLOWED', `端点 ${endpoint} 只接受 ${allowed}`), { allow: allowed })
    return
  }

  try {
    if (endpoint === '/poll') {
      const clientId = url.searchParams.get('clientId') ?? ''
      const sessionIdRaw = url.searchParams.get('sessionId')
      const sessionId = sessionIdRaw === null || sessionIdRaw === '' ? undefined : sessionIdRaw
      if (clientId.trim() === '') {
        json(res, 400, failure('BAD_REQUEST', 'poll 缺少 clientId'))
        return
      }
      const waitRaw = url.searchParams.get('wait')
      const wait = waitRaw === null ? undefined : Number(waitRaw)
      audit.debug('route', { endpoint, method, clientId, sessionId, wait })
      bridge.poll({
        clientId: clientId.trim(),
        sessionId,
        wait: Number.isFinite(wait) ? wait : undefined,
        req,
        res,
      })
      return
    }

    if (endpoint === '/shot') {
      const bytes = await readBytes(req, SHOT_BODY_LIMIT)
      const pageId = url.searchParams.get('pageId') ?? undefined
      const target = url.searchParams.get('url') ?? undefined
      if (bytes.length === 0) {
        json(res, 400, failure('BAD_REQUEST', 'shot 的 body 是空的（应为 image/png 原始字节）'))
        return
      }
      const saved = await audit.saveShot(bytes, { pageId, url: target })
      audit.debug('shot', { pageId, url: target, bytes: saved.bytes, path: saved.path })
      json(res, 200, { ok: true, path: saved.path, bytes: saved.bytes })
      return
    }

    const body = await readJsonBody(req)
    let result
    if (endpoint === '/hello') {
      result = bridge.hello(body)
    } else if (endpoint === '/result') {
      result = bridge.result(body)
    } else if (endpoint === '/log') {
      result = bridge.log(body)
    } else {
      result = bridge.bye(body)
    }
    json(res, 200, result)
    audit.debug('route', { endpoint, method, status: 200, ms: Date.now() - startedAt })
  } catch (error) {
    const code = error instanceof BridgeError ? error.code : 'INTERNAL'
    const message = String(error?.message ?? error)
    if (code === 'BODY_TOO_LARGE') {
      audit.debug('route', { endpoint, method, status: 413, message })
      json(res, 413, failure(code, message), { connection: 'close' })
      return
    }
    const status = code === 'BAD_REQUEST' || code === 'BAD_JSON' ? 400 : 500
    audit.debug('route-error', {
      endpoint,
      method,
      status,
      code,
      message,
      // 非 BridgeError 说明是没预料到的异常，带上栈才能定位。
      stack: code === 'INTERNAL' && typeof error?.stack === 'string' ? error.stack.slice(0, 4000) : undefined,
    })
    json(res, status, failure(code, message))
  }
}

/**
 * 路由处理器：把 {@link dispatch} 包一层，保证任何意外异常都变成 500 JSON，
 * 而不是一个未处理的 Promise rejection（webServer 不会 await 这个返回值，
 * 它只会在自己的 catch 里写一个空 body 的 400）。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @param {import('node:http').ServerResponse} res - 响应。
 * @param {object} deps - 依赖。
 * @returns {Promise<void>} 处理完成。
 */
async function handle(req, res, deps) {
  try {
    await dispatch(req, res, deps)
  } catch (error) {
    deps.audit.debug('route-crash', {
      url: req.url,
      method: req.method,
      message: String(error?.message ?? error),
      stack: typeof error?.stack === 'string' ? error.stack.slice(0, 4000) : undefined,
    })
    try {
      json(res, 500, failure('INTERNAL', `路由处理异常：${String(error?.message ?? error)}`))
    } catch {
      // 响应已经结束或连接已断开，无需再处理。
    }
  }
}
