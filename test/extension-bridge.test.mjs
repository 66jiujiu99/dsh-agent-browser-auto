/**
 * lib/extension-bridge.js 的单元/集成回归（node --test）。
 *
 * 起真实 ws 服务绑端口 0（内核随机端口），用 Node 内建 WebSocket 客户端跑完整链路：
 *   - 配对（对码/错码/过期/单次使用）与长效 token 持久化（只落盘 SHA-256）；
 *   - 命令下发 → 扩展回结果 → sendCommand resolve（lossless JSON）；
 *   - 同 clientId 重连顶掉旧连接、ping/pong、超时与离线错误码、端口占用退避、dispose。
 *
 * 时钟、token、配对码生成、重试等待全部注入，测试不睡眠、不碰真实浏览器。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createExtensionBridge } from '../lib/extension-bridge.js'
import { createAudit } from '../lib/audit.js'
import { resolveConfig } from '../lib/config.js'

/** 静音日志。 */
const silentLog = () => {}

/**
 * 起一套真实服务（临时审计目录 + 端口 0）。
 * @param {object} [options] - 覆盖项。
 * @param {object} [options.io] - 注入 createExtensionBridge 的 io。
 * @param {object} [options.extensionBridge] - 覆盖 config.extensionBridge。
 * @param {boolean} [options.debug] - 是否写 debug.jsonl（默认 false）。
 * @returns {Promise<object>} bridge/config/cleanup 套件。
 */
async function makeSuite({ io = {}, extensionBridge = {}, debug = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ext-bridge-'))
  const config = resolveConfig({
    auditDir: dir,
    debug,
    extensionBridge: { enabled: true, port: 0, pairTimeoutMs: 300_000, ...extensionBridge },
  })
  const audit = createAudit({ config, log: silentLog })
  const bridge = createExtensionBridge({ config, audit, log: silentLog, io })
  const cleanup = async () => {
    await bridge.dispose()
    await rm(dir, { recursive: true, force: true })
  }
  return { dir, config, audit, bridge, cleanup }
}

/** 已注入延迟的 io（端口重试不真等）。 */
const noDelayIo = { delay: async () => {} }

/**
 * 打开一条已配对连接并完成 hello，返回 { ws, messages, readyMessage }。
 * @param {number} port - 服务端口。
 * @param {string} tokenOrCode - token 或配对码。
 * @param {string} [clientId] - hello 用的 clientId。
 * @returns {Promise<{ ws: WebSocket, messages: object[], readyMessage: object }>} 连接与收到的消息数组。
 */
async function openPaired(port, tokenOrCode, clientId = 'ext-test') {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(tokenOrCode)}`)
  const messages = []
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ready 超时')), 3000)
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data))
      messages.push(message)
      if (message.type === 'ready' || message.type === 'superseded') {
        clearTimeout(timer)
        resolve(message)
      }
    })
    ws.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('连接失败'))
    })
    ws.addEventListener('close', (event) => {
      clearTimeout(timer)
      if (messages.length === 0) reject(new Error(`连接被关闭 code=${event.code}`))
      else resolve(messages.at(-1))
    })
  })
  const readyMessage = await ready
  ws.send(JSON.stringify({ type: 'hello', clientId, version: 1 }))
  await waitFor(() => messages.some((message) => message.type === 'sessionReady'))
  return { ws, messages, readyMessage }
}

/** 等条件成立（默认 3 秒）。 */
async function waitFor(check, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = check()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('waitFor 超时')
}

/** 截获 Host 下发的下一条 command 消息。 */
function captureCommand(ws) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等 command 超时')), 3000)
    const handler = (event) => {
      const message = JSON.parse(String(event.data))
      if (message.type === 'command') {
        clearTimeout(timer)
        ws.removeEventListener('message', handler)
        resolve(message)
      }
    }
    ws.addEventListener('message', handler)
  })
}

test('配置解析：extensionBridge 有安全默认值并拒绝非法值', () => {
  const defaults = resolveConfig({})
  assert.deepEqual(defaults.extensionBridge, { enabled: false, port: 9335, pairTimeoutMs: 300_000 })
  const custom = resolveConfig({ extensionBridge: { enabled: true, port: 9400, pairTimeoutMs: 60_000 } })
  assert.deepEqual(custom.extensionBridge, { enabled: true, port: 9400, pairTimeoutMs: 60_000 })
  assert.throws(() => resolveConfig({ extensionBridge: { port: 70_000 } }), /between 0 and 65535/)
  assert.throws(() => resolveConfig({ extensionBridge: { pairTimeoutMs: 100 } }), /between 5000/)
  assert.throws(() => resolveConfig({ extensionBridge: { enabled: 'yes' } }), /boolean/)
  assert.throws(() => resolveConfig({ extensionBridge: { ports: 1 } }), /unknown key/)
  assert.throws(() => resolveConfig({ extensionBridge: [] }), /must be an object/)
})

test('未启用时 beginPairing 回 EXTENSION_DISABLED（防御分支）', async () => {
  const suite = await makeSuite({ extensionBridge: { enabled: false } })
  try {
    const result = suite.bridge.beginPairing()
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'EXTENSION_DISABLED')
    assert.ok(result.error.message.includes('extensionBridge.enabled'))
  } finally {
    await suite.cleanup()
  }
})

test('配对成功：一次性码换取长效 token，token 只以 SHA-256 落盘', async () => {
  const suite = await makeSuite({ io: { ...noDelayIo } })
  try {
    await suite.bridge.start()
    const port = suite.bridge.status().port
    const pairing = suite.bridge.beginPairing()
    assert.equal(pairing.ok, true)
    assert.equal(pairing.code.length, 8)
    assert.match(pairing.code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/)
    assert.equal(pairing.port, port)
    assert.equal(pairing.wsUrl, `ws://127.0.0.1:${port}`)

    const { ws, messages } = await openPaired(port, pairing.code, 'ext-alpha')
    const ready = messages.find((message) => message.type === 'ready')
    assert.equal(typeof ready.token, 'string')
    assert.ok(ready.token.length >= 32)
    // clientId 归扩展所有：ready 不携带 clientId，sessionReady 回显 hello 里的权威值。
    assert.equal(ready.clientId, undefined)
    const sessionReady = messages.find((message) => message.type === 'sessionReady')
    assert.equal(sessionReady.clientId, 'ext-alpha')

    // 配对状态文件：只存哈希，绝不存 token 原文。
    const raw = await readFile(join(suite.dir, 'extension-paired.json'), 'utf8')
    assert.ok(raw.includes('ext-alpha'))
    assert.ok(!raw.includes(ready.token))
    const stored = JSON.parse(raw)
    assert.equal(stored.clients.length, 1)
    assert.equal(stored.clients[0].digest.length, 64)

    // 同一码不能再用：旧连接关掉后用码重连会被 401 拒绝。
    ws.close()
    await waitFor(() => suite.bridge.sessionCount() === 0)
    await assert.rejects(() => openPaired(port, pairing.code, 'ext-beta'), /连接被关闭|连接失败/)
    assert.equal(suite.bridge.status().connected, false)
  } finally {
    await suite.cleanup()
  }
})

test('错误 token 与过期配对码都被 HTTP 401 拒绝，不升级 WebSocket', async () => {
  let clock = 1_000_000
  const suite = await makeSuite({
    io: {
      ...noDelayIo,
      now: () => clock,
      randomToken: () => 'unit-test-token',
      randomPairCode: () => 'CODE1234',
    },
    extensionBridge: { pairTimeoutMs: 5_000 },
  })
  try {
    await suite.bridge.start()
    const port = suite.bridge.status().port
    const pairing = suite.bridge.beginPairing()
    assert.equal(pairing.code, 'CODE1234')
    assert.equal(pairing.expiresAt, 1_005_000)

    // 完全错的 token。
    await assert.rejects(() => openPaired(port, 'wrong-token'), /连接被关闭|连接失败/)

    // 时钟拨过 pairTimeoutMs：配对码过期，连接被拒。
    clock += 5_001
    await assert.rejects(() => openPaired(port, 'CODE1234'), /连接被关闭|连接失败/)

    // 过期后的码也不在状态里计为 pending。
    assert.equal(suite.bridge.status().pairPending, false)
  } finally {
    await suite.cleanup()
  }
})

test('命令往返：sendCommand → 扩展执行 → result 回传，lossless JSON', async () => {
  const suite = await makeSuite({ io: { ...noDelayIo } })
  try {
    await suite.bridge.start()
    const port = suite.bridge.status().port
    const pairing = suite.bridge.beginPairing()
    const { ws } = await openPaired(port, pairing.code, 'ext-cmd')

    const pending = suite.bridge.sendCommand('s-1', 'open', { url: 'https://example.com/', scope: 'viewport' }, 2000)
    const command = await captureCommand(ws)
    assert.equal(command.op, 'open')
    assert.deepEqual(command.args, { url: 'https://example.com/', scope: 'viewport' })
    ws.send(JSON.stringify({
      type: 'result',
      id: command.id,
      ok: true,
      value: { ok: true, pageId: '7', url: 'https://example.com/', title: '例', snapshot: { url: 'https://example.com/', elements: [] } },
    }))
    const outcome = await pending
    assert.deepEqual(JSON.parse(JSON.stringify(outcome.value)), outcome.value)
    assert.equal(outcome.clientId, 'ext-cmd')
    assert.equal(suite.bridge.knownUrl('s-1'), 'https://example.com/')
  } finally {
    await suite.cleanup()
  }
})

test('命令失败：扩展回 error 时 reject 出稳定错误码', async () => {
  const suite = await makeSuite({ io: { ...noDelayIo } })
  try {
    await suite.bridge.start()
    const port = suite.bridge.status().port
    const pairing = suite.bridge.beginPairing()
    const { ws } = await openPaired(port, pairing.code, 'ext-err')
    const pending = suite.bridge.sendCommand('s-2', 'snapshot', {}, 2000).catch((error) => error)
    const command = await captureCommand(ws)
    ws.send(JSON.stringify({ type: 'result', id: command.id, ok: false, error: { code: 'NO_PAGE', message: '没有打开的标签' } }))
    const error = await pending
    assert.equal(error.code, 'NO_PAGE')
    assert.ok(error.message.includes('没有打开的标签'))
  } finally {
    await suite.cleanup()
  }
})

test('无扩展在线回 EXTENSION_OFFLINE；无结果回 TIMEOUT；dispose 使在途命令失败', async () => {
  const suite = await makeSuite({ io: { ...noDelayIo } })
  try {
    await suite.bridge.start()
    await assert.rejects(
      () => suite.bridge.sendCommand('s-3', 'snapshot', {}, 500),
      (error) => error.code === 'EXTENSION_OFFLINE' && error.message.includes('browser_ext_pair'),
    )

    const port = suite.bridge.status().port
    const pairing = suite.bridge.beginPairing()
    const { ws } = await openPaired(port, pairing.code, 'ext-slow')
    const timeoutError = await suite.bridge.sendCommand('s-4', 'snapshot', {}, 120).catch((error) => error)
    assert.equal(timeoutError.code, 'TIMEOUT')
    const abortPromise = suite.bridge.sendCommand('s-5', 'snapshot', {}, 5000).catch((error) => error)
    // dispose 后在途命令立刻失败。
    await suite.bridge.dispose()
    const aborted = await abortPromise
    assert.equal(aborted.code, 'NO_CHANNEL')
    ws.close()
  } finally {
    await rm(suite.dir, { recursive: true, force: true })
  }
})

test('ping/pong 与状态：connected/clientId/lastHeartbeatMs lossless', async () => {
  const suite = await makeSuite({ io: { ...noDelayIo } })
  try {
    await suite.bridge.start()
    const port = suite.bridge.status().port
    const pairing = suite.bridge.beginPairing()
    const { ws, messages } = await openPaired(port, pairing.code, 'ext-ping')
    ws.send(JSON.stringify({ type: 'ping', t: 4321 }))
    const pong = await waitFor(() => messages.find((message) => message.type === 'pong'))
    assert.equal(pong.t, 4321)

    const status = suite.bridge.status()
    assert.equal(status.connected, true)
    assert.equal(status.clientId, 'ext-ping')
    assert.ok(status.paired)
    assert.ok(typeof status.lastHeartbeatMs === 'number')
    assert.deepEqual(JSON.parse(JSON.stringify(status)), status)

    assert.equal(suite.bridge.connected(), true)
    ws.close()
    await waitFor(() => suite.bridge.sessionCount() === 0)
    assert.equal(suite.bridge.connected(), false)
  } finally {
    await suite.cleanup()
  }
})

test('同 clientId 重连顶掉旧连接（offscreen 接管/断网重连路径）', async () => {
  const suite = await makeSuite({ io: { ...noDelayIo } })
  try {
    await suite.bridge.start()
    const port = suite.bridge.status().port
    const pairing = suite.bridge.beginPairing()
    const first = await openPaired(port, pairing.code, 'ext-dup')
    assert.equal(suite.bridge.sessionCount(), 1)

    // 配对码已烧掉：第二台连接改走持久化 token（从配对状态里拿不到原文——
    // 这里直接用第一台连接里 ready.token）。
    const ready = first.messages.find((message) => message.type === 'ready')
    const second = await openPaired(port, ready.token, 'ext-dup')
    await waitFor(() => suite.bridge.sessionCount() === 1)
    // 旧连接被服务端关闭（superseded 或 close）。
    await waitFor(async () => {
      return first.ws.readyState === 3 || first.messages.some((message) => message.type === 'superseded')
    })
    assert.ok(
      first.messages.some((message) => message.type === 'superseded') || first.ws.readyState === 3,
      '旧连接应被顶掉',
    )
    second.ws.close()
    await waitFor(() => suite.bridge.sessionCount() === 0)
  } finally {
    await suite.cleanup()
  }
})

test('持久化：重启服务（同一 auditDir）后长效 token 仍然有效', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ext-bridge-persist-'))
  const config = resolveConfig({ auditDir: dir, debug: false, extensionBridge: { enabled: true, port: 0 } })
  const audit = createAudit({ config, log: silentLog })
  const first = createExtensionBridge({ config, audit, log: silentLog, io: { ...noDelayIo } })
  try {
    await first.start()
    const portA = first.status().port
    const pairing = first.beginPairing()
    const session = await openPaired(portA, pairing.code, 'ext-restart')
    const token = session.messages.find((message) => message.type === 'ready').token
    session.ws.close()
    await first.dispose()

    const second = createExtensionBridge({ config, audit, log: silentLog, io: { ...noDelayIo } })
    try {
      await second.start()
      const portB = second.status().port
      const reconnected = await openPaired(portB, token, 'ext-restart')
      assert.equal(second.status().connected, true)
      assert.equal(second.status().clientId, 'ext-restart')
      reconnected.ws.close()
      await waitFor(() => second.sessionCount() === 0)
    } finally {
      await second.dispose()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('端口占用：退避重试后如实报错，不抛异常不拖垮调用方', async () => {
  const net = await import('node:net')
  const blocker = net.createServer()
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve))
  const busyPort = blocker.address().port
  let attempts = 0
  const suite = await makeSuite({
    io: {
      delay: async () => {
        attempts += 1
      },
    },
    extensionBridge: { port: busyPort },
  })
  try {
    const started = await suite.bridge.start()
    assert.equal(started.ok, false)
    assert.equal(started.listening, false)
    assert.equal(attempts, 2, 'PORT_RETRY_ATTEMPTS-1 次重试')
    assert.notEqual(started.error, '')
    const status = suite.bridge.status()
    assert.equal(status.listening, false)
    assert.notEqual(status.portError, '')
    assert.deepEqual(JSON.parse(JSON.stringify(status)), status)
    // 离线命令依旧是 EXTENSION_OFFLINE（WS 没监听 ≠ 插件崩溃）。
    await assert.rejects(() => suite.bridge.sendCommand('s-6', 'snapshot', {}, 100), /EXTENSION_OFFLINE|没有在线的扩展/)
  } finally {
    await suite.cleanup()
    await new Promise((resolve) => blocker.close(resolve))
  }
})

test('截图结果：pngBase64 落盘 auditDir/shots 并从结果摘除', async () => {
  const suite = await makeSuite({ io: { ...noDelayIo } })
  try {
    await suite.bridge.start()
    const port = suite.bridge.status().port
    const pairing = suite.bridge.beginPairing()
    const { ws } = await openPaired(port, pairing.code, 'ext-shot')
    const pending = suite.bridge.sendCommand('s-7', 'screenshot', { fullPage: false }, 2000)
    const command = await captureCommand(ws)
    // 1x1 PNG 的 base64（合法 PNG 头，落盘不校验内容）。
    const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    ws.send(JSON.stringify({
      type: 'result',
      id: command.id,
      ok: true,
      value: { ok: true, pngBase64, pageId: '9', url: 'https://example.com/' },
    }))
    const { value } = await pending
    assert.equal(value.pngBase64, undefined)
    assert.equal(value.pageId, '9')
    assert.ok(typeof value.path === 'string' && value.path.includes(join('shots', '')))
    assert.ok(value.bytes > 0)
    assert.deepEqual(JSON.parse(JSON.stringify(value)), value)
  } finally {
    await suite.cleanup()
  }
})
