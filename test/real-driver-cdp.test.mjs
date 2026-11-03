/**
 * 真实 CDP attach 测试：只使用本测试创建的临时浏览器和本地 fixture。
 * 验证页面隔离、pageUrl 精确共享，以及断开/卸载不关闭外部页面。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { createRealDriver } from '../lib/real-driver.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function startFixture() {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><title>CDP fixture</title><button id="button">CDP 按钮</button><p>${String(request.url).replace(/[<>&]/g, '')}</p>`)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  }
}

async function readDevToolsPort(userDataDir) {
  const file = join(userDataDir, 'DevToolsActivePort')
  let lastError
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const text = await readFile(file, 'utf8')
      const port = Number(text.split(/\r?\n/u)[0])
      if (Number.isInteger(port) && port > 0 && port <= 65535) return port
    } catch (error) {
      lastError = error
    }
    await sleep(100)
  }
  throw new Error(`DevToolsActivePort 未就绪: ${String(lastError || '无有效端口')}`)
}

test('CDP：仅控制新页或精确共享页，断开与 dispose 保留外部浏览器', { timeout: 120_000 }, async (t) => {
  const selected = process.env.REAL_BROWSER || 'chrome'
  assert.ok(['chrome', 'edge'].includes(selected), 'CDP 测试 REAL_BROWSER 只能是 chrome/edge')
  const fixture = await startFixture()
  const temp = await mkdtemp(join(tmpdir(), 'real-driver-cdp-'))
  const userDataDir = join(temp, 'owner-profile')
  let ownerContext
  const driver = createRealDriver({
    config: {
      auditDir: join(temp, 'audit'),
      commandTimeoutMs: 10_000,
      realBrowser: { profileDir: join(temp, 'unused'), startupTimeoutMs: 15_000 },
    },
    log: () => {},
  })
  t.after(async () => {
    await driver.dispose()
    if (ownerContext) await ownerContext.close().catch(() => {})
    await fixture.close()
    await rm(temp, { recursive: true, force: true })
  })

  ownerContext = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    channel: selected === 'edge' ? 'msedge' : 'chrome',
    viewport: null,
    args: ['--remote-debugging-port=0'],
    timeout: 30_000,
  })
  const port = await readDevToolsPort(userDataDir)
  const endpoint = `http://127.0.0.1:${port}`
  const sharedUrl = `${fixture.origin}/shared`
  const otherUrl = `${fixture.origin}/other`
  const shared = await ownerContext.newPage()
  await shared.goto(sharedUrl)
  const other = await ownerContext.newPage()
  await other.goto(otherUrl)
  const originalPages = ownerContext.pages().length

  await driver.connectSession('cdp-new-only', { endpoint })
  const newOnly = await driver.sendCommand('cdp-new-only', 'tabs', { action: 'list' })
  assert.equal(newOnly.value.tabs.length, 1)
  assert.equal(newOnly.value.tabs[0].url, 'about:blank')
  assert.equal(ownerContext.pages().length, originalPages + 1)
  await driver.disconnectSession('cdp-new-only')
  assert.equal(ownerContext.pages().length, originalPages + 1)
  assert.equal(shared.isClosed(), false)
  assert.equal(other.isClosed(), false)

  await assert.rejects(
    driver.connectSession('cdp-missing', { endpoint, pageUrl: `${fixture.origin}/missing` }),
    (error) => error && error.code === 'NO_PAGE',
  )
  assert.equal(shared.isClosed(), false)
  assert.equal(other.isClosed(), false)
  assert.equal(ownerContext.pages().length, originalPages + 1)

  await driver.connectSession('cdp-shared', { endpoint, pageUrl: sharedUrl })
  const attached = await driver.sendCommand('cdp-shared', 'snapshot', { scope: 'document' })
  assert.equal(attached.value.snapshot.url, sharedUrl)
  assert.equal(attached.value.snapshot.elements.some((element) => element.name === 'CDP 按钮'), true)
  const tabs = await driver.sendCommand('cdp-shared', 'tabs', { action: 'list' })
  assert.equal(tabs.value.tabs.length, 1)
  assert.equal(tabs.value.tabs[0].url, sharedUrl)

  await driver.dispose()
  assert.equal(shared.isClosed(), false)
  assert.equal(other.isClosed(), false)
  assert.equal(ownerContext.pages().length, originalPages + 1)
  assert.equal(await shared.title(), 'CDP fixture')
})
