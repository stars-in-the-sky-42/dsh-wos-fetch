/**
 * 发布前替换包身份：包名、仓库地址、客户端 loader id、patch 行名、README 占位符。
 *
 * 用法：
 *   node scripts/set-identity.mjs --name @your-scope/dsh-wos-fetch \
 *     --repo https://github.com/you/dsh-wos-fetch
 *
 * 不传 --repo 时只改包名。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const args = process.argv.slice(2)
const valueOf = (flag, fallback = '') => {
  const index = args.indexOf(flag)
  return index === -1 ? fallback : String(args[index + 1] ?? fallback)
}

const name = valueOf('--name').trim()
if (!name) {
  console.error('用法：node scripts/set-identity.mjs --name @scope/pkg [--repo https://github.com/user/repo]')
  process.exit(2)
}

const manifestPath = join(ROOT, 'package.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const oldName = manifest.name
manifest.name = name

const repo = valueOf('--repo').trim()
if (repo) {
  const clean = repo.replace(/^git\+/, '').replace(/\.git$/, '')
  manifest.repository = { type: 'git', url: `git+${clean}.git` }
  manifest.homepage = valueOf('--homepage', clean)
  manifest.bugs = { url: valueOf('--bugs', `${clean}/issues`) }
}
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

const patchPath = join(ROOT, 'cordis.patch.yml')
let patch = readFileSync(patchPath, 'utf8')
patch = patch.replaceAll(oldName, name)
writeFileSync(patchPath, patch, 'utf8')

const clientPath = join(ROOT, 'client.js')
let client = readFileSync(clientPath, 'utf8')
client = client.replaceAll(oldName, name)
writeFileSync(clientPath, client, 'utf8')

// 允许 README / docs 里用占位符；能确定 scope / 账号时顺手替换。
const scope = name.startsWith('@') ? name.split('/')[0] : ''
const owner = repo ? repo.replace(/^git\+/, '').replace(/^https?:\/\/github\.com\//, '').split('/')[0] : ''
for (const file of ['README.md', 'docs/USAGE.md']) {
  const path = join(ROOT, file)
  if (!existsSync(path)) continue
  let text = readFileSync(path, 'utf8')
  text = text.replaceAll(oldName, name)
  if (scope) text = text.replaceAll('@<你的scope>/', `${scope}/`)
  if (owner) text = text.replaceAll('<你的账号>', owner)
  writeFileSync(path, text, 'utf8')
}

console.log(`包名：${oldName} -> ${name}`)
if (repo) console.log(`仓库：${repo}`)
console.log('已更新 package.json / cordis.patch.yml / client.js / README.md / docs/USAGE.md')
