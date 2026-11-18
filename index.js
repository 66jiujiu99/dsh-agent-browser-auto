/**
 * dsh-agent-browser-auto —— Host 半边入口。
 *
 * 数据流（Host ⇄ Client 的长轮询总线，契约见 PROTOCOL.md）：
 *
 *   模型 ──browser_* 工具──▶ lib/tools.js：参数校验 + URL 预校验（lib/guard.js）
 *        └─ bridge.sendCommand ─▶ 命令入队（按 sessionId 找最近心跳的客户端）
 *   Client（右侧边栏 tab，client.js）──GET /agent-browser-auto/poll──▶ 取到命令并执行
 *        └─ POST /agent-browser-auto/result ─▶ 唤醒等待中的 Promise
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
 * @module dsh-agent-browser-auto
 */

import { resolveConfig } from './lib/config.js'
import { createAudit } from './lib/audit.js'
import { createBridge } from './lib/bridge.js'
import { createNavigator } from './lib/guard.js'
import { registerRoutes, ROUTE_PREFIX } from './lib/routes.js'
import { registerBrowserTools, BROWSER_TOOL_NAMES } from './lib/tools.js'
import { discover, resolveEndpoint } from './lib/cdp.js'
import { createRealDriver } from './lib/real-driver.js'
import { createBackendRouter } from './lib/backend.js'
import { createExtensionBridge } from './lib/extension-bridge.js'
import {
  loadDedicatedPrompt,
  loadExtensionPrompt,
  DEDICATED_SECTION_NAME,
  DEDICATED_SECTION_ORDER,
  EXTENSION_SECTION_NAME,
  EXTENSION_SECTION_ORDER,
} from './lib/prompt.js'

/** 插件名（与 package.json / cordis.patch.yml 的行 id 对齐）。 */
export const name = 'dsh-agent-browser-auto'

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
  const realDriver = createRealDriver({ config, log })
  // 扩展桥接（0.8.0）：默认关闭；启用时启动 loopback WS 服务并接入后端路由。
  const extensionBridge = config.extensionBridge.enabled === true
    ? createExtensionBridge({ config, audit, log })
    : undefined
  const backend = createBackendRouter({ bridge, realDriver, extensionDriver: extensionBridge })
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

  // 总线自带掉线扫描定时器，卸载时必须清掉；真实浏览器上下文与扩展桥接 WS 也要逐项释放。
  ctx.effect(() => () => bridge.dispose(), 'agent-browser-auto: 命令总线')
  ctx.effect(() => () => realDriver.dispose(), 'agent-browser-auto: Playwright 后端')
  ctx.effect(() => () => backend.dispose(), 'agent-browser-auto: 后端路由')
  if (extensionBridge !== undefined) {
    ctx.effect(() => extensionBridge.dispose(), 'agent-browser-auto: 扩展桥接 WS 服务')
    audit.debug('extension-bridge-mount', {
      enabled: config.extensionBridge.enabled,
      port: config.extensionBridge.port,
      pairTimeoutMs: config.extensionBridge.pairTimeoutMs,
    })
    // 监听是异步的：端口被占时会退避重试并如实写日志/状态，绝不拖垮插件加载。
    // start() 内部已有退避与 portError；这里只兜底捕获意外异常并落审计——静默吞掉会导致
    // 「enabled=true 却永远不监听」且无任何排查线索（2026-11-18 实测发生过一次）。
    extensionBridge.start().catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      audit.debug('extension-start-failed', { message })
      log('error', `agent-browser-auto: 扩展桥接 start 失败：${message}`)
    })
  } else {
    audit.debug('extension-bridge-mount', { enabled: false, note: 'config.extensionBridge.enabled !== true，未创建' })
  }

  // webServer 是可选依赖：没有它就只是不注册路由，工具会回 NO_CHANNEL 可读错误。
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      let disposeRoute
      try {
        disposeRoute = registerRoutes(webCtx, { bridge, audit, backend })
      } catch (error) {
        // 路由注册失败同样不拖垮插件：留下栈，工具侧会如实回 NO_CHANNEL。
        const message = String(error?.message ?? error)
        audit.debug('route-failed', {
          prefix: ROUTE_PREFIX,
          message,
          stack: typeof error?.stack === 'string' ? error.stack.slice(0, 4000) : undefined,
        })
        log('error', `agent-browser-auto: ${ROUTE_PREFIX} 路由注册失败：${message}`)
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
      log('info', `agent-browser-auto: 路由已挂载 ${ROUTE_PREFIX}（${origin ?? 'origin 未知'}）`)
      return () => {
        bridge.setAvailable(false)
        disposeRoute()
        audit.debug('route-unmounted', { prefix: ROUTE_PREFIX })
      }
    }, 'agent-browser-auto: /agent-browser-auto 路由')
  })

  // 工具注册失败不该拖垮整个插件：路由和 Client 通道要活着（否则面板会陷入
  // poll 404 循环，现场什么也看不到）。把栈写进 debug.jsonl 再继续。
  ctx.effect(() => {
    try {
      return registerBrowserTools(ctx, { config, bridge: backend, backend, navigator, audit, extensionBridge })
    } catch (error) {
      const message = String(error?.message ?? error)
      audit.debug('tools-failed', {
        message,
        stack: typeof error?.stack === 'string' ? error.stack.slice(0, 4000) : undefined,
      })
      log('error', `agent-browser-auto: browser_* 工具注册失败：${message}`)
      return () => {}
    }
  }, 'agent-browser-auto: browser_* 工具')

  // systemPrompt 注入（0.7.0 专用浏览器 / 0.8.0 扩展桥接）。systemPrompt 按可选服务
  // 处理：profile 里没有这个服务时插件照常加载，只是不注入。文案来自 locale/*.json
  // （对应能力 enabled=false 或拿不到文案时什么都不注，避免给 agent 一条走不通的指引）。
  // 子作用域取服务参照 resolveConnection 的教训：属性访问失败就换 .get()，不猜版本差异。
  ctx.inject(['systemPrompt'], (promptCtx) => {
    void (async () => {
      /** @type {Array<{ loader: () => Promise<string>, name: string, order: number, label: string }>} */
      const sections = [
        { loader: () => loadDedicatedPrompt(config), name: DEDICATED_SECTION_NAME, order: DEDICATED_SECTION_ORDER, label: '专用浏览器约定' },
        { loader: () => loadExtensionPrompt(config), name: EXTENSION_SECTION_NAME, order: EXTENSION_SECTION_ORDER, label: '扩展桥接约定' },
      ]
      let systemPrompt
      try {
        systemPrompt = promptCtx.systemPrompt
      } catch {
        systemPrompt = undefined
      }
      if ((systemPrompt === undefined || systemPrompt === null) && typeof promptCtx.get === 'function') {
        try {
          systemPrompt = promptCtx.get('systemPrompt')
        } catch {
          systemPrompt = undefined
        }
      }
      if (systemPrompt === undefined || systemPrompt === null || typeof systemPrompt.section !== 'function') {
        log('warn', 'agent-browser-auto: systemPrompt 服务不可用，跳过约定注入')
        return
      }
      for (const section of sections) {
        let promptText = ''
        try {
          promptText = await section.loader()
        } catch (error) {
          log('warn', `agent-browser-auto: 读取${section.label}文案失败：${String(error?.message ?? error)}`)
          continue
        }
        if (promptText === '') continue
        promptCtx.effect(() => systemPrompt.section({
          name: section.name,
          order: section.order,
          interpolate: false,
          text: promptText,
        }), `agent-browser-auto: ${section.label} section`)
        log('info', `agent-browser-auto: ${section.label}已注入 systemPrompt`)
      }
    })()
  })

  ctx.effect(() => () => {
    audit.debug('disposed', { stats: bridge.stats() })
  }, 'agent-browser-auto: 收尾日志')

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
        log('info', `agent-browser-auto: 深度模式端口可达 ${endpoint}（${discovery.targets.length} 个 target）`)
      } catch (error) {
        audit.debug('deep-mode', {
          enabled: true,
          reachable: false,
          code: typeof error?.code === 'string' ? error.code : 'INTERNAL',
          error: String(error?.message ?? error),
        })
        log('warn', `agent-browser-auto: 深度模式端口不可达 —— ${String(error?.message ?? error)}`)
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
    `agent-browser-auto: ${BROWSER_TOOL_NAMES.length} 个工具就绪；审计目录 ${config.auditDir}`
    + `；enableEval=${config.enableEval}；deepMode=${config.deepMode.enabled}`
    + `；dedicatedBrowser=${config.dedicatedBrowser.enabled}（端口 ${config.dedicatedBrowser.port}）`
    + `；extensionBridge=${config.extensionBridge.enabled}（端口 ${config.extensionBridge.port}）`,
  )
}
