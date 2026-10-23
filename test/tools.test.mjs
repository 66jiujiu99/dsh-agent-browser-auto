/**
 * tools.js / render.js 的工具层回归测试（node --test）。
 *
 * 用假 bridge 捕获下发的 op/args，验证：
 *   - 快照类工具默认 `scope:viewport`、不带正文；
 *   - `browser_snapshot` 的 text/scope 显式 opt-in；
 *   - 动作类工具默认回快照（scope:viewport）、`snapshot:false` 被尊重；
 *   - 同 URL 动作走 `[delta]`，URL 变化 / 口径不一致回全量；
 *   - `browser_type` 的 `text`（输入内容）不被快照参数覆盖。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildBrowserTools } from '../lib/tools.js'
import { BridgeError } from '../lib/bridge.js'

const BASE_CONFIG = {
  enableEval: false,
  maxResultBytes: 12000,
  commandTimeoutMs: 1000,
  deepMode: { enabled: false, portFile: '', endpoint: '', maxNodes: 200, timeoutMs: 8000 },
}

/**
 * 造一套依赖；`frames` 依次作为每次 sendCommand 的快照返回值。
 * @param {Array<object>} frames - 快照序列（用完后重复最后一帧）。
 * @param {string[]} [calls] - 收集下发的 op/args。
 * @returns {object} deps。
 */
function makeDeps(frames, calls) {
  let index = 0
  const bridge = {
    knownUrl: () => undefined,
    sendCommand: async (sessionId, op, args) => {
      if (calls !== undefined) calls.push({ sessionId, op, args })
      const frame = frames[Math.min(index, frames.length - 1)]
      index += 1
      // 模拟 client：快照的 scope 跟随下发的 args.scope（默认 viewport）。
      const snapshot = { ...frame, scope: args?.scope === 'document' ? 'document' : (frame.scope ?? 'viewport') }
      return { clientId: 'c-1', value: { ok: true, changed: true, action: op, snapshot } }
    },
  }
  const navigator = { checkUrl: (url) => ({ ok: true, href: String(url) }) }
  return { config: BASE_CONFIG, bridge, audit: { audit() {} }, navigator }
}

/**
 * 建工具表。
 * @param {object} deps - 依赖。
 * @returns {Record<string, object>} name → tool。
 */
function toolset(deps) {
  return Object.fromEntries(buildBrowserTools(deps).map((tool) => [tool.name, tool]))
}

/**
 * 执行并渲染，返回模型可见文本。
 * @param {object} tool - 工具定义。
 * @param {object} args - 参数。
 * @param {string} sessionId - 会话 id（不同用例用不同 id，避免上一帧缓存串味）。
 * @returns {Promise<string>} 渲染文本。
 */
async function run(tool, args, sessionId) {
  const value = await tool.execute(args, { agent: { id: sessionId } })
  return tool.output.render(args, value).map((part) => part.text).join('')
}

const frameA = {
  url: 'https://e.com/', title: '例', scope: 'viewport', offscreen: 2,
  elements: [
    { ref: '@e1', role: 'link', name: '首页', href: 'https://e.com/', inViewport: true },
    { ref: '@e2', role: 'button', name: '登录', inViewport: true },
  ],
}

test('15 个工具都注册且 schema 只用受支持关键字', () => {
  const tools = buildBrowserTools(makeDeps([frameA]))
  assert.equal(tools.length, 15)
  const names = tools.map((t) => t.name)
  for (const required of ['browser_open', 'browser_snapshot', 'browser_click', 'browser_nav', 'browser_close']) {
    assert.ok(names.includes(required), `缺少 ${required}`)
  }
  const allowed = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'description', 'title', 'default', 'examples'])
  const walk = (node, path) => {
    for (const key of Object.keys(node)) assert.ok(allowed.has(key), `${path}.${key} 不受支持`)
    if (node.properties) for (const [k, v] of Object.entries(node.properties)) walk(v, `${path}.properties.${k}`)
    if (node.items) walk(node.items, `${path}.items`)
  }
  for (const tool of tools) {
    walk(tool.parameters, `${tool.name}.parameters`)
    walk(tool.output.schema, `${tool.name}.output`)
  }
})

test('browser_snapshot 默认不带正文/视口；显式 text+document 才转发', async () => {
  const calls = []
  const tools = toolset(makeDeps([frameA], calls))
  await run(tools.browser_snapshot, {}, 's-snap-default')
  assert.deepEqual(calls[0].args, {})

  calls.length = 0
  await run(tools.browser_snapshot, { text: true, scope: 'document' }, 's-snap-optin')
  assert.deepEqual(calls[0].args, { text: true, scope: 'document' })
})

test('browser_open 默认 scope:viewport，可显式 document', async () => {
  const calls = []
  const tools = toolset(makeDeps([frameA], calls))
  await run(tools.browser_open, { url: 'https://e.com/' }, 's-open-default')
  assert.deepEqual(calls[0].args, { url: 'https://e.com/', scope: 'viewport' })

  calls.length = 0
  await run(tools.browser_open, { url: 'https://e.com/', scope: 'document' }, 's-open-doc')
  assert.deepEqual(calls[0].args, { url: 'https://e.com/', scope: 'document' })
})

test('动作类工具默认 {snapshot:true, scope:viewport}，snapshot:false 被尊重', async () => {
  const calls = []
  const tools = toolset(makeDeps([frameA], calls))
  await run(tools.browser_click, { ref: '@e1' }, 's-action-default')
  assert.deepEqual(calls[0].args, { snapshot: true, scope: 'viewport', ref: '@e1' })

  calls.length = 0
  await run(tools.browser_click, { ref: '@e1', snapshot: false }, 's-action-off')
  assert.deepEqual(calls[0].args, { snapshot: false, ref: '@e1' })
})

test('browser_type 的 text（输入内容）不被快照参数覆盖', async () => {
  const calls = []
  const tools = toolset(makeDeps([frameA], calls))
  await run(tools.browser_type, { ref: '@e2', text: '你好' }, 's-type-text')
  assert.equal(calls[0].args.text, '你好')
  assert.equal(calls[0].args.snapshot, true)
  assert.equal(calls[0].args.scope, 'viewport')
})

test('同 URL 动作走 [delta]：added/removed 出现，不再整页重发', async () => {
  const after = {
    url: 'https://e.com/', title: '例', scope: 'viewport',
    elements: [
      { ref: '@e1', role: 'link', name: '首页', href: 'https://e.com/', inViewport: true },
      { ref: '@e9', role: 'button', name: '退出', inViewport: true },
    ],
  }
  const tools = toolset(makeDeps([frameA, after]))
  const session = 's-delta-same'
  await run(tools.browser_open, { url: 'https://e.com/' }, session)
  const text = await run(tools.browser_click, { ref: '@e2' }, session)
  assert.ok(text.includes('[delta]'), text)
  assert.ok(text.includes('+ @e9 button "退出"'), text)
  assert.ok(text.includes('removed (1): @e2'), text)
  assert.ok(text.includes('+1 -1'), text)
})

test('URL 变化时回全量（不带 [delta]）', async () => {
  const next = {
    url: 'https://e.com/next', title: '下一页', scope: 'viewport',
    elements: [{ ref: '@e1', role: 'link', name: '返回', href: 'https://e.com/', inViewport: true }],
  }
  const tools = toolset(makeDeps([frameA, next]))
  const session = 's-delta-url'
  await run(tools.browser_open, { url: 'https://e.com/' }, session)
  const text = await run(tools.browser_click, { ref: '@e2' }, session)
  assert.ok(!text.includes('[delta]'), text)
  assert.ok(text.includes('下一页'), text)
})

test('scope 口径不一致时回全量（不产生误导性 diff）', async () => {
  const tools = toolset(makeDeps([frameA]))
  const session = 's-delta-scope'
  await run(tools.browser_open, { url: 'https://e.com/', scope: 'document' }, session)
  const text = await run(tools.browser_click, { ref: '@e2' }, session)
  assert.ok(!text.includes('[delta]'), text)
})

test('delta 的 stats 按增量文本计，且带 total/计数', async () => {
  const after = {
    url: 'https://e.com/', title: '例', scope: 'viewport',
    elements: [{ ref: '@e1', role: 'link', name: '首页', href: 'https://e.com/', inViewport: true }],
  }
  const tools = toolset(makeDeps([frameA, after]))
  const session = 's-delta-stats'
  await run(tools.browser_open, { url: 'https://e.com/' }, session)
  const text = await run(tools.browser_click, { ref: '@e2' }, session)
  assert.ok(text.includes('[delta]'), text)
  assert.ok(/\+\d+ -\d+ ~\d+/.test(text), text)
  assert.ok(/total=\d+/.test(text), text)
  const tokens = Number((text.match(/~(\d+) tokens/) ?? [])[1])
  assert.ok(Number.isFinite(tokens) && tokens < 100, `delta tokens=${tokens}`)
})

test('失败结果渲染成一行可读错误', async () => {
  const deps = makeDeps([frameA])
  deps.bridge.sendCommand = async () => {
    throw new BridgeError('NO_CLIENT', '没有客户端连着该会话')
  }
  const tools = toolset(deps)
  const text = await run(tools.browser_snapshot, {}, 's-fail')
  assert.ok(text.includes('browser_snapshot failed: NO_CLIENT'), text)
})
