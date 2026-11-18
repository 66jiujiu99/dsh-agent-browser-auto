/**
 * 共享契约测试：pageAgent 单一实现源 + 扩展与内嵌的命令表一致。
 *
 * 防漂移的三道闸（对应 EXTENSION_BACKEND.md「快照逻辑抽取共享」）：
 *   1. client.js 与 extension/page-agent.js 的 [PAGE_AGENT_*] 标记块逐字节一致
 *      （仅 export 前缀差异）——两套后端的快照/点击/输入在页面里跑的是同一份代码；
 *   2. extension/background.js 通过 pageAgent 执行的页面级 op 都真实存在于共享函数里；
 *   3. 扩展命令表覆盖 PROTOCOL §2.2 的核心 op，且对内嵌专属 op 明确 NOT_SUPPORTED。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => readFileSync(join(root, relative), 'utf8')

/**
 * 取两个 [PAGE_AGENT_BEGIN]/[PAGE_AGENT_END] 标记行之间的内容。
 * @param {string} source - 文件全文。
 * @param {string} file - 报错用的文件名。
 * @returns {string} 标记块内部文本。
 */
function pageAgentBlock(source, file) {
  const lines = source.split('\n')
  const begin = lines.findIndex((line) => line.includes('[PAGE_AGENT_BEGIN]'))
  const end = lines.findIndex((line) => line.includes('[PAGE_AGENT_END]'))
  assert.ok(begin >= 0 && end > begin, `${file} 缺少 PAGE_AGENT 标记块`)
  return lines.slice(begin + 1, end).join('\n')
}

test('pageAgent 标记块在 client.js 与 extension/page-agent.js 之间逐字节一致', () => {
  const clientBlock = pageAgentBlock(read('client.js'), 'client.js')
  const extensionBlock = pageAgentBlock(read('extension/page-agent.js'), 'extension/page-agent.js')
    .replace('export function pageAgent', 'function pageAgent')
  assert.equal(extensionBlock, clientBlock, '两份 pageAgent 副本出现漂移：请同步修改两侧标记块之间的代码')
})

test('共享 pageAgent 自包含：不引用外部变量、不使用 import/require', () => {
  const block = pageAgentBlock(read('extension/page-agent.js'), 'extension/page-agent.js')
  assert.ok(!/\b(import|require)\b/.test(block), 'pageAgent 必须自包含（会被 toString 注入页面）')
  assert.ok(!/window\.__ModuleLoader__|pluginCtx|deps\.|chrome\./.test(block), 'pageAgent 不得引用宿主/扩展 API')
  assert.match(block, /function pageAgent\(op, args\)/)
})

test('extension/background.js 经 pageAgent 执行的页面 op 都存在于共享函数', () => {
  const shared = pageAgentBlock(read('extension/page-agent.js'), 'extension/page-agent.js')
  const sharedOps = new Set([...shared.matchAll(/case '([a-zA-Z]+)':/g)].map((match) => match[1]))
  assert.ok(sharedOps.has('snapshot'))
  const background = read('extension/background.js')
  const usedOps = [...background.matchAll(/runPageAgent\([^,]+,\s*'([a-zA-Z]+)'/g)].map((match) => match[1])
  assert.ok(usedOps.length >= 10, `background.js 应通过 pageAgent 执行页面操作（实得 ${usedOps.length} 个）`)
  const missing = [...new Set(usedOps)].filter((op) => !sharedOps.has(op))
  assert.deepEqual(missing, [], `background.js 使用了共享 pageAgent 里不存在的 op：${missing.join(', ')}`)
})

/** PROTOCOL §2.2 中扩展桥接必须支持的命令（browser_* 工具在扩展模式的核心面）。 */
const REQUIRED_EXTENSION_OPS = Object.freeze([
  'open', 'snapshot', 'find', 'wait', 'click', 'type', 'select', 'upload',
  'press', 'scroll', 'nav', 'dialog', 'rect', 'tabFront', 'screenshot', 'close', 'ping',
])

/** 其中与内嵌 client.js dispatch 必须对称的 op（tabFront 例外：内嵌后端明确 NOT_SUPPORTED，由真实/扩展后端实现）。 */
const SHARED_WITH_EMBEDDED_OPS = Object.freeze(REQUIRED_EXTENSION_OPS.filter((op) => op !== 'tabFront'))

/** 仅轻量内嵌后端有意义的 op：扩展模式必须明确 NOT_SUPPORTED（而不是静默忽略）。 */
const EMBEDDED_ONLY_OPS = Object.freeze(['tabs', 'console', 'network', 'eval'])

test('扩展命令表：核心 op 全覆盖，内嵌专属 op 明确 NOT_SUPPORTED', () => {
  const background = read('extension/background.js')
  const executeCommand = background.slice(background.indexOf('async function executeCommand'))
  for (const op of REQUIRED_EXTENSION_OPS) {
    assert.ok(executeCommand.includes(`case '${op}':`), `扩展命令表缺少 ${op}`)
  }
  for (const op of SHARED_WITH_EMBEDDED_OPS) {
    // 这些 op 也必须存在于内嵌 client.js 的 dispatch（同一套 Host 工具参数）。
    assert.ok(read('client.js').includes(`case '${op}':`), `内嵌 dispatch 缺少 ${op}`)
  }
  const notSupportedBlock = executeCommand.slice(executeCommand.indexOf("case 'tabs':"), executeCommand.indexOf("default:"))
  for (const op of EMBEDDED_ONLY_OPS) {
    assert.ok(notSupportedBlock.includes(`case '${op}':`), `${op} 应在扩展模式的 NOT_SUPPORTED 分支里`)
  }
  assert.match(notSupportedBlock, /NOT_SUPPORTED/)
})

test('manifest：MV3 必备权限、模块 SW 与弹窗入口齐备', () => {
  const manifest = JSON.parse(read('extension/manifest.json'))
  assert.equal(manifest.manifest_version, 3)
  for (const permission of ['tabs', 'scripting', 'storage', 'offscreen', 'alarms']) {
    assert.ok(manifest.permissions.includes(permission), `manifest 缺少 ${permission} 权限`)
  }
  assert.deepEqual(manifest.host_permissions, ['<all_urls>'])
  assert.equal(manifest.background.type, 'module')
  assert.equal(manifest.background.service_worker, 'background.js')
  assert.equal(manifest.action.default_popup, 'pair.html')
  assert.ok(Number(manifest.minimum_chrome_version) >= 116, 'WS 心跳保活需要 Chrome/Edge 116+')
})

test('offscreen 兜底：KEEP_ALIVE 原因创建、探活-接管-交还三段齐全', () => {
  const background = read('extension/background.js')
  const offscreen = read('extension/offscreen.js')
  assert.match(background, /reasons:\s*\['KEEP_ALIVE'\]/)
  assert.match(background, /OFFSCREEN_DOCUMENT/)
  // 探活（sw-probe）、接管（takeover / bridgeOwner=offscreen）、交还（offscreen-release）。
  assert.match(offscreen, /sw-probe/)
  assert.match(offscreen, /bridgeOwner/)
  assert.match(offscreen, /offscreen-release/)
  assert.match(background, /offscreen-release/)
})
