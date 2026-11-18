/**
 * DSH Agent 浏览器桥 —— 配对弹窗逻辑。
 * 只与 background.js 通信（runtime 消息），不做任何网络请求。
 */

const statusEl = document.getElementById('status')
const portEl = document.getElementById('port')
const codeEl = document.getElementById('code')
const pairBtn = document.getElementById('pair')
const unpairBtn = document.getElementById('unpair')

const STATE_LABEL = {
  online: '已连接：agent 可以操作本浏览器的标签页',
  connecting: '连接中…',
  backoff: '连接断开，正在自动重连…',
  offline: '未连接',
}

function send(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message).then(resolve).catch(() => resolve(null))
    } catch {
      resolve(null)
    }
  })
}

async function refresh() {
  const state = await send({ target: 'sw', type: 'state-query' })
  if (!state) {
    statusEl.textContent = '后台未就绪，稍后再试'
    statusEl.className = 'status bad'
    return
  }
  const suffix = state.lastError ? `（${state.lastError}）` : ''
  const ownerNote = state.owner === 'offscreen' ? ' · offscreen 持有连接' : ''
  statusEl.textContent = `${STATE_LABEL[state.state] || state.state}${suffix}${ownerNote}`
  statusEl.className = state.state === 'online' ? 'status ok' : 'status bad'
  portEl.value = String(state.hostPort || 9335)
}

pairBtn.addEventListener('click', async () => {
  const code = codeEl.value.trim().toUpperCase()
  const port = Number(portEl.value) || 9335
  if (!code) {
    statusEl.textContent = '请先输入配对码'
    statusEl.className = 'status bad'
    return
  }
  pairBtn.disabled = true
  statusEl.textContent = '配对中…'
  statusEl.className = 'status'
  const response = await send({ target: 'sw', type: 'pair', code, port })
  if (response && response.ok === false) {
    statusEl.textContent = response.message || '配对失败'
    statusEl.className = 'status bad'
  }
  // 成功路径的结果由 background 的 pair-result 消息回调更新。
})

unpairBtn.addEventListener('click', async () => {
  await send({ target: 'sw', type: 'unpair' })
  statusEl.textContent = '已清除配对'
  statusEl.className = 'status bad'
  void refresh()
})

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.target !== 'popup' || message.type !== 'pair-result') return false
  pairBtn.disabled = false
  if (message.ok === true) {
    statusEl.textContent = '配对成功：连接已建立'
    statusEl.className = 'status ok'
  } else {
    statusEl.textContent = message.message || '配对失败'
    statusEl.className = 'status bad'
  }
  void refresh()
  return false
})

void refresh()
setInterval(() => void refresh(), 2000)
