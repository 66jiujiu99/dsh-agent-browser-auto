/**
 * 专用浏览器实例保障（0.7.0）：`browser_agent_ensure` 的 Host 侧实现。
 *
 * 职责边界（刻意收窄）：只保证「浏览器进程活着、调试端口在监听」——
 * TCP 探测 `127.0.0.1:<port>`（默认 9333），未监听才拉起浏览器并轮询端口。
 * **不做 CDP 连接**：连接仍由 agent 用 `browser_backend {action:"connect"}` 完成。
 *
 * 安全边界：
 * - `port` / `userDataDir` 只来自插件配置，工具不接受任何参数覆盖，
 *   防止提示注入把任意参数塞进浏览器启动命令；
 * - endpoint 恒为 `http://127.0.0.1:<port>`（loopback），不接受远程地址；
 * - spawn 用参数数组 + `shell:false`，元素永远不经过 shell 解析；
 * - `detached:true` + `child.unref()`：浏览器进程不属于 Host 进程树，
 *   Host 退出/重启不会牵连浏览器（Windows 实测必要条件）。
 *
 * 可测试性：探活、延迟、时钟、spawn、可执行文件解析全部可注入，
 * 单测不启动真实浏览器、不访问网络。
 *
 * @module dsh-agent-browser-auto/dedicated
 */

import net from 'node:net'
import { spawn as nodeSpawn, execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'

/** 专用实例默认端口（与 cordis.patch.yml / README / systemPrompt 文案对齐）。 */
export const DEDICATED_DEFAULT_PORT = 9333

/** 拉起后端口轮询的默认总期限。 */
export const DEDICATED_DEFAULT_TIMEOUT_MS = 15_000

/** 端口轮询间隔（200ms，见验收需求）。 */
export const DEDICATED_POLL_INTERVAL_MS = 200

/** 单次 TCP 探测的连接超时；loopback 上拒绝是即时的，超时只是兜底。 */
export const DEDICATED_PROBE_TIMEOUT_MS = 1_000

/** 专用实例 endpoint（恒为 loopback）。 @param {number} port - 端口。 @returns {string} endpoint。 */
export function dedicatedEndpoint(port) {
  return `http://127.0.0.1:${port}`
}

/**
 * 带稳定错误码的错误（工具层 failureValue 会透出 code/message）。
 */
export class DedicatedError extends Error {
  /**
   * @param {string} code - 稳定错误码（SPAWN_FAILED / PORT_TIMEOUT / EXECUTABLE_NOT_FOUND）。
   * @param {string} message - 可读原因。
   */
  constructor(code, message) {
    super(message)
    this.name = 'DedicatedError'
    this.code = code
  }
}

/**
 * TCP 探测：端口有进程监听 → true；拒绝/超时/任何错误 → false。
 * 只连 `127.0.0.1`，不接受其它主机（专用实例只允许 loopback）。
 * @param {number} port - 端口。
 * @param {number} [timeoutMs] - 单次连接超时。
 * @returns {Promise<boolean>} 是否已有监听。
 */
export function probePort(port, timeoutMs = DEDICATED_PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    let settled = false
    /**
     * 收尾：只取第一次结论，销毁 socket。
     * @param {boolean} ok - 探测结论。
     * @returns {void}
     */
    const finish = (ok) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(ok)
    }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(timeoutMs, () => finish(false))
    try {
      socket.connect(port, '127.0.0.1')
    } catch {
      finish(false)
    }
  })
}

/**
 * 组装浏览器启动参数数组（纯函数，测试直接断言数组形状）。
 * 参数永远是数组元素，不经 shell 拼接；profile 目录与端口全部来自配置。
 * @param {object} spec - 启动规格。
 * @param {string} spec.userDataDir - 独立 profile 目录（配置提供）。
 * @param {number} spec.port - 远程调试端口（配置提供）。
 * @returns {string[]} 启动参数数组。
 */
export function buildSpawnArgs({ userDataDir, port }) {
  return [
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${String(port)}`,
    '--no-first-run',
    '--no-default-browser-check',
  ]
}

/** Windows 上探测可执行文件的目录环境变量（按常见安装优先级排序）。 */
const WINDOWS_DIR_KEYS = Object.freeze(['ProgramFiles(x86)', 'ProgramFiles', 'LOCALAPPDATA'])

/** 各浏览器的 Windows 相对安装路径。 */
const WINDOWS_RELATIVE = Object.freeze({
  msedge: Object.freeze(['Microsoft', 'Edge', 'Application', 'msedge.exe']),
  chrome: Object.freeze(['Google', 'Chrome', 'Application', 'chrome.exe']),
})

/** 各浏览器在 macOS 的常见路径。 */
const DARWIN_PATHS = Object.freeze({
  msedge: Object.freeze(['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']),
  chrome: Object.freeze(['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']),
})

/** 各浏览器在 Linux 的常见路径。 */
const LINUX_PATHS = Object.freeze({
  msedge: Object.freeze(['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable']),
  chrome: Object.freeze(['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome']),
})

/** Windows 注册表 App Paths 键前缀（HKLM 优先，HKCU 兜底 Chrome 用户级安装）。 */
const REGISTRY_PREFIXES = Object.freeze([
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\',
  'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\',
])

/**
 * 构造可执行文件候选清单（纯函数；顺序即探测顺序）：
 * 配置 `executablePath` → 注册表 App Paths → 常见安装路径；
 * `browser:edge` 优先 msedge.exe（找不到再退 chrome.exe），`chrome` 相反。
 * 候选是 `{kind:'path',path}` 或 `{kind:'registry',name}`（win32 才有 registry）。
 * @param {object} [options] - 候选参数。
 * @param {string} [options.browser] - 'edge' | 'chrome'。
 * @param {string} [options.executablePath] - 配置显式指定的可执行文件路径。
 * @param {NodeJS.ProcessEnv} [options.env] - 环境变量（测试注入）。
 * @param {string} [options.platform] - 平台（测试注入）。
 * @returns {Array<{kind:'path',path:string}|{kind:'registry',name:string}>} 候选清单。
 */
export function buildExecutableCandidates({ browser = 'edge', executablePath = '', env = process.env, platform = process.platform } = {}) {
  const order = browser === 'chrome' ? ['chrome', 'msedge'] : ['msedge', 'chrome']
  const candidates = []
  if (typeof executablePath === 'string' && executablePath.trim() !== '') {
    candidates.push({ kind: 'path', path: executablePath.trim() })
  }
  for (const name of order) {
    if (platform === 'win32') {
      candidates.push({ kind: 'registry', name })
      for (const key of WINDOWS_DIR_KEYS) {
        const dir = env[key]
        if (typeof dir === 'string' && dir !== '') {
          candidates.push({ kind: 'path', path: join(dir, ...WINDOWS_RELATIVE[name]) })
        }
      }
    } else if (platform === 'darwin') {
      for (const filePath of DARWIN_PATHS[name]) candidates.push({ kind: 'path', path: filePath })
    } else {
      for (const filePath of LINUX_PATHS[name]) candidates.push({ kind: 'path', path: filePath })
    }
  }
  return candidates
}

/**
 * 默认存在性检查：路径存在且是普通文件。
 * @param {string} filePath - 候选路径。
 * @returns {Promise<boolean>} 结论。
 */
async function defaultExists(filePath) {
  try {
    return (await stat(filePath)).isFile()
  } catch {
    return false
  }
}

/**
 * 读注册表 App Paths 的默认值（win32 专用；失败/非 win32 返回 null）。
 * `reg query <key> /ve` 的输出里默认值跟在 `REG_SZ` 后面。
 * @param {string} executableName - 如 `msedge.exe`。
 * @returns {Promise<string|null>} 可执行文件完整路径；拿不到为 null。
 */
export function readRegistryDefault(executableName) {
  if (process.platform !== 'win32') return Promise.resolve(null)
  const keys = REGISTRY_PREFIXES.map((prefix) => `${prefix}${executableName}`)
  /**
   * 逐个键尝试，第一个成功即返回。
   * @param {number} index - 当前键下标。
   * @returns {Promise<string|null>} 结果。
   */
  const attempt = (index) => {
    if (index >= keys.length) return Promise.resolve(null)
    return new Promise((resolve) => {
      execFile('reg', ['query', keys[index], '/ve'], { timeout: 3_000, windowsHide: true }, (error, stdout) => {
        if (error !== null || typeof stdout !== 'string') {
          resolve(attempt(index + 1))
          return
        }
        const match = stdout.match(/REG_SZ\s+(\S[^\r\n]*)/)
        const value = match === null ? '' : match[1].trim()
        resolve(value !== '' ? value : attempt(index + 1))
      })
    })
  }
  return attempt(0)
}

/**
 * 按候选清单解析浏览器可执行文件；全部落空返回 null。
 * @param {object} dconfig - `config.dedicatedBrowser`。
 * @param {object} [io] - 注入实现（测试用）。
 * @param {(filePath: string) => Promise<boolean>} [io.exists] - 存在性检查。
 * @param {(name: string) => Promise<string|null>} [io.regQueryDefault] - 注册表查询。
 * @returns {Promise<string|null>} 可执行文件路径。
 */
export async function resolveExecutablePath(dconfig, io = {}) {
  const exists = io.exists ?? defaultExists
  const regQueryDefault = io.regQueryDefault ?? readRegistryDefault
  for (const candidate of buildExecutableCandidates(dconfig)) {
    if (candidate.kind === 'registry') {
      const found = await regQueryDefault(candidate.name)
      if (typeof found === 'string' && found !== '' && await exists(found)) return found
    } else if (await exists(candidate.path)) {
      return candidate.path
    }
  }
  return null
}

/**
 * 保障专用实例在跑（工具执行体）。
 * 返回值刻意保持 lossless JSON：成功对象不带多余键，失败回 `{ok:false,error:{code,message}}`。
 * @param {object} config - 已解析插件配置（含 `dedicatedBrowser`）。
 * @param {object} [deps] - 注入实现（测试用；缺省用真实系统调用）。
 * @param {(port: number, timeoutMs?: number) => Promise<boolean>} [deps.probe] - 端口探测。
 * @param {(cmd: string, args: string[], options: object) => {pid?: number|null, once?: Function, unref?: Function}} [deps.spawn] - 进程启动。
 * @param {(ms: number) => Promise<void>} [deps.delay] - 轮询间隔等待。
 * @param {() => number} [deps.now] - 时钟。
 * @param {(dconfig: object, io?: object) => Promise<string|null>} [deps.resolveExecutable] - 可执行文件解析。
 * @returns {Promise<Record<string, unknown>>} 工具值。
 */
export async function ensureDedicatedBrowser(config, deps = {}) {
  const dconfig = config?.dedicatedBrowser
  if (dconfig?.enabled !== true) {
    return {
      ok: false,
      error: {
        code: 'DEDICATED_DISABLED',
        message: '专用浏览器实例未启用（dedicatedBrowser.enabled=false）：请让用户在 cordis.patch.yml 的 agent-browser-auto 配置里打开 dedicatedBrowser.enabled。',
      },
    }
  }
  const probe = deps.probe ?? probePort
  const delay = deps.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const now = deps.now ?? Date.now
  const spawnImpl = deps.spawn ?? nodeSpawn
  const resolveExecutable = deps.resolveExecutable ?? resolveExecutablePath
  const port = dconfig.port
  const endpoint = dedicatedEndpoint(port)

  // 1) 已监听 → 直接成功，绝不重复拉起第二个实例。
  if (await probe(port, DEDICATED_PROBE_TIMEOUT_MS)) {
    return { ok: true, ensured: true, spawned: false, port, endpoint }
  }

  // 2) 找可执行文件：配置路径 → 注册表/常见安装路径 msedge → chrome。
  const executable = await resolveExecutable(dconfig)
  if (typeof executable !== 'string' || executable === '') {
    return {
      ok: false,
      error: {
        code: 'EXECUTABLE_NOT_FOUND',
        message: '没有找到可用的 Chrome/Edge 可执行文件：请确认已安装，或在 dedicatedBrowser.executablePath 里显式指定完整路径。',
      },
    }
  }

  // 3) 拉起：detached + unref（浏览器不挂在 Host 进程树下）、参数数组、不走 shell。
  const args = buildSpawnArgs({ userDataDir: dconfig.userDataDir, port })
  let child
  try {
    child = spawnImpl(executable, args, { detached: true, stdio: 'ignore', shell: false, windowsHide: true })
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'SPAWN_FAILED',
        message: `启动浏览器失败（${executable}）：${String(error?.message ?? error)}`,
      },
    }
  }
  const pid = typeof child?.pid === 'number' ? child.pid : null
  let spawnFailure = null
  child.once?.('error', (error) => {
    spawnFailure = error
  })
  try {
    child.unref?.()
  } catch {
    // unref 只是解绑进程引用，失败不影响探测流程。
  }

  // 4) 轮询端口直到监听或超时。
  const deadline = now() + dconfig.spawnTimeoutMs
  while (now() < deadline) {
    await delay(DEDICATED_POLL_INTERVAL_MS)
    if (spawnFailure !== null) {
      return {
        ok: false,
        error: {
          code: 'SPAWN_FAILED',
          message: `启动浏览器失败（${executable}）：${String(spawnFailure?.message ?? spawnFailure)}`,
        },
      }
    }
    if (await probe(port, DEDICATED_PROBE_TIMEOUT_MS)) {
      const value = { ok: true, ensured: true, spawned: true, port, endpoint }
      if (pid !== null) value.pid = pid
      return value
    }
  }
  return {
    ok: false,
    error: {
      code: 'PORT_TIMEOUT',
      message: `浏览器进程已启动${pid !== null ? `（pid=${pid}）` : ''}，但端口 ${port} 在 ${dconfig.spawnTimeoutMs}ms 内未开始监听：可能被占用或启动参数被覆盖，请检查 dedicatedBrowser 配置。`,
    },
  }
}
