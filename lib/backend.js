/**
 * 按 Agent 会话选择浏览器后端。
 *
 * 默认始终是现有内嵌 Client；只有 launch/connect（真实浏览器）或 extension
 * （扩展桥接，0.8.0）成功后才切走。后端失败不会自动降级，避免模型以为在操作
 * 真实浏览器、实际却操作了另一个页面。
 *
 * 路由优先级：显式 real（launch/connect）> extension > embedded。
 * 切换永远是显式的（browser_backend），绝不为任何失败自动回退。
 *
 * @module dsh-agent-browser-auto/backend
 */

import { BridgeError } from './bridge.js'

/**
 * @param {object} deps - 依赖。
 * @param {ReturnType<import('./bridge.js').createBridge>} deps.bridge - 内嵌命令总线。
 * @param {ReturnType<import('./real-driver.js').createRealDriver>} deps.realDriver - Playwright 后端。
 * @param {ReturnType<import('./extension-bridge.js').createExtensionBridge>|undefined} [deps.extensionDriver] - 扩展桥接后端（未启用时为 undefined）。
 * @returns {object} 与 bridge 兼容的命令路由及后端控制方法。
 */
export function createBackendRouter({ bridge, realDriver, extensionDriver }) {
  const modes = new Map()
  const transitions = new Map()

  const modeOf = (sessionId) => {
    const mode = modes.get(sessionId)
    if (mode === 'real' || mode === 'extension') return mode
    return 'embedded'
  }

  const status = (sessionId, extra = {}) => {
    const real = realDriver.status(sessionId)
    const mode = modeOf(sessionId)
    return {
      ok: true,
      backend: mode,
      previousBackend: extra.previousBackend ?? mode,
      // 工具 schema 的 real/extension 是可选 object，不接受 null/undefined。
      ...(real && typeof real === 'object' ? { real } : {}),
      ...(extensionDriver !== undefined ? { extension: extensionDriver.status() } : {}),
      // DSH 工具结果必须是 lossless JSON；status 没有提示语时不能带 message: undefined。
      ...(typeof extra.message === 'string' ? { message: extra.message } : {}),
    }
  }

  const runAction = async (sessionId, raw) => {
    const action = raw.action
    const previousBackend = modeOf(sessionId)
    if (action === 'status') return status(sessionId, { previousBackend })
    if (action === 'embedded') {
      modes.set(sessionId, 'embedded')
      return status(sessionId, { previousBackend, message: '已切回轻量内嵌；真实浏览器页面保持原状。' })
    }
    if (action === 'disconnect') {
      await realDriver.disconnectSession(sessionId, { closeBrowser: raw.closeBrowser === true })
      modes.set(sessionId, 'embedded')
      return status(sessionId, { previousBackend, message: '真实浏览器连接已断开，已切回轻量内嵌。' })
    }
    if (action === 'launch' || action === 'connect') {
      // 先完成连接，再提交模式；任何错误都保留 previousBackend。
      await realDriver.connectSession(sessionId, {
        browser: raw.browser,
        temporary: raw.temporary === true,
        endpoint: raw.endpoint,
        pageUrl: raw.pageUrl,
      })
      modes.set(sessionId, 'real')
      return status(sessionId, {
        previousBackend,
        message: action === 'launch' ? '真实浏览器已启动并接管本会话。' : '已连接本机浏览器并接管本会话。',
      })
    }
    if (action === 'extension') {
      // 显式进入扩展桥接；离线/未启用都如实报错，绝不静默回落到内嵌。
      if (extensionDriver === undefined) {
        throw new BridgeError(
          'EXTENSION_DISABLED',
          '扩展桥接未启用（extensionBridge.enabled=false）：请让用户在插件配置里打开 extensionBridge.enabled 并重新 apply。',
        )
      }
      if (extensionDriver.connected() !== true) {
        const detail = extensionDriver.status()
        const reason = detail.listening === false && detail.portError !== ''
          ? `WS 服务未监听（${detail.portError}）`
          : '扩展尚未连接'
        throw new BridgeError(
          'EXTENSION_OFFLINE',
          `扩展桥接后端不可用：${reason}。请先调用 browser_ext_pair 生成配对码，`
            + '让用户在日常浏览器加载 extension/ 目录的扩展并输入配对码；已配对时扩展会自动重连。',
        )
      }
      modes.set(sessionId, 'extension')
      return status(sessionId, {
        previousBackend,
        message: '已切换到扩展桥接后端：browser_* 命令经扩展操作用户日常浏览器的真实标签页。',
      })
    }
    throw new BridgeError('BAD_ARGUMENTS', `不支持的后端 action：${String(action)}`)
  }

  return {
    modeOf,
    status,
    knownUrl(sessionId) {
      const mode = modeOf(sessionId)
      if (mode === 'real') return realDriver.knownUrl(sessionId)
      if (mode === 'extension' && extensionDriver !== undefined) return extensionDriver.knownUrl(sessionId)
      return bridge.knownUrl(sessionId)
    },
    sendCommand(sessionId, op, args, timeoutMs) {
      const mode = modeOf(sessionId)
      if (mode === 'real') return realDriver.sendCommand(sessionId, op, args, timeoutMs)
      if (mode === 'extension' && extensionDriver !== undefined) {
        return extensionDriver.sendCommand(sessionId, op, args, timeoutMs)
      }
      return bridge.sendCommand(sessionId, op, args, timeoutMs)
    },
    execute(sessionId, raw) {
      const previous = transitions.get(sessionId) ?? Promise.resolve()
      const next = previous.catch(() => {}).then(() => runAction(sessionId, raw))
      transitions.set(sessionId, next)
      return next.finally(() => {
        if (transitions.get(sessionId) === next) transitions.delete(sessionId)
      })
    },
    dispose() {
      modes.clear()
      transitions.clear()
    },
  }
}
