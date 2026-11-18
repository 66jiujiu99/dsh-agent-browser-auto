/**
 * DSH Agent 浏览器桥 —— offscreen 兜底文档。
 *
 * 职责（与 background.js 的注释、EXTENSION_BACKEND.md 对齐）：
 * 1. **保活**：每 15s 向 service worker 发一次探活（chrome.runtime 消息会唤醒/保活 SW，
 *    同时重置 SW 30s 休眠计时器）——这让 SW 的主连接在所有版本上都常驻；
 * 2. **接管**：探活连续失败（SW 被杀且无法唤醒的边缘情况）时，offscreen 自己开同一条
 *    WS（同一个 token/clientId，Host 侧按同 clientId 重连顶掉旧连接），Host 下发的命令
 *    经 chrome.runtime 转交并唤醒 SW；所有权记在 chrome.storage.session 的 `bridgeOwner`；
 * 3. **交还**：SW 探活连续 3 次成功后发 offscreen-release，offscreen 关闭自己的连接，
 *    SW 恢复直连。
 *
 * 本文档由 chrome.offscreen 以 KEEP_ALIVE 原因创建，宿主保证其长期存活。
 */

const PROBE_INTERVAL_MS = 15_000
const PROBE_TIMEOUT_MS = 5_000
const RELEASE_AFTER_ALIVE = 3
const DEFAULT_HOST_PORT = 9335

/** @type {WebSocket|undefined} */
let ws
let owner = false
let aliveStreak = 0

function log(...args) {
  console.log('[dsh-bridge-offscreen]', ...args)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 带超时的探活：SW 死透（连消息都唤不醒）时超时拒绝。 */
function probe() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('probe-timeout')), PROBE_TIMEOUT_MS)
    try {
      chrome.runtime.sendMessage({ target: 'sw', type: 'sw-probe' })
        .then((response) => {
          clearTimeout(timer)
          resolve(response)
        })
        .catch((error) => {
          clearTimeout(timer)
          reject(error)
        })
    } catch (error) {
      clearTimeout(timer)
      reject(error)
    }
  })
}

async function setOwnerFlag(value) {
  try {
    const current = await chrome.storage.session.get({ bridgeOwner: 'sw' })
    // 只在所有权确实属于当前声称方时改写，避免覆盖 SW 刚 reclaim 的状态。
    if (value === 'offscreen' || current.bridgeOwner === 'offscreen') {
      await chrome.storage.session.set({ bridgeOwner: value })
    }
  } catch {
    // storage.session 不可用时只影响所有权记账，主流程照走。
  }
}

/** 接管连接：用存储里的长效 token 开 WS（与 SW 同一条通道、同一个 clientId）。 */
async function takeover() {
  if (owner) return
  let store
  try {
    store = await chrome.storage.local.get({ clientId: '', bridgeToken: '', hostPort: 0 })
  } catch {
    return
  }
  if (!store.bridgeToken) return
  const port = Number(store.hostPort) || DEFAULT_HOST_PORT
  log('taking over the bridge connection on port', port)
  try {
    ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(store.bridgeToken)}`)
  } catch (error) {
    log('takeover connect failed:', String(error && error.message ? error.message : error))
    return
  }
  ws.onopen = () => {
    owner = true
    aliveStreak = 0
    void setOwnerFlag('offscreen')
    ws.send(JSON.stringify({ type: 'hello', clientId: store.clientId || undefined, version: 1 }))
    log('offscreen owns the connection')
  }
  ws.onmessage = (event) => {
    let message
    try {
      message = JSON.parse(String(event.data))
    } catch {
      return
    }
    if (message && message.type === 'ping') {
      // 心跳不走 SW：offscreen 直接回，省一次跨进程唤醒。
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'pong', t: typeof message.t === 'number' ? message.t : 0 }))
      return
    }
    // 其余消息（command/ready/superseded…）转交 SW 并顺带唤醒它；SW 的回包
    // 经 runtime 消息 {target:'offscreen', type:'ws-send'} 送回这里再上 WS。
    chrome.runtime.sendMessage({ target: 'sw', type: 'ws-inbound', payload: message }).catch(() => {})
  }
  ws.onclose = (event) => {
    log('offscreen connection closed')
    if (ws === event.target) ws = undefined
    owner = false
    void setOwnerFlag('sw')
  }
  ws.onerror = () => {
    log('offscreen connection error')
  }
}

/** 交还所有权：通知 SW 重连，稍后关闭自己的连接（Host 会按 clientId 顶掉旧连接）。 */
async function release() {
  if (!owner) return
  log('handing ownership back to service worker')
  try {
    await chrome.runtime.sendMessage({ target: 'sw', type: 'offscreen-release' })
  } catch {
    // SW 还没醒也没关系：它下次被唤醒的启动块会自行 connect。
  }
  await sleep(3_000)
  if (ws && owner) {
    const closing = ws
    owner = false
    await setOwnerFlag('sw')
    try { closing.close(4000, 'offscreen-release') } catch { /* 忽略 */ }
  }
}

/** 探活主循环：保活 SW；失败即接管，连续成功即交还。 */
async function probeLoop() {
  for (;;) {
    try {
      const response = await probe()
      aliveStreak = response && response.alive === true ? aliveStreak + 1 : 0
      if (owner && aliveStreak >= RELEASE_AFTER_ALIVE) await release()
    } catch {
      aliveStreak = 0
      if (!owner) await takeover()
    }
    await sleep(PROBE_INTERVAL_MS)
  }
}

/** SW（或自己持有连接时）要求把一条消息送上 WS。 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== 'offscreen') return false
  if (message.type === 'ws-send') {
    if (owner && ws && ws.readyState === 1 && message.payload && typeof message.payload === 'object') {
      try {
        ws.send(JSON.stringify(message.payload))
        sendResponse({ ok: true })
      } catch (error) {
        sendResponse({ ok: false, message: String(error && error.message ? error.message : error) })
      }
    } else {
      sendResponse({ ok: false, message: owner ? 'ws not open' : 'offscreen does not own the connection' })
    }
    return false
  }
  return false
})

void probeLoop()
