/**
 * 快照渲染与成本估算（纯函数，无宿主依赖，便于单测）。
 *
 * 为什么放 Host 侧而不是 Client：元素「在不在视口、是不是真的可见」必须在页面里
 * 算，所以 `inViewport`（几何）和隐藏/零尺寸剔除都由 client.js 的
 * `pageAgent.snapshot()` 完成；但**行渲染、视口优先的展示选择、diff、stats 估算**
 * 抽到这里，Host 能完全掌控，且不需要动渲染进程。
 *
 * 成本主线（与 PROTOCOL §6 对应）：
 *   1. 默认不发正文（text=false）——这是最大头，约砍掉默认成本的 ~75%；
 *   2. 隐藏/零尺寸元素由 client 剔除；
 *   3. 视口优先（scope:viewport 默认）——长页面元素数从几十砍到 10–15。
 *
 * 协议 §6 定义两类返回：
 *   - snapshot（全量）：`{ url, title, scope, offscreen, text?, elements, stats }`
 *     （text 仅在 text:true 时存在，否则为 null/不存在）
 *   - delta（增量）：`{ url, title, added, removed, changed, textChanged, textSample?, stats }`
 *
 * 降级兼容：client 没回 `scope` / `inViewport`（旧版或别的前端）时，按 document
 * 渲染，并在 `stats.scope` 标 `document-fallback`，**不报错、不破坏现有行为**。
 *
 * @module dsh-plugin-browser-hands/snapshot
 */

/** 协议 §2.1 列出的 role 取值（仅用于 stats 校验，不影响渲染）。 */
export const ELEMENT_ROLES = Object.freeze([
  'link', 'button', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'option',
  'textarea', 'menuitem', 'tab', 'slider', 'switch', 'heading', 'other',
])

/** 视口外元素在元素表末尾的统一提示文案。 */
export const OFFSCREEN_NOTICE = (count) => `另有 ${count} 个元素在视口外（用 browser_snapshot scope:document 看全部）`

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
 * 数字 → 显示文本（四舍五入；非数字给 0）。
 * @param {unknown} value - 任意值。
 * @returns {string} 文本。
 */
function num(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? String(Math.round(parsed)) : '0'
}

/**
 * 截断字符串。
 * @param {string} value - 原文。
 * @param {number} limit - 字符上限。
 * @returns {string} 截断后的文本。
 */
function clip(value, limit) {
  const source = typeof value === 'string' ? value : ''
  return source.length > limit ? `${source.slice(0, limit)}…` : source
}

/**
 * 单行可交互元素（PROTOCOL §3 / §6 的排版本）。
 * @param {unknown} raw - 快照里的元素。
 * @param {number} index - 序号（用于兜底 ref）。
 * @returns {string} 该行文本。
 */
export function elementLine(raw, index) {
  const element = isRecord(raw) ? raw : {}
  const ref = text(element.ref) || `@e${index + 1}`
  const role = text(element.role) || 'other'
  const name = String(text(element.name)).replace(/\s+/g, ' ').trim()
  let line = `${ref} ${role} "${name}"`
  if (element.checked === true) line += ' checked'
  if (element.disabled === true) line += ' disabled'
  if (typeof element.href === 'string' && element.href !== '') line += ` → ${text(element.href)}`
  if (typeof element.value === 'string' && element.value !== '') line += ` value="${text(element.value)}"`
  return line
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
 * 估算 token 数：CJK 字符按 1.0，其余字符按 4 个算 1 个（粗估，用于成本对比）。
 * @param {string} value - 文本。
 * @returns {number} 估算 token 数（整数）。
 */
export function estimateTokens(value) {
  const str = String(value ?? '')
  let cjk = 0
  let other = 0
  for (const char of str) {
    if (char.charCodeAt(0) > 0x2e80 || /[　-鿿]/.test(char)) cjk += 1
    else other += 1
  }
  return Math.ceil(cjk + other / 4)
}

/**
 * 一条快照的 stats：元素数、字符数、估算 token 数。
 *
 * 正文默认不发，所以默认 chars/estTokens 只算元素行本身，不清算正文——这样 stats
 * 如实反映「默认模式」的成本。传入 `extraChars` 可把正文（仅 text:true 时）一并计入。
 *
 * @param {object} input - 计算依据。
 * @param {string} input.elementText - 元素行拼起来的文本（始终计入）。
 * @param {number} input.elementCount - 元素数。
 * @param {string} input.scope - 实际生效的 scope（已做降级判断）。
 * @param {string} [input.extraChars=''] - 额外计入的字符（正文等，仅 text:true）。
 * @returns {{ elements: number, chars: number, estTokens: number, scope: string }} stats。
 */
export function snapshotStats({ elementText, elementCount, scope, extraChars = '' }) {
  const chars = byteLength(String(elementText ?? '')) + byteLength(String(extraChars ?? ''))
  const estTokens = estimateTokens(String(elementText ?? '')) + estimateTokens(String(extraChars ?? ''))
  return {
    elements: elementCount,
    chars,
    estTokens,
    scope: scope === 'document' ? 'document' : scope === 'document-fallback' ? 'document-fallback' : 'viewport',
  }
}

/**
 * 把原始快照（client 返回）整理成协议 §6 的全量 snapshot 展示块。
 *
 * 视口优先：`scope==='viewport'` 且元素带 `inViewport` 时，只列视口内元素；
 * 视口外元素在末尾用 `OFFSCREEN_NOTICE` 一行提示（不逐个列出）。
 * client 没回 `scope`/`inViewport` → 降级 document，并标 `document-fallback`。
 * text 默认不发（null/不存在），仅当 client 真的回了 `text` 才计入。
 *
 * @param {unknown} raw - client 的 snapshot 对象。
 * @returns {{ ok: true, scope: string, offscreen: number, lines: string[], stats: object, hasText: boolean }} 渲染结果。
 */
export function renderFullSnapshot(raw) {
  const snapshot = isRecord(raw) ? raw : {}
  const requestedScope = text(snapshot.scope)
  const clientProvidesGeom = Array.isArray(snapshot.elements)
    && snapshot.elements.some((el) => isRecord(el) && typeof el.inViewport === 'boolean')
  const effectiveScope = requestedScope === 'document'
    ? 'document'
    : clientProvidesGeom
      ? 'viewport'
      : 'document-fallback'

  const elements = Array.isArray(snapshot.elements) ? snapshot.elements : []
  const visible = []
  // 视口外元素由 client 汇总成 `offscreen` 计数（不在 elements 数组里逐个列出）。
  // 若个别元素仍带 `inViewport:false`（罕见/旧版），一并计入，且不放进可见表。
  let scopeOffscreen = effectiveScope === 'viewport' && Number.isFinite(Number(snapshot.offscreen))
    ? Number(snapshot.offscreen)
    : 0
  for (const element of elements) {
    if (isRecord(element) && element.inViewport === false) {
      if (effectiveScope === 'viewport') {
        scopeOffscreen += 1
        continue
      }
      // document scope：用户明确要「看全部」，视口外的也照样列。
      visible.push(element)
      continue
    }
    visible.push(element)
  }

  const lines = []
  for (let index = 0; index < visible.length; index += 1) lines.push(elementLine(visible[index], index))
  if (effectiveScope === 'viewport' && scopeOffscreen > 0) lines.push(OFFSCREEN_NOTICE(scopeOffscreen))
  // 跨源 iframe 的内容读不到（浏览器安全边界，不是本插件的选择），如实告诉模型别白找。
  const frames = isRecord(snapshot.frames) ? snapshot.frames : null
  if (frames !== null && Number(frames.crossOrigin) > 0) {
    lines.push(`(${Number(frames.crossOrigin)} 个跨源 iframe 的内容不可见：需要在该站点内直接操作，或改用截图判断)`)
  }
  // 不可读但可点的区域（跨源 iframe / canvas）：给矩形，模型可用坐标点或截图判断。
  const opaque = Array.isArray(snapshot.opaque) ? snapshot.opaque : []
  if (opaque.length > 0) {
    lines.push('--- 不可读区域（可用 browser_click x/y 点，或截图看）---')
    for (const raw of opaque.slice(0, 10)) {
      const item = isRecord(raw) ? raw : {}
      const kind = text(item.kind) || 'region'
      const name = text(item.name)
      lines.push(`${kind} ${num(item.width)}×${num(item.height)} @ (${num(item.x)}, ${num(item.y)})${name !== '' ? ` "${clip(name, 40)}"` : ''}`)
    }
  }

  // 正文按需：只有 client 真的回了非空 text（模型传 text:true）才展示与计费。
  const body = typeof snapshot.text === 'string' && snapshot.text !== '' ? snapshot.text : null
  if (body !== null) {
    lines.push('--- 页面文本 ---')
    lines.push(body)
  }
  // body 已经拼进 lines，stats 只从 lines 计一次（extraChars 不再重复加，避免虚高一倍）。
  const stats = snapshotStats({
    elementText: lines.join('\n'),
    elementCount: visible.length,
    scope: effectiveScope,
  })
  return {
    ok: true,
    scope: effectiveScope,
    offscreen: scopeOffscreen,
    lines,
    stats,
    hasText: body !== null,
  }
}

/**
 * 计算两帧之间的元素 diff（语义与全量快照一致：ref 由 client 提供，天然同一套）。
 * @param {unknown} beforeRaw - 上一帧全量快照。
 * @param {unknown} afterRaw - 当前帧全量快照。
 * @returns {{ added: string[], removed: string[], changed: string[] }} 增量行。
 */
export function diffSnapshots(beforeRaw, afterRaw) {
  const before = isRecord(beforeRaw) ? beforeRaw : {}
  const after = isRecord(afterRaw) ? afterRaw : {}
  const beforeElements = Array.isArray(before.elements) ? before.elements : []
  const afterElements = Array.isArray(after.elements) ? after.elements : []

  /** @type {Map<string, object>} */
  const beforeById = new Map()
  for (const element of beforeElements) {
    if (isRecord(element) && typeof element.ref === 'string') beforeById.set(element.ref, element)
  }
  const afterById = new Map()
  for (const element of afterElements) {
    if (isRecord(element) && typeof element.ref === 'string') afterById.set(element.ref, element)
  }

  const added = []
  const removed = []
  const changed = []
  for (const [ref, element] of afterById) {
    if (!beforeById.has(ref)) added.push(elementLine(element, afterElements.indexOf(element)))
  }
  for (const ref of beforeById.keys()) {
    if (!afterById.has(ref)) removed.push(ref)
  }
  for (const [ref, element] of afterById) {
    const previous = beforeById.get(ref)
    if (previous === undefined) continue
    const beforeLine = elementLine(previous, beforeElements.indexOf(previous))
    const afterLine = elementLine(element, afterElements.indexOf(element))
    if (beforeLine !== afterLine) changed.push(afterLine)
  }
  return { added, removed, changed }
}

/**
 * 渲染动作后的增量结果（协议 §6 的 delta）。
 *
 * 触发全量降级的情形（都由调用方判断后传入 `forceFull`）：
 *   - URL 变了（新页面，模型本来就要全量）；
 *   - 首帧 / HMR 后 / 找不到上一帧。
 *
 * @param {object} options - 入参。
 * @param {unknown} beforeRaw - 上一帧全量快照（可空）。
 * @param {unknown} afterRaw - 当前帧全量快照。
 * @param {boolean} forceFull - 是否强制全量（由调用方按上述情形决定）。
 * @param {number} [textSampleLimit=200] - `textSample` 的字符上限。
 * @returns {{ lines: string[], stats: object, full: boolean }} 渲染结果。
 */
export function renderDelta({ beforeRaw, afterRaw, forceFull, textSampleLimit = 200 }) {
  const after = isRecord(afterRaw) ? afterRaw : {}
  const before = isRecord(beforeRaw) ? beforeRaw : {}
  const beforeText = typeof before.text === 'string' ? before.text : ''
  const afterText = typeof after.text === 'string' ? after.text : ''
  const textChanged = afterText !== beforeText

  // 全量降级：直接走全量渲染（ref 语义完全一致）。
  if (forceFull || beforeRaw === undefined || beforeRaw === null) {
    const full = renderFullSnapshot(afterRaw)
    return { lines: full.lines, stats: full.stats, full: true }
  }

  const { added, removed, changed } = diffSnapshots(beforeRaw, afterRaw)
  const lines = []
  const beforeTitle = typeof before.title === 'string' ? before.title : ''
  const afterTitle = typeof after.title === 'string' ? after.title : ''
  if (beforeTitle !== afterTitle) lines.push(`title changed: "${afterTitle}"`)
  if (beforeText !== '' || afterText !== '') {
    lines.push(`text changed: ${textChanged}`)
    if (textChanged) {
      const sample = afterText.length > textSampleLimit ? `${afterText.slice(0, textSampleLimit)}…` : afterText
      lines.push(`textSample: ${sample}`)
    }
  }
  if (added.length > 0) {
    lines.push(`added (${added.length}):`)
    lines.push(...added.map((line) => `  + ${line}`))
  }
  if (removed.length > 0) {
    lines.push(`removed (${removed.length}): ${removed.join(' ')}`)
  }
  if (changed.length > 0) {
    lines.push(`changed (${changed.length}):`)
    lines.push(...changed.map((line) => `  ~ ${line}`))
  }
  if (lines.length === 0) lines.push('no visible change')

  const afterFull = renderFullSnapshot(afterRaw)
  // stats 要如实反映「这次真正发给模型的增量」，而不是整页元素的规模。
  const deltaText = lines.join('\n')
  return {
    lines,
    stats: {
      ...snapshotStats({
        elementText: deltaText,
        elementCount: added.length + changed.length,
        scope: afterFull.scope,
      }),
      added: added.length,
      removed: removed.length,
      changed: changed.length,
      textChanged,
      totalElements: afterFull.stats.elements,
      full: false,
    },
    full: false,
  }
}

/**
 * 把渲染块（全量或增量）排版成工具返回值里的快照文本。
 * @param {string} tool - 工具名。
 * @param {string} url - 页面 URL。
 * @param {string} title - 页面标题。
 * @param {string[]} lines - 渲染行（元素表/增量）。
 * @param {object} stats - stats 对象。
 * @param {boolean} full - 是否全量。
 * @returns {string} 多行文本。
 */
export function formatSnapshotText({ tool, url, title, lines, stats, full }) {
  const header = `${title || '(no title)'} · ${url || '(about:blank)'}${full ? '' : ' [delta]'}`
  const body = lines.length > 0 ? lines.join('\n') : '(空)'
  let statLine = `stats: ${stats.elements} elements, ${stats.chars} chars, ~${stats.estTokens} tokens (scope=${stats.scope})`
  if (full === false && typeof stats.added === 'number') {
    statLine += ` +${stats.added} -${stats.removed} ~${stats.changed}`
    if (stats.textChanged === true) statLine += ' textChanged'
    if (typeof stats.totalElements === 'number') statLine += ` total=${stats.totalElements}`
  }
  return [header, '---', body, statLine].join('\n')
}

