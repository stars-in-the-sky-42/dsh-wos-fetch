/**
 * cookie 文件的读写与"指路"逻辑。
 *
 * 设计取舍（用户明确要求）：
 *   cookie 只从文件读，不做浏览器自动抓取。
 *   文件里写清路径、用途和复制步骤，方便日后忘记时一眼看到该放哪。
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { dataDir } from './settings-store.js'

/** 本插件认为"最合理"的默认位置；实际值由插件 config 覆盖。 */
export function defaultCookieFile() {
  return join(dataDir(), 'cookie.txt')
}

/**
 * cookie 文件模板。
 * 用 `#` 注释行把"这是什么、从哪弄、怎么更新"写在文件最上面，
 * 因为用户最可能直接打开这个文件。
 */
export const COOKIE_TEMPLATE = `# ============================================================
#  Web of Science 会话 Cookie —— dsh-wos-fetch 插件读取此文件
# ============================================================
#
#  首选做法：打开“设置 → 文献检索（WoS）”，把 cookie 粘进“凭据”一栏保存。
#  那个值存在 DSH 凭据库里，优先于本文件。
#
#  只有不想用设置页时，才把 cookie 填进本文件。
#
#  怎么填：
#    1. 用 Edge 打开 https://webofscience.clarivate.cn/wos/woscc/basic-search
#       确认页面正常（能出现检索框）。
#    2. 按 F12 打开开发者工具 -> Network（网络）标签。
#    3. 在页面里随便检索一次，点 Network 里任意一条 webofscience.clarivate.cn
#       /api/wosnx/... 的请求。
#    4. 在 Request Headers 里找到 cookie 这一行，右键 Copy value。
#    5. 把复制到的一整行粘贴到本文件最后一行（即下一行的位置），保存。
#
#  注意：
#    - 整行必须是 name=value; name=value; ... 的格式，不要换行拆开。
#    - 至少要包含 WOSSID（插件用它当 SID）。
#    - cookie 会过期。检索时报 401/403 或提示 cookie 失效时，重复上面步骤覆盖即可。
#    - 这个文件等同于密码，不要提交到 git、不要发给别人。
#
#  当前 cookie 文件路径见文件末尾。
# ------------------------------------------------------------

`

/** 确保读到的是"真正的 cookie 内容"，而不是模板里的说明文字。 */
export function isTemplateOnly(text) {
  const meaningful = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
  return meaningful.length === 0
}

export function ensureCookieFile(path) {
  const file = resolve(path)
  const existed = existsSync(file)
  if (!existed) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${COOKIE_TEMPLATE}# cookie 文件位置：${file}\n`, 'utf8')
  }
  return { path: file, created: !existed }
}

export function writeCookie(path, cookieText) {
  const file = resolve(path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${COOKIE_TEMPLATE}${String(cookieText).trim()}\n`, 'utf8')
  return file
}

export function readCookieFile(path) {
  const file = resolve(path)
  if (!existsSync(file)) {
    return { ok: false, path: file, reason: 'missing' }
  }
  const text = readFileSync(file, 'utf8')
  if (isTemplateOnly(text)) {
    return { ok: false, path: file, reason: 'empty' }
  }
  return {
    ok: true,
    path: file,
    text,
    size: statSync(file).size,
    modifiedAt: statSync(file).mtime.toISOString(),
  }
}

/**
 * cookie 缺失时的指引文本。
 * 直接把路径和步骤写给模型/用户，避免只说一句"cookie 无效"。
 */
export function cookieHelp({ path, reason } = {}) {
  const why =
    reason === 'stale'
      ? 'cookie 已失效或与当前请求不匹配'
      : reason === 'missing'
        ? '还没有配置 WoS cookie'
        : '凭据里还没有填入真正的 cookie'
  const lines = [
    `【需要先准备 WoS cookie】${why}`,
    ``,
    `首选：打开 DSH 的“设置 → 文献检索（WoS）”，在“凭据”里粘贴 cookie 并保存。`,
    `  1. Edge 打开 https://webofscience.clarivate.cn/wos/woscc/basic-search`,
    `  2. F12 -> Network -> 页面里检索一次`,
    `  3. 点任意一条 /api/wosnx/... 请求 -> Request Headers -> cookie -> Copy value`,
    `  4. 把整行粘进设置页的 cookie 输入框（保持 name=value; name=value 形式）`,
    ``,
    `必须包含 WOSSID（插件拿它当 SID）。`,
  ]
  if (path) {
    lines.push(
      '',
      `备用：也可以把 cookie 粘进这个文件的最后一行：`,
      `  ${resolve(path)}`,
    )
  }
  return lines.join('\n')
}
