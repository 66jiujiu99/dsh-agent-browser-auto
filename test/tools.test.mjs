/**
 * tools.js / render.js 的工具层回归测试（node --test）。
 *
 * 用假 bridge 捕获下发的 op/args，验证：
 *   - 快照类工具默认 `scope:viewport`、不带正文；
 *   - `browser_snapshot` 的 text/scope 显式 opt-in；
 *   - 动作类工具默认回快照（scope:viewport）、`snapshot:false` 被尊重；
 *   - 动作后默认回**全量视口结构**；`delta:true` 且同 URL 才走 `[delta]`，
 *     URL 变化 / 口径不一致时 delta 也降级回全量；
 *   - `browser_type` 的 `text`（输入内容）不被快照参数覆盖。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildBrowserTools } from '../lib/tools.js'
import { BridgeError } from '../lib/bridge.js'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
    sendCommand: async (sessionId, op, args, timeoutMs) => {
      if (calls !== undefined) calls.push({ sessionId, op, args, timeoutMs })
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

test('19 个工具都注册且 schema 只用受支持关键字', () => {
  const tools = buildBrowserTools(makeDeps([frameA]))
  assert.equal(tools.length, 19)
  const names = tools.map((t) => t.name)
  for (const required of ['browser_open', 'browser_snapshot', 'browser_wait', 'browser_click', 'browser_select', 'browser_upload', 'browser_dialog', 'browser_nav', 'browser_close']) {
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

test('browser_wait 恰好一个条件，默认等待 10 秒并回视口', async () => {
  const calls = []
  const tools = toolset(makeDeps([frameA], calls))
  const text = await run(tools.browser_wait, { text: '提交成功' }, 's-wait-text')
  assert.deepEqual(calls[0].args, {
    snapshot: true, scope: 'viewport', text: '提交成功', timeoutMs: 10000, state: 'visible',
  })
  assert.equal(calls[0].timeoutMs, 15000)
  assert.ok(text.includes('wait text "提交成功" → matched'), text)
  assert.ok(text.includes('@e1'), text)

  calls.length = 0
  await run(tools.browser_wait, { selector: '#loading', state: 'hidden', timeoutMs: 5000, snapshot: false }, 's-wait-hidden')
  assert.deepEqual(calls[0].args, { snapshot: false, selector: '#loading', timeoutMs: 5000, state: 'hidden' })
  assert.equal(calls[0].timeoutMs, 10000)

  calls.length = 0
  await run(tools.browser_wait, { url: '/result' }, 's-wait-url')
  assert.deepEqual(calls[0].args, { snapshot: true, scope: 'viewport', url: '/result', timeoutMs: 10000 })

  calls.length = 0
  const invalid = await run(tools.browser_wait, { text: '完成', selector: '#done' }, 's-wait-invalid')
  assert.ok(invalid.includes('BAD_ARGUMENTS'), invalid)
  assert.equal(calls.length, 0)
})

test('browser_select 恰好一个选择条件并回视口', async () => {
  const calls = []
  const tools = toolset(makeDeps([frameA], calls))
  await run(tools.browser_select, { ref: '@e7', label: '四川' }, 's-select-label')
  assert.deepEqual(calls[0].args, { ref: '@e7', snapshot: true, scope: 'viewport', label: '四川' })

  calls.length = 0
  await run(tools.browser_select, { ref: '@e7', value: '', snapshot: false }, 's-select-value')
  assert.deepEqual(calls[0].args, { ref: '@e7', snapshot: false, value: '' })

  calls.length = 0
  const invalid = await run(tools.browser_select, { ref: '@e7', label: '四川', index: 1 }, 's-select-invalid')
  assert.ok(invalid.includes('BAD_ARGUMENTS'), invalid)
  assert.equal(calls.length, 0)
})

test('browser_upload 读取绝对路径并只下发文件名、MIME 与 base64', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'browser-upload-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'proof.txt')
  await writeFile(path, 'upload-content', 'utf8')
  const calls = []
  const deps = makeDeps([frameA], calls)
  const audits = []
  deps.audit.audit = (entry) => audits.push(entry)
  const tools = toolset(deps)
  await run(tools.browser_upload, { ref: '@e8', paths: [path] }, 's-upload-file')
  assert.equal(calls[0].op, 'upload')
  assert.deepEqual(calls[0].args.files, [{
    name: 'proof.txt', type: 'text/plain', base64: Buffer.from('upload-content').toString('base64'),
  }])
  assert.equal(calls[0].args.scope, 'viewport')
  assert.equal(audits.length, 1)
  assert.deepEqual(audits[0].args.paths, '[object]')
  assert.ok(!JSON.stringify(audits).includes('upload-content'))
  assert.ok(!JSON.stringify(audits).includes(Buffer.from('upload-content').toString('base64')))

  calls.length = 0
  const invalid = await run(tools.browser_upload, { ref: '@e8', paths: ['relative.txt'] }, 's-upload-relative')
  assert.ok(invalid.includes('BAD_ARGUMENTS'), invalid)
  assert.equal(calls.length, 0)
})

test('browser_dialog 预置一次性响应并校验 promptText', async () => {
  const calls = []
  const tools = toolset(makeDeps([frameA], calls))
  const text = await run(tools.browser_dialog, { action: 'accept', promptText: '张' }, 's-dialog-accept')
  assert.deepEqual(calls[0].args, { action: 'accept', promptText: '张' })
  assert.ok(text.includes('dialog accept armed'), text)

  calls.length = 0
  const invalid = await run(tools.browser_dialog, { action: 'dismiss', promptText: '不应携带' }, 's-dialog-invalid')
  assert.ok(invalid.includes('BAD_ARGUMENTS'), invalid)
  assert.equal(calls.length, 0)
})

test('NO_REF 失败自动补现场视口；snapshot:false 时不补拍', async () => {
  const calls = []
  const deps = makeDeps([frameA], calls)
  const snapshotCommand = deps.bridge.sendCommand
  deps.bridge.sendCommand = async (sessionId, op, args, timeoutMs) => {
    if (op === 'click') {
      calls.push({ sessionId, op, args, timeoutMs })
      throw new BridgeError('NO_REF', '元素 @e9 已失效', 'c-1')
    }
    return snapshotCommand(sessionId, op, args, timeoutMs)
  }
  const tools = toolset(deps)
  const text = await run(tools.browser_click, { ref: '@e9' }, 's-failure-scene')
  assert.ok(text.includes('browser_click failed: NO_REF'), text)
  assert.ok(text.includes('@e1 link "首页"'), text)
  assert.deepEqual(calls.map((call) => call.op), ['click', 'snapshot'])

  calls.length = 0
  const withoutSnapshot = await run(tools.browser_click, { ref: '@e9', snapshot: false }, 's-failure-no-scene')
  assert.ok(withoutSnapshot.includes('NO_REF'), withoutSnapshot)
  assert.ok(!withoutSnapshot.includes('@e1'), withoutSnapshot)
  assert.deepEqual(calls.map((call) => call.op), ['click'])
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

test('同 URL 动作默认回全量视口：新旧元素都在，模型无需再调 browser_snapshot', async () => {
  const after = {
    url: 'https://e.com/', title: '例', scope: 'viewport',
    elements: [
      { ref: '@e1', role: 'link', name: '首页', href: 'https://e.com/', inViewport: true },
      { ref: '@e9', role: 'button', name: '退出', inViewport: true },
    ],
  }
  const tools = toolset(makeDeps([frameA, after]))
  const session = 's-full-default'
  await run(tools.browser_open, { url: 'https://e.com/' }, session)
  const text = await run(tools.browser_click, { ref: '@e2' }, session)
  assert.ok(!text.includes('[delta]'), text)
  assert.ok(text.includes('click @e2'), text)
  assert.ok(text.includes('@e1'), text)
  assert.ok(text.includes('@e9'), text)
})

test('delta:true 时同 URL 动作走 [delta]：added/removed 出现，不再整页重发', async () => {
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
  const text = await run(tools.browser_click, { ref: '@e2', delta: true }, session)
  assert.ok(text.includes('[delta]'), text)
  assert.ok(text.includes('+ @e9 button "退出"'), text)
  assert.ok(text.includes('removed (1): @e2'), text)
  assert.ok(text.includes('+1 -1'), text)
})

test('delta:true 但 URL 变化时回全量（不带 [delta]）', async () => {
  const next = {
    url: 'https://e.com/next', title: '下一页', scope: 'viewport',
    elements: [{ ref: '@e1', role: 'link', name: '返回', href: 'https://e.com/', inViewport: true }],
  }
  const tools = toolset(makeDeps([frameA, next]))
  const session = 's-delta-url'
  await run(tools.browser_open, { url: 'https://e.com/' }, session)
  const text = await run(tools.browser_click, { ref: '@e2', delta: true }, session)
  assert.ok(!text.includes('[delta]'), text)
  assert.ok(text.includes('下一页'), text)
})

test('delta:true 但 scope 口径不一致时回全量（不产生误导性 diff）', async () => {
  const tools = toolset(makeDeps([frameA]))
  const session = 's-delta-scope'
  await run(tools.browser_open, { url: 'https://e.com/', scope: 'document' }, session)
  const text = await run(tools.browser_click, { ref: '@e2', delta: true }, session)
  assert.ok(!text.includes('[delta]'), text)
})

test('delta:true 的 stats 按增量文本计，且带 total/计数', async () => {
  const after = {
    url: 'https://e.com/', title: '例', scope: 'viewport',
    elements: [{ ref: '@e1', role: 'link', name: '首页', href: 'https://e.com/', inViewport: true }],
  }
  const tools = toolset(makeDeps([frameA, after]))
  const session = 's-delta-stats'
  await run(tools.browser_open, { url: 'https://e.com/' }, session)
  const text = await run(tools.browser_click, { ref: '@e2', delta: true }, session)
  assert.ok(text.includes('[delta]'), text)
  assert.ok(/\+\d+ -\d+ ~\d+/.test(text), text)
  assert.ok(/total=\d+/.test(text), text)
  const tokens = Number((text.match(/~(\d+) tokens/) ?? [])[1])
  assert.ok(Number.isFinite(tokens) && tokens < 100, `delta tokens=${tokens}`)
})

test('browser_tabs 在最后一个标签关闭后允许 activeId=null', async () => {
  const deps = makeDeps([frameA])
  deps.bridge.sendCommand = async () => ({
    clientId: 'c-1',
    value: { ok: true, tabs: [], activeId: null },
  })
  const tools = toolset(deps)
  assert.deepEqual(tools.browser_tabs.output.schema.properties.activeId.type, ['string', 'null'])
  const value = await tools.browser_tabs.execute({ action: 'list' }, { agent: { id: 's-tabs-empty' } })
  assert.equal(value.ok, true)
  assert.equal(value.activeId, null)
  assert.deepEqual(value.tabs, [])
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
