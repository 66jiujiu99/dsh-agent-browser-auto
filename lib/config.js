/**
 * Host 侧配置：从 `cordis.patch.yml` 的 `config` 读取，在本模块里手写校验。
 *
 * 本插件刻意**不导出** Schemastery `Config`：Host 半边不 import 任何
 * `@deepseek-ai/*` 包，profile 加载器自己提供 `export const Config` 所需的
 * schema 值类型；每多一个内部依赖，就多一条让插件加载失败的路。因此校验写成
 * 显式代码，出错时抛 `Error` 并点名出错的键——这正是加载器自带 schema 会做的
 * 事，只是由我们自己解释清楚。
 *
 * @module dsh-plugin-browser-hands/config
 */

import os from 'node:os'
import path from 'node:path'

/** 默认审计目录的相对位置（`auditDir` 为空时使用）。 */
export const DEFAULT_AUDIT_SUBDIR = ['.dsh', 'storages', 'browser-hands']

/** 配置里允许出现的全部键；其余一律拒绝，避免拼写错误被静默忽略。 */
export const CONFIG_KEYS = Object.freeze([
  'allowedHosts',
  'blockedHosts',
  'enableEval',
  'commandTimeoutMs',
  'pollWaitMs',
  'maxResultBytes',
  'auditDir',
  'debug',
  'deepMode',
])

/** 深度模式允许出现的子键。 */
const DEEP_MODE_KEYS = Object.freeze(['enabled', 'portFile', 'endpoint', 'maxNodes', 'timeoutMs'])

/**
 * Chromium 写到 userData 里的调试端口文件（第一行是端口，第二行是 ws 路径）。
 * 启动器用 `--remote-debugging-port=0`（随机端口），端口以这个文件为准。
 * @returns {string} 绝对路径；拿不到 APPDATA 时为空串（表示必须显式配置）。
 */
export function defaultPortFile() {
  const appData = typeof process.env.APPDATA === 'string' && process.env.APPDATA !== ''
    ? process.env.APPDATA
    : ''
  if (appData === '') return ''
  return path.join(appData, '@deepseek-ai', 'dsh-desktop', 'DevToolsActivePort')
}

/** 深度模式默认最多返回节点数。 */
export const DEFAULT_DEEP_MAX_NODES = 200

/** 单条 `poll` 挂起时间的上限：超过它浏览器/代理会先掐断连接。 */
const MAX_POLL_WAIT_MS = 600_000

/** `maxResultBytes` 的下限：再小连一行错误都放不下。 */
const MIN_RESULT_BYTES = 512

/** `maxResultBytes` 的上限：防止一次工具返回把上下文顶爆。 */
const MAX_RESULT_BYTES = 4_000_000

/** 定时器上限，与 Node 允许的最大 setTimeout 延迟一致。 */
const MAX_TIMER_MS = 2_147_483_647

/** `hello` 回给 Client 的响应里声明的快照字节上限（协议固定值）。 */
export const MAX_SNAPSHOT_BYTES = 8192

/**
 * 解析后的配置（默认值已填好）。
 * @typedef {object} ResolvedConfig
 * @property {string[]} allowedHosts - 非空时只允许这些主机（含子域）。
 * @property {string[]} blockedHosts - 优先拒绝的主机（含子域）。
 * @property {boolean} enableEval - 是否允许 `browser_eval` 下发到 Client。
 * @property {number} commandTimeoutMs - 单条命令从入队到回结果的期限。
 * @property {number} pollWaitMs - `poll` 最长挂起时间。
 * @property {number} maxResultBytes - 单个工具渲染文本的字节上限。
 * @property {string} auditDir - 审计目录绝对路径。
 * @property {boolean} debug - 是否写 `debug.jsonl`。
 * @property {{ enabled: boolean, portFile: string, endpoint: string, maxNodes: number, timeoutMs: number }} deepMode -
 *   深度模式（CDP 直连）配置；`enabled=false` 时工具回 `DEEP_UNAVAILABLE`。`endpoint` 为空时
 *   运行时读 `portFile`（Chromium 写的 `DevToolsActivePort`）拼出端口。
 */

/** 配置非法时抛出的错误：message 里必须说清「哪个键、要什么」。 */
export class ConfigError extends Error {
  /**
   * @param {string} message - 具体问题与可接受的取值。
   */
  constructor(message) {
    super(`dsh-plugin-browser-hands config: ${message}`)
    this.name = 'ConfigError'
  }
}

/**
 * 拒绝插件未实现的键。
 * @param {Record<string, unknown>} raw - 整行 config。
 * @returns {void}
 */
function rejectUnknownKeys(raw) {
  const unknown = Object.keys(raw).filter((key) => !CONFIG_KEYS.includes(key))
  if (unknown.length > 0) {
    throw new ConfigError(
      `unknown key(s) ${unknown.map((key) => JSON.stringify(key)).join(', ')}; `
      + `accepted keys are ${CONFIG_KEYS.map((key) => JSON.stringify(key)).join(', ')}`,
    )
  }
}

/**
 * 读一个布尔值。
 * @param {Record<string, unknown>} raw - 整行 config。
 * @param {string} key - 键名。
 * @param {boolean} fallback - 缺省值。
 * @returns {boolean} 解析结果。
 */
function readBoolean(raw, key, fallback) {
  const value = raw[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') {
    throw new ConfigError(`${key} must be a boolean, got ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * 读一个整数并做区间检查。
 * @param {Record<string, unknown>} raw - 整行 config。
 * @param {string} key - 键名。
 * @param {number} fallback - 缺省值。
 * @param {number} min - 允许的最小值。
 * @param {number} max - 允许的最大值。
 * @returns {number} 解析结果。
 */
function readInteger(raw, key, fallback, min, max) {
  const value = raw[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new ConfigError(
      `${key} must be an integer between ${min} and ${max}, got ${JSON.stringify(value)}`,
    )
  }
  return value
}

/**
 * 读一组主机名（允许为空数组）。
 * @param {Record<string, unknown>} raw - 整行 config。
 * @param {string} key - 键名。
 * @returns {string[]} 规范化后的主机名列表。
 */
function readHostList(raw, key) {
  const value = raw[key]
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new ConfigError(`${key} must be an array of host names, got ${JSON.stringify(value)}`)
  }
  if (value.length > 512) {
    throw new ConfigError(`${key} must hold at most 512 hosts, got ${value.length}`)
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new ConfigError(`${key}[${index}] must be a non-empty host name, got ${JSON.stringify(entry)}`)
    }
    return entry.trim().toLowerCase()
  })
}

/**
 * 解析审计目录：空串表示 `$HOME/.dsh/storages/browser-hands`。
 * @param {Record<string, unknown>} raw - 整行 config。
 * @returns {string} 绝对路径。
 */
function readAuditDir(raw) {
  const value = raw.auditDir
  if (value === undefined || value === null || value === '') {
    return path.join(os.homedir(), ...DEFAULT_AUDIT_SUBDIR)
  }
  if (typeof value !== 'string') {
    throw new ConfigError(`auditDir must be a string, got ${JSON.stringify(value)}`)
  }
  return path.resolve(value)
}

/**
 * 深度模式端点（可空）：空表示运行时读 `portFile` 拼 `http://127.0.0.1:<port>`。
 * 非空则必须是 loopback 的 http(s) URL（CDP 端口无认证，绝不接受远程地址）。
 * @param {unknown} value - 原始值。
 * @returns {string} 规范化后的端点（空串表示由 portFile 推导）。
 */
function readDeepEndpoint(value) {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value !== 'string') {
    throw new ConfigError(`deepMode.endpoint must be a string, got ${JSON.stringify(value)}`)
  }
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new ConfigError(`deepMode.endpoint must be an absolute http(s) URL, got ${JSON.stringify(value)}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ConfigError(`deepMode.endpoint must use http: or https:, got ${JSON.stringify(value)}`)
  }
  const host = parsed.hostname.toLowerCase()
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
  if (!loopback) {
    throw new ConfigError(
      `deepMode.endpoint must point at loopback (127.0.0.1/localhost/::1) — the CDP port has no auth, `
      + `got ${JSON.stringify(value)}`,
    )
  }
  return value.replace(/\/+$/, '')
}

/**
 * 解析深度模式的端口文件路径：空串表示默认 userData 路径。
 * @param {unknown} value - 原始值。
 * @returns {string} 绝对路径（拿不到默认路径时为空串）。
 */
function readDeepPortFile(value) {
  if (value === undefined || value === null || value === '') return defaultPortFile()
  if (typeof value !== 'string') {
    throw new ConfigError(`deepMode.portFile must be a string, got ${JSON.stringify(value)}`)
  }
  return path.resolve(value)
}

/**
 * 解析 `deepMode`（CDP 直连）配置。
 * @param {Record<string, unknown>} raw - 整行 config。
 * @returns {{ enabled: boolean, portFile: string, endpoint: string, maxNodes: number, timeoutMs: number }} 解析结果。
 */
function readDeepMode(raw) {
  const value = raw.deepMode
  if (value === undefined || value === null) {
    return {
      enabled: false,
      portFile: defaultPortFile(),
      endpoint: '',
      maxNodes: DEFAULT_DEEP_MAX_NODES,
      timeoutMs: 8_000,
    }
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError(`deepMode must be an object, got ${JSON.stringify(value)}`)
  }
  const record = /** @type {Record<string, unknown>} */ (value)
  const unknown = Object.keys(record).filter((key) => !DEEP_MODE_KEYS.includes(key))
  if (unknown.length > 0) {
    throw new ConfigError(
      `deepMode has unknown key(s) ${unknown.map((key) => JSON.stringify(key)).join(', ')}; `
      + `accepted keys are ${DEEP_MODE_KEYS.map((key) => JSON.stringify(key)).join(', ')}`,
    )
  }
  if (record.enabled !== undefined && typeof record.enabled !== 'boolean') {
    throw new ConfigError(`deepMode.enabled must be a boolean, got ${JSON.stringify(record.enabled)}`)
  }
  if (record.maxNodes !== undefined
    && (typeof record.maxNodes !== 'number' || !Number.isSafeInteger(record.maxNodes)
      || record.maxNodes < 1 || record.maxNodes > 2_000)) {
    throw new ConfigError(`deepMode.maxNodes must be an integer between 1 and 2000, got ${JSON.stringify(record.maxNodes)}`)
  }
  if (record.timeoutMs !== undefined
    && (typeof record.timeoutMs !== 'number' || !Number.isSafeInteger(record.timeoutMs)
      || record.timeoutMs < 500 || record.timeoutMs > 60_000)) {
    throw new ConfigError(`deepMode.timeoutMs must be an integer between 500 and 60000, got ${JSON.stringify(record.timeoutMs)}`)
  }
  return {
    enabled: record.enabled === true,
    portFile: readDeepPortFile(record.portFile),
    endpoint: readDeepEndpoint(record.endpoint),
    maxNodes: record.maxNodes === undefined ? DEFAULT_DEEP_MAX_NODES : Number(record.maxNodes),
    timeoutMs: record.timeoutMs === undefined ? 8_000 : Number(record.timeoutMs),
  }
}

/**
 * 校验并解析一行插件配置。
 * @param {unknown} rawConfig - 加载器行里的 `config` 值。
 * @returns {ResolvedConfig} 填好默认值的配置。
 */
export function resolveConfig(rawConfig) {
  if (rawConfig === undefined || rawConfig === null) rawConfig = {}
  if (typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
    throw new ConfigError(`config must be an object, got ${JSON.stringify(rawConfig)}`)
  }
  const raw = /** @type {Record<string, unknown>} */ (rawConfig)
  rejectUnknownKeys(raw)

  return {
    allowedHosts: readHostList(raw, 'allowedHosts'),
    blockedHosts: readHostList(raw, 'blockedHosts'),
    enableEval: readBoolean(raw, 'enableEval', false),
    commandTimeoutMs: readInteger(raw, 'commandTimeoutMs', 45_000, 1, MAX_TIMER_MS),
    pollWaitMs: readInteger(raw, 'pollWaitMs', 20_000, 100, MAX_POLL_WAIT_MS),
    maxResultBytes: readInteger(raw, 'maxResultBytes', 12_000, MIN_RESULT_BYTES, MAX_RESULT_BYTES),
    auditDir: readAuditDir(raw),
    debug: readBoolean(raw, 'debug', true),
    deepMode: readDeepMode(raw),
  }
}
