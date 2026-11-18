/**
 * systemPrompt 注入文案（0.7.0 专用浏览器 / 0.8.0 扩展桥接）：从包内
 * `locale/zh.json` / `locale/en.json` 读取约定文案，代码里不硬编码中文。
 *
 * Host 侧没有可用的 locale 服务（`ctx.locale` 是 Client 半边注入），因此沿用
 * dsh-life 读取包内只读文件的成熟做法：`import.meta.url` 定位包目录 →
 * 优先 zh，缺失或坏 JSON 时回落 en；仍拿不到就返回空串（什么都不注入）。
 *
 * 文案里的 `{endpoint}` / `{port}` / `{code}` 占位符用配置值替换，端口改配置后文案自动跟。
 *
 * @module dsh-agent-browser-auto/prompt
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dedicatedEndpoint } from './dedicated.js'

/** 包根目录（lib/ 的上一级；extension/ 指引也以它为基准）。 */
export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 包内 locale 目录。 */
const LOCALE_DIR = join(PACKAGE_ROOT, 'locale')

/** 注入 section 的注册名（与 dsh-dev-copilot / dsh-life 的命名风格一致）。 */
export const DEDICATED_SECTION_NAME = 'agent-browser-auto:dedicated-browser'

/** 注入 section 的顺序（避开 dsh-dev-copilot 的 860，紧随其后）。 */
export const DEDICATED_SECTION_ORDER = 870

/** 扩展桥接 section 的注册名与顺序（紧随专用浏览器之后）。 */
export const EXTENSION_SECTION_NAME = 'agent-browser-auto:extension-bridge'
export const EXTENSION_SECTION_ORDER = 871

/** 语言回退顺序。 */
const LANGUAGE_FALLBACK = Object.freeze(['zh', 'en'])

/**
 * 从包内 locale 读一个字符串模板并做占位符替换；任何一层失败都返回空串。
 * @param {string} path - locale JSON 里的点路径，如 `systemPrompt.dedicatedBrowser`。
 * @param {Record<string, string>} replacements - `{name}` 占位符替换表。
 * @param {object} [io] - 注入实现（测试用）。
 * @param {(path: string, encoding: string) => Promise<string>} [io.readFile] - 文件读取。
 * @param {string[]} [io.languages] - 语言回退顺序。
 * @returns {Promise<string>} 文案；空串表示没有可用文案。
 */
export async function loadLocaleText(path, replacements = {}, io = {}) {
  const read = io.readFile ?? readFile
  const languages = io.languages ?? LANGUAGE_FALLBACK
  const segments = path.split('.')
  for (const language of languages) {
    let raw
    try {
      raw = await read(join(LOCALE_DIR, `${language}.json`), 'utf8')
    } catch {
      continue
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      continue
    }
    let value = parsed
    for (const segment of segments) {
      value = value === undefined || value === null ? undefined : value[segment]
    }
    if (typeof value === 'string' && value.trim() !== '') {
      let text = value
      for (const [name, replacement] of Object.entries(replacements)) {
        text = text.replaceAll(`{${name}}`, replacement)
      }
      return text
    }
  }
  return ''
}

/**
 * 读取专用浏览器约定文案；`dedicatedBrowser.enabled !== true` 或拿不到文案时返回空串。
 * @param {object} config - 已解析插件配置。
 * @param {object} [io] - 注入实现（测试用）。
 * @param {(path: string, encoding: string) => Promise<string>} [io.readFile] - 文件读取。
 * @param {string[]} [io.languages] - 语言回退顺序。
 * @returns {Promise<string>} 注入文本；空串表示不注入。
 */
export async function loadDedicatedPrompt(config, io = {}) {
  const dconfig = config?.dedicatedBrowser
  if (dconfig?.enabled !== true) return ''
  const endpoint = dedicatedEndpoint(dconfig.port)
  return loadLocaleText('systemPrompt.dedicatedBrowser', { endpoint, port: String(dconfig.port) }, io)
}

/**
 * 读取扩展桥接约定文案；`extensionBridge.enabled !== true` 或拿不到文案时返回空串。
 * @param {object} config - 已解析插件配置。
 * @param {object} [io] - 注入实现（测试用）。
 * @param {(path: string, encoding: string) => Promise<string>} [io.readFile] - 文件读取。
 * @param {string[]} [io.languages] - 语言回退顺序。
 * @returns {Promise<string>} 注入文本；空串表示不注入。
 */
export async function loadExtensionPrompt(config, io = {}) {
  const econfig = config?.extensionBridge
  if (econfig?.enabled !== true) return ''
  return loadLocaleText('systemPrompt.extensionBridge', { port: String(econfig.port) }, io)
}
