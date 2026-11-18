/**
 * systemPrompt 注入文案（0.7.0）：从包内 `locale/zh.json` / `locale/en.json` 读取
 * 「专用浏览器实例」约定，代码里不硬编码中文。
 *
 * Host 侧没有可用的 locale 服务（`ctx.locale` 是 Client 半边注入），因此沿用
 * dsh-life 读取包内只读文件的成熟做法：`import.meta.url` 定位包目录 →
 * 优先 zh，缺失或坏 JSON 时回落 en；仍拿不到就返回空串（什么都不注入）。
 *
 * 文案里的 `{endpoint}` / `{port}` 占位符用配置值替换，端口改配置后文案自动跟。
 *
 * @module dsh-agent-browser-auto/prompt
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dedicatedEndpoint } from './dedicated.js'

/** 包内 locale 目录（lib/ 的上一级）。 */
const LOCALE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'locale')

/** 注入 section 的注册名（与 dsh-dev-copilot / dsh-life 的命名风格一致）。 */
export const DEDICATED_SECTION_NAME = 'agent-browser-auto:dedicated-browser'

/** 注入 section 的顺序（避开 dsh-dev-copilot 的 860，紧随其后）。 */
export const DEDICATED_SECTION_ORDER = 870

/** 语言回退顺序。 */
const LANGUAGE_FALLBACK = Object.freeze(['zh', 'en'])

/**
 * 读取专用浏览器约定文案；`dedicatedBrowser.enabled !== true` 或拿不到文案时返回空串。
 * @param {object} config - 已解析插件配置。
 * @param {object} [io] - 注入实现（测试用）。
 * @param {(path: string, encoding: string) => Promise<string>} [io.readFile] - 文件读取。
 * @param {string[]} [io.languages] - 语言回退顺序。
 * @returns {Promise<string>} 注入文本；空串表示不注入。
 */
export async function loadDedicatedPrompt(config, io = {}) {
  const read = io.readFile ?? readFile
  const languages = io.languages ?? LANGUAGE_FALLBACK
  const dconfig = config?.dedicatedBrowser
  if (dconfig?.enabled !== true) return ''
  const endpoint = dedicatedEndpoint(dconfig.port)
  for (const language of languages) {
    let raw
    try {
      raw = await read(join(LOCALE_DIR, `${language}.json`), 'utf8')
    } catch {
      continue
    }
    let template
    try {
      const parsed = JSON.parse(raw)
      template = parsed?.systemPrompt?.dedicatedBrowser
    } catch {
      continue
    }
    if (typeof template === 'string' && template.trim() !== '') {
      return template.replaceAll('{endpoint}', endpoint).replaceAll('{port}', String(dconfig.port))
    }
  }
  return ''
}
