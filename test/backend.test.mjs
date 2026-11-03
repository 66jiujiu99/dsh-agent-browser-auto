import test from 'node:test'
import assert from 'node:assert/strict'
import { createBackendRouter } from '../lib/backend.js'
import { resolveConfig, ConfigError } from '../lib/config.js'

function fixture() {
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
  return { calls, bridge, realDriver, backend: createBackendRouter({ bridge, realDriver }) }
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
