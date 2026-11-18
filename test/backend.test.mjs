import test from 'node:test'
import assert from 'node:assert/strict'
import { createBackendRouter } from '../lib/backend.js'
import { resolveConfig, ConfigError } from '../lib/config.js'

function fixture({ extensionDriver } = {}) {
  const calls = []
  const bridge = {
    knownUrl: (id) => `embedded:${id}`,
    sendCommand: async (id, op) => {
      calls.push(['embedded', id, op])
      return { clientId: 'embedded', value: { op } }
    },
  }
  const realDriver = {
    connected: false,
    fail: null,
    status: () => realDriver.connected ? { connected: true, browser: 'chrome', profileMode: 'persistent' } : null,
    knownUrl: (id) => `real:${id}`,
    connectSession: async (id, args) => {
      calls.push(['connect', id, args])
      if (realDriver.fail) throw realDriver.fail
      realDriver.connected = true
    },
    disconnectSession: async (id, args) => {
      calls.push(['disconnect', id, args])
      realDriver.connected = false
    },
    sendCommand: async (id, op) => {
      calls.push(['real', id, op])
      return { clientId: 'playwright', value: { op } }
    },
  }
  const backend = createBackendRouter({ bridge, realDriver, extensionDriver })
  return { calls, bridge, realDriver, extensionDriver, backend }
}

/** 一个假的扩展桥接 driver（backend 路由测试用）。 */
function fakeExtensionDriver({ online = true } = {}) {
  const calls = []
  return {
    calls,
    connected: () => online,
    status: () => ({
      enabled: true, listening: online, port: 9335, portError: '', paired: true,
      connected: online, clientId: online ? 'ext-fake' : null, sessions: online ? 1 : 0,
      lastHeartbeatMs: null, pairPending: false,
    }),
    sendCommand: async (id, op) => {
      calls.push(['extension', id, op])
      return { clientId: 'ext-fake', value: { op, url: `https://ext.example/${op}` } }
    },
    knownUrl: (id) => `extension:${id}`,
    dispose: async () => {},
  }
}

test('默认内嵌，launch 成功后才切换，另一会话不受影响', async () => {
  const f = fixture()
  assert.equal(f.backend.modeOf('a'), 'embedded')
  await f.backend.sendCommand('a', 'snapshot', {}, 100)
  const launched = await f.backend.execute('a', { action: 'launch', temporary: true })
  assert.equal(launched.backend, 'real')
  assert.equal(launched.previousBackend, 'embedded')
  await f.backend.sendCommand('a', 'snapshot', {}, 100)
  await f.backend.sendCommand('b', 'snapshot', {}, 100)
  assert.deepEqual(f.calls.filter((x) => x[0] === 'embedded' || x[0] === 'real').map((x) => x.slice(0, 3)), [
    ['embedded', 'a', 'snapshot'], ['real', 'a', 'snapshot'], ['embedded', 'b', 'snapshot'],
  ])
})

test('connect 失败保留原后端，sendCommand 不自动降级', async () => {
  const f = fixture()
  const error = new Error('端口不可达')
  error.code = 'CDP_UNREACHABLE'
  f.realDriver.fail = error
  await assert.rejects(f.backend.execute('a', { action: 'connect', endpoint: 'http://127.0.0.1:9222' }), /端口不可达/)
  assert.equal(f.backend.modeOf('a'), 'embedded')
  await f.backend.sendCommand('a', 'snapshot', {}, 100)
  assert.equal(f.calls.at(-1)[0], 'embedded')

  f.realDriver.fail = null
  await f.backend.execute('a', { action: 'launch' })
  f.realDriver.sendCommand = async () => { throw error }
  await assert.rejects(f.backend.sendCommand('a', 'snapshot', {}, 100), /端口不可达/)
  assert.equal(f.calls.filter((x) => x[0] === 'embedded').length, 1)
})

test('embedded 保留真实连接；disconnect 才释放并切回', async () => {
  const f = fixture()
  await f.backend.execute('a', { action: 'launch' })
  await f.backend.execute('a', { action: 'embedded' })
  assert.equal(f.realDriver.connected, true)
  assert.equal(f.calls.some((x) => x[0] === 'disconnect'), false)
  await f.backend.execute('a', { action: 'disconnect', closeBrowser: true })
  assert.equal(f.realDriver.connected, false)
  assert.deepEqual(f.calls.at(-1), ['disconnect', 'a', { closeBrowser: true }])
  assert.equal(f.backend.modeOf('a'), 'embedded')
})

test('status 不携带 undefined，符合 lossless JSON 工具结果约束', async () => {
  const f = fixture()
  const embedded = await f.backend.execute('a', { action: 'status' })
  assert.equal(Object.hasOwn(embedded, 'message'), false)
  assert.equal(Object.hasOwn(embedded, 'real'), false)
  assert.deepEqual(JSON.parse(JSON.stringify(embedded)), embedded)
  await f.backend.execute('a', { action: 'launch', temporary: true })
  const real = await f.backend.execute('a', { action: 'status' })
  assert.equal(real.backend, 'real')
  assert.equal(Object.hasOwn(real, 'message'), false)
  assert.deepEqual(JSON.parse(JSON.stringify(real)), real)
})

test('realBrowser 配置有安全默认值并拒绝拼写和非法启动参数', () => {
  const config = resolveConfig({})
  assert.equal(config.realBrowser.browser, 'auto')
  assert.equal(config.realBrowser.startupTimeoutMs, 30000)
  assert.ok(config.realBrowser.profileDir.includes('real-browser-profiles'))
  assert.equal(resolveConfig({ realBrowser: { browser: 'edge', startupTimeoutMs: 1000 } }).realBrowser.browser, 'edge')
  assert.throws(() => resolveConfig({ realBrowser: { browser: 'firefox' } }), ConfigError)
  assert.throws(() => resolveConfig({ realBrowser: { profielDir: 'x' } }), /unknown key/)
  assert.throws(() => resolveConfig({ realBrowser: { startupTimeoutMs: 10 } }), /between 1000/)
})

test('extension 模式：显式切换成功并路由到扩展 driver，状态 lossless', async () => {
  const extensionDriver = fakeExtensionDriver()
  const f = fixture({ extensionDriver })
  assert.equal(f.backend.modeOf('a'), 'embedded')
  const switched = await f.backend.execute('a', { action: 'extension' })
  assert.equal(switched.backend, 'extension')
  assert.equal(switched.previousBackend, 'embedded')
  assert.equal(switched.extension.connected, true)
  assert.deepEqual(JSON.parse(JSON.stringify(switched)), switched)
  assert.equal(Object.hasOwn(switched, 'message'), true)

  await f.backend.sendCommand('a', 'snapshot', {}, 100)
  assert.deepEqual(f.extensionDriver.calls.at(-1), ['extension', 'a', 'snapshot'])
  assert.equal(f.backend.knownUrl('a'), 'extension:a')
  // 切换只对本会话生效。
  await f.backend.sendCommand('b', 'snapshot', {}, 100)
  assert.equal(f.extensionDriver.calls.length, 1)
  // embedded 切回不销毁扩展连接。
  await f.backend.execute('a', { action: 'embedded' })
  assert.equal(extensionDriver.connected(), true)
  await f.backend.sendCommand('a', 'snapshot', {}, 100)
  assert.deepEqual(f.calls.at(-1), ['embedded', 'a', 'snapshot'])
})

test('extension 离线回 EXTENSION_OFFLINE 且保留原后端；未启用回 EXTENSION_DISABLED', async () => {
  const offline = fixture({ extensionDriver: fakeExtensionDriver({ online: false }) })
  await assert.rejects(
    offline.backend.execute('a', { action: 'extension' }),
    (error) => error.code === 'EXTENSION_OFFLINE' && error.message.includes('browser_ext_pair'),
  )
  assert.equal(offline.backend.modeOf('a'), 'embedded')
  await offline.backend.sendCommand('a', 'snapshot', {}, 100)
  assert.deepEqual(offline.calls.at(-1), ['embedded', 'a', 'snapshot'])

  const noDriver = fixture({})
  await assert.rejects(
    noDriver.backend.execute('a', { action: 'extension' }),
    (error) => error.code === 'EXTENSION_DISABLED' && error.message.includes('extensionBridge.enabled'),
  )
  // 未启用时 status 不携带 extension 字段（lossless：绝不 undefined）。
  const status = await noDriver.backend.execute('a', { action: 'status' })
  assert.equal(Object.hasOwn(status, 'extension'), false)
  assert.deepEqual(JSON.parse(JSON.stringify(status)), status)
})
