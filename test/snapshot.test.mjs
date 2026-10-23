/**
 * snapshot.js 纯函数单测（node --test）。
 * 覆盖：视口过滤、document 降级、视口外提示、text 开关、stats estTokens、delta 全量/增量。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  elementLine,
  estimateTokens,
  byteLength,
  snapshotStats,
  renderFullSnapshot,
  diffSnapshots,
  renderDelta,
  formatSnapshotText,
  OFFSCREEN_NOTICE,
} from '../lib/snapshot.js'

const viewportSnapshot = {
  url: 'https://example.com/',
  title: '例',
  scope: 'viewport',
  offscreen: 2,
  elements: [
    { ref: '@e1', role: 'link', name: '首页', href: 'https://example.com/', inViewport: true },
    { ref: '@e2', role: 'button', name: '登录', inViewport: true },
    { ref: '@e3', role: 'link', name: '隐藏', href: 'https://example.com/x', inViewport: false },
  ],
}

test('elementLine 渲染基本形态', () => {
  assert.equal(elementLine({ ref: '@e1', role: 'link', name: '首页', href: 'https://e.com/' }, 0), '@e1 link "首页" → https://e.com/')
  assert.equal(elementLine({ role: 'button', name: '登录' }, 4), '@e5 button "登录"')
  assert.equal(elementLine({ ref: '@e2', role: 'checkbox', name: '记住', checked: true, disabled: true }, 1), '@e2 checkbox "记住" checked disabled')
})

test('byteLength / estimateTokens CJK 与非 CJK', () => {
  assert.equal(byteLength('abc'), 3)
  assert.equal(estimateTokens('abcd'), 1) // 4 个非 CJK 算 1 token
  const cjk = '中文测试'
  assert.ok(estimateTokens(cjk) >= cjk.length) // CJK 每个算 1
})

test('renderFullSnapshot 默认视口过滤 + 视口外提示', () => {
  const out = renderFullSnapshot(viewportSnapshot)
  assert.equal(out.scope, 'viewport')
  assert.equal(out.offscreen, 3) // client 汇总的 2 个 + 元素里标了 inViewport:false 的 1 个
  assert.equal(out.lines.length, 3) // 2 个可见 + 1 行提示
  assert.equal(out.lines[0], '@e1 link "首页" → https://example.com/')
  assert.equal(out.lines[1], '@e2 button "登录"')
  assert.equal(out.lines[2], OFFSCREEN_NOTICE(3))
  assert.equal(out.hasText, false) // 默认无 text
})

test('renderFullSnapshot text:true 渲染并计入', () => {
  const out = renderFullSnapshot({ ...viewportSnapshot, text: '这是正文内容' })
  assert.equal(out.hasText, true)
  assert.ok(out.lines.includes('这是正文内容'))
  assert.ok(out.lines.includes('--- 页面文本 ---'))
  assert.ok(out.stats.chars >= byteLength('这是正文内容'))
  assert.ok(out.stats.estTokens > 0)
})

test('renderFullSnapshot text:false 不渲染正文', () => {
  const out = renderFullSnapshot(viewportSnapshot)
  assert.equal(out.hasText, false)
  assert.ok(!out.lines.includes('--- 页面文本 ---'))
  // 不因正文缺席而虚增成本：chars 只来自元素行。
  assert.equal(out.stats.chars, byteLength(out.lines.join('\n')))
})

test('renderFullSnapshot scope:document 列出全部', () => {
  const out = renderFullSnapshot({ ...viewportSnapshot, scope: 'document' })
  assert.equal(out.scope, 'document')
  assert.equal(out.lines.length, 3) // 3 个元素，无提示
  assert.equal(out.offscreen, 0)
  assert.ok(!out.lines.some((l) => l.startsWith('另有')))
})

test('renderFullSnapshot 降级 document-fallback（无 geom）', () => {
  const fallback = {
    url: 'https://e.com/',
    title: 't',
    elements: [
      { ref: '@e1', role: 'link', name: 'a' },
      { ref: '@e2', role: 'link', name: 'b' },
    ],
  }
  const out = renderFullSnapshot(fallback)
  assert.equal(out.scope, 'document-fallback')
  assert.equal(out.lines.length, 2)
  assert.equal(out.offscreen, 0)
})

test('snapshotStats 字段与 scope 归一', () => {
  const s = snapshotStats({ elementText: 'x'.repeat(8), elementCount: 3, scope: 'viewport' })
  assert.deepEqual(s, { elements: 3, chars: byteLength('x'.repeat(8)), estTokens: estimateTokens('x'.repeat(8)), scope: 'viewport' })
  assert.equal(snapshotStats({ elementText: '', elementCount: 0, scope: 'document-fallback' }).scope, 'document-fallback')
})

test('diffSnapshots 增/删/改', () => {
  const before = {
    elements: [
      { ref: '@e1', role: 'link', name: 'a' },
      { ref: '@e2', role: 'button', name: '旧' },
      { ref: '@e3', role: 'link', name: '删除' },
    ],
  }
  const after = {
    elements: [
      { ref: '@e1', role: 'link', name: 'a' },
      { ref: '@e2', role: 'button', name: '新' },
      { ref: '@e4', role: 'link', name: '新增' },
    ],
  }
  const { added, removed, changed } = diffSnapshots(before, after)
  assert.deepEqual(added, ['@e4 link "新增"'])
  assert.deepEqual(removed, ['@e3'])
  assert.deepEqual(changed, ['@e2 button "新"'])
})

test('renderDelta 增量', () => {
  const before = viewportSnapshot
  const after = {
    ...viewportSnapshot,
    elements: [
      { ref: '@e1', role: 'link', name: '首页', href: 'https://example.com/', inViewport: true },
      { ref: '@e2', role: 'button', name: '退出', inViewport: true },
    ],
  }
  const out = renderDelta({ beforeRaw: before, afterRaw: after, forceFull: false })
  assert.equal(out.full, false)
  assert.ok(out.lines.some((l) => l.startsWith('changed')))
  assert.ok(out.stats.changed >= 1)
  assert.equal(out.stats.full, false)
})

test('renderDelta 无变化', () => {
  const out = renderDelta({ beforeRaw: viewportSnapshot, afterRaw: viewportSnapshot, forceFull: false })
  assert.equal(out.full, false)
  assert.ok(out.lines.includes('no visible change'))
})

test('renderDelta forceFull 走全量', () => {
  const out = renderDelta({ beforeRaw: viewportSnapshot, afterRaw: viewportSnapshot, forceFull: true })
  assert.equal(out.full, true)
  assert.equal(out.lines.length, 3)
})

test('renderDelta 首帧（无 before）走全量', () => {
  const out = renderDelta({ beforeRaw: undefined, afterRaw: viewportSnapshot, forceFull: false })
  assert.equal(out.full, true)
})

test('renderDelta textChanged 采样', () => {
  const before = { text: '旧文本' }
  const after = { text: '新文本'.repeat(60) }
  const out = renderDelta({ beforeRaw: before, afterRaw: after, forceFull: false, textSampleLimit: 20 })
  assert.ok(out.lines.some((l) => l.startsWith('text changed: true')))
  assert.ok(out.lines.some((l) => l.startsWith('textSample:') && l.endsWith('…')))
})

test('formatSnapshotText 排版', () => {
  const text2 = formatSnapshotText({
    tool: 'browser_snapshot',
    url: 'https://e.com/',
    title: '标题',
    lines: ['@e1 link "a"'],
    stats: { elements: 1, chars: 10, estTokens: 2, scope: 'viewport' },
    full: false,
  })
  assert.ok(text2.includes('标题 · https://e.com/ [delta]'))
  assert.ok(text2.includes('stats: 1 elements, 10 chars, ~2 tokens (scope=viewport)'))
})

test('formatSnapshotText 全量不带 [delta]', () => {
  const text2 = formatSnapshotText({
    tool: 'browser_open',
    url: 'https://e.com/',
    title: 'T',
    lines: ['@e1 link "a"'],
    stats: { elements: 1, chars: 10, estTokens: 2, scope: 'viewport' },
    full: true,
  })
  assert.ok(!text2.includes('[delta]'))
})

test('formatSnapshotText delta 附增量计数与 total', () => {
  const text2 = formatSnapshotText({
    tool: 'delta',
    url: 'https://e.com/',
    title: 'T',
    lines: ['added (1):', '  + @e5 button "退出"'],
    stats: {
      elements: 1, chars: 30, estTokens: 8, scope: 'viewport',
      added: 1, removed: 0, changed: 0, textChanged: false, totalElements: 4, full: false,
    },
    full: false,
  })
  assert.ok(text2.includes('[delta]'))
  assert.ok(text2.includes('+1 -0 ~0'))
  assert.ok(text2.includes('total=4'))
  assert.ok(!text2.includes('textChanged'))
})

test('formatSnapshotText delta textChanged 标记', () => {
  const text2 = formatSnapshotText({
    tool: 'delta', url: 'u', title: 't', lines: ['text changed: true'],
    stats: { elements: 0, chars: 10, estTokens: 2, scope: 'viewport', added: 0, removed: 0, changed: 0, textChanged: true, totalElements: 3, full: false },
    full: false,
  })
  assert.ok(text2.includes('textChanged'))
})

test('renderDelta stats 按增量文本计（不虚高成全量）', () => {
  const big = { url: 'u', title: 't', scope: 'viewport', elements: [] }
  for (let i = 0; i < 40; i += 1) big.elements.push({ ref: `@e${i}`, role: 'link', name: `很长的元素名字${i}`.repeat(3), inViewport: true })
  const before = { ...big }
  const after = { ...big, elements: [...big.elements] }
  after.elements.push({ ref: '@e99', role: 'button', name: '新增', inViewport: true })
  const out = renderDelta({ beforeRaw: before, afterRaw: after, forceFull: false })
  assert.equal(out.full, false)
  // 增量文本远小于全量：estTokens 应接近增量行本身，而不是 40 个元素。
  assert.ok(out.stats.estTokens < 100, `estTokens=${out.stats.estTokens}`)
  assert.equal(out.stats.added, 1)
  assert.equal(out.stats.totalElements, 41)
})
