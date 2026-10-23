/**
 * 深度模式（CDP）单测。
 *
 * 覆盖：
 *   - 纯函数：quadToBox / offsetBox / framePathOf / flattenAxTree / matchTarget
 *   - resolveEndpoint：读 DevToolsActivePort、5 秒缓存自愈、文件缺失/内容非法
 *   - discover：假 CDP HTTP 端点；端口不可达
 *   - connect/send：假 WebSocket 端点；错误映射；命令超时；target 消失
 *   - deepSnapshot：假 CDP 全链路（attach → a11y → box）
 *   - 工具层：DEEP_UNAVAILABLE（未启用 / 端口文件缺失）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import {
  CdpError,
  DEEP_HELP,
  clearEndpointCache,
  connect,
  deepSnapshot,
  discover,
  flattenAxTree,
  framePathOf,
  matchTarget,
  mergeAttachedFrame,
  offsetBox,
  quadToBox,
  resolveEndpoint,
  seedChildCount,
} from '../lib/cdp.js'
import { buildBrowserTools } from '../lib/tools.js'

// ---------------------------------------------------------------------------
// 假 CDP 服务端（HTTP /json/* + 手写 WebSocket）
// ---------------------------------------------------------------------------

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/**
 * 编码一帧服务端→客户端文本帧（不掩码）。
 * @param {string} text - 文本。
 * @returns {Buffer} 帧。
 */
function encodeServerFrame(text) {
  const payload = Buffer.from(text, 'utf8')
  const length = payload.length
  if (length < 126) return Buffer.concat([Buffer.from([0x81, length]), payload])
  if (length < 65_536) {
    const header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(length, 2)
    return Buffer.concat([header, payload])
  }
  const header = Buffer.alloc(10)
  header[0] = 0x81
  header[1] = 127
  header.writeBigUInt64BE(BigInt(length), 2)
  return Buffer.concat([header, payload])
}

/**
 * 解析客户端→服务端帧（客户端会掩码）。
 * @param {Buffer} buffer - 当前缓冲。
 * @returns {{ messages: string[], rest: Buffer }} 解析结果。
 */
function decodeClientFrames(buffer) {
  const messages = []
  let rest = buffer
  for (;;) {
    if (rest.length < 2) break
    const first = rest[0]
    const second = rest[1]
    const opcode = first & 0x0f
    const masked = (second & 0x80) !== 0
    let length = second & 0x7f
    let offset = 2
    if (length === 126) {
      if (rest.length < 4) break
      length = rest.readUInt16BE(2)
      offset = 4
    } else if (length === 127) {
      if (rest.length < 10) break
      length = Number(rest.readBigUInt64BE(2))
      offset = 10
    }
    let maskKey = null
    if (masked) {
      if (rest.length < offset + 4) break
      maskKey = rest.subarray(offset, offset + 4)
      offset += 4
    }
    if (rest.length < offset + length) break
    let payload = rest.subarray(offset, offset + length)
    rest = rest.subarray(offset + length)
    if (masked && maskKey !== null) {
      const unmasked = Buffer.alloc(length)
      for (let index = 0; index < length; index += 1) unmasked[index] = payload[index] ^ maskKey[index % 4]
      payload = unmasked
    }
    if (opcode === 0x8) break
    if (opcode === 0x1) messages.push(payload.toString('utf8'))
  }
  return { messages, rest }
}

/**
 * 启动一个假 CDP 端点。
 *
 * @param {object} options - 入参。
 * @param {object[]} options.targets - /json/list 返回的 target。
 * @param {(method: string, params: object, sessionId?: string, ctx?: { emit: Function }) => unknown} options.handler -
 *   命令处理：返回值作为 result；抛 `{ cdpError: '…' }` 作为 error；返回 Promise 可延迟；
 *   `ctx.emit(method, params, sessionId)` 可主动推事件（模拟 `Target.attachedToTarget`）。
 * @returns {Promise<{ endpoint: string, port: number, close: () => Promise<void>, events: object[] }>} 服务。
 */
async function startFakeCdp({ targets, handler }) {
  const events = []
  const sockets = new Set()
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/json/version') {
      const body = JSON.stringify({
        Browser: 'Fake/1.0',
        webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/browser/fake`,
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(body)
      return
    }
    if (url.pathname === '/json/list') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(targets))
      return
    }
    res.writeHead(404)
    res.end()
  })
  server.on('upgrade', (req, socket) => {
    sockets.add(socket)
    const key = String(req.headers['sec-websocket-key'] ?? '')
    const accept = crypto.createHash('sha1').update(`${key}${WS_GUID}`).digest('base64')
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '', '',
    ].join('\r\n'))
    let buffer = Buffer.alloc(0)
    /**
     * 服务端主动推一条事件。
     * @param {string} method - 事件名。
     * @param {object} params - 参数。
     * @param {string} [sessionId] - 发事件的会话（缺省为浏览器级）。
     * @returns {void}
     */
    const emit = (method, params, sessionId) => {
      const payload = { method, params: params ?? {} }
      if (typeof sessionId === 'string' && sessionId !== '') payload.sessionId = sessionId
      try {
        socket.write(encodeServerFrame(JSON.stringify(payload)))
      } catch {
        // 连接已断，忽略。
      }
    }
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      const decoded = decodeClientFrames(buffer)
      buffer = decoded.rest
      for (const raw of decoded.messages) {
        let message
        try {
          message = JSON.parse(raw)
        } catch {
          continue
        }
        if (typeof message.id !== 'number') continue
        void (async () => {
          try {
            const result = await handler(message.method, message.params ?? {}, message.sessionId, { emit })
            socket.write(encodeServerFrame(JSON.stringify({ id: message.id, result: result ?? {} })))
          } catch (error) {
            if (error?.cdpError !== undefined) {
              socket.write(encodeServerFrame(JSON.stringify({
                id: message.id,
                error: { code: -32_000, message: String(error.cdpError) },
              })))
              return
            }
            socket.write(encodeServerFrame(JSON.stringify({
              id: message.id,
              error: { code: -32_000, message: String(error?.message ?? error) },
            })))
          }
        })()
      }
    })
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    endpoint: `http://127.0.0.1:${port}`,
    port,
    events,
    async close() {
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/**
 * 找一个当前没被监听的端口。
 * @returns {Promise<number>} 端口。
 */
async function closedPort() {
  const probe = net.createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  return port
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

test('quadToBox 取外接矩形并取整', () => {
  assert.deepEqual(quadToBox([10, 20, 110, 20, 110, 60, 10, 60]), { x: 10, y: 20, width: 100, height: 40 })
  assert.equal(quadToBox(null), null)
  assert.equal(quadToBox([1, 2, 3]), null)
  assert.equal(quadToBox([1, 2, 3, 4, 5, 6, 7, Number.NaN]), null)
})

test('offsetBox 换算不了就返回 null（不编造坐标）', () => {
  const box = { x: 10, y: 20, width: 30, height: 40 }
  assert.deepEqual(offsetBox(box, { x: 100, y: 200 }), { x: 110, y: 220, width: 30, height: 40 })
  assert.equal(offsetBox(box, null), null)
  assert.equal(offsetBox(null, { x: 1, y: 2 }), null)
})

test('framePathOf 按父链拼 main > #1 > #2', () => {
  const index = new Map([
    ['F1', { parentId: null, index: 0 }],
    ['F2', { parentId: 'F1', index: 1 }],
    ['F3', { parentId: 'F2', index: 2 }],
  ])
  assert.equal(framePathOf('F1', index), 'main')
  assert.equal(framePathOf('F2', index), 'main > #1')
  assert.equal(framePathOf('F3', index), 'main > #1 > #2')
  assert.equal(framePathOf('nope', index), '#?')
})

test('mergeAttachedFrame 把 attached 事件子 frame 补进 frame 表（含嵌套续号/去重）', () => {
  const frames = [{ frameId: 'F1', parentId: null, index: 0, url: 'https://e.example/', name: '' }]
  const frameIndex = new Map([['F1', { parentId: null, index: 0, url: 'https://e.example/' }]])
  const childCount = seedChildCount(frames)
  assert.equal(childCount.get('__root__'), 1)

  const first = mergeAttachedFrame({
    frames,
    frameIndex,
    childCount,
    childFrameId: 'F2',
    parentFrameId: 'F1',
    url: 'https://x.example/',
  })
  assert.deepEqual(first, { frameId: 'F2', parentId: 'F1', index: 1, url: 'https://x.example/', name: '' })
  assert.equal(framePathOf('F2', frameIndex), 'main > #1')

  // 嵌套 OOPIF：父 frameId 是上一个子 frame；`#n` 是「父 frame 下的子序号」
  const nested = mergeAttachedFrame({
    frames,
    frameIndex,
    childCount,
    childFrameId: 'F3',
    parentFrameId: 'F2',
    url: 'https://y.example/',
  })
  assert.equal(nested.index, 1)
  assert.equal(framePathOf('F3', frameIndex), 'main > #1 > #1')

  // 同一个父 frame 的第二个子 frame → #2
  mergeAttachedFrame({
    frames,
    frameIndex,
    childCount,
    childFrameId: 'F4',
    parentFrameId: 'F2',
    url: 'https://z.example/',
  })
  assert.equal(framePathOf('F4', frameIndex), 'main > #1 > #2')

  // 同一个子 frame 的重复事件不能重复入表
  assert.equal(mergeAttachedFrame({ frames, frameIndex, childCount, childFrameId: 'F2', parentFrameId: 'F1' }), null)
  assert.equal(frames.length, 4)
  assert.equal(framePathOf('F1', frameIndex), 'main')
})

test('flattenAxTree 过滤噪声/无名字节点并截断', () => {
  const box = { x: 1, y: 2, width: 3, height: 4 }
  const ax = [
    { role: { value: 'RootWebArea' }, name: { value: '页面' }, backendDOMNodeId: 1 },
    { role: { value: 'generic' }, name: { value: '' }, backendDOMNodeId: 2 },
    { role: { value: 'link' }, name: { value: '  More   info ' }, backendDOMNodeId: 3 },
    { role: { value: 'button' }, name: { value: '登录' }, backendDOMNodeId: 4 },
    { role: { value: 'StaticText' }, name: { value: '' }, backendDOMNodeId: 5 },
    { role: { value: 'heading' }, name: { value: '标题' }, backendDOMNodeId: 6, ignored: true },
  ]
  const flat = flattenAxTree(ax, { maxNodes: 1, boxOf: () => box, pathOf: () => 'main' })
  assert.equal(flat.total, 2) // link + button（RootWebArea/generic/空 StaticText/ignored 都跳过）
  assert.equal(flat.nodes.length, 1)
  assert.equal(flat.truncated, true)
  assert.deepEqual(flat.nodes[0], { role: 'link', name: 'More info', framePath: 'main', box })
})

test('matchTarget：唯一页面自动选中；多页必须给 url；找不到给明确错误', () => {
  const targets = [
    { id: 'A', type: 'page', url: 'https://a.example/', title: 'A' },
    { id: 'B', type: 'page', url: 'https://b.example/', title: 'B' },
    { id: 'C', type: 'iframe', url: 'https://c.example/', title: 'C' },
  ]
  assert.equal(matchTarget([targets[0]]).id, 'A')
  assert.equal(matchTarget(targets, { url: 'https://b.example/' }).id, 'B')
  // 忽略 hash
  assert.equal(matchTarget(targets, { url: 'https://a.example/#x' }).id, 'A')
  assert.throws(() => matchTarget(targets), (error) => error.code === 'CDP_TARGET_MULTIPLE')
  assert.throws(() => matchTarget(targets, { url: 'https://nope/' }), (error) => error.code === 'CDP_TARGET_NOT_FOUND')
  assert.throws(() => matchTarget([targets[2]]), (error) => error.code === 'CDP_NO_PAGE')
})

// ---------------------------------------------------------------------------
// resolveEndpoint
// ---------------------------------------------------------------------------

test('resolveEndpoint：读端口文件第一行；5 秒缓存后自愈', async () => {
  clearEndpointCache()
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bh-cdp-'))
  const file = path.join(dir, 'DevToolsActivePort')
  try {
    await fs.writeFile(file, '54321\n/devtools/browser/abc\n')
    assert.equal(await resolveEndpoint({ portFile: file }), 'http://127.0.0.1:54321')
    // 缓存期内改文件不生效
    await fs.writeFile(file, '54322\n/devtools/browser/def\n')
    assert.equal(await resolveEndpoint({ portFile: file }), 'http://127.0.0.1:54321')
    // ttl 归零 → 重读
    assert.equal(await resolveEndpoint({ portFile: file, ttlMs: 0 }), 'http://127.0.0.1:54322')
  } finally {
    clearEndpointCache()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('resolveEndpoint：显式 endpoint 优先，不读文件', async () => {
  assert.equal(await resolveEndpoint({ endpoint: 'http://127.0.0.1:1/', portFile: 'C:\\nope' }), 'http://127.0.0.1:1')
})

test('resolveEndpoint：文件缺失/内容非法 → DEEP_UNAVAILABLE（带启动器原话）', async () => {
  clearEndpointCache()
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bh-cdp-'))
  try {
    await assert.rejects(
      resolveEndpoint({ portFile: path.join(dir, 'nope') }),
      (error) => error instanceof CdpError && error.code === 'DEEP_UNAVAILABLE' && error.message.includes('start-dsh-debug.cmd'),
    )
    const bad = path.join(dir, 'DevToolsActivePort')
    await fs.writeFile(bad, 'not-a-port\n')
    await assert.rejects(
      resolveEndpoint({ portFile: bad }),
      (error) => error.code === 'DEEP_UNAVAILABLE' && error.message.includes('端口文件内容非法'),
    )
    assert.ok(DEEP_HELP.includes('deepMode'))
  } finally {
    clearEndpointCache()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// discover / connect
// ---------------------------------------------------------------------------

test('discover：解析 /json/version + /json/list', async () => {
  const server = await startFakeCdp({
    targets: [{ id: 'A', type: 'page', url: 'https://a.example/', title: 'A', webSocketDebuggerUrl: 'ws://x/page' }],
    handler: () => ({}),
  })
  try {
    const found = await discover(server.endpoint, { timeoutMs: 1_000 })
    assert.equal(found.endpoint, server.endpoint)
    assert.ok(found.browserWSUrl.startsWith('ws://127.0.0.1:'))
    assert.equal(found.targets.length, 1)
    assert.equal(found.targets[0].url, 'https://a.example/')
  } finally {
    await server.close()
  }
})

test('discover：端口不可达 → CDP_UNREACHABLE', async () => {
  const port = await closedPort()
  await assert.rejects(
    discover(`http://127.0.0.1:${port}`, { timeoutMs: 1_000 }),
    (error) => error.code === 'CDP_UNREACHABLE',
  )
})

test('connect/send：正常回包 + 错误映射 + 命令超时', async () => {
  const server = await startFakeCdp({
    targets: [],
    handler: (method) => {
      if (method === 'Echo') return { value: 42 }
      if (method === 'Gone') return Promise.reject({ cdpError: 'No target with given id found' })
      if (method === 'Slow') return new Promise(() => {})
      return {}
    },
  })
  const found = await discover(server.endpoint, { timeoutMs: 1_000 })
  const connection = await connect(found.browserWSUrl, { timeoutMs: 1_000 })
  try {
    assert.deepEqual(await connection.send('Echo', { a: 1 }), { value: 42 })
    await assert.rejects(connection.send('Gone'), (error) => error.code === 'CDP_TARGET_GONE')
    await assert.rejects(
      connection.send('Slow', {}, { timeoutMs: 150 }),
      (error) => error.code === 'CDP_TIMEOUT' && error.message.includes('Slow'),
    )
  } finally {
    connection.close()
    await server.close()
  }
})

// ---------------------------------------------------------------------------
// deepSnapshot 全链路
// ---------------------------------------------------------------------------

const AX_NODES = [
  { role: { value: 'RootWebArea' }, name: { value: 'Example' }, backendDOMNodeId: 1, frameId: 'F1' },
  { role: { value: 'link' }, name: { value: 'More information...' }, backendDOMNodeId: 2, frameId: 'F1' },
  { role: { value: 'button' }, name: { value: '登录' }, backendDOMNodeId: 3, frameId: 'F1' },
  { role: { value: 'generic' }, name: { value: '' }, backendDOMNodeId: 4, frameId: 'F1' },
]

test('deepSnapshot：attach → a11y → box（顶层视口坐标）', async () => {
  const server = await startFakeCdp({
    targets: [{ id: 'T1', type: 'page', url: 'https://e.example/', title: 'Example' }],
    handler: (method) => {
      if (method === 'Target.attachToTarget') return { sessionId: 'S1' }
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'F1', url: 'https://e.example/' } } }
      if (method === 'Accessibility.getFullAXTree') return { nodes: AX_NODES }
      if (method === 'DOM.getBoxModel') return { model: { content: [10, 20, 110, 20, 110, 60, 10, 60] } }
      return {}
    },
  })
  try {
    const value = await deepSnapshot({
      endpoint: server.endpoint,
      url: 'https://e.example/',
      maxNodes: 200,
      includeFrames: true,
      timeoutMs: 2_000,
    })
    assert.equal(value.ok, true)
    assert.equal(value.target.url, 'https://e.example/')
    assert.equal(value.target.type, 'page')
    assert.equal(value.nodes.length, 2) // RootWebArea/generic 被过滤
    assert.deepEqual(value.nodes[0], {
      role: 'link',
      name: 'More information...',
      framePath: 'main',
      box: { x: 10, y: 20, width: 100, height: 40 },
    })
    assert.equal(value.stats.nodes, 2)
    assert.ok(value.stats.estTokens > 0)
    assert.equal(value.stats.frames, 1)
  } finally {
    await server.close()
  }
})

test('deepSnapshot：target 消失 → CDP_TARGET_GONE', async () => {
  const server = await startFakeCdp({
    targets: [{ id: 'T1', type: 'page', url: 'https://e.example/', title: 'Example' }],
    handler: (method) => {
      if (method === 'Target.attachToTarget') return Promise.reject({ cdpError: 'No target with given id found' })
      return {}
    },
  })
  try {
    await assert.rejects(
      deepSnapshot({ endpoint: server.endpoint, url: 'https://e.example/', timeoutMs: 1_000 }),
      (error) => error.code === 'CDP_TARGET_GONE',
    )
  } finally {
    await server.close()
  }
})

test('deepSnapshot：DOM.getBoxModel 失败时 box:null（不编造）', async () => {
  const server = await startFakeCdp({
    targets: [{ id: 'T1', type: 'page', url: 'https://e.example/', title: 'Example' }],
    handler: (method) => {
      if (method === 'Target.attachToTarget') return { sessionId: 'S1' }
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'F1', url: 'https://e.example/' } } }
      if (method === 'Accessibility.getFullAXTree') return { nodes: AX_NODES }
      if (method === 'DOM.getBoxModel') return Promise.reject({ cdpError: 'No node with given id found' })
      return {}
    },
  })
  try {
    const value = await deepSnapshot({ endpoint: server.endpoint, url: 'https://e.example/', timeoutMs: 2_000 })
    assert.equal(value.ok, true)
    assert.ok(value.nodes.length > 0)
    assert.ok(value.nodes.every((node) => node.box === null))
  } finally {
    await server.close()
  }
})

// ---------------------------------------------------------------------------
// 跨源 iframe（OOPIF）：子 frame 只出现在 Target.attachedToTarget 事件里
// ---------------------------------------------------------------------------

/** 顶层视口里的 iframe 盒子：(16,300) 300x20。 */
const IFRAME_QUAD = [16, 300, 316, 300, 316, 320, 16, 320]
/** 子 frame 内部的按钮盒子（子 frame 局部坐标）：(0,0) 30x20。 */
const CHILD_QUAD = [0, 0, 30, 0, 30, 20, 0, 20]

test('deepSnapshot：OOPIF 子 frame 由 attached 事件补进表 → main > #1 + 偏移后坐标', async () => {
  const server = await startFakeCdp({
    targets: [{ id: 'T1', type: 'page', url: 'https://e.example/', title: 'Example' }],
    handler: (method, params, sessionId, ctx) => {
      if (method === 'Target.attachToTarget') return { sessionId: 'S1' }
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'F1', url: 'https://e.example/' } } }
      if (method === 'Target.setAutoAttach') {
        // 真机上 params.targetInfo.targetId 就是子 frameId（这里 F2）。
        if (sessionId === 'S1') {
          ctx.emit('Target.attachedToTarget', {
            sessionId: 'S2',
            targetInfo: { targetId: 'F2', type: 'iframe', url: 'https://x.example/' },
          }, 'S1')
        }
        return {}
      }
      if (method === 'Accessibility.getFullAXTree') {
        if (sessionId === 'S2') {
          return { nodes: [{ role: { value: 'button' }, name: { value: 'iframe 按钮 1' }, backendDOMNodeId: 5, frameId: 'F2' }] }
        }
        return { nodes: AX_NODES }
      }
      if (method === 'DOM.getFrameOwner') {
        return params.frameId === 'F2' ? { backendNodeId: 900 } : Promise.reject({ cdpError: 'No frame with given id' })
      }
      if (method === 'DOM.getBoxModel') {
        if (sessionId === 'S2') return { model: { content: CHILD_QUAD } }
        if (params.backendNodeId === 900) return { model: { content: IFRAME_QUAD } }
        return { model: { content: [10, 20, 110, 20, 110, 60, 10, 60] } }
      }
      return {}
    },
  })
  try {
    const value = await deepSnapshot({ endpoint: server.endpoint, url: 'https://e.example/', timeoutMs: 2_000 })
    assert.equal(value.ok, true)
    assert.equal(value.stats.frames, 2)
    const child = value.nodes.find((node) => node.name === 'iframe 按钮 1')
    assert.ok(child !== undefined, JSON.stringify(value.nodes))
    assert.equal(child.framePath, 'main > #1')
    assert.deepEqual(child.box, { x: 16, y: 300, width: 30, height: 20 })
    const link = value.nodes.find((node) => node.name === 'More information...')
    assert.equal(link.framePath, 'main')
    assert.deepEqual(link.box, { x: 10, y: 20, width: 100, height: 40 })
    assert.ok(value.nodes.every((node) => !node.framePath.includes('#?')), JSON.stringify(value.nodes))
  } finally {
    await server.close()
  }
})

test('deepSnapshot：嵌套 OOPIF 逐层 auto-attach → main > #1 > #1 / #1 > #2（无 #?）', async () => {
  const server = await startFakeCdp({
    targets: [{ id: 'T1', type: 'page', url: 'https://e.example/', title: 'Example' }],
    handler: (method, params, sessionId, ctx) => {
      if (method === 'Target.attachToTarget') return { sessionId: 'S1' }
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'F1', url: 'https://e.example/' } } }
      if (method === 'Target.setAutoAttach') {
        if (sessionId === 'S1') {
          ctx.emit('Target.attachedToTarget', {
            sessionId: 'S2',
            targetInfo: { targetId: 'F2', type: 'iframe', url: 'https://x.example/' },
          }, 'S1')
        }
        if (sessionId === 'S2') {
          // F2 里两个跨源子 frame：F3（第一个）、F4（第二个）
          ctx.emit('Target.attachedToTarget', {
            sessionId: 'S3',
            targetInfo: { targetId: 'F3', type: 'iframe', url: 'https://y.example/' },
          }, 'S2')
          ctx.emit('Target.attachedToTarget', {
            sessionId: 'S4',
            targetInfo: { targetId: 'F4', type: 'iframe', url: 'https://z.example/' },
          }, 'S2')
        }
        return {}
      }
      if (method === 'Accessibility.getFullAXTree') {
        if (sessionId === 'S2') {
          return { nodes: [{ role: { value: 'button' }, name: { value: '外层按钮' }, backendDOMNodeId: 5, frameId: 'F2' }] }
        }
        if (sessionId === 'S3') {
          return { nodes: [{ role: { value: 'button' }, name: { value: '内层按钮' }, backendDOMNodeId: 6, frameId: 'F3' }] }
        }
        if (sessionId === 'S4') {
          return { nodes: [{ role: { value: 'button' }, name: { value: '并列按钮' }, backendDOMNodeId: 7, frameId: 'F4' }] }
        }
        return { nodes: AX_NODES }
      }
      if (method === 'DOM.getFrameOwner') {
        if (params.frameId === 'F2') return { backendNodeId: 900 }
        if (params.frameId === 'F3') return { backendNodeId: 901 }
        // F4 的 iframe owner 拿不到 → 偏移 null → 它的节点 box:null（不编造）
        return Promise.reject({ cdpError: 'No frame with given id' })
      }
      if (method === 'DOM.getBoxModel') {
        if (sessionId === 'S2') {
          // F3 的 iframe owner 在 F2 里：(5,10) 200x20
          if (params.backendNodeId === 901) return { model: { content: [5, 10, 205, 10, 205, 30, 5, 30] } }
          return { model: { content: CHILD_QUAD } }
        }
        if (sessionId === 'S3') return { model: { content: [1, 1, 31, 1, 31, 21, 1, 21] } }
        if (params.backendNodeId === 900) return { model: { content: IFRAME_QUAD } }
        return { model: { content: [10, 20, 110, 20, 110, 60, 10, 60] } }
      }
      return {}
    },
  })
  try {
    const value = await deepSnapshot({ endpoint: server.endpoint, url: 'https://e.example/', timeoutMs: 2_000 })
    assert.equal(value.stats.frames, 4)
    const outer = value.nodes.find((node) => node.name === '外层按钮')
    const inner = value.nodes.find((node) => node.name === '内层按钮')
    const sibling = value.nodes.find((node) => node.name === '并列按钮')
    assert.ok(outer !== undefined && inner !== undefined && sibling !== undefined, JSON.stringify(value.nodes))
    assert.equal(outer.framePath, 'main > #1')
    assert.deepEqual(outer.box, { x: 16, y: 300, width: 30, height: 20 })
    assert.equal(inner.framePath, 'main > #1 > #1')
    // F2 偏移 (16,300) + F3 owner (5,10) + 内层按钮 (1,1)
    assert.deepEqual(inner.box, { x: 22, y: 311, width: 30, height: 20 })
    assert.equal(sibling.framePath, 'main > #1 > #2')
    assert.equal(sibling.box, null)
    assert.ok(value.nodes.every((node) => !node.framePath.includes('#?')), JSON.stringify(value.nodes))
  } finally {
    await server.close()
  }
})

test('deepSnapshot：auto-attach 失败不影响主 frame（frames=1，全 main）', async () => {
  const server = await startFakeCdp({
    targets: [{ id: 'T1', type: 'page', url: 'https://e.example/', title: 'Example' }],
    handler: (method) => {
      if (method === 'Target.attachToTarget') return { sessionId: 'S1' }
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'F1', url: 'https://e.example/' } } }
      if (method === 'Target.setAutoAttach') return Promise.reject({ cdpError: 'Target does not support auto-attach' })
      if (method === 'Accessibility.getFullAXTree') return { nodes: AX_NODES }
      if (method === 'DOM.getBoxModel') return { model: { content: [10, 20, 110, 20, 110, 60, 10, 60] } }
      return {}
    },
  })
  try {
    const value = await deepSnapshot({ endpoint: server.endpoint, url: 'https://e.example/', timeoutMs: 2_000 })
    assert.equal(value.stats.frames, 1)
    assert.equal(value.nodes.length, 2)
    assert.ok(value.nodes.every((node) => node.framePath === 'main'))
  } finally {
    await server.close()
  }
})

// ---------------------------------------------------------------------------
// 工具层：DEEP_UNAVAILABLE
// ---------------------------------------------------------------------------

/**
 * 建一套只够跑 deep 工具的 deps。
 * @param {object} deepMode - deepMode 配置。
 * @returns {object} deps。
 */
function deepDeps(deepMode) {
  return {
    config: { enableEval: false, maxResultBytes: 12_000, commandTimeoutMs: 1_000, deepMode },
    bridge: { knownUrl: () => 'https://last.example/', sendCommand: async () => { throw new Error('n/a') } },
    audit: { audit() {} },
    navigator: { checkUrl: (url) => ({ ok: true, href: String(url) }) },
  }
}

/**
 * 找到 deep 工具并执行。
 * @param {object} deps - 依赖。
 * @param {object} args - 参数。
 * @returns {Promise<{ value: object, text: string }>} 结果与渲染文本。
 */
async function runDeep(deps, args) {
  const tool = buildBrowserTools(deps).find((item) => item.name === 'browser_deep_snapshot')
  assert.ok(tool !== undefined, 'browser_deep_snapshot 未注册')
  const value = await tool.execute(args, { agent: { id: 's-deep' } })
  const text = tool.output.render(args, value).map((part) => part.text).join('')
  return { value, text }
}

test('工具层：deepMode.enabled=false → DEEP_UNAVAILABLE（带启动器原话）', async () => {
  const { value, text } = await runDeep(deepDeps({
    enabled: false, portFile: 'C:\\nope\\DevToolsActivePort', endpoint: '', maxNodes: 200, timeoutMs: 8000,
  }), {})
  assert.equal(value.ok, false)
  assert.equal(value.error.code, 'DEEP_UNAVAILABLE')
  assert.ok(value.error.message.includes('start-dsh-debug.cmd'))
  assert.ok(value.error.message.includes('deepMode'))
  assert.ok(text.includes('browser_deep_snapshot failed: DEEP_UNAVAILABLE'))
})

test('工具层：已启用但端口文件不存在 → DEEP_UNAVAILABLE（端口没开的实测路径）', async () => {
  clearEndpointCache()
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bh-cdp-'))
  try {
    const { value, text } = await runDeep(deepDeps({
      enabled: true,
      portFile: path.join(dir, 'missing-DevToolsActivePort'),
      endpoint: '',
      maxNodes: 200,
      timeoutMs: 8000,
    }), {})
    assert.equal(value.ok, false)
    assert.equal(value.error.code, 'DEEP_UNAVAILABLE')
    assert.ok(value.error.message.includes('端口文件不存在'))
    assert.ok(value.error.message.includes('start-dsh-debug.cmd'))
    assert.ok(text.includes('DEEP_UNAVAILABLE'))
  } finally {
    clearEndpointCache()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('工具层：端口可达时返回节点表并渲染坐标', async () => {
  const server = await startFakeCdp({
    targets: [{ id: 'T1', type: 'page', url: 'https://e.example/', title: 'Example' }],
    handler: (method) => {
      if (method === 'Target.attachToTarget') return { sessionId: 'S1' }
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'F1', url: 'https://e.example/' } } }
      if (method === 'Accessibility.getFullAXTree') return { nodes: AX_NODES }
      if (method === 'DOM.getBoxModel') return { model: { content: [10, 20, 110, 20, 110, 60, 10, 60] } }
      return {}
    },
  })
  try {
    const { value, text } = await runDeep(deepDeps({
      enabled: true, portFile: '', endpoint: server.endpoint, maxNodes: 200, timeoutMs: 2_000,
    }), { url: 'https://e.example/' })
    assert.equal(value.ok, true)
    assert.equal(value.nodes.length, 2)
    assert.ok(text.includes('deep snapshot (a11y)'))
    assert.ok(text.includes('@ (10,20,100,40)'), text)
    assert.ok(text.includes('stats:'), text)
  } finally {
    await server.close()
  }
})

test('工具层：15 个工具全部注册，deep 工具 schema 合法', () => {
  const tools = buildBrowserTools(deepDeps({
    enabled: false, portFile: '', endpoint: '', maxNodes: 200, timeoutMs: 8000,
  }))
  assert.equal(tools.length, 15)
  const names = tools.map((tool) => tool.name)
  assert.ok(names.includes('browser_deep_snapshot'))
  const allowed = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'description', 'title', 'default', 'examples'])
  const walk = (node, where) => {
    for (const key of Object.keys(node)) assert.ok(allowed.has(key), `${where}.${key} 不受支持`)
    if (node.properties) for (const [key, child] of Object.entries(node.properties)) walk(child, `${where}.properties.${key}`)
    if (node.items) walk(node.items, `${where}.items`)
  }
  const deep = tools.find((tool) => tool.name === 'browser_deep_snapshot')
  walk(deep.parameters, 'browser_deep_snapshot.parameters')
  walk(deep.output.schema, 'browser_deep_snapshot.output')
})
