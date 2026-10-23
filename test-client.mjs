/**
 * 设置页客户端冒烟测试（单包）。
 *
 * 用法：node test-client.mjs
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = import.meta.dirname
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
let failures = 0
const check = (condition, label, detail) => {
  if (condition) console.log(`  OK   ${label}`)
  else {
    failures += 1
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

let entry
globalThis.window = {
  __ModuleLoader__: {
    load(value) {
      entry = value
    },
  },
}

await import(pathToFileURL(join(ROOT, 'client.js')).href)
check(Boolean(entry), '调用了 window.__ModuleLoader__.load')
check(entry?.id === manifest.name, '客户端 id 等于包名', `${entry?.id} != ${manifest.name}`)

const React = {
  createElement(type, props, ...children) {
    return { type, props, children }
  },
  useState(value) {
    return [value, () => {}]
  },
  useEffect() {},
}
const require = (name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require: ${name}`)
}

// The settings page is mounted inside the DSH renderer, not opened as its own
// document. The component must inject its stylesheet itself; there is no build
// step that emits a CSS asset for this plain-JS bundle.
const styleTags = []
globalThis.document = {
  head: {
    appendChild(node) {
      styleTags.push(node)
    },
  },
  createElement(tagName) {
    return {
      tagName,
      dataset: {},
      textContent: '',
      remove() {
        const index = styleTags.indexOf(this)
        if (index !== -1) styleTags.splice(index, 1)
      },
    }
  },
  querySelector(selector) {
    return styleTags.find((tag) => selector.includes(tag.dataset.pluginCss)) || null
  },
}

const plugin = entry.factory(require)
check(Array.isArray(plugin.inject), '返回 inject 数组')
check(plugin.inject.includes('slots'), 'inject 含 slots')
check(plugin.inject.includes('remote.credentials'), 'inject 含 remote.credentials')

let registration = null
const ctx = {
  slots: {
    inject(key, callback) {
      check(key === 'settings.section', 'inject 到 settings.section', key)
      callback()
      return () => {}
    },
    register(options, component) {
      registration = { options, component }
      return () => {}
    },
  },
}

const dispose = plugin.apply(ctx)
check(Boolean(registration), '注册了设置页')
check(registration?.options?.name === 'settings.section', 'registration.name 正确')
check(registration?.options?.id?.startsWith('essayreader-'), 'registration.id 以 essayreader- 开头', registration?.options?.id)
check(typeof registration?.component === 'function', 'component 是函数')
check(styleTags.length === 1, '向 document.head 注入了样式表', String(styleTags.length))
check(styleTags[0]?.textContent?.includes('.er-page'), '样式表包含设置页 CSS')
check(styleTags[0]?.dataset?.pluginCss?.endsWith('/settings'), '样式表带唯一 data-plugin-css', styleTags[0]?.dataset?.pluginCss)
dispose()
check(styleTags.length === 0, '卸载时移除了样式表', String(styleTags.length))

console.log(`\n${failures === 0 ? '客户端冒烟通过。' : `失败 ${failures} 项。`}`)
process.exit(failures === 0 ? 0 : 1)
