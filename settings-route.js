/**
 * 设置页的“数据位置”接口（只处理目录，不接触凭据）。
 *
 * GET  /essayreader-api/wos/settings  → 当前/默认/生效目录
 * PUT  /essayreader-api/wos/settings  → { dataDir } 保存并返回新状态
 *
 * 安全：只接受同源请求 + application/json；不返回任何 cookie/key。
 */

import { dataDir, defaultDataDir, outputDir, setDataDir } from './settings-store.js'
import { habitsPath } from './habits.js'

const PLUGIN = 'wos'
const ROUTE = `/essayreader-api/${PLUGIN}/settings`
const MAX_BODY = 4096

function state() {
  return {
    dataDir: dataDir(),
    defaultDataDir: defaultDataDir(),
    outputDir: outputDir(),
    habitsPath: habitsPath(),
  }
}

function send(res, status, payload) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(payload))
}

function sameOrigin(req) {
  const origin = req.headers.origin
  if (origin) {
    try {
      const parsed = new URL(origin)
      if (parsed.host !== req.headers.host) return false
    } catch {
      return false
    }
  }
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  return true
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('请求体太大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

/**
 * Register the settings route when the Host has an HTTP carrier.
 *
 * @param {object} webServer - resolved webServer service.
 * @returns {(() => void) | undefined} route disposer.
 */
export function registerSettingsRoute(webServer) {
  if (!webServer || typeof webServer.register !== 'function') return undefined

  return webServer.register({
    kind: 'exact',
    path: ROUTE,
    async handler(req, res) {
      try {
        if (!sameOrigin(req)) return send(res, 403, { ok: false, error: 'cross-origin request denied' })
        if (req.method === 'GET') return send(res, 200, { ok: true, value: state() })
        if (req.method !== 'PUT' && req.method !== 'POST') {
          res.setHeader('Allow', 'GET, PUT')
          return send(res, 405, { ok: false, error: 'method not allowed' })
        }
        const type = String(req.headers['content-type'] || '')
        if (!type.toLowerCase().includes('application/json')) {
          return send(res, 415, { ok: false, error: 'content-type must be application/json' })
        }
        const body = await readJson(req)
        setDataDir(body?.dataDir)
        return send(res, 200, { ok: true, value: state() })
      } catch (error) {
        return send(res, 400, { ok: false, error: String(error?.message || error) })
      }
    },
  })
}
