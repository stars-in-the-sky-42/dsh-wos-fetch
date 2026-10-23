/**
 * Web of Science 检索客户端（纯 HTTP，不依赖浏览器）。
 *
 * 这条链路是实测出来的，不是猜的 —— 详见 NOTES-wos.md：
 *   1. POST /api/wosnx/core/runQuerySearch?SID=<SID>
 *      请求体里带真正的检索条件（rowField/rowText），
 *      返回的 NDJSON 流里直接就有 searchInfo / records / highlight / analyze / jcr / link，
 *      也就是一次调用就拿到整页记录，不必再调 runQueryGetRecordsStream。
 *   2. searchInfo.payload.QueryID 就是浏览器地址栏 /summary/<qid>/... 里的那个 qid，
 *      翻页（runQueryGetRecordsStream）时要用它。
 *
 * SID 不是单独的参数：它就是 cookie 里的 WOSSID。
 */

import { brotliDecompressSync, gunzipSync, inflateSync, zstdDecompressSync } from 'node:zlib'

export const HOST = 'webofscience.clarivate.cn'
export const BASE = `https://${HOST}`

/** 与 cookie 配套的浏览器 UA。换浏览器抓 cookie 时必须同步改这里。 */
export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0'

/** WoS 前端固定请求的 facet 集合（照抄真实抓包，勿随意增删）。 */
export const ANALYZES = [
  'TP.Value.6',
  'REVIEW.Value.6',
  'EARLY ACCESS.Value.6',
  'OA.Value.6',
  'DR.Value.6',
  'ECR.Value.6',
  'PY.Field_D.6',
  'FPY.Field_D.6',
  'DT.Value.6',
  'AU.Value.6',
  'DX2NG.Value.6',
  'PEERREVIEW.Value.6',
  'STK.Value.10',
]

/** 支持的检索字段（rowField）与中文别名。 */
export const FIELDS = {
  TS: '主题（Topic）',
  TI: '标题（Title）',
  AU: '作者（Author）',
  AI: '作者标识符（Author Identifiers）',
  SO: '来源出版物（Publication Name）',
  PY: '出版年（Year Published）',
  AB: '摘要（Abstract）',
  ALL: '所有字段（All Fields）',
  DO: 'DOI',
  OG: '机构（Affiliation）',
}

export const SORTS = ['relevance', 'date', 'times-cited', 'usage-count']

/**
 * 真实浏览器的请求头集合。
 *
 * 这些字段来自一次真实检索的抓包（见 NOTES-wos.md 的记录），
 * 改这里之前请先想清楚：少一个 sec-fetch-* 或多一个矛盾的 UA，
 * 都会让请求看起来不像浏览器。
 *
 * 不要在这里设置 content-length / host / cookie：由调用方按实际请求和 cookie 决定。
 */
export function browserHeaders({ cookie, referer }) {
  return {
    accept: 'application/x-ndjson',
    'accept-encoding': 'gzip, deflate, br, zstd',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
    'cache-control': 'no-cache',
    'content-type': 'text/plain;charset=UTF-8',
    dnt: '1',
    origin: BASE,
    pragma: 'no-cache',
    priority: 'u=1, i',
    referer,
    'sec-ch-ua': '"Chromium";v="154", "Microsoft Edge";v="154", "Not A(Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'user-agent': USER_AGENT,
    cookie,
  }
}

/**
 * 按 Content-Encoding 解压响应体。
 *
 * 这里有个实测踩到的坑：Node 的 fetch **默认已经自动解压**，但响应头里的
 * content-encoding 仍然保留原值。所以一看到 gzip 就 gunzip 是错的 —— 那是对
 * 已解压的数据再解一次，直接 "incorrect header check"。
 * gzip / zlib / zstd 有魔数可以先判断；brotli 没有魔数，只能"试着解，失败就当
 * 它已经是明文"。
 */
export function decodeBody(buffer, contentEncoding) {
  const raw = String(contentEncoding || '').toLowerCase()
  // Content-Encoding 可能带参数（例如 "gzip; charset=utf-8"），只取第一个 token。
  const encodingOf = (raw.split(';')[0] || '').trim()
  if (!encodingOf || encodingOf === 'identity') return buffer

  const guessed = guessEncoding(buffer)
  if (guessed && guessed !== encodingOf) return buffer // 魔数说明它已经是明文

  try {
    if (encodingOf.includes('br')) return brotliDecompressSync(buffer)
    if (encodingOf.includes('zstd')) return zstdDecompressSync(buffer)
    if (encodingOf.includes('gzip') || encodingOf.includes('x-gzip')) return gunzipSync(buffer)
    if (encodingOf.includes('deflate')) return inflateSync(buffer)
  } catch {
    // 解不开 = 它其实已经是明文，原样返回才是对的。
    return buffer
  }
  return buffer
}

/**
 * 按魔数猜 buffer 是否仍是压缩态。
 * gzip / zlib / zstd 都有固定magic；brotli 没有魔数，只能返回 null 表示
 * "无法判断"，由调用方按声明处理。
 */
export function guessEncoding(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) return 'gzip'
  if (buffer.length >= 4 && buffer[0] === 0x28 && buffer[1] === 0xb5 && buffer[2] === 0x2f && buffer[3] === 0xfd) {
    return 'zstd'
  }
  // zlib 头：CMF 低 4 位为 8，且 (CMF<<8 | FLG) 能被 31 整除。
  if (
    buffer.length >= 2 &&
    (buffer[0] & 0x0f) === 8 &&
    ((buffer[0] << 8) + buffer[1]) % 31 === 0
  ) {
    return 'deflate'
  }
  return null
}

const COOKIE_NAME_RE = /^[^=;]+=[^;]*$/
/**
 * Cookie 名/值允许的字符（RFC 6265 cookie-octet）。
 *
 * 必须校验：HTTP 头值只能是 Latin-1，一旦 cookie 里混进中文（比如把说明文字
 * 一起粘了进来），Node 的 fetch 会抛 "Cannot convert argument to a ByteString"，
 * 那种报错完全看不出问题在哪。这里提前拦掉。
 */
const COOKIE_VALUE_RE = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/
const COOKIE_NAME_ONLY_RE = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]+$/

/**
 * 把用户粘贴的 cookie 文本整理成 header 值。
 *
 * 容忍三种常见形态：
 *   - 一行 `name=value; name2=value2`（DevTools 里 copy value 的结果）
 *   - 多行，每行一段
 *   - 前面带 `cookie:` 前缀
 * 顺手丢掉注释、空白行和非法片段，避免把说明文字当 cookie 发出去。
 */
export function normalizeCookie(raw) {
  let text = String(raw || '')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1) // BOM
  const pairs = []
  const seen = new Set()
  for (let line of text.split(/\r?\n/)) {
    line = line.trim()
    if (!line) continue
    if (line.startsWith('#') || line.startsWith('//')) continue
    line = line.replace(/^cookie\s*:\s*/i, '')
    for (const part of line.replace(/\s*;\s*/g, ';').split(';')) {
      const piece = part.trim()
      if (!piece || !COOKIE_NAME_RE.test(piece)) continue
      const eq = piece.indexOf('=')
      const name = piece.slice(0, eq).trim()
      const value = piece.slice(eq + 1).trim()
      if (!name || seen.has(name)) continue
      if (!COOKIE_NAME_ONLY_RE.test(name)) continue
      // 值里有非 Latin-1 字符，说明这段根本不是 cookie：丢掉而不是发给 fetch 崩掉。
      if (value && !COOKIE_VALUE_RE.test(value)) continue
      seen.add(name)
      pairs.push(`${name}=${value}`)
    }
  }
  return pairs.join('; ')
}

/** 找出整理后 cookie 里第一个不能作为 HTTP 头值的字符，便于给出精确报错。 */
export function firstNonHeaderChar(cookie) {
  for (let index = 0; index < cookie.length; index += 1) {
    const code = cookie.charCodeAt(index)
    if (code > 0xff) return { index, char: cookie[index], code }
  }
  return null
}

/** SID 就是 cookie 里的 WOSSID —— 不需要用户单独提供。 */
export function sidFromCookie(cookie) {
  for (const part of normalizeCookie(cookie).split(';')) {
    const piece = part.trim()
    if (piece.startsWith('WOSSID=')) return piece.slice('WOSSID='.length) || null
  }
  return null
}

/**
 * 解析 NDJSON 流。
 * WoS 每个 chunk 之间用换行分隔；偶发畸形行直接跳过而不是整体失败。
 */
export function parseNdjson(text) {
  const items = []
  const malformed = []
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      items.push(JSON.parse(trimmed))
    } catch {
      malformed.push(trimmed.slice(0, 200))
    }
  }
  return { items, malformed }
}

/** 从解析后的流里找出 searchInfo。 */
export function searchInfoOf(items) {
  for (const item of items) {
    if (item && item.key === 'searchInfo' && item.payload) return item.payload
  }
  return null
}

/** records 的 payload 形如 { "1": {...}, "2": {...} }，用序号排序保证顺序稳定。 */
export function recordsOf(items) {
  const out = []
  for (const item of items) {
    if (!item || item.key !== 'records' || !item.payload || typeof item.payload !== 'object') continue
    for (const key of Object.keys(item.payload).sort((a, b) => Number(a) - Number(b))) {
      const record = item.payload[key]
      if (record && typeof record === 'object') out.push(record)
    }
  }
  return out
}

/** WoS 的标题带 <sub>/<sup>/<i> 之类内联标签，输出前清掉。 */
export function stripTags(value) {
  return String(value ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function englishList(node) {
  if (!node || typeof node !== 'object') return []
  const list = node.en
  if (!Array.isArray(list)) return []
  return list.filter(Boolean)
}

/**
 * 把一条原始记录压成便于阅读的摘要。
 * 只取最常用的字段：标题、作者、来源、年卷期页、DOI、被引、OA。
 */
export function summarizeRecord(record, index) {
  const titles = record.titles || {}
  const itemTitle = englishList(titles.item)[0]?.title
  const source = englishList(titles.source)[0]?.title
  const sourceAbbrev = englishList(titles.source_abbrev)[0]?.title

  const authors = englishList(record.names?.author)
    .map((author) => author?.wos_standard || author?.last_name)
    .filter(Boolean)

  const pubInfo = record.pub_info || {}
  const identifiers = Array.isArray(record.identifiers) ? record.identifiers : []
  const doiFromIdentifiers = identifiers.find((entry) => entry?.type === 'doi')?.value

  const counts = record.citation_related?.counts || {}
  const abstractText = record.abstract?.basic?.en?.abstract

  return {
    index,
    title: stripTags(itemTitle),
    authors,
    source: stripTags(source),
    sourceAbbrev: stripTags(sourceAbbrev),
    year: pubInfo.pubyear || pubInfo.coverdate || null,
    volume: pubInfo.vol || null,
    issue: pubInfo.issue || null,
    pages: pubInfo.page_no || null,
    doi: record.doi || doiFromIdentifiers || null,
    docType: Array.isArray(record.doctypes) ? record.doctypes.join('/') : null,
    cited: typeof counts.WOSCC === 'number' ? counts.WOSCC : null,
    openAccess: record.oa === true,
    uid: record.colluid || record.id?.value || null,
    hasAbstract: Boolean(abstractText),
  }
}

/** 拼一次 runQuerySearch 的请求体（字段命名照抄真实抓包）。 */
export function buildSearchPayload({ query, field = 'TS', count = 50, sort = 'relevance', page = 1 }) {
  const rowField = String(field || 'TS').toUpperCase()
  if (!Object.prototype.hasOwnProperty.call(FIELDS, rowField)) {
    throw new Error(`不支持的检索字段 "${field}"，可用：${Object.keys(FIELDS).join(' / ')}`)
  }
  if (!SORTS.includes(sort)) {
    throw new Error(`不支持的排序 "${sort}"，可用：${SORTS.join(' / ')}`)
  }
  const first = (Number(page) - 1) * Number(count) + 1
  if (!Number.isFinite(first) || first < 1) throw new Error(`page 必须是 >= 1 的整数（收到 ${page}）`)
  return {
    product: 'WOSCC',
    searchMode: 'general',
    viewType: 'search',
    serviceMode: 'summary',
    search: {
      mode: 'general',
      database: 'WOSCC',
      query: [{ rowField, rowText: String(query) }],
    },
    retrieve: {
      count: Number(count),
      first,
      history: true,
      jcr: true,
      sort,
      analyzes: ANALYZES,
      locale: 'en',
    },
    eventMode: null,
    skipRaFlag: null,
  }
}

/** 翻页/按 qid 重取记录时用的请求体。 */
export function buildRecordsPayload({ qid, count = 50, sort = 'relevance', page = 1 }) {
  const first = (Number(page) - 1) * Number(count) + 1
  return {
    qid,
    retrieve: {
      first,
      sort,
      count: Number(count),
      jcr: true,
      highlight: true,
      analyzes: ANALYZES,
    },
    product: 'WOSCC',
    searchMode: 'general',
    viewType: 'records',
  }
}

/** 浏览器地址栏里那种 summary 链接，方便直接点开看。 */
export function summaryUrl(qid) {
  if (!qid) return null
  return `${BASE}/wos/woscc/summary/${qid}/relevance/1`
}

function bodySnippet(text, limit = 400) {
  return String(text || '').replace(/\s+/g, ' ').slice(0, limit)
}

/**
 * 发一次 POST 并返回解码后的文本。
 * 非 2xx 直接抛出，带上足够定位问题的上下文（状态码 + 响应片段）。
 */
export async function postNdjson(path, payload, { cookie, referer, signal, timeoutMs = 60000 }) {
  const url = path.startsWith('http') ? path : `${BASE}${path}`
  // 最后一道防线：HTTP 头值只能是 Latin-1。正常路径已被 normalizeCookie 过滤，
  // 但调用方若绕过它直接传了脏 cookie，这里给人话错误而不是 ByteString 崩溃。
  const bad = firstNonHeaderChar(String(cookie ?? ''))
  if (bad) {
    throw new Error(
      `cookie 里含有不能作为 HTTP 头值的字符（位置 ${bad.index}，字符 ${JSON.stringify(bad.char)}）。` +
        '请确认 cookie 文件里那一行只是 name=value; name=value，不要把中文说明一起粘进去。',
    )
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`请求超时（${timeoutMs}ms）`)), timeoutMs)
  const onAbort = () => controller.abort(signal?.reason)
  if (signal) {
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: browserHeaders({ cookie, referer }),
      body: JSON.stringify(payload),
      signal: controller.signal,
      redirect: 'follow',
    })
    const buffer = Buffer.from(await response.arrayBuffer())
    let text
    try {
      text = decodeBody(buffer, response.headers.get('content-encoding')).toString('utf8')
    } catch (error) {
      throw new Error(`解压响应失败（content-encoding=${response.headers.get('content-encoding')}）：${error.message}`)
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText} — ${bodySnippet(text)}`)
    }
    return { text, status: response.status, url }
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}

/** 一步到位：检索词 -> 摘要记录。 */
export async function search({
  query,
  field = 'TS',
  count = 50,
  sort = 'relevance',
  page = 1,
  cookie,
  signal,
  timeoutMs,
  referer,
}) {
  // 入口统一规范化：调用方直接传文件里的原文也安全（说明文字/中文片段都会被清掉）。
  const cleanCookie = normalizeCookie(cookie)
  const sid = sidFromCookie(cleanCookie)
  if (!sid) {
    throw new Error(
      'cookie 里没有 WOSSID，无法确定 SID。请确认复制的是 webofscience.clarivate.cn 的完整 cookie。',
    )
  }
  const payload = buildSearchPayload({ query, field, count, sort, page })
  const { text, status, url } = await postNdjson(
    `/api/wosnx/core/runQuerySearch?SID=${encodeURIComponent(sid)}`,
    payload,
    { cookie: cleanCookie, referer: referer || `${BASE}/wos/woscc/basic-search`, signal, timeoutMs },
  )
  const { items, malformed } = parseNdjson(text)
  const errorItem = items.find((item) => item && item.key === 'error')
  if (errorItem) {
    const detail = Array.isArray(errorItem.payload)
      ? errorItem.payload.join('; ')
      : String(errorItem.payload ?? 'unknown error')
    throw new Error(`WoS 会话失效或请求被拒（${detail}）`)
  }
  const info = searchInfoOf(items)
  const records = recordsOf(items)
  return {
    sid,
    qid: info?.QueryID ?? null,
    recordsSearched: info?.RecordsSearched ?? null,
    recordsFound: info?.RecordsFound ?? null,
    recordsAvailable: info?.RecordsAvailable ?? null,
    summaries: records.map((record, index) => summarizeRecord(record, index + 1)),
    rawNdjson: text,
    streamKeys: [...new Set(items.map((item) => item.key).filter(Boolean))],
    malformedLines: malformed,
    httpStatus: status,
    url,
    payload,
  }
}
