/**
 * 发布前自检：清单、文件白名单、patch、客户端 id、图标、GIF、敏感信息。
 *
 * 用法：node scripts/verify-package.mjs
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
let failures = 0
const check = (condition, label, detail) => {
  if (condition) console.log(`  OK   ${label}`)
  else {
    failures += 1
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const manifestPath = join(ROOT, 'package.json')
const raw = readFileSync(manifestPath, 'utf8')
check(raw.charCodeAt(0) !== 0xfeff, 'package.json 没有 BOM')
const manifest = JSON.parse(raw)

check(typeof manifest.name === 'string' && manifest.name.length > 0, '有包名')
check(/^\d+\.\d+\.\d+/.test(manifest.version), '版本号形如 x.y.z')
check(manifest.type === 'module', 'type=module')
check(manifest.private !== true, '没有 private:true（可以发布）')
check(manifest.dsh?.bundle?.patch === './cordis.patch.yml', 'dsh.bundle.patch 指向 cordis.patch.yml')
check(manifest.dsh?.client?.platform === 'web', 'dsh.client.platform=web')
check(Array.isArray(manifest.dsh?.client?.inject), 'dsh.client.inject 是数组')
check(manifest.publishConfig?.access === 'public', 'publishConfig.access=public')
check(!manifest.dependencies || Object.keys(manifest.dependencies).length === 0, '没有 runtime dependencies')
check(
  !manifest.peerDependencies ||
    !Object.keys(manifest.peerDependencies).some((key) => key.startsWith('@deepseek-ai/')),
  '没有 @deepseek-ai/* peerDependencies（避免版本闸门）',
)
check(Array.isArray(manifest.files) && manifest.files.length > 0, 'files 白名单非空')

/** Expand the simple `dir/*.ext` patterns used by this package. */
function expand(pattern) {
  if (!pattern.includes('*')) return [pattern]
  const slash = pattern.lastIndexOf('/')
  const dir = slash === -1 ? '.' : pattern.slice(0, slash)
  const suffix = pattern.slice(pattern.lastIndexOf('*') + 1)
  if (!existsSync(join(ROOT, dir))) return []
  return readdirSync(join(ROOT, dir))
    .filter((name) => name.endsWith(suffix))
    .map((name) => (dir === '.' ? name : `${dir}/${name}`))
}

const shipped = manifest.files.flatMap(expand)
check(shipped.length >= 10, '发布文件数量合理', String(shipped.length))
for (const file of shipped) {
  check(existsSync(join(ROOT, file)), `文件存在：${file}`)
}

const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
check(patch.includes(`name: '${manifest.name}'`), 'patch 里的包名与 package.json 一致')
check(!/D:\\Tool\\EssayReader|\/Tool\/EssayReader/.test(patch), 'patch 没有写死工作区路径')

const client = readFileSync(join(ROOT, 'client.js'), 'utf8')
const clientId = client.match(/id:\s*'([^']+)'/)?.[1]
check(clientId === manifest.name, 'client.js 的 loader id 与包名一致', clientId)
check(client.includes("'settings.section'"), 'client.js 注册到 settings.section')

const iconPath = join(ROOT, 'icon.svg')
check(existsSync(iconPath), 'icon.svg 存在')
check(statSync(iconPath).size <= 256 * 1024, 'icon.svg 小于 256 KiB')

const gifPath = join(ROOT, 'assets', 'howto.gif')
check(existsSync(gifPath), 'assets/howto.gif 存在')
if (existsSync(gifPath)) {
  const header = readFileSync(gifPath).subarray(0, 6).toString('ascii')
  check(header === 'GIF89a' || header === 'GIF87a', 'GIF 文件头正确', header)
}
check(client.includes('data:image/gif;base64,'), 'client.js 内嵌了教程 GIF')
check(client.includes("'什么时候会用上'"), 'client.js 包含面向用户的说明')

const codeFiles = ['index.js', 'client.js', 'cookie-store.js', 'key-store.js', 'settings-store.js', 'settings-route.js', 'cordis.patch.yml'].filter(
  (file) => existsSync(join(ROOT, file)),
)
for (const file of codeFiles) {
  const text = readFileSync(join(ROOT, file), 'utf8')
  check(!text.includes('D:\\Tool\\EssayReader'), `${file} 没有写死工作区绝对路径`)
  check(!/sk-[A-Za-z0-9]{16,}/.test(text), `${file} 没有疑似 sk- 密钥`)
  check(!/WOSSID=[A-Za-z0-9]/.test(text), `${file} 没有硬编码 WOSSID`)
}

console.log(`\n${failures === 0 ? '包自检通过。' : `包自检失败：${failures} 项。`}`)
process.exit(failures === 0 ? 0 : 1)
