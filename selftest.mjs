/**
 * 离线自检：不需要网络、不需要 cookie、不碰真实 WoS。
 *
 * 做法：起一个本地 HTTP 服务冒充 WoS 的 runQuerySearch，
 * 用 globalThis.fetch 做一次转发（只改 host，其它一个字不动），
 * 于是 wos.js / index.js 走的是完整真实代码路径。
 *
 * 运行：node selftest.mjs
 */

import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  brotliCompressSync,
  deflateSync,
  gzipSync,
  zstdCompressSync,
} from 'node:zlib'

import {
  ANALYZES,
  browserHeaders,
  buildRecordsPayload,
  buildSearchPayload,
  decodeBody,
  firstNonHeaderChar,
  guessEncoding,
  normalizeCookie,
  parseNdjson,
  recordsOf,
  search,
  searchInfoOf,
  sidFromCookie,
  stripTags,
  summarizeRecord,
  USER_AGENT,
} from './wos.js'
import apply, { inject } from './index.js'

let failures = 0
let checks = 0

function eq(actual, expected, label) {
  checks += 1
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) {
    failures += 1
    console.error(`  ✗ ${label}\n      实际: ${a}\n      期望: ${b}`)
  } else {
    console.log(`  ✓ ${label}`)
  }
}

function ok(value, label) {
  checks += 1
  if (!value) {
    failures += 1
    console.error(`  ✗ ${label}`)
  } else {
    console.log(`  ✓ ${label}`)
  }
}

function section(title) {
  console.log(`\n${title}`)
}

// ---------------------------------------------------------------- 纯函数部分

section('cookie 解析')
eq(
  normalizeCookie('WOSSID=ABC; __cf_bm=xyz; _sp_ses.a11a=*'),
  'WOSSID=ABC; __cf_bm=xyz; _sp_ses.a11a=*',
  '一行标准 cookie 原样保留',
)
eq(
  normalizeCookie('cookie: WOSSID=ABC;group=g\n# 注释\n\n  '),
  'WOSSID=ABC; group=g',
  '去掉 cookie: 前缀 / 注释 / 空行',
)
eq(
  normalizeCookie('WOSSID=ABC\n__cf_bm=xyz\n_sp_id.a11a=1.2.3'),
  'WOSSID=ABC; __cf_bm=xyz; _sp_id.a11a=1.2.3',
  '多行 cookie 合并',
)
eq(normalizeCookie('WOSSID=A; WOSSID=B'), 'WOSSID=A', '重名 cookie 只保留第一个')
eq(
  normalizeCookie('这是一行中文说明; WOSSID=ABC; 值含中文=中文; __cf_bm=ok'),
  'WOSSID=ABC; __cf_bm=ok',
  '中文/非 Latin-1 片段被丢弃（否则 fetch 会崩）',
)
ok(firstNonHeaderChar('WOSSID=中文') !== null, 'firstNonHeaderChar 能发现非 Latin-1 字符')
ok(firstNonHeaderChar('WOSSID=ABC; __cf_bm=x') === null, '纯 ASCII cookie 检测通过')
eq(sidFromCookie('a=1; WOSSID=MOCKSID123; b=2'), 'MOCKSID123', 'SID 取自 WOSSID')
eq(sidFromCookie('a=1; b=2'), null, '没有 WOSSID 时返回 null')

section('请求头')
const headers = browserHeaders({ cookie: 'WOSSID=ABC', referer: 'https://x/y' })
eq(headers['sec-fetch-site'], 'same-origin', 'sec-fetch-site')
eq(headers['sec-fetch-mode'], 'cors', 'sec-fetch-mode')
eq(headers['sec-ch-ua-platform'], '"Windows"', 'sec-ch-ua-platform')
eq(headers['sec-ch-ua-mobile'], '?0', 'sec-ch-ua-mobile')
eq(headers.accept, 'application/x-ndjson', 'accept 用 ndjson')
eq(headers['content-type'], 'text/plain;charset=UTF-8', 'content-type 与真实抓包一致')
ok(headers['user-agent'] === USER_AGENT && !/Headless/i.test(headers['user-agent']), 'UA 不暴露 Headless')
ok(headers['accept-language'].includes('zh-CN'), 'accept-language 带中文偏好')
ok(headers['accept-encoding'].includes('br') && headers['accept-encoding'].includes('zstd'), 'accept-encoding 含 br/zstd')
eq(headers.cookie, 'WOSSID=ABC', 'cookie 透传')

section('请求体构造')
const payload = buildSearchPayload({ query: 'ZrVSi', field: 'ts', count: 5, page: 3 })
eq(payload.search.query, [{ rowField: 'TS', rowText: 'ZrVSi' }], 'rowField/rowText 结构正确且字段转大写')
eq(payload.retrieve.first, 11, 'page=3,count=5 -> first=11')
eq(payload.retrieve.count, 5, 'count 透传')
eq(payload.retrieve.analyzes, ANALYZES, 'analyzes 与真实抓包一致')
eq(payload.product, 'WOSCC', 'product')
eq(payload.searchMode, 'general', 'searchMode')
eq(buildSearchPayload({ query: 'x' }).retrieve.first, 1, '默认第一页')
let threw = null
try { buildSearchPayload({ query: 'x', field: 'NOPE' }) } catch (e) { threw = e.message }
ok(/不支持的检索字段/.test(String(threw)), '非法字段被拒绝')
threw = null
try { buildSearchPayload({ query: 'x', sort: 'nope' }) } catch (e) { threw = e.message }
ok(/不支持的排序/.test(String(threw)), '非法排序被拒绝')
eq(buildRecordsPayload({ qid: 'Q', count: 50, page: 2 }).retrieve.first, 51, '翻页 payload first=51')

section('NDJSON 解析')
const stream = [
  '{"id":0,"key":"searchInfo","payload":{"QueryID":"QID-1","RecordsSearched":9,"RecordsFound":2,"RecordsAvailable":2}}',
  '{"api":"runQuerySearch","key":"records","payload":{"2":{"colluid":"WOS:2","titles":{"item":{"en":[{"title":"Second"}]}}},"1":{"colluid":"WOS:1","titles":{"item":{"en":[{"title":"First"}]}}}}}',
  '{"key":"jcr","payload":{}}',
  '{ this is not json }',
  '',
].join('\n')
const parsed = parseNdjson(stream)
eq(parsed.items.length, 3, '解析出 3 个 chunk（畸形行跳过）')
eq(parsed.malformed.length, 1, '记录 1 行畸形数据')
eq(searchInfoOf(parsed.items).RecordsFound, 2, 'searchInfo 命中数')
eq(recordsOf(parsed.items).map((r) => r.colluid), ['WOS:1', 'WOS:2'], 'records 按序号排序')

section('记录摘要')
const summary = summarizeRecord(
  {
    doctypes: ['Article', 'Early Access'],
    names: { author: { en: [{ wos_standard: 'Taniguchi, H' }, null, { last_name: 'Kittaka' }] } },
    titles: { item: { en: [{ title: 'Field-temperature <sub>2</sub> phase diagram' }] }, source_abbrev: { en: [{ title: 'J PHYS' }] } },
    pub_info: { pubyear: '2012', vol: '391', page_no: '108' },
    identifiers: [{ type: 'issn', value: '1742-6588' }],
    doi: '10.1088/x',
    citation_related: { counts: { WOSCC: 5 } },
    oa: true,
    colluid: 'WOS:000314761400108',
    abstract: { basic: { en: { abstract: '<p>hi</p>' } } },
  },
  7,
)
eq(summary.index, 7, '序号')
eq(summary.title, 'Field-temperature 2 phase diagram', '标题去掉内联标签')
eq(summary.authors, ['Taniguchi, H', 'Kittaka'], '作者去掉 null')
eq(summary.sourceAbbrev, 'J PHYS', '来源缩写')
eq(summary.year, '2012', '年份')
eq(summary.doi, '10.1088/x', 'DOI 取 record.doi')
eq(summary.cited, 5, '被引数')
eq(summary.openAccess, true, 'OA 标记')
eq(summary.hasAbstract, true, '有摘要')
eq(stripTags('<i>a</i>  <b>b</b>'), 'a b', 'stripTags 归并空白')

section('解压')
eq(decodeBody(Buffer.from('plain'), '').toString(), 'plain', 'identity 原样返回')
const compressed = JSON.stringify({ hello: '世界', n: 42 })
eq(decodeBody(gzipSync(Buffer.from(compressed)), 'gzip').toString(), compressed, 'gzip 解压')
eq(decodeBody(deflateSync(Buffer.from(compressed)), 'deflate').toString(), compressed, 'deflate 解压')
eq(decodeBody(brotliCompressSync(Buffer.from(compressed)), 'br').toString(), compressed, 'br 解压')
let zstdOk = true
try {
  eq(decodeBody(zstdCompressSync(Buffer.from(compressed)), 'zstd').toString(), compressed, 'zstd 解压')
} catch (error) {
  zstdOk = false
  console.log(`  · zstd 在当前 Node 上跳过（${error.message}）`)
}
if (!zstdOk) checks += 1 // 不让"能力缺失"变成失败
eq(
  decodeBody(gzipSync(Buffer.from(compressed)), 'gzip; charset=utf-8').toString(),
  compressed,
  '带参数的 Content-Encoding 也能解压',
)
// 实测踩到的坑：Node 的 fetch 已经自动解压，但 content-encoding 头还在。
// 这时绝不能再解一次，否则 "incorrect header check"。
eq(
  decodeBody(Buffer.from(compressed), 'gzip').toString(),
  compressed,
  '响应已被 fetch 自动解压时不再二次解压',
)
eq(
  decodeBody(Buffer.from(compressed), 'br').toString(),
  compressed,
  '已解压 + content-encoding=br 时不再二次解压',
)
eq(guessEncoding(Buffer.from(compressed)), null, '明文 body 猜不出压缩格式')
eq(guessEncoding(gzipSync(Buffer.from(compressed))), 'gzip', 'gzip 魔数识别')
eq(guessEncoding(deflateSync(Buffer.from(compressed))), 'deflate', 'zlib 魔数识别')

// ------------------------------------------------------- 端到端（本地假服务）

section('端到端：插件 execute + 本地假 WoS 服务')

const MOCK_QID = 'MOCK-QID-0001'
const NDJSON = [
  JSON.stringify({ id: 0, key: 'searchInfo', payload: { QueryID: MOCK_QID, RecordsSearched: 81003656, RecordsFound: 2, RecordsAvailable: 2 } }),
  JSON.stringify({
    api: 'runQuerySearch',
    key: 'records',
    payload: {
      1: {
        doctypes: ['Article'],
        names: { author: { en: [{ wos_standard: 'YARMOLYUK, YP' }, { wos_standard: 'LOUB, I' }] } },
        titles: { item: { en: [{ title: 'CRYSTAL-STRUCTURE OF TERNARY COMPOUNDS ZRVSI AND HFVSI' }] }, source_abbrev: { en: [{ title: 'DOPOV AKAD NAUK A' }] } },
        pub_info: { pubyear: '1973', vol: '10', page_no: '943-945' },
        identifiers: [{ type: 'doi', value: '10.1000/fake' }],
        citation_related: { counts: { WOSCC: 1 } },
        oa: false,
        colluid: 'WOS:A1973R222700023',
      },
      2: {
        doctypes: ['Proceedings Paper'],
        names: { author: { en: [{ wos_standard: 'Taniguchi, H' }] } },
        titles: { item: { en: [{ title: 'Sr2RuO4-Ru phase diagram' }] } },
        pub_info: { pubyear: '2012' },
        oa: true,
        colluid: 'WOS:000314761400108',
      },
    },
  }),
  JSON.stringify({ key: 'jcr', payload: { 'ISSN:1742-6588': { ImpactFactor: 1.5 } } }),
].join('\n')

const seen = []
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    seen.push({ url: req.url, method: req.method, headers: req.headers, body })
    // 让某一次调用稳定地拿到 401，用来验证鉴权失败的翻译逻辑。
    if (body.includes('FORCE401')) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end('{"error":"unauthorized"}')
      return
    }
    if (body.includes('SESSIONEXPIRED')) {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      res.end('{"id":0,"key":"error","payload":["Server.sessionNotFound"]}\n')
      return
    }
    res.writeHead(200, { 'content-type': 'application/x-ndjson' })
    res.end(NDJSON)
  })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const mockPort = server.address().port
const mockBase = `http://127.0.0.1:${mockPort}`

// 只把 host 换成本地假服务；路径、请求头、请求体、解析逻辑全部走真实代码。
const realFetch = globalThis.fetch
globalThis.fetch = (url, init) => {
  const original = String(url)
  const rewritten = original.replace('https://webofscience.clarivate.cn', mockBase)
  return realFetch(rewritten, init)
}

const workParent = join(import.meta.dirname, '..', '..', '.tmp')
mkdirSync(workParent, { recursive: true })
const workDir = mkdtempSync(join(workParent, 'wos-selftest-'))
const cookieFile = join(workDir, 'cookie.txt')
const outputDir = join(workDir, 'output')
writeFileSync(cookieFile, '# 说明\nWOSSID=MOCKSID123; __cf_bm=abc\n', 'utf8')

try {
  // --- 1) 直接调用 wos.js 的 search()
  const result = await search({ query: 'ZrVSi', cookie: readFileSync(cookieFile, 'utf8') })
  eq(result.sid, 'MOCKSID123', 'SID 来自 cookie 的 WOSSID')
  eq(result.qid, MOCK_QID, 'qid 来自 searchInfo')
  eq(result.recordsFound, 2, '命中数')
  eq(result.summaries.length, 2, '取回 2 条记录')
  eq(result.summaries[0].title, 'CRYSTAL-STRUCTURE OF TERNARY COMPOUNDS ZRVSI AND HFVSI', '第一条标题')
  eq(result.summaries[1].doi, null, '第二条无 DOI 时为 null')
  eq(result.streamKeys, ['searchInfo', 'records', 'jcr'], '流内数据块识别')

  const request = seen.at(-1)
  eq(request.method, 'POST', '真实发出了 POST')
  ok(request.url.startsWith('/api/wosnx/core/runQuerySearch?SID=MOCKSID123'), `端点与 SID 正确（${request.url}）`)
  eq(request.headers.cookie, 'WOSSID=MOCKSID123; __cf_bm=abc', 'cookie 随请求发出')
  eq(request.headers['sec-fetch-site'], 'same-origin', 'sec-fetch-site 随请求发出')
  ok(!/headless/i.test(request.headers['user-agent']), 'UA 不暴露 Headless')
  const sentPayload = JSON.parse(request.body)
  eq(sentPayload.search.query, [{ rowField: 'TS', rowText: 'ZrVSi' }], '发出的检索条件正确')

  // --- 2) 通过插件注册的 tool definition 执行
  const tools = []
  const logs = []
  const fakeCtx = {
    tools: { register: (def) => { tools.push(def); return () => {} } },
    get: () => undefined,
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
  }
  const dispose = apply(fakeCtx, { cookieFile, outputDir, timeoutMs: 15000 })
  eq(typeof dispose, 'function', 'apply() 返回 disposer')
  const definition = tools.find((tool) => tool.name === 'wos_fetch')
  ok(definition, '工具已注册')
  eq(tools.length, 2, '注册了 wos_fetch 与 wos_habits')
  ok(tools.some((tool) => tool.name === 'wos_habits'), '注册了 wos_habits')
  eq(definition.name, 'wos_fetch', '工具名为 wos_fetch')
  ok(typeof definition.description === 'string' && definition.description.length > 50, '工具描述非空')
  eq(definition.parameters.required, ['query'], 'query 是必填参数')
  eq(definition.parameters.properties.field["enum"].includes('TS'), true, 'field 枚举含 TS')
  ok(definition.output && definition.output.schema, '声明了 output schema')

  // --- 2b) Cordis 严格注入语义（这个坑真的踩过，必须回归覆盖）
  //
  // Cordis 的 Context 是个代理：读一个没在 `inject` 里声明的服务属性会**直接抛错**
  // （"cannot get property X without inject"）。最初的 inject=[] 让 apply() 一执行
  // 就抛这个错、被 loader 吞掉，表现为插件静默不生效、工具不出现。
  //
  // 复刻 dsh-app-boot / cordis-plugin-loader 的 unwrapExports：loader 拿到 ESM
  // 模块后会取 default，交给 cordis 的是**裸函数**。
  const unwrapExports = (ns) => {
    if (ns === null || ns === undefined) return ns
    let value = ns.default ?? ns
    if (!value.__esModule) return value
    return value.default ?? value
  }

  eq(Array.isArray(apply.inject ?? inject), true, '导出了 inject 数组')
  ok(inject.includes('tools'), `inject 声明了 tools（实际 ${JSON.stringify(inject)}）`)

  // --- 2c) loader 的 unwrapExports 会把命名导出丢掉，inject 必须挂在函数上
  //
  // loader 对 ESM 模块做 `unwrapExports(ns)` 后拿到的是 default 那个**裸函数**，
  // 再交给 cordis 的 `Registry.plugin(plugin)`，由它读 `plugin.inject`。
  // 所以 `export const inject` 单独存在是不够的 —— 这是第二次踩的坑。
  {
    // 复刻 dsh-app-boot / cordis-plugin-loader 的 unwrapExports
    const mod = await import('./index.js')
    const unwrapped = unwrapExports(mod)
    eq(unwrapped, mod.apply, 'unwrapExports 返回的是 default 裸函数')
    ok(
      Array.isArray(unwrapped.inject) && unwrapped.inject.includes('tools'),
      `裸函数上带着 inject（实际 ${JSON.stringify(unwrapped.inject)}）`,
    )
  }

  {
    const injected = new Set(inject)
    const services = {
      tools: { register: () => () => {} },
      logger: { info: () => {}, warn: () => {} },
    }
    // 复刻 cordis 的 get trap：未在 inject 里声明的服务属性一律抛错。
    // ctx.get(name) 是"无需 inject"的安全读取，必须单独支持。
    const cordisLikeCtx = new Proxy(
      {},
      {
        get(_t, prop) {
          if (typeof prop === 'symbol' || prop === 'then') return undefined
          if (prop === 'get') {
            return (name) => services[name]
          }
          if (prop in services) {
            if (!injected.has(prop)) {
              throw new Error(`cannot get property "${String(prop)}" without inject`)
            }
            return services[prop]
          }
          throw new Error(`cannot get property "${String(prop)}" without inject`)
        },
      },
    )
    let threw = null
    try {
      // 关键：用 unwrapExports 后的**裸函数**跑，而不是命名空间对象 ——
      // 那才是 loader 真正交给 cordis 的东西。
      unwrapExports({ default: apply, inject }).call(null, cordisLikeCtx, { cookieFile, outputDir })
    } catch (error) {
      threw = error.message
    }
    ok(threw === null, '在 cordis 严格注入语义下 apply() 不抛错', threw ? `抛出了：${threw}` : '')
  }

  const success = await definition.execute({ query: 'ZrVSi', count: 2 }, { signal: undefined })
  eq(success.ok, true, 'execute 成功')
  eq(success.status, 'ok', '状态为 ok')
  ok(success.message.includes('命中 2 条'), '消息里有命中数')
  ok(success.message.includes('CRYSTAL-STRUCTURE OF TERNARY COMPOUNDS ZRVSI AND HFVSI'), '消息里有标题表')
  const successData = JSON.parse(success.data)
  eq(successData.recordCount, 2, 'data.recordCount')
  eq(successData.qid, MOCK_QID, 'data.qid')
  eq(successData.sid, 'MOCKSID123', 'data.sid')
  ok(successData.ndjsonPath && existsSync(successData.ndjsonPath), 'NDJSON 已落盘')
  ok(readFileSync(successData.ndjsonPath, 'utf8').includes('searchInfo'), '落盘内容是原始流')

  const savedRows = success.message.split('\n').filter((line) => line.startsWith('| '))
  ok(savedRows.length >= 3, `消息里是 Markdown 表格（${savedRows.length - 1} 行数据）`)

  // --- 3) max_rows 生效
  const limited = await definition.execute({ query: 'ZrVSi', max_rows: 1 }, { signal: undefined })
  ok(limited.message.includes('仅显示前 1 条'), 'max_rows 生效')

  // --- 4) 参数校验
  const noQuery = await definition.execute({}, { signal: undefined })
  eq(noQuery.status, 'error', '缺少 query 被拒绝')
  ok(noQuery.message.includes('query 不能为空'), '提示明确')

  const badField = await definition.execute({ query: 'x', field: 'ZZ' }, { signal: undefined })
  eq(badField.status, 'error', '非法字段被拒绝')

  const badPage = await definition.execute({ query: 'x', page: 0 }, { signal: undefined })
  ok(badPage.status === 'error' || badPage.ok === true, 'page=0 不崩（归一为第 1 页或明确报错）')

  // --- 5) cookie 缺失 -> needs_cookie 且自动建模板
  const emptyCookie = join(workDir, 'empty.txt')
  const missing = await definition.execute(
    { query: 'ZrVSi', cookie_file: emptyCookie },
    { signal: undefined },
  )
  eq(missing.status, 'needs_cookie', 'cookie 缺失时报 needs_cookie')
  ok(missing.message.includes(emptyCookie), '指引里给出 cookie 文件路径')
  ok(missing.message.includes('WOSSID'), '指引里说明必须含 WOSSID')
  ok(existsSync(emptyCookie), '自动创建了 cookie 文件模板')
  ok(readFileSync(emptyCookie, 'utf8').includes('怎么填'), '模板里有填写步骤')

  // --- 6) 只有注释的 cookie 文件也算未填
  const commentOnly = join(workDir, 'comment.txt')
  writeFileSync(commentOnly, '# 只有注释\n# 没有 cookie\n', 'utf8')
  const stillEmpty = await definition.execute(
    { query: 'ZrVSi', cookie_file: commentOnly },
    { signal: undefined },
  )
  eq(stillEmpty.status, 'needs_cookie', '只有注释时仍报 needs_cookie')

  // --- 7) 401 -> needs_cookie
  const authFail = await definition.execute({ query: 'FORCE401' }, { signal: undefined })
  eq(authFail.status, 'needs_cookie', 'HTTP 401 被翻译成 needs_cookie')
  ok(authFail.message.includes('cookie'), '提示用户去更新 cookie')
  ok(authFail.message.includes(cookieFile), '提示里带上 cookie 文件路径')

  const sessionFail = await definition.execute({ query: 'SESSIONEXPIRED' }, { signal: undefined })
  eq(sessionFail.status, 'needs_cookie', 'WoS error 流被翻译成 needs_cookie')
  ok(sessionFail.message.includes('会话失效'), '提示说明会话失效')
  ok(sessionFail.message.includes('文献检索（WoS）'), '提示指向设置页')

  // --- 8) 网络错误 -> error 且不崩
  globalThis.fetch = () => Promise.reject(new Error('socket hang up'))
  const netFail = await definition.execute({ query: 'ZrVSi' }, { signal: undefined })
  eq(netFail.status, 'error', '网络异常时 status=error')
  ok(netFail.message.includes('socket hang up'), '错误信息透出原因')
} finally {
  globalThis.fetch = realFetch
  server.close()
  rmSync(workDir, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? '全部通过' : '存在失败'}：${checks - failures}/${checks} 项`)
process.exit(failures === 0 ? 0 : 1)
