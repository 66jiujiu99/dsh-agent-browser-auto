/**
 * 13 个模型可见工具（PROTOCOL §3）：`browser_open` … `browser_close`。
 *
 * 每个工具都是纯对象定义 + `ctx.tools.register()`，没有任何 `@deepseek-ai/*`
 * 值导入。执行路径统一为：
 *
 *   参数校验 →（仅 open/goto）Host 侧 URL 预校验 → bridge.sendCommand
 *   → 结果值 `{ok:true, …}` / 失败值 `{ok:false, error:{code,message}}`
 *   → 写一条 audit.jsonl
 *
 * 失败**不抛异常**：抛异常会把工具结果变成框架级错误，模型看不到「为什么」。
 * `output.render` 只做排版与截断（见 `./render.js`）。
 *
 * @module dsh-plugin-browser-hands/tools
 */

import { BridgeError } from './bridge.js'
import { deltaBlock, renderToolText } from './render.js'
import { CdpError, DEEP_HELP, deepSnapshot } from './cdp.js'

/** 上一帧全量快照缓存（sessionId → snapshot），只在动作后算 delta 用；进程内、不落盘。 */
const lastSnapshots = new Map()

/** 这些工具的动作结果在 URL 未变时走增量渲染。 */
const DELTA_TOOLS = new Set(['browser_click', 'browser_type', 'browser_press', 'browser_scroll', 'browser_nav'])

/** 输出 schema 的公共 `error` 片段。 */
const ERROR_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    code: { type: 'string' },
    message: { type: 'string' },
  },
})

/** 页面快照的宽松 schema：Client 保证形状，这里只做类型提示。 */
const SNAPSHOT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    pageId: { type: 'string' },
    url: { type: 'string' },
    title: { type: 'string' },
    scope: { type: 'string' },
    offscreen: { type: 'number' },
    text: { type: 'string' },
    scroll: { type: 'object' },
    elements: { type: 'array', items: { type: 'object' } },
    stats: { type: 'object' },
    truncated: { type: 'object' },
  },
})

/** 工具名清单（注册与自检都从这里取）。 */
export const BROWSER_TOOL_NAMES = Object.freeze([
  'browser_open',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_press',
  'browser_scroll',
  'browser_nav',
  'browser_find',
  'browser_deep_snapshot',
  'browser_screenshot',
  'browser_tabs',
  'browser_console',
  'browser_network',
  'browser_eval',
  'browser_close',
])

/**
 * 是否是普通对象。
 * @param {unknown} value - 任意值。
 * @returns {boolean} 结论。
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 取本次调用所属的会话 id（ToolRunContext 上 `agent.id`）。
 * @param {unknown} exec - 工具执行上下文。
 * @returns {string} 会话 id，取不到时为 `'unknown'`。
 */
function sessionOf(exec) {
  const id = isRecord(exec) && isRecord(exec.agent) ? exec.agent.id : undefined
  return typeof id === 'string' && id !== '' ? id : 'unknown'
}

/**
 * 组装成功值：Client 的 `value` 是数据，`ok` 只能由 Host 写。
 * @param {unknown} raw - Client 返回值。
 * @returns {Record<string, unknown>} 工具值。
 */
function successValue(raw) {
  if (isRecord(raw)) return { ...raw, ok: true }
  return { ok: true, value: raw === undefined ? null : raw }
}

/**
 * 组装失败值。
 * @param {unknown} error - 捕获到的错误。
 * @returns {{ ok: false, error: { code: string, message: string } }} 工具值。
 */
function failureValue(error) {
  if (error instanceof BridgeError) {
    return { ok: false, error: { code: error.code, message: error.message } }
  }
  // CdpError 等自带稳定 code 的错误原样透出（如 DEEP_UNAVAILABLE / CDP_TIMEOUT）。
  if (isRecord(error) && typeof error.code === 'string' && error.code !== '') {
    return { ok: false, error: { code: error.code, message: String(error.message ?? error) } }
  }
  return { ok: false, error: { code: 'INTERNAL', message: String(error?.message ?? error) } }
}

/**
 * 审计里的参数精简形式（长字符串截断）。
 * @param {unknown} args - 模型给的参数。
 * @returns {unknown} 精简结果。
 */
function summarizeArgs(args) {
  if (!isRecord(args)) return args ?? null
  /** @type {Record<string, unknown>} */
  const summary = {}
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string') summary[key] = value.length > 200 ? `${value.slice(0, 200)}…` : value
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) summary[key] = value
    else summary[key] = '[object]'
  }
  return summary
}

/**
 * 读必填字符串。
 * @param {Record<string, unknown>} raw - 工具参数。
 * @param {string} key - 参数名。
 * @param {string} hint - 出错时给模型的提示。
 * @returns {string} 值。
 */
function requireString(raw, key, hint) {
  const value = raw[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BridgeError('BAD_ARGUMENTS', `参数 ${key} 必须是非空字符串：${hint}`)
  }
  return value
}

/**
 * 读必填数字。
 * @param {Record<string, unknown>} raw - 工具参数。
 * @param {string} key - 参数名。
 * @param {number} min - 允许的最小值。
 * @param {number} max - 允许的最大值。
 * @returns {number} 值。
 */
function requireNumber(raw, key, min, max) {
  const value = raw[key]
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new BridgeError('BAD_ARGUMENTS', `参数 ${key} 必须是 ${min}~${max} 之间的数字，收到 ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * 读可选数字。
 * @param {Record<string, unknown>} raw - 工具参数。
 * @param {string} key - 参数名。
 * @param {number} min - 允许的最小值。
 * @param {number} max - 允许的最大值。
 * @returns {number|undefined} 值。
 */
function optionalNumber(raw, key, min, max) {
  const value = raw[key]
  if (value === undefined || value === null) return undefined
  return requireNumber(raw, key, min, max)
}

/**
 * 读可选布尔（缺省按 `fallback`）。
 * @param {Record<string, unknown>} raw - 工具参数。
 * @param {string} key - 参数名。
 * @param {boolean} fallback - 缺省值。
 * @returns {boolean} 值。
 */
function optionalBoolean(raw, key, fallback) {
  const value = raw[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') throw new BridgeError('BAD_ARGUMENTS', `参数 ${key} 必须是布尔值`)
  return value
}

/**
 * 校验「动作后是否回快照」开关（协议默认 true）。
 * @param {Record<string, unknown>} raw - 工具参数。
 * @returns {boolean} 是否回快照。
 */
function snapshotFlag(raw) {
  return optionalBoolean(raw, 'snapshot', true)
}

/**
 * 动作类工具（点击/输入/按键/滚动/导航/打开）回快照时的默认参数。
 *
 * 默认 scope:viewport（client 侧 snapshot 的 `text` 本就默认 false，最省 token，
 * 无需显式下发）。snapshot:false 时不带 scope。模型如要看文本，用 browser_snapshot
 * 传 text:true（动作类工具的 `text` 语义被占用，不能顺带要文本）。
 * @param {Record<string, unknown>} raw - 工具参数。
 * @returns {Record<string, unknown>} 快照参数片段。
 */
function actionSnapshotArgs(raw) {
  const snapshot = snapshotFlag(raw)
  if (!snapshot) return { snapshot: false }
  // 动作类工具只回视口内元素；要看全部/正文时模型改用 browser_snapshot。
  return { snapshot: true, scope: 'viewport' }
}

/**
 * 校验导航目标（open / nav goto 共用）。
 * @param {object} deps - 依赖。
 * @param {ReturnType<import('./guard.js').createNavigator>} deps.navigator - URL 校验器。
 * @param {unknown} raw - 原始 URL。
 * @returns {string} 规范化后的 href。
 */
function requireNavigableUrl({ navigator }, raw) {
  const checked = navigator.checkUrl(raw)
  if (checked.ok !== true) throw new BridgeError(checked.code, checked.message)
  return checked.href
}

/**
 * 建一个工具定义（统一的 execute 骨架 + 输出 schema）。
 * @param {object} deps - 依赖。
 * @param {import('./config.js').ResolvedConfig} deps.config - 配置。
 * @param {ReturnType<import('./bridge.js').createBridge>} deps.bridge - 命令总线。
 * @param {ReturnType<import('./audit.js').createAudit>} deps.audit - 审计器。
 * @param {ReturnType<import('./guard.js').createNavigator>} deps.navigator - URL 校验器。
 * @param {object} spec - 工具规格。
 * @param {string} spec.name - 工具名。
 * @param {string} spec.description - 一行描述。
 * @param {Record<string, unknown>} spec.parameters - 参数 JSON Schema。
 * @param {string} spec.op - 协议 §2.2 的 op。
 * @param {Record<string, unknown>} spec.outputProperties - 输出 schema 的额外属性。
 * @param {(raw: Record<string, unknown>, deps: object) => Record<string, unknown>} spec.buildArgs - 参数整理。
 * @returns {object} `ctx.tools.register()` 接受的定义。
 */
function makeTool(deps, spec) {
  const { config, bridge, audit } = deps
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, error: ERROR_SCHEMA, ...spec.outputProperties },
        required: ['ok'],
      },
      render: (args, value) => [{
        type: 'text',
        text: renderToolText(spec.name, value, config.maxResultBytes, args),
      }],
    },
    /**
     * 下发命令并组装结果值。
     * @param {unknown} rawArgs - 模型给的参数。
     * @param {unknown} exec - 工具执行上下文。
     * @returns {Promise<Record<string, unknown>>} 结果值。
     */
    async execute(rawArgs, exec) {
      const startedAt = Date.now()
      const sessionId = sessionOf(exec)
      const raw = isRecord(rawArgs) ? rawArgs : {}
      const urlBefore = bridge.knownUrl(sessionId)
      let value
      let clientId
      try {
        const opArgs = spec.buildArgs(raw, deps)
        const result = await bridge.sendCommand(sessionId, spec.op, opArgs, config.commandTimeoutMs)
        clientId = result.clientId
        value = successValue(result.value)
      } catch (error) {
        clientId = isRecord(error) && typeof error.clientId === 'string' ? error.clientId : undefined
        value = failureValue(error)
      }
      const snapshotUrl = isRecord(value.snapshot) && typeof value.snapshot.url === 'string' ? value.snapshot.url : undefined
      // 同页动作回增量：URL 没变时只把「变化的那几行」交给模型（首帧/URL 变化/无上一帧 → 全量）。
      if (value.ok === true && isRecord(value.snapshot) && DELTA_TOOLS.has(spec.name)) {
        const before = lastSnapshots.get(sessionId)
        if (before !== undefined) {
          const delta = deltaBlock(value, before)
          if (delta !== '') value.__deltaText = delta
        }
      }
      if (value.ok === true && isRecord(value.snapshot)) lastSnapshots.set(sessionId, value.snapshot)
      const valueUrl = typeof value.url === 'string' ? value.url : undefined
      audit.audit({
        sessionId,
        tool: spec.name,
        op: spec.op,
        args: summarizeArgs(raw),
        urlBefore: urlBefore ?? null,
        urlAfter: valueUrl ?? snapshotUrl ?? null,
        ok: value.ok === true,
        error: value.ok === true ? null : `${value.error.code}: ${value.error.message}`,
        ms: Date.now() - startedAt,
        clientId: clientId ?? null,
      })
      return value
    },
  }
}

/**
 * 建一个「Host 直连」工具定义：不走 bridge，直接在本进程执行（如 CDP 深度快照）。
 *
 * @param {object} deps - 依赖（与 {@link makeTool} 相同）。
 * @param {object} spec - 工具规格。
 * @param {string} spec.name - 工具名。
 * @param {string} spec.description - 一行描述。
 * @param {Record<string, unknown>} spec.parameters - 参数 JSON Schema。
 * @param {string} spec.op - 审计里的 op 名。
 * @param {Record<string, unknown>} spec.outputProperties - 输出 schema 的额外属性。
 * @param {(raw: Record<string, unknown>, ctx: { sessionId: string, urlBefore: string|undefined }) => Promise<Record<string, unknown>>} spec.run - 执行体。
 * @returns {object} `ctx.tools.register()` 接受的定义。
 */
function makeDirectTool(deps, spec) {
  const { config, bridge, audit } = deps
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, error: ERROR_SCHEMA, ...spec.outputProperties },
        required: ['ok'],
      },
      render: (args, value) => [{
        type: 'text',
        text: renderToolText(spec.name, value, config.maxResultBytes, args),
      }],
    },
    /**
     * 直接执行并组装结果值。
     * @param {unknown} rawArgs - 模型给的参数。
     * @param {unknown} exec - 工具执行上下文。
     * @returns {Promise<Record<string, unknown>>} 结果值。
     */
    async execute(rawArgs, exec) {
      const startedAt = Date.now()
      const sessionId = sessionOf(exec)
      const raw = isRecord(rawArgs) ? rawArgs : {}
      const urlBefore = bridge.knownUrl(sessionId)
      let value
      try {
        value = await spec.run(raw, { sessionId, urlBefore })
      } catch (error) {
        value = failureValue(error)
      }
      const urlAfter = isRecord(value.target) && typeof value.target.url === 'string' ? value.target.url : null
      audit.audit({
        sessionId,
        tool: spec.name,
        op: spec.op,
        args: summarizeArgs(raw),
        urlBefore: urlBefore ?? null,
        urlAfter,
        ok: value.ok === true,
        error: value.ok === true ? null : `${value.error.code}: ${value.error.message}`,
        ms: Date.now() - startedAt,
        clientId: null,
      })
      return value
    },
  }
}

/**
 * 构造全部工具定义。
 * @param {object} deps - 依赖。
 * @param {import('./config.js').ResolvedConfig} deps.config - 配置。
 * @param {ReturnType<import('./bridge.js').createBridge>} deps.bridge - 命令总线。
 * @param {ReturnType<import('./audit.js').createAudit>} deps.audit - 审计器。
 * @param {ReturnType<import('./guard.js').createNavigator>} deps.navigator - URL 校验器。
 * @returns {object[]} 13 个工具定义。
 */
export function buildBrowserTools(deps) {
  return [
    makeTool(deps, {
      name: 'browser_open',
      description: 'Open an absolute http(s) URL in the visible sidebar browser and return a fresh snapshot of '
        + 'interactive @refs (viewport only, no page text, to save tokens).',
      op: 'open',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Absolute http(s) URL to open.' },
          newTab: { type: 'boolean', description: 'Open in a new page of the panel instead of reusing the active one.' },
          waitMs: { type: 'number', description: 'Extra wait for the page to settle, in milliseconds (default 8000).' },
          scope: {
            type: 'string',
            enum: ['viewport', 'document'],
            description: 'viewport (default) lists only on-screen elements; document lists all.',
          },
        },
        required: ['url'],
        additionalProperties: false,
      },
      outputProperties: {
        pageId: { type: 'string' },
        url: { type: 'string' },
        title: { type: 'string' },
        snapshot: SNAPSHOT_SCHEMA,
      },
      buildArgs(raw, toolsDeps) {
        const url = requireNavigableUrl(toolsDeps, raw.url)
        const args = { url, scope: 'viewport' }
        if (raw.newTab !== undefined) args.newTab = optionalBoolean(raw, 'newTab', false)
        if (raw.scope === 'document') args.scope = 'document'
        const waitMs = optionalNumber(raw, 'waitMs', 0, 120_000)
        if (waitMs !== undefined) args.waitMs = waitMs
        return args
      },
    }),

    makeTool(deps, {
      name: 'browser_snapshot',
      description: 'Re-read the current page of the sidebar browser. By default returns only the interactive '
        + 'elements (low token cost). Set text:true to also include page text (capped by textLimit). Set '
        + 'scope:document to list elements outside the viewport too.',
      op: 'snapshot',
      parameters: {
        type: 'object',
        properties: {
          maxElements: { type: 'number', description: 'Maximum interactive elements to return (default 80).' },
          text: { type: 'boolean', description: 'Also return page text (default false — elements only, to save tokens).' },
          textLimit: { type: 'number', description: 'When text:true, max characters of page text (default 3000).' },
          scope: {
            type: 'string',
            enum: ['viewport', 'document'],
            description: 'viewport (default) lists only on-screen elements; document lists all.',
          },
        },
        additionalProperties: false,
      },
      outputProperties: { snapshot: SNAPSHOT_SCHEMA },
      buildArgs(raw) {
        const args = {}
        const maxElements = optionalNumber(raw, 'maxElements', 1, 500)
        if (maxElements !== undefined) args.maxElements = Math.floor(maxElements)
        const textLimit = optionalNumber(raw, 'textLimit', 1, 50_000)
        if (textLimit !== undefined) args.textLimit = Math.floor(textLimit)
        if (raw.text === true) args.text = true
        if (raw.scope === 'document') args.scope = 'document'
        return args
      },
    }),

    makeTool(deps, {
      name: 'browser_click',
      description: 'Click an element by @ref (preferred) or by viewport coordinates x/y, then report whether '
        + 'the page changed (with a fresh snapshot unless snapshot:false).',
      op: 'click',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Element ref from the latest snapshot, e.g. @e12.' },
          x: { type: 'number', description: 'Viewport x coordinate (use with y instead of ref).' },
          y: { type: 'number', description: 'Viewport y coordinate (use with x instead of ref).' },
          snapshot: { type: 'boolean', description: 'Return a fresh snapshot afterwards (default true).' },
        },
        additionalProperties: false,
      },
      outputProperties: {
        action: { type: 'string' },
        changed: { type: 'boolean' },
        snapshot: SNAPSHOT_SCHEMA,
      },
      buildArgs(raw) {
        const args = actionSnapshotArgs(raw)
        const ref = typeof raw.ref === 'string' ? raw.ref.trim() : ''
        if (ref !== '') {
          args.ref = ref
          return args
        }
        const hasX = raw.x !== undefined && raw.x !== null
        const hasY = raw.y !== undefined && raw.y !== null
        if (hasX && hasY) {
          args.x = requireNumber(raw, 'x', 0, 100_000)
          args.y = requireNumber(raw, 'y', 0, 100_000)
          return args
        }
        throw new BridgeError('BAD_ARGUMENTS', 'click 需要 ref（如 @e12），或者同时给出视口坐标 x 与 y')
      },
    }),

    makeTool(deps, {
      name: 'browser_type',
      description: 'Type text into the element with @ref; set clear to replace its current value, submit to '
        + 'press Enter, then report whether the page changed.',
      op: 'type',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Element ref of the input/textarea, e.g. @e3.' },
          text: { type: 'string', description: 'Text to type.' },
          clear: { type: 'boolean', description: 'Clear the field before typing (default false).' },
          submit: { type: 'boolean', description: 'Press Enter after typing (default false).' },
          snapshot: { type: 'boolean', description: 'Return a fresh snapshot afterwards (default true).' },
        },
        required: ['ref', 'text'],
        additionalProperties: false,
      },
      outputProperties: {
        action: { type: 'string' },
        changed: { type: 'boolean' },
        snapshot: SNAPSHOT_SCHEMA,
      },
      buildArgs(raw) {
        const ref = requireString(raw, 'ref', '先用 browser_snapshot 拿到 @ref')
        if (typeof raw.text !== 'string') {
          throw new BridgeError('BAD_ARGUMENTS', '参数 text 必须是字符串（可以为空串表示只做 clear）')
        }
        return {
          ref,
          text: raw.text,
          clear: optionalBoolean(raw, 'clear', false),
          submit: optionalBoolean(raw, 'submit', false),
          ...actionSnapshotArgs(raw),
        }
      },
    }),

    makeTool(deps, {
      name: 'browser_press',
      description: 'Press one keyboard key in the page (Enter, Tab, Escape, ArrowDown, Control+A, …); '
        + 'use it for form submission and keyboard navigation.',
      op: 'press',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Key name or chord, e.g. Enter or Control+A.' },
          snapshot: { type: 'boolean', description: 'Return a fresh snapshot afterwards (default true).' },
        },
        required: ['key'],
        additionalProperties: false,
      },
      outputProperties: {
        action: { type: 'string' },
        changed: { type: 'boolean' },
        snapshot: SNAPSHOT_SCHEMA,
      },
      buildArgs(raw) {
        return { key: requireString(raw, 'key', '例如 Enter'), ...actionSnapshotArgs(raw) }
      },
    }),

    makeTool(deps, {
      name: 'browser_scroll',
      description: 'Scroll the page vertically by dy pixels (positive scrolls down); dx is optional horizontal '
        + 'scroll.',
      op: 'scroll',
      parameters: {
        type: 'object',
        properties: {
          dy: { type: 'number', description: 'Vertical delta in pixels; positive scrolls down.' },
          dx: { type: 'number', description: 'Horizontal delta in pixels (default 0).' },
          snapshot: { type: 'boolean', description: 'Return a fresh snapshot afterwards (default true).' },
        },
        required: ['dy'],
        additionalProperties: false,
      },
      outputProperties: {
        action: { type: 'string' },
        scroll: { type: 'object' },
        snapshot: SNAPSHOT_SCHEMA,
      },
      buildArgs(raw) {
        const args = { dy: requireNumber(raw, 'dy', -100_000, 100_000), ...actionSnapshotArgs(raw) }
        const dx = optionalNumber(raw, 'dx', -100_000, 100_000)
        if (dx !== undefined) args.dx = dx
        return args
      },
    }),

    makeTool(deps, {
      name: 'browser_nav',
      description: 'Navigate the sidebar page: back, forward, reload, or goto an absolute http(s) URL.',
      op: 'nav',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['back', 'forward', 'reload', 'goto'],
            description: 'Navigation action.',
          },
          url: { type: 'string', description: 'Absolute http(s) URL; required when action is goto.' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      outputProperties: {
        action: { type: 'string' },
        url: { type: 'string' },
        title: { type: 'string' },
        snapshot: SNAPSHOT_SCHEMA,
      },
      buildArgs(raw, toolsDeps) {
        const action = requireString(raw, 'action', 'back / forward / reload / goto')
        if (!['back', 'forward', 'reload', 'goto'].includes(action)) {
          throw new BridgeError('BAD_ARGUMENTS', `nav 的 action 只能是 back/forward/reload/goto，收到 ${action}`)
        }
        if (action === 'goto') {
          return { action, url: requireNavigableUrl(toolsDeps, raw.url), snapshot: true, scope: 'viewport' }
        }
        return { action, snapshot: true, scope: 'viewport' }
      },
    }),

    makeTool(deps, {
      name: 'browser_screenshot',
      description: 'Capture the sidebar page as a PNG saved on the host disk and return its absolute path '
        + '(readable with read_image). fullPage captures the whole scrollable page.',
      op: 'screenshot',
      parameters: {
        type: 'object',
        properties: {
          fullPage: { type: 'boolean', description: 'Capture the full scrollable page (default false: viewport only).' },
        },
        additionalProperties: false,
      },
      outputProperties: {
        path: { type: 'string' },
        bytes: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
        pageId: { type: 'string' },
        url: { type: 'string' },
      },
      buildArgs(raw) {
        return { fullPage: optionalBoolean(raw, 'fullPage', false) }
      },
    }),

    makeTool(deps, {
      name: 'browser_find',
      description: 'Find interactive elements by their visible name/value anywhere in the document (including '
        + 'open shadow roots and same-origin iframes, even outside the viewport), and get their @refs. '
        + 'Cheaper than a full snapshot when the element is not listed: scrolls the first match into view.',
      op: 'find',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Case-insensitive substring to match against element name or current value.' },
          limit: { type: 'number', description: 'Maximum matches to return (default 20, max 50).' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      outputProperties: {
        query: { type: 'string' },
        matches: { type: 'array', items: { type: 'object' } },
      },
      buildArgs(raw) {
        const needle = typeof raw.text === 'string' ? raw.text.trim() : ''
        if (needle === '') throw new BridgeError('BAD_ARG', 'browser_find 需要非空的 text')
        const args = { text: needle }
        const limit = optionalNumber(raw, 'limit', 1, 50)
        if (limit !== undefined) args.limit = Math.floor(limit)
        return args
      },
    }),

    makeDirectTool(deps, {
      name: 'browser_deep_snapshot',
      description: 'Deep snapshot via the Chrome DevTools Protocol (CDP): reads the real page target\'s '
        + 'accessibility tree (covers closed shadow roots and cross-origin iframes) with top-level viewport '
        + 'coordinates. Requires DSH restarted via tools\\start-dsh-debug.cmd and deepMode.enabled=true; '
        + 'otherwise it fails with DEEP_UNAVAILABLE. Read-only: it never clicks or types.',
      op: 'deep-snapshot',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Page URL to snapshot; defaults to the last URL this session opened.' },
          maxNodes: { type: 'number', description: 'Maximum nodes to return (default from config, 200; max 2000).' },
          scope: {
            type: 'string',
            enum: ['a11y', 'dom'],
            description: 'a11y (default) uses the accessibility tree; dom uses the pierced DOM tree.',
          },
          includeFrames: { type: 'boolean', description: 'Descend into cross-origin iframes (default true).' },
        },
        additionalProperties: false,
      },
      outputProperties: {
        target: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            type: { type: 'string' },
            title: { type: 'string' },
          },
        },
        nodes: { type: 'array', items: { type: 'object' } },
        stats: { type: 'object' },
      },
      async run(raw, ctx) {
        const deep = deps.config.deepMode
        if (deep.enabled !== true) {
          throw new CdpError('DEEP_UNAVAILABLE', `${DEEP_HELP}（deepMode.enabled=false，当前配置未启用深度模式）`)
        }
        let url = ''
        if (typeof raw.url === 'string' && raw.url.trim() !== '') {
          url = requireNavigableUrl(deps, raw.url)
        } else if (typeof ctx.urlBefore === 'string' && ctx.urlBefore !== '') {
          url = ctx.urlBefore
        }
        const scope = raw.scope === undefined ? 'a11y' : raw.scope
        if (scope !== 'a11y' && scope !== 'dom') {
          throw new BridgeError('BAD_ARGUMENTS', "参数 scope 只能是 'a11y' 或 'dom'")
        }
        const maxNodes = optionalNumber(raw, 'maxNodes', 1, 2_000)
        return await deepSnapshot({
          endpoint: deep.endpoint,
          portFile: deep.portFile,
          url,
          maxNodes: maxNodes === undefined ? deep.maxNodes : Math.floor(maxNodes),
          scope,
          includeFrames: optionalBoolean(raw, 'includeFrames', true),
          timeoutMs: deep.timeoutMs,
        })
      },
    }),

    makeTool(deps, {
      name: 'browser_tabs',
      description: 'Manage the pages (tabs) of the sidebar browser: list them, open a new one, switch to one '
        + 'by id, or close one by id.',
      op: 'tabs',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'new', 'switch', 'close'],
            description: 'Tab action.',
          },
          id: { type: 'string', description: 'Page id such as p1; required for switch and close.' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      outputProperties: {
        tabs: { type: 'array', items: { type: 'object' } },
        activeId: { type: 'string' },
      },
      buildArgs(raw) {
        const action = requireString(raw, 'action', 'list / new / switch / close')
        if (!['list', 'new', 'switch', 'close'].includes(action)) {
          throw new BridgeError('BAD_ARGUMENTS', `tabs 的 action 只能是 list/new/switch/close，收到 ${action}`)
        }
        const args = { action }
        if (action === 'switch' || action === 'close') {
          args.id = requireString(raw, 'id', '先用 action:list 看页面 id，例如 p1')
        }
        return args
      },
    }),

    makeTool(deps, {
      name: 'browser_console',
      description: 'Read the most recent console messages collected from the sidebar page (errors from the '
        + 'page itself are often the fastest diagnosis).',
      op: 'console',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'How many recent entries to return (default 50).' },
        },
        additionalProperties: false,
      },
      outputProperties: { entries: { type: 'array', items: { type: 'object' } } },
      buildArgs(raw) {
        const args = {}
        const limit = optionalNumber(raw, 'limit', 1, 200)
        if (limit !== undefined) args.limit = Math.floor(limit)
        return args
      },
    }),

    makeTool(deps, {
      name: 'browser_network',
      description: 'Read the most recent network requests the sidebar page made (URL, status, failure); use it '
        + 'when the page looks empty or a request seems to have failed.',
      op: 'network',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'How many recent entries to return (default 50).' },
        },
        additionalProperties: false,
      },
      outputProperties: { entries: { type: 'array', items: { type: 'object' } } },
      buildArgs(raw) {
        const args = {}
        const limit = optionalNumber(raw, 'limit', 1, 200)
        if (limit !== undefined) args.limit = Math.floor(limit)
        return args
      },
    }),

    makeTool(deps, {
      name: 'browser_eval',
      description: 'Evaluate JavaScript in the sidebar page and return its serialized result. Disabled unless '
        + 'the plugin config sets enableEval:true.',
      op: 'eval',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'JavaScript expression or statements to run in the page.' },
        },
        required: ['code'],
        additionalProperties: false,
      },
      outputProperties: {},
      buildArgs(raw) {
        if (deps.config.enableEval !== true) {
          throw new BridgeError(
            'EVAL_DISABLED',
            'browser_eval 已被配置关闭（enableEval=false）：请让用户在插件配置里打开 enableEval，'
            + '或用 browser_snapshot / browser_click 等动作完成目标。',
          )
        }
        return { code: requireString(raw, 'code', '例如 document.title') }
      },
    }),

    makeTool(deps, {
      name: 'browser_close',
      description: 'Close the sidebar browser page and release the underlying guest.',
      op: 'close',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      outputProperties: { closed: { type: 'boolean' } },
      buildArgs() {
        return {}
      },
    }),
  ]
}

/**
 * 注册全部工具。
 * @param {object} ctx - 已注入 `tools` 的 Cordis 上下文。
 * @param {object} deps - 依赖（与 {@link buildBrowserTools} 相同）。
 * @returns {() => void} 注销器。
 */
export function registerBrowserTools(ctx, deps) {
  // `inject` 保证 tools 已就位；`ctx.get` 只是兜住不同 Cordis 版本的取值方式。
  const registry = ctx.tools ?? ctx.get?.('tools')
  if (registry === undefined || typeof registry.register !== 'function') {
    throw new Error('browser-hands: tools 服务不可用，无法注册 browser_* 工具')
  }
  const disposers = []
  for (const definition of buildBrowserTools(deps)) {
    disposers.push(registry.register(definition))
  }
  return () => {
    for (const dispose of disposers.splice(0).reverse()) {
      try {
        dispose()
      } catch {
        // 注销失败不影响卸载流程。
      }
    }
  }
}
