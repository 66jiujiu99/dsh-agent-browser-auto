/**
 * Playwright 真实驱动测试。
 *
 * 所有页面、iframe、网络请求都指向 127.0.0.1 随机端口；不访问外网、DeepSeek 或任何敏感站点。
 * 真实浏览器使用 Playwright temporary profile，结束后 dispose 并关闭本地 server。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRealDriver } from '../lib/real-driver.js'

const NODE_TEST_TIMEOUT = 180_000

const FIXTURE_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>真实驱动 fixture</title>
<style>
  body { font: 16px/1.4 sans-serif; margin: 20px; }
  button, input, select { margin: 5px; padding: 6px; }
  [hidden] { display: none !important; }
  #spacer { height: 1100px; background: linear-gradient(#fff,#eee); }
</style></head><body>
<h1>本地真实浏览器 fixture</h1>
<button id="increment" type="button">点击加一</button>
<label for="text-input">文本框</label><input id="text-input" placeholder="请输入文本">
<select id="city" aria-label="城市"><option value="">请选择</option><option value="chengdu">成都</option><option value="leshan">乐山</option></select>
<button id="custom" type="button" aria-haspopup="listbox" aria-expanded="false">自定义城市</button>
<ul id="custom-list" role="listbox" hidden><li role="option" data-value="chengdu">成都</li><li role="option" data-value="leshan">乐山</li></ul>
<label for="upload">上传附件</label><input id="upload" type="file" multiple>
<button id="prompt" type="button">打开 prompt</button>
<button id="delayed" type="button">延迟显示</button>
<div id="late" hidden>延迟内容</div><button id="hide-late" type="button" hidden>隐藏延迟内容</button>
<button id="fetch" type="button">加载本地数据</button>
<a id="second" href="?page=two">第二页</a>
<div>纯文字定位目标</div>
<div id="shadow-host"></div>
<iframe id="child" src="/frame" title="本地子框架" style="width:320px;height:100px"></iframe>
<output id="result">ready</output>
<div id="spacer">长页面</div><button id="bottom" type="button">底部按钮</button>
<script>
  const result = document.querySelector('#result');
  const show = (value) => { result.textContent = String(value); };
  document.querySelector('#increment').addEventListener('click', () => show('clicked'));
  document.querySelector('#text-input').addEventListener('input', (event) => show('input:' + event.target.value));
  document.querySelector('#city').addEventListener('change', (event) => show('city:' + event.target.value));
  const custom = document.querySelector('#custom');
  const list = document.querySelector('#custom-list');
  custom.addEventListener('click', () => { list.hidden = !list.hidden; custom.setAttribute('aria-expanded', String(!list.hidden)); });
  list.addEventListener('click', (event) => {
    const option = event.target.closest('[role=option]');
    if (!option) return;
    show('custom:' + option.dataset.value);
    custom.textContent = option.textContent;
    list.hidden = true;
  });
  document.querySelector('#upload').addEventListener('change', (event) => show([...event.target.files].map((file) => file.name + ':' + file.size).join(',')));
  document.querySelector('#prompt').addEventListener('click', () => show('prompt:' + prompt('fixture prompt', 'default-text')));
  document.querySelector('#delayed').addEventListener('click', () => setTimeout(() => {
    document.querySelector('#late').hidden = false;
    document.querySelector('#hide-late').hidden = false;
    show('late-visible');
  }, 300));
  document.querySelector('#hide-late').addEventListener('click', () => { document.querySelector('#late').hidden = true; show('late-hidden'); });
  document.querySelector('#fetch').addEventListener('click', async () => {
    const response = await fetch('/data');
    show(await response.text());
  });
  document.querySelector('#shadow-host').attachShadow({ mode: 'open' }).innerHTML = '<button id="shadow-button" type="button">影子按钮</button>';
  document.querySelector('#shadow-host').shadowRoot.querySelector('button').addEventListener('click', () => show('shadow-clicked'));
  console.log('fixture console ready');
</script></body></html>`

const FRAME_HTML = '<!doctype html><html><body><button id="frame-button" type="button">子框架按钮</button><script>document.querySelector("button").onclick=()=>{parent.document.querySelector("#result").textContent="frame-clicked"}</script></body></html>'

/**
 * 启动只服务固定内容的 loopback fixture。
 * @returns {Promise<{origin:string,close:()=>Promise<void>}>} fixture。
 */
async function startFixture() {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname
    if (pathname === '/data') {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      response.end('local-data-ok')
      return
    }
    if (pathname === '/frame') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      response.end(FRAME_HTML)
      return
    }
    if (pathname !== '/' && pathname !== '/fixture') {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('not found')
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    response.end(FIXTURE_HTML)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise((resolve) => server.close(resolve))
      server.closeAllConnections?.()
    },
  }
}

/** @param {unknown} error - 错误。 @param {string} code - 期望码。 @returns {boolean} 断言。 */
function hasCode(error, code) {
  assert.ok(error instanceof Error)
  assert.equal(error.code, code)
  return true
}

/** @param {object} driver - 驱动。 @param {string} session - session。 @param {object} [options] - 快照参数。 @returns {Promise<object>} snapshot。 */
async function takeSnapshot(driver, session, options = {}) {
  const result = await driver.sendCommand(session, 'snapshot', options, 15_000)
  return result.value.snapshot
}

/** @param {object} snapshot - 快照。 @param {string} name - 精确名称。 @returns {object} 元素。 */
function elementNamed(snapshot, name) {
  const element = snapshot.elements.find((item) => item.name === name)
  assert.ok(element, `快照里找不到 ${JSON.stringify(name)}；实际: ${snapshot.elements.map((item) => item.name).join(' | ')}`)
  return element
}

test('安全参数与未知会话在启动浏览器前失败', async (t) => {
  const driver = createRealDriver({ config: { auditDir: join(tmpdir(), 'unused-real-driver'), commandTimeoutMs: 1000 } })
  t.after(() => driver.dispose())
  for (const endpoint of ['http://example.com:9222', 'http://192.168.1.2:9222', 'file:///tmp/chrome', 'http://user:pass@127.0.0.1:9222']) {
    await assert.rejects(driver.connectSession('unsafe', { endpoint }), (error) => hasCode(error, 'BAD_ARG'))
  }
  await assert.rejects(driver.connectSession('bad-browser', { browser: 'firefox', temporary: true }), (error) => hasCode(error, 'BAD_ARG'))
  await assert.rejects(driver.sendCommand('missing', 'snapshot', {}, 100), (error) => hasCode(error, 'NO_PAGE'))
  assert.equal(driver.status('missing'), null)
  assert.equal(driver.knownUrl('missing'), undefined)
})

test('真实 Chrome/Edge：完整操作、locator refs、shadow/iframe 与资源清理', { timeout: NODE_TEST_TIMEOUT }, async (t) => {
  const selectedBrowser = process.env.REAL_BROWSER || 'auto'
  assert.ok(['auto', 'chrome', 'edge'].includes(selectedBrowser), 'REAL_BROWSER 只能是 auto/chrome/edge')
  const fixture = await startFixture()
  const temp = await mkdtemp(join(tmpdir(), 'real-driver-test-'))
  const driver = createRealDriver({
    config: {
      auditDir: join(temp, 'audit'),
      commandTimeoutMs: 20_000,
      realBrowser: { browser: selectedBrowser, profileDir: join(temp, 'profiles'), startupTimeoutMs: 30_000 },
    },
    log: () => {},
  })
  const session = 'real-e2e-session'
  let cleaned = false
  t.after(async () => {
    if (cleaned) return
    await driver.dispose()
    await fixture.close()
    await rm(temp, { recursive: true, force: true })
  })

  const connected = await driver.connectSession(session, { browser: selectedBrowser, temporary: true })
  assert.equal(connected.clientId, 'playwright')
  assert.equal(connected.mode, 'launch')
  assert.equal(connected.temporary, true)
  assert.equal(connected.profileDir, null)
  assert.equal(connected.pageCount, 1)

  const call = async (op, args = {}, timeoutMs = 20_000) => {
    const result = await driver.sendCommand(session, op, args, timeoutMs)
    assert.equal(result.clientId, 'playwright')
    return result.value
  }
  const evaluate = async (code) => (await call('eval', { code })).value
  const fixtureUrl = `${fixture.origin}/fixture`
  const opened = await call('open', { url: fixtureUrl, snapshot: false })
  assert.equal(opened.url, fixtureUrl)
  assert.equal(driver.knownUrl(session), fixtureUrl)

  let snapshot = await takeSnapshot(driver, session, { text: true, scope: 'document', maxElements: 300 })
  assert.equal(snapshot.scope, 'document')
  assert.equal(snapshot.url, fixtureUrl)
  assert.ok(snapshot.text.includes('本地真实浏览器 fixture'))
  assert.ok(snapshot.frames.shadowRoots >= 1)
  assert.ok(snapshot.frames.sameOrigin >= 1)
  assert.ok(snapshot.elements.some((element) => element.name === '影子按钮'))
  assert.ok(snapshot.elements.some((element) => element.name === '子框架按钮'))

  const incrementRef = elementNamed(snapshot, '点击加一').ref
  const typedRef = snapshot.elements.find((item) => item.name === '请输入文本' && item.role === 'textbox')?.ref
  assert.ok(typedRef)
  await call('type', { ref: typedRef, text: 'abc', clear: true, snapshot: false })
  assert.equal(await evaluate('document.querySelector("#text-input").value'), 'abc')
  await call('press', { key: 'Control+A', snapshot: false })
  await call('press', { key: 'Delete', snapshot: false })
  assert.equal(await evaluate('document.querySelector("#text-input").value'), '')
  await call('type', { ref: typedRef, text: '重新输入', clear: true, snapshot: false })
  assert.equal(await evaluate('document.querySelector("#text-input").value'), '重新输入')

  await call('click', { ref: incrementRef, snapshot: false })
  assert.equal(await evaluate('document.querySelector("#result").textContent'), 'clicked')
  const incrementPoint = await evaluate('(() => { const r = document.querySelector("#increment").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()')
  await evaluate('document.querySelector("#result").textContent = "coordinate-reset"')
  await call('click', { ...incrementPoint, snapshot: false })
  assert.equal(await evaluate('document.querySelector("#result").textContent'), 'clicked')
  await call('click', { ref: elementNamed(snapshot, '影子按钮').ref, snapshot: false })
  assert.equal(await evaluate('document.querySelector("#result").textContent'), 'shadow-clicked')
  await call('click', { ref: elementNamed(snapshot, '子框架按钮').ref, snapshot: false })
  assert.equal(await evaluate('document.querySelector("#result").textContent'), 'frame-clicked')

  snapshot = await takeSnapshot(driver, session, { scope: 'document', maxElements: 300 })
  await call('select', { ref: elementNamed(snapshot, '城市').ref, label: '成都', snapshot: false })
  assert.equal(await evaluate('document.querySelector("#city").value'), 'chengdu')
  await call('select', { ref: elementNamed(snapshot, '自定义城市').ref, value: 'leshan', snapshot: false })
  assert.equal(await evaluate('document.querySelector("#result").textContent'), 'custom:leshan')

  const files = [
    { name: 'hello.txt', type: 'text/plain', base64: Buffer.from('hello', 'utf8').toString('base64') },
    { name: 'empty.bin', type: 'application/octet-stream', base64: '' },
  ]
  const uploadRef = snapshot.elements.find((item) => item.name === '上传附件' && item.role === 'textbox')?.ref
  assert.ok(uploadRef)
  const uploaded = await call('upload', { ref: uploadRef, files, snapshot: false })
  assert.deepEqual(uploaded.files, [{ name: 'hello.txt', size: 5 }, { name: 'empty.bin', size: 0 }])
  await assert.rejects(call('upload', { ref: uploadRef, paths: ['C:\\secret.txt'] }), (error) => hasCode(error, 'BAD_ARG'))

  await call('dialog', { action: 'accept', promptText: 'playwright-text' })
  await call('click', { ref: elementNamed(snapshot, '打开 prompt').ref, snapshot: false })
  assert.equal(await evaluate('document.querySelector("#result").textContent'), 'prompt:playwright-text')

  await call('click', { ref: elementNamed(snapshot, '延迟显示').ref, snapshot: false })
  const waited = await call('wait', { selector: '#late', state: 'visible', timeoutMs: 3000, snapshot: false })
  assert.equal(waited.action, 'wait')
  const lateSnapshot = await takeSnapshot(driver, session, { scope: 'document', maxElements: 300 })
  await call('click', { ref: elementNamed(lateSnapshot, '隐藏延迟内容').ref, snapshot: false })
  await call('wait', { text: 'late-visible', state: 'hidden', timeoutMs: 3000, snapshot: false })
  await assert.rejects(call('wait', { selector: '#never-exists', timeoutMs: 100, snapshot: false }), (error) => hasCode(error, 'WAIT_TIMEOUT'))

  const found = await call('find', { text: '点击加一', limit: 5 })
  assert.ok(found.matches.some((match) => match.ref === incrementRef))
  const fallback = await call('find', { text: '纯文字定位目标' })
  assert.equal(fallback.matches[0].fallback, true)
  assert.ok(Number.isFinite(fallback.matches[0].x))

  await evaluate('window.scrollTo(0, 0)')
  const scrolled = await call('scroll', { dy: 700, snapshot: false })
  assert.equal(scrolled.changed, true)
  assert.ok(scrolled.scroll.y > 0)

  await call('click', { ref: elementNamed(snapshot, '加载本地数据').ref, snapshot: false })
  await call('wait', { text: 'local-data-ok', timeoutMs: 3000, snapshot: false })
  const consoleEntries = (await call('console', { limit: 20 })).entries
  assert.ok(consoleEntries.some((entry) => entry.text.includes('fixture console ready')))
  const networkEntries = (await call('network', { limit: 100 })).entries
  assert.ok(networkEntries.some((entry) => entry.url.endsWith('/data') && entry.status === 200))

  const shot = await call('screenshot', { fullPage: false })
  assert.ok(shot.path.endsWith('.png'))
  assert.ok(shot.bytes > 100)
  assert.ok(shot.width > 0 && shot.height > 0)
  assert.equal(shot.url, fixtureUrl)
  assert.equal((await stat(shot.path)).size, shot.bytes)
  assert.ok((await readFile(shot.path)).subarray(1, 4).toString() === 'PNG')

  const oldRef = incrementRef
  const twoUrl = `${fixtureUrl}?page=two`
  assert.equal((await call('nav', { action: 'goto', url: twoUrl, snapshot: false })).url, twoUrl)
  await assert.rejects(call('click', { ref: oldRef, snapshot: false }), (error) => hasCode(error, 'NO_REF'))
  assert.equal((await call('nav', { action: 'back', snapshot: false })).url, fixtureUrl)
  assert.equal((await call('nav', { action: 'forward', snapshot: false })).url, twoUrl)
  assert.equal((await call('nav', { action: 'reload', snapshot: false })).url, twoUrl)
  await assert.rejects(call('nav', { action: 'forward', snapshot: false }), (error) => hasCode(error, 'NAV_BLOCKED'))
  const literalUrl = `${fixtureUrl}?literal=*[x]`
  await call('nav', { action: 'goto', url: literalUrl, snapshot: false })
  await call('wait', { url: '*[x]', timeoutMs: 500, snapshot: false })

  const firstTab = (await call('tabs', { action: 'list' })).activeId
  const secondTab = (await call('tabs', { action: 'new' })).activeId
  assert.notEqual(firstTab, secondTab)
  await call('open', { url: `${fixtureUrl}?tab=second`, newTab: false, snapshot: false })
  assert.equal((await call('tabs', { action: 'list' })).tabs.length, 2)
  assert.equal((await call('tabs', { action: 'switch', id: firstTab })).activeId, firstTab)
  assert.equal((await call('tabs', { action: 'switch', id: secondTab })).activeId, secondTab)
  const afterActiveClose = await call('tabs', { action: 'close', id: secondTab })
  assert.equal(afterActiveClose.tabs.length, 1)
  assert.equal(afterActiveClose.activeId, firstTab)

  const disconnected = await driver.disconnectSession(session)
  assert.equal(disconnected.browserClosed, false)
  assert.equal(disconnected.closedPages, 0)
  assert.equal(driver.status(session).connected, false)
  assert.equal(driver.status(session).pageCount, 1)
  await driver.connectSession(session, { browser: selectedBrowser, temporary: true })
  assert.equal(driver.status(session).connected, true)
  assert.equal(driver.status(session).pageCount, 1)
  assert.equal(driver.status(session).activeId, firstTab)
  await driver.disconnectSession(session, { closeBrowser: true })
  assert.equal(driver.status(session), null)

  const persistentSession = 'stable-profile-session'
  const persistentFirst = await driver.connectSession(persistentSession, { browser: selectedBrowser, temporary: false })
  assert.equal(persistentFirst.temporary, false)
  assert.equal(dirname(persistentFirst.profileDir), join(temp, 'profiles'))
  assert.match(persistentFirst.profileDir, /[a-f0-9]{24}$/)
  await driver.disconnectSession(persistentSession, { closeBrowser: true })
  const persistentSecond = await driver.connectSession(persistentSession, { browser: selectedBrowser, temporary: false })
  assert.equal(persistentSecond.profileDir, persistentFirst.profileDir)
  await driver.disconnectSession(persistentSession, { closeBrowser: true })

  cleaned = true
  await driver.dispose()
  await fixture.close()
  await rm(temp, { recursive: true, force: true })
})
