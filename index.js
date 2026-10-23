/**
 * dsh-plugin-browser-hands —— Host 半边入口。
 *
 * 数据流（Host ⇄ Client 的长轮询总线，契约见 PROTOCOL.md）：
 *
 *   模型 ──browser_* 工具──▶ lib/tools.js：参数校验 + URL 预校验（lib/guard.js）
 *        └─ bridge.sendCommand ─▶ 命令入队（按 sessionId 找最近心跳的客户端）
 *   Client（右侧边栏 tab，client.js）──GET /browser-hands/poll──▶ 取到命令并执行
 *        └─ POST /browser-hands/result ─▶ 唤醒等待中的 Promise
 *   工具 ─▶ lib/render.js 排版（按 maxResultBytes 截断）─▶ 模型看到文本
 *
 *   每次工具调用写 `<auditDir>/audit.jsonl`；路由命中、客户端上下线、命令下发/
 *   超时、Client 日志写 `debug.jsonl`（`debug:false` 关闭）。截图由 `POST /shot`
 *   带原始 PNG 上传，落盘到 `<auditDir>/shots/`。
 *
 * 依赖约定：**不 import 任何 `@deepseek-ai/*` 包**。`tools` 是硬依赖（`inject`），
 * `webServer` 与 `connection` 都按可选处理——`webServer` 没挂载时只是不注册路由、
 * 工具回可读错误，插件本身照常加载。
 *
 * @module dsh-plugin-browser-hands
 */

import { resolveConfig } from './lib/config.js'
import { createAudit } from './lib/audit.js'
import { createBridge } from './lib/bridge.js'
import { createNavigator } from './lib/guard.js'
import { registerRoutes, ROUTE_PREFIX } from './lib/routes.js'
import { registerBrowserTools, BROWSER_TOOL_NAMES } from './lib/tools.js'
import { discover, resolveEndpoint } from './lib/cdp.js'

/** 插件名（与 package.json / cordis.patch.yml 的行 id 对齐）。 */
export const name = 'dsh-plugin-browser-hands'

/** 工具注册表是硬依赖：没有它这个插件没有意义。 */
export const inject = ['tools']

/**
 * 取一个可用的 logger：Cordis 的 `ctx.logger` 既可能是「可调用的命名工厂」，
 * 也可能是带 `info/warn/error` 方法的对象，两种都兜住；都没有就退回 console。
 * @param {object} ctx - Cordis 上下文。
 * @returns {{ debug: Function, info: Function, warn: Function, error: Function }} 日志出口。
 */
function pickLogger(ctx) {
  const raw = ctx?.logger
  let target = raw
  if (typeof raw === 'function') {
    try {
      const named = raw.call(ctx, name)
      if (named !== undefined && named !== null) target = named
    } catch {
      target = raw
    }
  }
  /**
   * 写一条日志。
   * @param {string} level - 级别。
   * @param {string} message - 正文。
   * @returns {void}
   */
  const write = (level, message) => {
    const method = target?.[level]
    if (typeof method === 'function') {
      try {
        method.call(target, message)
        return
      } catch {
        // 落到 console。
      }
    }
    if (level === 'error' || level === 'warn') console.warn(message)
    else console.log(message)
  }
  return {
    debug: (message) => write('debug', message),
    info: (message) => write('info', message),
    warn: (message) => write('warn', message),
    error: (message) => write('error', message),
  }
}

/**
 * 插件入口。
 * @param {object} ctx - Cordis 上下文（已保证 `tools` 可用）。
 * @param {unknown} rawConfig - `cordis.patch.yml` 里该行的 `config`。
 * @returns {void}
 */
export function apply(ctx, rawConfig) {
  // 配置非法就直接抛：带着明确的键名失败，比加载出半个插件好排查。
  const config = resolveConfig(rawConfig)
  const logger = pickLogger(ctx)

  /**
   * 写一条日志（审计器只需要 warn）。
   * @param {'debug'|'info'|'warn'|'error'} level - 级别。
   * @param {string} message - 正文。
   * @returns {void}
   */
  const log = (level, message) => {
    const write = logger[level] ?? logger.info
    write(message)
  }

  const audit = createAudit({ config, log })
  const bridge = createBridge({ config, audit })
  const navigator = createNavigator({
    config,
    getOrigin: () => {
      const webServer = ctx.get('webServer')
      if (webServer === undefined || typeof webServer.getOrigin !== 'function') {
        throw new Error('webServer 服务不可用')
      }
      return webServer.getOrigin()
    },
  })

  // 总线自带掉线扫描定时器，卸载时必须清掉，否则会拖住 Host 进程。
  ctx.effect(() => () => bridge.dispose(), 'browser-hands: 命令总线')

  // webServer 是可选依赖：没有它就只是不注册路由，工具会回 NO_CHANNEL 可读错误。
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      let disposeRoute
      try {
        disposeRoute = registerRoutes(webCtx, { bridge, audit })
      } catch (error) {
        // 路由注册失败同样不拖垮插件：留下栈，工具侧会如实回 NO_CHANNEL。
        const message = String(error?.message ?? error)
        audit.debug('route-failed', {
          prefix: ROUTE_PREFIX,
          message,
          stack: typeof error?.stack === 'string' ? error.stack.slice(0, 4000) : undefined,
        })
        log('error', `browser-hands: ${ROUTE_PREFIX} 路由注册失败：${message}`)
        return () => {}
      }
      bridge.setAvailable(true)
      let origin
      try {
        origin = webCtx.get('webServer')?.getOrigin?.()
      } catch {
        origin = undefined
      }
      audit.debug('route-mounted', { prefix: ROUTE_PREFIX, origin })
      log('info', `browser-hands: 路由已挂载 ${ROUTE_PREFIX}（${origin ?? 'origin 未知'}）`)
      return () => {
        bridge.setAvailable(false)
        disposeRoute()
        audit.debug('route-unmounted', { prefix: ROUTE_PREFIX })
      }
    }, 'browser-hands: /browser-hands 路由')
  })

  // 工具注册失败不该拖垮整个插件：路由和 Client 通道要活着（否则面板会陷入
  // poll 404 循环，现场什么也看不到）。把栈写进 debug.jsonl 再继续。
  ctx.effect(() => {
    try {
      return registerBrowserTools(ctx, { config, bridge, navigator, audit })
    } catch (error) {
      const message = String(error?.message ?? error)
      audit.debug('tools-failed', {
        message,
        stack: typeof error?.stack === 'string' ? error.stack.slice(0, 4000) : undefined,
      })
      log('error', `browser-hands: browser_* 工具注册失败：${message}`)
      return () => {}
    }
  }, 'browser-hands: browser_* 工具')

  ctx.effect(() => () => {
    audit.debug('disposed', { stats: bridge.stats() })
  }, 'browser-hands: 收尾日志')

  // 深度模式（CDP）：启动时探一次端口，结果只进 debug.jsonl/日志；不阻塞加载。
  // 端口默认关闭（用户用 tools/start-dsh-debug.cmd 以 --remote-debugging-port=0 重启），
  // 真实端口由 Chromium 写进 DevToolsActivePort，插件运行时按需重读。
  if (config.deepMode.enabled) {
    void (async () => {
      try {
        const endpoint = await resolveEndpoint({
          endpoint: config.deepMode.endpoint,
          portFile: config.deepMode.portFile,
        })
        const discovery = await discover(endpoint, { timeoutMs: 2_000 })
        audit.debug('deep-mode', {
          enabled: true,
          reachable: true,
          endpoint,
          targets: discovery.targets.length,
        })
        log('info', `browser-hands: 深度模式端口可达 ${endpoint}（${discovery.targets.length} 个 target）`)
      } catch (error) {
        audit.debug('deep-mode', {
          enabled: true,
          reachable: false,
          code: typeof error?.code === 'string' ? error.code : 'INTERNAL',
          error: String(error?.message ?? error),
        })
        log('warn', `browser-hands: 深度模式端口不可达 —— ${String(error?.message ?? error)}`)
      }
    })()
  } else {
    audit.debug('deep-mode', {
      enabled: false,
      endpoint: config.deepMode.endpoint,
      portFile: config.deepMode.portFile,
    })
  }

  log(
    'info',
    `browser-hands: ${BROWSER_TOOL_NAMES.length} 个工具就绪；审计目录 ${config.auditDir}`
    + `；enableEval=${config.enableEval}；deepMode=${config.deepMode.enabled}`,
  )
}
