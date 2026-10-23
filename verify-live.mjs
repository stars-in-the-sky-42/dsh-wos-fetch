/**
 * 真实环境验证：从本机默认 cookie 文件读一次 cookie，跑一次真正的 WoS 检索。
 *
 * 只是验证脚本，日常不需要。cookie 只在内存里流转，不落盘。
 *
 * 用法：
 *   node verify-live.mjs --query "ZrVSi"
 *   node verify-live.mjs --cookie-file "C:\path\to\cookie.txt" --query "ScRuP"
 *
 * 注意：只有当前网络有 WoS 访问权限、且 cookie 未过期时才会成功。
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import { search, summaryUrl } from './wos.js'

const { values } = parseArgs({
  options: {
    query: { type: 'string', default: 'ScRuP' },
    field: { type: 'string', default: 'TS' },
    count: { type: 'string', default: '3' },
    'cookie-file': { type: 'string' },
  },
})

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const cookieFile = values['cookie-file'] || join(DSH_HOME, 'storages', 'wos-fetch', 'cookie.txt')

if (!existsSync(cookieFile)) {
  console.error(`cookie 文件不存在：${cookieFile}`)
  console.error('请先在“设置 → 文献检索（WoS）”保存 cookie；或传 --cookie-file。')
  process.exit(2)
}

const cookie = readFileSync(cookieFile, 'utf8').trim()
if (!cookie || cookie.split(/\r?\n/).every((line) => !line.trim() || line.trim().startsWith('#'))) {
  console.error('cookie 文件里只有说明文字，没有真正的 cookie。')
  process.exit(2)
}

try {
  const result = await search({
    query: values.query,
    field: values.field,
    count: Number(values.count),
    cookie,
  })
  console.log(`[i] SID   : ${result.sid}`)
  console.log(`[i] qid   : ${result.qid}`)
  console.log(`[i] 页面  : ${summaryUrl(result.qid)}`)
  console.log(`[i] 命中  : ${result.recordsFound}（检索范围 ${result.recordsSearched}）`)
  console.log(`[i] 流块  : ${result.streamKeys.join(', ')}`)
  for (const row of result.summaries) {
    console.log(
      `  ${row.index}. ${row.title}\n     ${row.authors.join('; ')} | ${row.sourceAbbrev} | ${row.year} | DOI: ${row.doi} | 被引 ${row.cited}`,
    )
  }
  process.exit(result.summaries.length ? 0 : 1)
} catch (error) {
  console.error(`WoS 验证失败：${error?.message || error}`)
  console.error('如果提示 sessionNotFound / 会话失效：cookie 过期，或当前网络没有 WoS 权限。')
  process.exit(1)
}
