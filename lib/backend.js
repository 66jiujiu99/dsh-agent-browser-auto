/**
 * 按 Agent 会话选择浏览器后端。
 *
 * 默认始终是现有内嵌 Client；只有 launch/connect 成功后才切到 Playwright。
 * 后端失败不会自动降级，避免模型以为在操作真实浏览器、实际却操作了另一个页面。
 *
 * @module dsh-agent-browser-auto/backend
 */

import { BridgeError } from './bridge.js'

/**
 * @param {object} deps - 依赖。
 * @param {ReturnType<import('./bridge.js').createBridge>} deps.bridge - 内嵌命令总线。
 * @param {ReturnType<import('./real-driver.js').createRealDriver>} deps.realDriver - Playwright 后端。
 * @returns {object} 与 bridge 兼容的命令路由及后端控制方法。
 */
export function createBackendRouter({ bridge, realDriver }) {
  const modes = new Map()
  const transitions = new Map()

  const modeOf = (sessionId) => modes.get(sessionId) === 'real' ? 'real' : 'embedded'

  const status = (sessionId, extra = {}) => {
    const real = realDriver.status(sessionId)
    return {
      ok: true,
      backend: modeOf(sessionId),
      previousBackend: extra.previousBackend ?? modeOf(sessionId),
      // 工具 schema 的 real 是可选 object，不接受 null/undefined。
      ...(real && typeof real === 'object' ? { real } : {}),
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
    throw new BridgeError('BAD_ARGUMENTS', `不支持的后端 action：${String(action)}`)
  }

  return {
    modeOf,
    status,
    knownUrl(sessionId) {
      return modeOf(sessionId) === 'real' ? realDriver.knownUrl(sessionId) : bridge.knownUrl(sessionId)
    },
    sendCommand(sessionId, op, args, timeoutMs) {
      return modeOf(sessionId) === 'real'
        ? realDriver.sendCommand(sessionId, op, args, timeoutMs)
        : bridge.sendCommand(sessionId, op, args, timeoutMs)
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
