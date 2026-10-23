/**
 * 工具返回值 → 模型可读文本（PROTOCOL §3/§6 的排版），以及按 UTF-8 字节截断。
 *
 * 快照排版统一交给 `./snapshot.js`（视口优先、视口外提示、stats），render 只负责
 * 动作摘要、控制台/网络块、失败行、以及按字节截断。这样所有快照结果都带
 * `stats`（`elements/chars/estTokens/scope`），成本可对比。
 *
 * 失败一律排成一行：`browser_open failed: NAV_BLOCKED — 原因`。
 * 这里对 Client 的返回值一律不信任：字段缺失、类型不对都只降级成占位文本，
 * 绝不抛异常（pipeline 里 render 抛错会把整次调用变成投影错误）。
 *
 * @module dsh-plugin-browser-hands/render
 */

import { renderFullSnapshot, renderDelta, formatSnapshotText } from './snapshot.js'

/** 总长超限时追加的提示，同时提醒用哪个工具收窄。 */
export const TRUNCATION_NOTICE = '\n… (truncated; use browser_snapshot with maxElements/textLimit)'

/**
 * 是否是普通对象。
 * @param {unknown} value - 任意值。
 * @returns {boolean} 结论。
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 安全转文本。
 * @param {unknown} value - 任意值。
 * @returns {string} 文本（`null`/`undefined` 得到空串）。
 */
function text(value) {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

/**
 * 数字安全转文本。
 * @param {unknown} value - 任意值。
 * @returns {string} 数字或 `?`。
 */
function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? String(Math.round(value)) : '?'
}

/**
 * 一帧快照是否带正文（非空字符串）。用来判断两帧口径是否可比。
 * @param {unknown} snapshot - 快照对象。
 * @returns {boolean} 是否带正文。
 */
function hasText(snapshot) {
  return isRecord(snapshot) && typeof snapshot.text === 'string' && snapshot.text !== ''
}

/**
 * 截短单行文本。
 * @param {string} value - 原始文本。
 * @param {number} limit - 字符上限。
 * @returns {string} 截短后的文本。
 */
function clip(value, limit) {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

/**
 * UTF-8 字节数。
 * @param {string} value - 文本。
 * @returns {number} 字节数。
 */
export function byteLength(value) {
  return Buffer.byteLength(value, 'utf8')
}

/**
 * 按 UTF-8 字节截断，保证结果不超过 `maxBytes`，并追加截断提示。
 * @param {string} value - 原文。
 * @param {number} maxBytes - 字节上限。
 * @returns {string} 截断后的文本。
 */
export function truncateText(value, maxBytes) {
  if (byteLength(value) <= maxBytes) return value
  const notice = TRUNCATION_NOTICE
  const budget = maxBytes - byteLength(notice)
  if (budget <= 0) return notice.trimStart()
  // 从字节预算倒推字符边界：先按字节切，再丢掉结尾可能出现的半个多字节字符。
  const buffer = Buffer.from(value, 'utf8')
  let cut = buffer.subarray(0, budget).toString('utf8')
  if (cut.endsWith('\uFFFD')) cut = cut.slice(0, -1)
  return `${cut.replace(/\s+$/, '')}${notice}`
}

/**
 * 排版一个全量快照块（统一走 `./snapshot.js` 的视口优先渲染 + stats）。
 * @param {unknown} raw - `snapshot` 对象。
 * @returns {string} 多行文本。
 */
export function snapshotBlock(raw) {
  const rendered = renderFullSnapshot(raw)
  return formatSnapshotText({
    tool: 'snapshot',
    url: text(isRecord(raw) ? raw.url : null),
    title: text(isRecord(raw) ? raw.title : null),
    lines: rendered.lines,
    stats: rendered.stats,
    full: true,
  })
}

/**
 * 动作后的增量块（同页动作默认走这里，模型只看到变化的那几行）。
 * URL / pageId / scope / 是否带正文 任一不同 → 返回空串，调用方退回全量块
 * （跨页或口径不一致的 diff 会误导模型）。
 * @param {unknown} value - 工具返回值（需含 `snapshot`）。
 * @param {unknown} beforeRaw - 上一帧全量快照。
 * @returns {string} 增量文本；不适用时为空串。
 */
export function deltaBlock(value, beforeRaw) {
  if (!isRecord(value) || !isRecord(value.snapshot) || !isRecord(beforeRaw)) return ''
  const after = value.snapshot
  if (text(after.url) !== text(beforeRaw.url)) return ''
  if (text(after.pageId) !== '' && text(beforeRaw.pageId) !== '' && text(after.pageId) !== text(beforeRaw.pageId)) return ''
  if (text(after.scope) !== text(beforeRaw.scope)) return ''
  if (hasText(after) !== hasText(beforeRaw)) return ''
  const delta = renderDelta({ beforeRaw, afterRaw: after, forceFull: false })
  if (delta.full !== false) return ''
  return formatSnapshotText({
    tool: 'delta',
    url: text(after.url),
    title: text(after.title),
    lines: delta.lines,
    stats: delta.stats,
    full: false,
  })
}

/**
 * 动作行上「页面有没有变化」的措辞。
 * @param {unknown} changed - 值。
 * @returns {string} 措辞。
 */
function changedWord(changed) {
  if (changed === true) return 'page changed'
  if (changed === false) return 'no visible change'
  return 'change unknown'
}

/**
 * 动作类工具的摘要行（快照另起一块）。
 * @param {string} tool - 工具名。
 * @param {Record<string, unknown>} value - 返回值。
 * @param {Record<string, unknown>} args - 本次调用的参数（用来补 Client 没回显的目标）。
 * @returns {string} 摘要文本。
 */
function actionLine(tool, value, args) {
  switch (tool) {
    case 'browser_click': {
      const ref = text(value.ref) || text(args.ref)
      const target = ref !== '' ? ref : `(${num(value.x ?? args.x)}, ${num(value.y ?? args.y)})`
      return `click ${target} → ${changedWord(value.changed)}`
    }
    case 'browser_type': {
      const ref = text(value.ref) || text(args.ref) || '?'
      const typed = typeof args.text === 'string' ? ` "${clip(args.text, 80)}"` : ''
      const flags = []
      if (value.cleared === true || args.clear === true) flags.push('cleared')
      if (value.submitted === true || args.submit === true) flags.push('submitted')
      const suffix = flags.length > 0 ? ` (${flags.join(', ')})` : ''
      return `type ${ref}${typed}${suffix} → ${changedWord(value.changed)}`
    }
    case 'browser_press': {
      const key = text(value.key) || text(args.key) || '?'
      return `press ${key} → ${changedWord(value.changed)}`
    }
    case 'browser_scroll': {
      const scroll = isRecord(value.scroll) ? value.scroll : {}
      const dy = `dy=${num(value.dy ?? args.dy)}`
      const dx = args.dx !== undefined && args.dx !== 0 ? ` dx=${num(args.dx)}` : ''
      return `${dy}${dx} → y=${num(scroll.y)}/${num(scroll.height)} (viewport ${num(scroll.viewport)})`
    }
    case 'browser_nav': {
      const action = text(value.action) || text(args.action) || 'goto'
      const url = text(value.url)
      const title = text(value.title)
      return `nav ${action} → ${url}${title !== '' ? ` · ${title}` : ''}`
    }
    case 'browser_tabs': {
      const tabs = Array.isArray(value.tabs) ? value.tabs : []
      const activeId = text(value.activeId)
      const lines = [`tabs (${tabs.length}, active=${activeId || '?'}):`]
      if (tabs.length === 0) lines.push('(没有页面)')
      for (const raw of tabs) {
        const tab = isRecord(raw) ? raw : {}
        const mark = tab.active === true ? ' [active]' : ''
        lines.push(`${text(tab.id) || '?'} ${text(tab.url) || '(about:blank)'} "${clip(text(tab.title), 80)}"${mark}`)
      }
      return lines.join('\n')
    }
    default:
      return ''
  }
}

/**
 * 截图结果行。
 * @param {Record<string, unknown>} value - 返回值。
 * @returns {string} 文本。
 */
function screenshotLine(value) {
  const path = text(value.path) || '(unknown path)'
  const bytes = typeof value.bytes === 'number' ? `${value.bytes} bytes` : 'size unknown'
  const size = `${num(value.width)}x${num(value.height)}`
  const url = text(value.url)
  return `screenshot saved: ${path} (${bytes}, ${size})${url !== '' ? ` ${url}` : ''}`
}

/**
 * 控制台结果块。
 * @param {Record<string, unknown>} value - 返回值。
 * @returns {string} 文本。
 */
function consoleBlock(value) {
  const entries = Array.isArray(value.entries) ? value.entries : []
  const lines = [`console (${entries.length} entries):`]
  if (entries.length === 0) lines.push('(无输出)')
  for (const raw of entries) {
    const entry = isRecord(raw) ? raw : {}
    const level = text(entry.level) || 'log'
    const where = text(entry.url)
    const line = typeof entry.line === 'number' ? `:${entry.line}` : ''
    lines.push(`[${level}] ${clip(text(entry.text), 500)}${where !== '' ? ` (${where}${line})` : ''}`)
  }
  return lines.join('\n')
}

/**
 * 网络结果块。
 * @param {Record<string, unknown>} value - 返回值。
 * @returns {string} 文本。
 */
function networkBlock(value) {
  const entries = Array.isArray(value.entries) ? value.entries : []
  const lines = [`network (${entries.length} entries):`]
  if (entries.length === 0) lines.push('(无请求)')
  for (const raw of entries) {
    const entry = isRecord(raw) ? raw : {}
    const status = typeof entry.status === 'number' ? String(entry.status) : '---'
    const method = text(entry.method) || 'GET'
    const failure = text(entry.failure)
    const ok = entry.ok === true ? ' ok' : ' failed'
    lines.push(`[${status}${ok}] ${method} ${clip(text(entry.url), 300)}${failure !== '' ? ` — ${clip(failure, 200)}` : ''}`)
  }
  return lines.join('\n')
}

/**
 * 渲染一次成功调用的文本。
 * @param {string} tool - 工具名。
 * @param {Record<string, unknown>} value - 返回值。
 * @param {Record<string, unknown>} args - 本次调用的参数。
 * @returns {string} 文本。
 */
function renderSuccess(tool, value, args) {
  switch (tool) {
    case 'browser_open':
      if (isRecord(value.snapshot)) return snapshotBlock(value.snapshot)
      return `opened ${text(value.url)}${text(value.title) !== '' ? ` · ${text(value.title)}` : ''}`
    case 'browser_snapshot':
      return snapshotBlock(value.snapshot)
    case 'browser_click':
    case 'browser_type':
    case 'browser_press':
    case 'browser_scroll':
    case 'browser_nav':
    case 'browser_tabs': {
      const summary = actionLine(tool, value, args)
      if (isRecord(value.snapshot)) {
        const block = typeof value.__deltaText === 'string' && value.__deltaText !== ''
          ? value.__deltaText
          : snapshotBlock(value.snapshot)
        return summary === '' ? block : `${summary}\n\n${block}`
      }
      return summary === '' ? 'done.' : summary
    }
    case 'browser_find': {
      const query = text(value.query)
      const matches = Array.isArray(value.matches) ? value.matches : []
      const lines = [`find "${query}" → ${matches.length} match(es):`]
      if (matches.length === 0) lines.push('(没有匹配；试试更短的关键词，或 browser_snapshot scope:document)')
      for (const raw of matches) {
        const item = isRecord(raw) ? raw : {}
        if (item.fallback === true) {
          lines.push(`(无语义标记) "${clip(text(item.name), 80)}" @ (${num(item.x)}, ${num(item.y)})`
            + ` → 用 browser_click x=${num(item.x)} y=${num(item.y)} 点它`)
          continue
        }
        const where = item.inViewport === false ? ' (视口外)' : ''
        lines.push(`${text(item.ref) || '?'} ${text(item.role) || '?'} "${clip(text(item.name), 80)}"${where}`)
      }
      return lines.join('\n')
    }
    case 'browser_deep_snapshot': {
      const target = isRecord(value.target) ? value.target : {}
      const stats = isRecord(value.stats) ? value.stats : {}
      const nodes = Array.isArray(value.nodes) ? value.nodes : []
      const scope = text(stats.scope) || 'a11y'
      const lines = [
        `deep snapshot (${scope}) · ${text(target.title) || '(no title)'} · ${text(target.url) || '(unknown)'}`,
        '---',
      ]
      if (nodes.length === 0) lines.push('(没有可展示节点；试试 scope:dom 或放宽 maxNodes)')
      for (const raw of nodes) {
        const node = isRecord(raw) ? raw : {}
        const box = isRecord(node.box)
          ? ` @ (${num(node.box.x)},${num(node.box.y)},${num(node.box.width)},${num(node.box.height)})`
          : ' @ box:n/a'
        lines.push(`[${text(node.framePath) || 'main'}] ${text(node.role) || '?'} "${clip(text(node.name), 80)}"${box}`)
      }
      const frames = typeof stats.frames === 'number' ? stats.frames : 1
      const truncated = stats.truncated === true ? ` (${num(stats.total)} 个中截断)` : ''
      lines.push(
        `stats: ${num(stats.nodes)} nodes${truncated}, ~${num(stats.estTokens)} tokens, `
        + `${num(frames)} frame(s), ${num(stats.ms)}ms`,
      )
      return lines.join('\n')
    }
    case 'browser_screenshot':
      return screenshotLine(value)
    case 'browser_console':
      return consoleBlock(value)
    case 'browser_network':
      return networkBlock(value)
    case 'browser_eval': {
      let payload
      try {
        payload = JSON.stringify(value.value ?? null)
      } catch {
        payload = String(value.value)
      }
      return `eval → ${clip(payload ?? 'null', 4000)}`
    }
    case 'browser_close':
      return 'page closed.'
    default: {
      try {
        return clip(JSON.stringify(value), 4000) ?? 'done.'
      } catch {
        return 'done.'
      }
    }
  }
}

/**
 * 把一次工具调用的返回值渲染成模型看到的文本（含截断）。
 * @param {string} tool - 工具名，如 `browser_open`。
 * @param {unknown} value - `execute` 返回的值。
 * @param {number} maxResultBytes - 文本字节上限。
 * @param {unknown} [args] - 本次调用的参数（补全 Client 未回显的目标信息）。
 * @returns {string} 最终文本。
 */
export function renderToolText(tool, value, maxResultBytes, args) {
  if (!isRecord(value)) {
    return truncateText(`${tool} failed: INTERNAL — 工具返回了非对象结果`, maxResultBytes)
  }
  if (value.ok !== true) {
    const error = isRecord(value.error) ? value.error : {}
    const code = text(error.code) || 'INTERNAL'
    const message = text(error.message) || '未知错误'
    return truncateText(`${tool} failed: ${code} — ${message}`, maxResultBytes)
  }
  return truncateText(renderSuccess(tool, value, isRecord(args) ? args : {}), maxResultBytes)
}

