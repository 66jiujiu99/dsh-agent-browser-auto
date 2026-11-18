/**
 * 专用浏览器实例保障（0.7.0）单元测试：lib/dedicated.js + lib/config.js + lib/prompt.js。
 *
 * 全部走注入实现：不启动真实 Chrome/Edge、不访问外网；唯一的真实网络是本机
 * loopback 上的临时 net server（验证 TCP 探测本身）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { createServer } from 'node:http'
import { resolveConfig, ConfigError } from '../lib/config.js'
import {
  dedicatedEndpoint,
  probePort,
  buildSpawnArgs,
  buildExecutableCandidates,
  resolveExecutablePath,
  ensureDedicatedBrowser,
} from '../lib/dedicated.js'
import { loadDedicatedPrompt } from '../lib/prompt.js'

/**
 * 断言一个工具值是 lossless JSON：JSON 往返不变、任何位置都没有 undefined 值字段。
 * @param {unknown} value - 工具返回值。
 * @returns {void}
 */
function assertLossless(value) {
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value)
  const walk = (node) => {
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    if (node !== null && typeof node === 'object') {
      for (const entry of Object.values(node)) {
        assert.notEqual(entry, undefined, '结果对象里出现了 undefined 值字段')
        walk(entry)
      }
    }
  }
  walk(value)
}

/**
 * 起一个 loopback 临时 server。
 * @param {net.Server|import('node:http').Server} server - 已 listen 的 server。
 * @returns {Promise<number>} 实际端口。
 */
function listenPort(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      resolve(/** @type {import('node:net').AddressInfo} */ (server.address()).port)
    })
  })
}

/** @returns {Promise<number>} 找一个当前空闲的端口（绑定后立刻释放）。 */
async function freePort() {
  const server = net.createServer()
  const port = await listenPort(server)
  await new Promise((resolve) => server.close(resolve))
  return port
}

/**
 * 造一个 fake child 进程（记录 once/unref 调用）。
 * @param {number|null} [pid] - 暴露的 pid。
 * @returns {object} fake child。
 */
function fakeChild(pid = 4321) {
  return {
    pid,
    handlers: {},
    unrefCalls: 0,
    once(event, handler) {
      this.handlers[event] = handler
    },
    emitError(error) {
      this.handlers.error?.(error)
    },
    unref() {
      this.unrefCalls += 1
    },
  }
}

test('probePort 对监听端口返回 true，对关闭端口返回 false', async () => {
  const server = createServer(() => {})
  const port = await listenPort(server)
  try {
    assert.equal(await probePort(port), true)
    assert.equal(await probePort(port, 500), true)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
  const closed = await freePort()
  assert.equal(await probePort(closed, 500), false)
})

test('buildSpawnArgs 输出参数数组：profile、调试端口与免打扰参数', () => {
  assert.deepEqual(
    buildSpawnArgs({ userDataDir: 'C:\\Data\\browser-agent', port: 9333 }),
    [
      '--user-data-dir=C:\\Data\\browser-agent',
      '--remote-debugging-port=9333',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  )
})

test('可执行文件候选：配置路径最优先，browser 决定 msedge/chrome 顺序', () => {
  const winEnv = {
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    ProgramFiles: 'C:\\Program Files',
    LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
  }
  const edge = buildExecutableCandidates({ browser: 'edge', executablePath: 'C:\\edge.exe', env: winEnv, platform: 'win32' })
  assert.deepEqual(edge[0], { kind: 'path', path: 'C:\\edge.exe' })
  assert.deepEqual(edge[1], { kind: 'registry', name: 'msedge' })
  assert.ok(edge.some((entry) => entry.kind === 'path' && entry.path.endsWith('Microsoft\\Edge\\Application\\msedge.exe')))
  assert.ok(edge.some((entry) => entry.kind === 'path' && entry.path.endsWith('Google\\Chrome\\Application\\chrome.exe')))
  const firstBrowserPath = edge.filter((entry) => entry.kind === 'path')[1]
  assert.ok(firstBrowserPath.path.includes('msedge.exe'))

  const chrome = buildExecutableCandidates({ browser: 'chrome', env: winEnv, platform: 'win32' })
  assert.deepEqual(chrome[0], { kind: 'registry', name: 'chrome' })
  const firstChromePath = chrome.filter((entry) => entry.kind === 'path')[0]
  assert.ok(firstChromePath.path.includes('chrome.exe'))

  const darwin = buildExecutableCandidates({ browser: 'edge', env: {}, platform: 'darwin' })
  assert.equal(darwin.filter((entry) => entry.kind === 'registry').length, 0)
  assert.ok(darwin[0].path.includes('Microsoft Edge.app'))
})

test('resolveExecutablePath 按顺序取第一个存在的候选；全部落空返回 null', async () => {
  const existing = new Set(['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'])
  const io = {
    exists: async (filePath) => existing.has(filePath),
    regQueryDefault: async () => null,
  }
  const found = await resolveExecutablePath({ browser: 'edge', executablePath: '', env: { 'ProgramFiles(x86)': 'C:\\Program Files (x86)', ProgramFiles: '', LOCALAPPDATA: '' } }, io)
  assert.ok(String(found).endsWith('msedge.exe'))

  const explicit = await resolveExecutablePath(
    { browser: 'edge', executablePath: 'C:\\custom\\edge.exe', env: {} },
    { exists: async (filePath) => filePath === 'C:\\custom\\edge.exe', regQueryDefault: async () => null },
  )
  assert.equal(explicit, 'C:\\custom\\edge.exe')

  const registryHit = await resolveExecutablePath(
    { browser: 'chrome', executablePath: '', env: {} },
    { exists: async (filePath) => filePath === 'C:\\reg\\chrome.exe', regQueryDefault: async (name) => name === 'chrome' ? 'C:\\reg\\chrome.exe' : null },
  )
  assert.equal(registryHit, 'C:\\reg\\chrome.exe')

  const none = await resolveExecutablePath(
    { browser: 'edge', executablePath: '', env: {} },
    { exists: async () => false, regQueryDefault: async () => null },
  )
  assert.equal(none, null)
})

test('ensure：端口已监听 → 直接成功，不 spawn', async () => {
  const spawnCalls = []
  const value = await ensureDedicatedBrowser(
    { dedicatedBrowser: { enabled: true, port: 9333, userDataDir: 'C:\\Data\\browser-agent', browser: 'edge', executablePath: '', spawnTimeoutMs: 15_000 } },
    { probe: async () => true, spawn: (...args) => spawnCalls.push(args) },
  )
  assert.deepEqual(value, { ok: true, ensured: true, spawned: false, port: 9333, endpoint: 'http://127.0.0.1:9333' })
  assert.equal(spawnCalls.length, 0)
  assertLossless(value)
})

test('ensure：未监听 → spawn（detached/unref/参数数组）并轮询成功', async () => {
  const spawnCalls = []
  const child = fakeChild(4321)
  let probeCalls = 0
  let clock = 1_000
  const delayCalls = []
  const value = await ensureDedicatedBrowser(
    { dedicatedBrowser: { enabled: true, port: 9333, userDataDir: 'C:\\Data\\browser-agent', browser: 'edge', executablePath: '', spawnTimeoutMs: 15_000 } },
    {
      probe: async () => {
        probeCalls += 1
        return probeCalls >= 3
      },
      spawn: (cmd, args, options) => {
        spawnCalls.push({ cmd, args, options })
        return child
      },
      delay: async (ms) => {
        delayCalls.push(ms)
        clock += ms
      },
      now: () => clock,
      resolveExecutable: async () => 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    },
  )
  assert.equal(spawnCalls.length, 1)
  assert.equal(spawnCalls[0].cmd, 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe')
  assert.deepEqual(spawnCalls[0].args, [
    '--user-data-dir=C:\\Data\\browser-agent',
    '--remote-debugging-port=9333',
    '--no-first-run',
    '--no-default-browser-check',
  ])
  assert.equal(spawnCalls[0].options.detached, true)
  assert.equal(spawnCalls[0].options.shell, false)
  assert.equal(spawnCalls[0].options.stdio, 'ignore')
  assert.equal(child.unrefCalls, 1)
  assert.ok(delayCalls.length > 0 && delayCalls.every((ms) => ms === 200), `轮询间隔应为 200ms，实际 ${JSON.stringify(delayCalls)}`)
  assert.deepEqual(value, { ok: true, ensured: true, spawned: true, port: 9333, endpoint: 'http://127.0.0.1:9333', pid: 4321 })
  assertLossless(value)
})

test('ensure：spawn 同步抛错 → SPAWN_FAILED 结构化错误', async () => {
  const value = await ensureDedicatedBrowser(
    { dedicatedBrowser: { enabled: true, port: 9333, userDataDir: 'C:\\Data\\browser-agent', browser: 'edge', executablePath: '', spawnTimeoutMs: 15_000 } },
    {
      probe: async () => false,
      spawn: () => {
        throw new Error('EPERM')
      },
      resolveExecutable: async () => 'C:\\edge.exe',
    },
  )
  assert.equal(value.ok, false)
  assert.equal(value.error.code, 'SPAWN_FAILED')
  assert.ok(String(value.error.message).includes('C:\\edge.exe'))
  assertLossless(value)
})

test('ensure：child error 事件 → SPAWN_FAILED，不再继续轮询', async () => {
  const child = fakeChild(123)
  const probeCalls = []
  let clock = 1_000
  const value = await ensureDedicatedBrowser(
    { dedicatedBrowser: { enabled: true, port: 9333, userDataDir: 'C:\\Data\\browser-agent', browser: 'edge', executablePath: '', spawnTimeoutMs: 15_000 } },
    {
      probe: async () => {
        probeCalls.push(clock)
        return false
      },
      spawn: () => child,
      delay: async () => {
        clock += 200
        child.emitError(new Error('spawn ENOENT'))
      },
      now: () => clock,
      resolveExecutable: async () => 'C:\\edge.exe',
    },
  )
  assert.equal(value.ok, false)
  assert.equal(value.error.code, 'SPAWN_FAILED')
  assert.ok(String(value.error.message).includes('ENOENT'))
  // 只有 spawn 前那一次「是否已监听」探测；出错后不再进入轮询。
  assert.equal(probeCalls.length, 1)
  assertLossless(value)
})

test('ensure：端口始终不监听 → PORT_TIMEOUT（循环有界，会终止）', async () => {
  let clock = 1_000
  let iterations = 0
  const value = await ensureDedicatedBrowser(
    { dedicatedBrowser: { enabled: true, port: 9333, userDataDir: 'C:\\Data\\browser-agent', browser: 'edge', executablePath: '', spawnTimeoutMs: 3_000 } },
    {
      probe: async () => false,
      spawn: () => fakeChild(77),
      delay: async (ms) => {
        clock += ms
        iterations += 1
        assert.ok(iterations < 100, '轮询必须收敛')
      },
      now: () => clock,
      resolveExecutable: async () => 'C:\\edge.exe',
    },
  )
  assert.equal(value.ok, false)
  assert.equal(value.error.code, 'PORT_TIMEOUT')
  assert.ok(String(value.error.message).includes('9333'))
  assert.ok(iterations >= 1)
  assertLossless(value)
})

test('ensure：enabled=false → DEDICATED_DISABLED，且完全不动 spawn', async () => {
  const spawnCalls = []
  const value = await ensureDedicatedBrowser(
    { dedicatedBrowser: { enabled: false, port: 9333, userDataDir: '', browser: 'edge', executablePath: '', spawnTimeoutMs: 15_000 } },
    { probe: async () => true, spawn: (...args) => spawnCalls.push(args) },
  )
  assert.equal(value.ok, false)
  assert.equal(value.error.code, 'DEDICATED_DISABLED')
  assert.ok(String(value.error.message).includes('enabled'))
  assert.equal(spawnCalls.length, 0)
  assertLossless(value)
})

test('ensure：找不到可执行文件 → EXECUTABLE_NOT_FOUND', async () => {
  const value = await ensureDedicatedBrowser(
    { dedicatedBrowser: { enabled: true, port: 9333, userDataDir: 'C:\\Data\\browser-agent', browser: 'edge', executablePath: '', spawnTimeoutMs: 15_000 } },
    { probe: async () => false, resolveExecutable: async () => null },
  )
  assert.equal(value.ok, false)
  assert.equal(value.error.code, 'EXECUTABLE_NOT_FOUND')
  assert.ok(String(value.error.message).includes('executablePath'))
  assertLossless(value)
})

test('真实 TCP 探测贯通 ensure 的「已监听」分支', async () => {
  const server = createServer(() => {})
  const port = await listenPort(server)
  try {
    const value = await ensureDedicatedBrowser(
      { dedicatedBrowser: { enabled: true, port, userDataDir: 'C:\\Data\\browser-agent', browser: 'edge', executablePath: '', spawnTimeoutMs: 15_000 } },
      { spawn: () => { throw new Error('已监听时不应 spawn') } },
    )
    assert.equal(value.ok, true)
    assert.equal(value.spawned, false)
    assert.equal(value.endpoint, dedicatedEndpoint(port))
    assertLossless(value)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('dedicatedBrowser 配置：安全默认值、覆盖与非法值拒绝', () => {
  const defaults = resolveConfig({}).dedicatedBrowser
  assert.equal(defaults.enabled, false)
  assert.equal(defaults.port, 9333)
  assert.equal(defaults.browser, 'edge')
  assert.equal(defaults.executablePath, '')
  assert.equal(defaults.spawnTimeoutMs, 15000)
  assert.ok(defaults.userDataDir.includes('dedicated-profile'))

  const custom = resolveConfig({
    dedicatedBrowser: {
      enabled: true,
      port: 9334,
      userDataDir: 'C:\\Data\\browser-agent',
      browser: 'chrome',
      executablePath: 'C:\\edge.exe',
      spawnTimeoutMs: 5000,
    },
  }).dedicatedBrowser
  assert.equal(custom.enabled, true)
  assert.equal(custom.port, 9334)
  assert.equal(custom.browser, 'chrome')
  assert.equal(custom.executablePath, 'C:\\edge.exe')
  assert.equal(custom.spawnTimeoutMs, 5000)
  assert.ok(custom.userDataDir.endsWith('browser-agent'))

  assert.throws(() => resolveConfig({ dedicatedBrowser: { portIs: 1 } }), ConfigError)
  assert.throws(() => resolveConfig({ dedicatedBrowser: { port: 0 } }), ConfigError)
  assert.throws(() => resolveConfig({ dedicatedBrowser: { port: 65536 } }), ConfigError)
  assert.throws(() => resolveConfig({ dedicatedBrowser: { port: 9333.5 } }), ConfigError)
  assert.throws(() => resolveConfig({ dedicatedBrowser: { browser: 'firefox' } }), ConfigError)
  assert.throws(() => resolveConfig({ dedicatedBrowser: { spawnTimeoutMs: 500 } }), ConfigError)
  assert.throws(() => resolveConfig({ dedicatedBrowser: { spawnTimeoutMs: 999999 } }), ConfigError)
  assert.throws(() => resolveConfig({ dedicatedBrowser: { enabled: 'yes' } }), ConfigError)
  assert.throws(() => resolveConfig({ dedicatedBrowser: { userDataDir: 3 } }), ConfigError)
})

test('loadDedicatedPrompt：读真实 locale，替换 endpoint/port 占位符', async () => {
  const enabled = resolveConfig({ dedicatedBrowser: { enabled: true } })
  const zh = await loadDedicatedPrompt(enabled, { languages: ['zh'] })
  assert.ok(zh.includes('browser_agent_ensure'), zh)
  assert.ok(zh.includes('browser_backend'), zh)
  assert.ok(zh.includes('http://127.0.0.1:9333'), zh)
  assert.ok(!zh.includes('{endpoint}') && !zh.includes('{port}'), zh)
  assert.ok(zh.includes('凭证'), zh)

  const en = await loadDedicatedPrompt(enabled, { languages: ['en'] })
  assert.ok(en.includes('browser_agent_ensure'), en)
  assert.ok(en.includes('http://127.0.0.1:9333'), en)

  // 自定义端口时占位符跟随配置。
  const custom = await loadDedicatedPrompt(
    resolveConfig({ dedicatedBrowser: { enabled: true, port: 9444 } }),
    { languages: ['zh'] },
  )
  assert.ok(custom.includes('http://127.0.0.1:9444'), custom)

  // enabled=false → 空串（不注入）。
  assert.equal(await loadDedicatedPrompt(resolveConfig({})), '')
})

test('loadDedicatedPrompt：zh 缺失回落 en，全缺失/坏 JSON 返回空串', async () => {
  const config = resolveConfig({ dedicatedBrowser: { enabled: true } })
  const ioByLanguage = (languages) => ({
    languages,
    readFile: async (path) => {
      if (path.endsWith('en.json')) return JSON.stringify({ systemPrompt: { dedicatedBrowser: 'en fallback {endpoint}' } })
      throw new Error('missing')
    },
  })
  assert.equal(await loadDedicatedPrompt(config, ioByLanguage(['zh', 'en'])), 'en fallback http://127.0.0.1:9333')
  assert.equal(await loadDedicatedPrompt(config, { readFile: async () => 'not-json', languages: ['zh', 'en'] }), '')
})
