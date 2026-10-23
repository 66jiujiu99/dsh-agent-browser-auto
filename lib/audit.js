/**
 * 审计与调试落盘：`audit.jsonl` / `debug.jsonl` / `shots/`。
 *
 * 写文件永远不阻塞调用方，也永远不让工具调用失败：所有失败只降级成一条
 * `console.warn`（同一条消息 30 秒内只喊一次，避免磁盘满时刷屏）。
 *
 * @module dsh-agent-browser-auto/audit
 */

import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** 同一条告警的最小重复间隔，毫秒。 */
const WARN_THROTTLE_MS = 30_000

/**
 * 把任意字符串压成可用作文件名的片段。
 * @param {unknown} value - 原始值。
 * @returns {string} 只含 `[A-Za-z0-9_-]`，空输入得到空串。
 */
function safeSegment(value) {
  if (typeof value !== 'string') return ''
  return value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)
}

/**
 * 建一个审计器。
 * @param {object} options - 依赖。
 * @param {import('./config.js').ResolvedConfig} options.config - 已解析配置。
 * @param {(level: 'debug'|'info'|'warn'|'error', message: string) => void} options.log - 插件日志出口。
 * @returns {{
 *   dir: string,
 *   shotsDir: string,
 *   audit: (entry: Record<string, unknown>) => void,
 *   debug: (kind: string, fields?: Record<string, unknown>) => void,
 *   saveShot: (bytes: Uint8Array, meta: { pageId?: unknown, url?: unknown }) => Promise<{ path: string, bytes: number }>,
 * }} 审计器。
 */
export function createAudit({ config, log }) {
  const dir = config.auditDir
  const shotsDir = path.join(dir, 'shots')
  /** @type {Promise<void>|undefined} */
  let directoryReady
  /** @type {Map<string, number>} */
  const lastWarnAt = new Map()
  /** 同一毫秒内的重名截图靠计数器错开。 */
  const usedShotNames = new Set()

  /**
   * 节流告警。
   * @param {string} message - 告警正文。
   * @returns {void}
   */
  function warn(message) {
    const now = Date.now()
    const previous = lastWarnAt.get(message)
    if (previous !== undefined && now - previous < WARN_THROTTLE_MS) return
    lastWarnAt.set(message, now)
    if (lastWarnAt.size > 64) lastWarnAt.clear()
    log('warn', message)
  }

  /**
   * 确保目录存在（只尝试一次；失败后继续尝试会因为节流只喊一次）。
   * @returns {Promise<void>} 目录就绪。
   */
  function ensureDirectory() {
    if (directoryReady === undefined) {
      directoryReady = mkdir(shotsDir, { recursive: true }).then(
        () => undefined,
        (error) => {
          directoryReady = undefined
          warn(`agent-browser-auto: 无法创建审计目录 ${shotsDir}: ${String(error?.message ?? error)}`)
        },
      )
    }
    return directoryReady
  }

  /**
   * 追加一行 JSON（fire-and-forget）。
   * @param {string} file - 文件名。
   * @param {Record<string, unknown>} entry - 一行的内容。
   * @returns {void}
   */
  function appendLine(file, entry) {
    let line
    try {
      line = `${JSON.stringify(entry)}\n`
    } catch (error) {
      warn(`agent-browser-auto: 审计记录无法序列化 (${file}): ${String(error?.message ?? error)}`)
      return
    }
    void ensureDirectory()
      .then(() => appendFile(path.join(dir, file), line, 'utf8'))
      .catch((error) => {
        warn(`agent-browser-auto: 写 ${file} 失败: ${String(error?.message ?? error)}`)
      })
  }

  return {
    dir,
    shotsDir,

    /**
     * 记一条工具调用审计（PROTOCOL §4）。
     * @param {Record<string, unknown>} entry - 除 `ts` 之外的字段。
     * @returns {void}
     */
    audit(entry) {
      appendLine('audit.jsonl', { ts: new Date().toISOString(), ...entry })
    },

    /**
     * 记一条调试事件；`config.debug === false` 时整体关闭。
     * @param {string} kind - 事件类型，如 `route`、`hello`、`command`。
     * @param {Record<string, unknown>} [fields] - 事件字段。
     * @returns {void}
     */
    debug(kind, fields = {}) {
      if (config.debug !== true) return
      appendLine('debug.jsonl', { ts: new Date().toISOString(), kind, ...fields })
    },

    /**
     * 把 Client 上传的 PNG 落盘。
     * @param {Uint8Array} bytes - 原始 PNG 字节。
     * @param {{ pageId?: unknown, url?: unknown }} meta - 来自查询串的上下文。
     * @returns {Promise<{ path: string, bytes: number }>} 落盘结果。
     */
    async saveShot(bytes, meta) {
      await ensureDirectory()
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const page = safeSegment(meta?.pageId) || 'page'
      let name = `${stamp}-${page}.png`
      for (let attempt = 2; usedShotNames.has(name) && attempt < 1000; attempt += 1) {
        name = `${stamp}-${page}-${attempt}.png`
      }
      if (usedShotNames.size > 2048) usedShotNames.clear()
      usedShotNames.add(name)
      const file = path.join(shotsDir, name)
      await writeFile(file, bytes)
      return { path: file, bytes: bytes.length }
    },
  }
}
