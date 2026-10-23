/**
 * 本机 WoS 检索习惯文档的读写。
 *
 * 文件位置：<dataDir>/habits.md；dataDir 默认为 $DSH_HOME/storages/wos-fetch。 
 * 修改入口：对话里让 DSH 调用 wos_habits(action="write")。
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { DEFAULT_HABITS } from './default-habits.js'
import { dataDir } from './settings-store.js'

/** Hard cap so a pasted document cannot flood the system prompt. */
export const MAX_HABITS_CHARS = 8000

let cache = { path: '', mtimeMs: -1, size: -1, content: '', isDefault: true }

/** Absolute path of this plugin's habits document. */
export function habitsPath() {
  return join(dataDir(), 'habits.md')
}

/** Create the habits document from the shipped default when missing. */
export function ensureHabits() {
  const file = habitsPath()
  if (existsSync(file)) return file
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, DEFAULT_HABITS, 'utf8')
  cache = { path: file, mtimeMs: -1, size: -1, content: '', isDefault: true }
  return file
}

/**
 * Read the current habits document.
 *
 * @returns {{content: string, path: string, isDefault: boolean}}
 */
export function readHabits() {
  const file = ensureHabits()
  const st = statSync(file)
  if (cache.path === file && cache.mtimeMs === st.mtimeMs && cache.size === st.size && cache.content) {
    return { content: cache.content, isDefault: cache.isDefault, path: file }
  }
  const content = readFileSync(file, 'utf8')
  const isDefault = content.trim() === DEFAULT_HABITS.trim()
  cache = { path: file, mtimeMs: st.mtimeMs, size: st.size, content, isDefault }
  return { content, isDefault, path: file }
}

/**
 * Replace the habits document, keeping one `.bak` copy of the previous text.
 *
 * @param {string} content - markdown written by the model.
 * @returns {{content: string, path: string, isDefault: boolean}}
 */
export function writeHabits(content) {
  const text = String(content ?? '').trim()
  if (!text) throw new Error('习惯内容不能为空')
  if (text.length > MAX_HABITS_CHARS) {
    throw new Error(`习惯内容太长（${text.length} 字），上限 ${MAX_HABITS_CHARS} 字`)
  }
  const file = ensureHabits()
  writeFileSync(`${file}.bak`, readFileSync(file, 'utf8'), 'utf8')
  writeFileSync(file, `${text}\n`, 'utf8')
  cache = { path: file, mtimeMs: -1, size: -1, content: '', isDefault: false }
  return readHabits()
}

/** Restore the shipped default, keeping the previous text in `.bak`. */
export function resetHabits() {
  const file = ensureHabits()
  writeFileSync(`${file}.bak`, readFileSync(file, 'utf8'), 'utf8')
  writeFileSync(file, DEFAULT_HABITS, 'utf8')
  cache = { path: file, mtimeMs: -1, size: -1, content: '', isDefault: true }
  return readHabits()
}
