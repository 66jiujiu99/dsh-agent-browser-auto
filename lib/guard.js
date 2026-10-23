/**
 * 导航前的 URL 预校验（Host 侧，命令下发之前）。
 *
 * 桌面版主进程会**静默吞掉**被拒绝的导航：页面不会报错，模型只会看到「点了没反应」。
 * 所以 Host 必须在命令进队列前就拒绝，并把原因说清楚（PROTOCOL §0/§2.3 `NAV_BLOCKED`）。
 *
 * 规则（与主进程一致）：
 * - 只允许 `http:` / `https:`；
 * - 不允许内嵌凭据（`user:pass@`）；
 * - 不允许指向 DSH Host 自身（`webServer.getOrigin()` 的 host+port，
 *   `localhost` / `127.0.0.1` / `[::1]` 同端口同样算自身）；
 * - `blockedHosts` 优先拒绝；`allowedHosts` 非空时只放行白名单（后缀匹配）。
 *
 * @module dsh-agent-browser-auto/guard
 */

/** 视作「本机」的主机名（已去方括号、已小写）。 */
export const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '::ffff:127.0.0.1'])

/** 拒绝原因的错误码，与协议 §2.3 对齐。 */
export const NAV_BLOCKED = 'NAV_BLOCKED'

/**
 * 去掉 IPv6 方括号并小写。
 * @param {string} hostname - `URL#hostname`。
 * @returns {string} 规范化主机名。
 */
function bareHost(hostname) {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '')
}

/**
 * URL 的有效端口（缺省端口按协议补齐）。
 * @param {URL} url - 已解析的 URL。
 * @returns {string} 端口字符串。
 */
function effectivePort(url) {
  if (url.port !== '') return url.port
  if (url.protocol === 'https:') return '443'
  if (url.protocol === 'http:') return '80'
  return ''
}

/**
 * 一条主机规则是否命中该 URL（`example.com` 命中 `a.example.com`）。
 * @param {URL} url - 目标 URL。
 * @param {string} pattern - 配置里的主机规则，可带端口或 `*.` 前缀。
 * @returns {boolean} 是否命中。
 */
export function hostMatches(url, pattern) {
  const host = bareHost(url.hostname)
  let rule = pattern.trim().toLowerCase().replace(/^\*\./, '').replace(/^\.+/, '')
  if (rule === '') return false
  // 带端口的规则（`example.com:8080`）要求端口也一致；IPv6 字面量除外。
  if (!rule.startsWith('[')) {
    const colon = rule.lastIndexOf(':')
    if (colon > 0) {
      const patternPort = rule.slice(colon + 1)
      if (patternPort !== '' && patternPort !== effectivePort(url)) return false
      rule = rule.slice(0, colon)
    }
  }
  rule = rule.replace(/^\[|\]$/g, '')
  return host === rule || host.endsWith(`.${rule}`)
}

/**
 * 建一个导航校验器。
 * @param {object} options - 依赖。
 * @param {import('./config.js').ResolvedConfig} options.config - 已解析配置。
 * @param {() => string} options.getOrigin - `webServer.getOrigin()` 的包装（可能抛）。
 * @returns {{
 *   checkUrl: (raw: unknown) => { ok: true, href: string, host: string } | { ok: false, code: string, message: string },
 *   selfOrigin: () => string | undefined,
 * }} 校验器。
 */
export function createNavigator({ config, getOrigin }) {
  /**
   * 读取 Host 自身 origin；`webServer` 尚未 listen 时抛错，这里当作「不知道」。
   * @returns {string|undefined} origin 字符串。
   */
  function selfOrigin() {
    try {
      const origin = getOrigin()
      return typeof origin === 'string' && origin !== '' ? origin : undefined
    } catch {
      return undefined
    }
  }

  /**
   * 目标是否就是 DSH Host 自己。
   * @param {URL} url - 目标 URL。
   * @returns {string|undefined} 命中时返回 origin，用于报错文案。
   */
  function selfHit(url) {
    const origin = selfOrigin()
    if (origin === undefined) return undefined
    let parsed
    try {
      parsed = new URL(origin)
    } catch {
      return undefined
    }
    if (effectivePort(url) !== effectivePort(parsed)) return undefined
    const host = bareHost(url.hostname)
    const originHost = bareHost(parsed.hostname)
    if (host === originHost) return origin
    if (LOOPBACK_HOSTNAMES.has(host) && LOOPBACK_HOSTNAMES.has(originHost)) return origin
    return undefined
  }

  /**
   * 校验一个待导航 URL。
   * @param {unknown} raw - 模型给的 URL。
   * @returns {{ ok: true, href: string, host: string } | { ok: false, code: string, message: string }} 结果。
   */
  function checkUrl(raw) {
    if (typeof raw !== 'string' || raw.trim() === '') {
      return { ok: false, code: NAV_BLOCKED, message: '缺少 url：请给出完整的 http/https 地址，例如 https://example.com/' }
    }
    let url
    try {
      url = new URL(raw.trim())
    } catch {
      return {
        ok: false,
        code: NAV_BLOCKED,
        message: `URL 无法解析：${raw.trim().slice(0, 200)}（需要形如 https://example.com/ 的绝对地址）`,
      }
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return {
        ok: false,
        code: NAV_BLOCKED,
        message: `只允许 http/https 地址，收到 ${url.protocol.replace(':', '')}：${url.href}`,
      }
    }
    if (url.username !== '' || url.password !== '') {
      return { ok: false, code: NAV_BLOCKED, message: 'URL 不能包含内嵌凭据（user:password@），请先登录页面再操作' }
    }
    const host = bareHost(url.hostname)
    const self = selfHit(url)
    if (self !== undefined) {
      return {
        ok: false,
        code: NAV_BLOCKED,
        message: `不能指向 DSH Host 自身地址（${self}）——面板是给外部站点用的`,
      }
    }
    const blocked = config.blockedHosts.find((pattern) => hostMatches(url, pattern))
    if (blocked !== undefined) {
      return { ok: false, code: NAV_BLOCKED, message: `主机 ${host} 被 blockedHosts 拒绝（规则 ${blocked}）` }
    }
    if (config.allowedHosts.length > 0 && !config.allowedHosts.some((pattern) => hostMatches(url, pattern))) {
      return {
        ok: false,
        code: NAV_BLOCKED,
        message: `主机 ${host} 不在 allowedHosts 白名单中（已配置 ${config.allowedHosts.length} 条规则）`,
      }
    }
    return { ok: true, href: url.href, host }
  }

  return { checkUrl, selfOrigin }
}
