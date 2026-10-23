/**
 * 本插件的数据目录。
 *
 * 所有可写数据都放在 DSH 自己的 home 下，跨平台、跨工作区一致；
 * 包内不写死任何绝对路径。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/** Resolve the DSH home directory for this process. */
export function dshHome() {
  const env = process.env.DSH_HOME
  if (env && String(env).trim()) return String(env).trim()
  return join(homedir(), '.dsh')
}

/** One plugin-owned storage directory under $DSH_HOME/storages. */
export function storageDir(plugin = 'wos-fetch') {
  return join(dshHome(), 'storages', plugin)
}
