/**
 * 可配置的数据目录。
 *
 * 配置文件本身很小，固定在 $DSH_HOME/storages/wos-fetch/settings.json；
 * 真正的内容（NDJSON、habits.md、日志、旧 cookie 文件）放在用户选择的目录。
 * 本机可以把 dataDir 指到工作区，满足“产物留在工作区”的要求。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

import { storageDir } from './paths.js'

const PLUGIN = 'wos-fetch'
const ENV_DATA_DIR = 'ESSAYREADER_WOS_DATA_DIR'
const MAX_PATH = 500

let cache = { mtimeMs: -1, size: -1, value: null }

/** Fixed bootstrap directory for the small settings file. */
export function configDir() {
  return storageDir(PLUGIN)
}

/** Path of the small settings document. */
export function settingsFile() {
  return join(configDir(), 'settings.json')
}

/** Default data directory when the user has not chosen one. */
export function defaultDataDir() {
  const env = process.env[ENV_DATA_DIR]
  return env && env.trim() ? env.trim() : configDir()
}

/** Read the raw settings document (cached by mtime). */
export function readSettings() {
  const file = settingsFile()
  if (!existsSync(file)) return { version: 1, dataDir: defaultDataDir() }
  try {
    const st = statSync(file)
    if (cache.mtimeMs === st.mtimeMs && cache.size === st.size && cache.value) return cache.value
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const value = {
      version: 1,
      dataDir: typeof parsed.dataDir === 'string' && parsed.dataDir.trim() ? parsed.dataDir.trim() : defaultDataDir(),
    }
    cache = { mtimeMs: st.mtimeMs, size: st.size, value }
    return value
  } catch {
    return { version: 1, dataDir: defaultDataDir() }
  }
}

/** Effective data directory. */
export function dataDir() {
  return readSettings().dataDir
}

/** Output directory under the data directory. */
export function outputDir() {
  return join(dataDir(), 'output')
}

/** Validate an absolute, writable directory path. */
export function normalizeDataDir(input) {
  const dir = String(input ?? '').trim()
  if (!dir) throw new Error('数据目录不能为空')
  if (dir.length > MAX_PATH) throw new Error(`路径太长（上限 ${MAX_PATH} 字符）`)
  if (dir.includes('\0')) throw new Error('路径包含非法字符')
  if (!isAbsolute(dir)) throw new Error('请填绝对路径，例如 D:\\data\\wos')
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Persist a new data directory and move the habits document when possible.
 *
 * @param {string} input - absolute path chosen by the user.
 * @returns {string} the effective data directory.
 */
export function setDataDir(input) {
  const next = normalizeDataDir(input)
  const previous = dataDir()
  if (previous !== next) {
    const oldHabits = join(previous, 'habits.md')
    const newHabits = join(next, 'habits.md')
    try {
      if (existsSync(oldHabits) && !existsSync(newHabits)) copyFileSync(oldHabits, newHabits)
    } catch {
      /* 迁移失败不阻止保存；用户可手动复制 */
    }
  }
  mkdirSync(configDir(), { recursive: true })
  const temp = `${settingsFile()}.tmp`
  writeFileSync(temp, `${JSON.stringify({ version: 1, dataDir: next }, null, 2)}\n`, 'utf8')
  renameSync(temp, settingsFile())
  cache = { mtimeMs: -1, size: -1, value: null }
  return next
}
