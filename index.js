/**
 * dsh-wos-fetch —— Web of Science 检索插件（DSH Host 半）。
 *
 * 提供一个模型可调用的工具 `wos_fetch`：
 *   用 cookie 文件里的会话凭据，直接 POST WoS 的 runQuerySearch 接口，
 *   把 NDJSON 记录流解析成"精简表格 + 原始流落盘"。
 *
 * 为什么不用浏览器：实测（NOTES-wos.md）证明这条纯 HTTP 链路可用，
 * 摆脱了 Edge 启动、页面渲染、Cookie 横幅那一整套脆弱依赖。
 * 浏览器驱动的旧路径与 Python 脚本已删除，只保留本插件一条合法路径。
 *
 * 环境变量（可选，覆盖插件 config）：
 *   WOS_COOKIE_FILE, WOS_OUTPUT_DIR
 */

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import {
  BASE,
  FIELDS,
  SORTS,
  buildSearchPayload,
  search,
  summaryUrl,
} from './wos.js'
import {
  cookieHelp,
  defaultCookieFile,
  ensureCookieFile,
  readCookieFile,
} from './cookie-store.js'
import { FALLBACK_COOKIE_REFS, resolveCredential } from './credentials.js'
import { registerSettingsRoute } from './settings-route.js'
import {
  MAX_HABITS_CHARS,
  readHabits,
  resetHabits,
  writeHabits,
} from './habits.js'
import { dataDir, outputDir } from './settings-store.js'

export const name = 'wos-fetch'

/**
 * 必须声明 inject（注册工具的唯一硬依赖）。
 *
 * Cordis 是严格依赖注入：`ctx.tools` 这类服务属性必须先在 inject 里声明，
 * 否则**读取就抛错** —— cordis 的 Context 代理里写得很直接：
 *   `throw new Error('cannot get property "' + prop + '" without inject')`
 *
 * 踩过的坑：最初写成 `inject = []`，apply() 一执行就抛这个错，
 * 被 loader 的 try/catch 吞掉（只在日志里留一行），结果是插件静默不生效、
 * 工具永远不出现 —— 现象上非常像"插件没装"。
 *
 * 注意 logger **不要**放进 inject：它不是注册工具所必需的，
 * 放进去反而会让插件在缺少该服务的组合下无法加载。用 ctx.get('logger') 可选读取。
 */
export const inject = ['tools']

/** 可选 logger：ctx.get() 是"无需 inject"的安全读取，缺失时返回 undefined。 */
function loggerOf(ctx) {
  try {
    return ctx.get?.('logger')
  } catch {
    return undefined
  }
}

function logInfo(ctx, message) {
  try {
    loggerOf(ctx)?.info?.(message)
  } catch {
    /* 日志失败绝不该影响插件功能 */
  }
}

function logWarn(ctx, message) {
  try {
    loggerOf(ctx)?.warn?.(message)
  } catch {
    /* 同上 */
  }
}

export const Config = {
  cookieFile: {
    type: 'string',
    description:
      '旧版 cookie 文件路径（回退用）。默认 <DSH_HOME>/storages/wos-fetch/cookie.txt；设置页保存的凭据优先。',
  },
  outputDir: {
    type: 'string',
    description: '原始 NDJSON 的落盘目录。默认 <DSH_HOME>/storages/wos-fetch/output。',
  },
  referer: {
    type: 'string',
    description: '请求 Referer。默认 WoS 基础检索页；换成自己实际的检索页更像真实用户。',
  },
  timeoutMs: {
    type: 'number',
    description: '单次 HTTP 请求超时（毫秒）。默认 60000。',
  },
}

const TOOL_NAME = 'wos_fetch'

const TOOL_DESCRIPTION = [
  '检索 Web of Science 核心合集（WoSCC），返回结构化文献记录。',
  '',
  '用法要点：',
  '- 直接用检索词检索，无需浏览器、无需手动提供 qid；qid 由接口返回。',
  `- 检索字段 field 可选：${Object.entries(FIELDS).map(([key, label]) => `${key}（${label}）`).join('、')}。默认 TS=主题。`,
  `- 排序 sort 可选：${SORTS.join(' / ')}。`,
  '- 会话凭据优先取 DSH 凭据库里的 WoS cookie（设置页管理），未配置时回退到 cookie 文件；过期时返回更新指引。',
  '- 返回精简记录表（标题/作者/来源/年/DOI/被引）；完整原始 NDJSON 会落到磁盘，避免占用上下文。',
  '- 想拿摘要全文或其它字段，用返回里的 ndjson_path 去读原始文件。',
  '- 系统提示里会带上本机“课题组 WoS 检索习惯”；用户要求修改习惯时调用 wos_habits。',
].join('\n')

const PARAMETERS = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: '检索词，例如 "ZrVSi" 或 \'"Sr2RuO4" AND superconduct*\'。',
    },
    field: {
      type: 'string',
      description: `检索字段（rowField）。默认 TS。可选：${Object.keys(FIELDS).join(' / ')}。`,
      enum: Object.keys(FIELDS),
    },
    sort: {
      type: 'string',
      description: '排序方式。默认 relevance。date=最新优先，times-cited=被引最多优先。',
      enum: SORTS,
    },
    count: {
      type: 'number',
      description: '本次取回多少条记录。默认 50，最大 200。',
    },
    page: {
      type: 'number',
      description: '第几页（从 1 开始）。默认 1。配合 count 实现翻页。',
    },
    cookie_file: {
      type: 'string',
      description: '覆盖 cookie 文件路径（一般不需要，插件已配置默认路径）。',
    },
    save: {
      type: 'boolean',
      description: '是否把原始 NDJSON 落盘。默认 true。',
    },
    max_rows: {
      type: 'number',
      description: '返回的精简记录最多几行。默认 30，避免刷屏。',
    },
  },
  required: ['query'],
}

const OUTPUT = {
  schema: {
    type: 'object',
    properties: {
      ok: { type: 'boolean', description: '本次调用是否成功得到结果。' },
      status: {
        type: 'string',
        description: '结果状态：ok / needs_cookie / error。',
      },
      message: { type: 'string', description: '给模型看的可读总结（含记录表）。' },
      data: { type: 'string', description: '结构化结果（JSON 字符串）。' },
    },
    required: ['ok', 'status', 'message'],
  },
  render(_args, value) {
    const status = value && typeof value === 'object' ? value.status : undefined
    return [
      {
        type: 'text',
        text: String((value && typeof value === 'object' && value.message) || '(无输出)'),
      },
      ...(status === 'needs_cookie'
        ? [{ type: 'text', text: '需要补充 cookie 后重试。' }]
        : []),
    ]
  },
}

function envOr(envName, fallback) {
  const value = process.env[envName]
  return value && String(value).trim() ? String(value).trim() : fallback
}

function formatTable(rows) {
  if (!rows.length) return '（没有返回记录）'
  const lines = [
    '| # | 标题 | 作者 | 来源 | 年 | DOI | 被引 |',
    '|---|------|------|------|----|-----|------|',
  ]
  for (const row of rows) {
    const authors = row.authors.length
      ? row.authors.length > 3
        ? `${row.authors.slice(0, 3).join('; ')} 等 ${row.authors.length} 人`
        : row.authors.join('; ')
      : '（无）'
    const source = row.sourceAbbrev || row.source || '（无）'
    const cell = (text) => String(text ?? '（无）').replace(/\|/g, '\\|')
    lines.push(
      `| ${row.index} | ${cell(row.title)} | ${cell(authors)} | ${cell(source)} | ` +
        `${cell(row.year)} | ${cell(row.doi)} | ${cell(row.cited)} |`,
    )
  }
  return lines.join('\n')
}

function buildMessage(result, { query, field, sort, page, count, maxRows, ndjsonPath, saved }) {
  const found = result.recordsFound ?? '未知'
  const searched = result.recordsSearched ?? '未知'
  const shown = Math.min(result.summaries.length, maxRows)
  const head = [
    `Web of Science 检索：${field} = "${query}"`,
    `命中 ${found} 条（检索范围 ${searched} 条），本页取回 ${result.summaries.length} 条` +
      (sort !== 'relevance' ? `，排序 ${sort}` : '') +
      `，第 ${page} 页 / 每页 ${count} 条`,
  ]
  if (result.qid) head.push(`qid：${result.qid}`)
  if (result.qid) head.push(`页面：${summaryUrl(result.qid)}`)
  const body = [
    '',
    formatTable(result.summaries.slice(0, shown)),
  ]
  if (result.summaries.length > shown) {
    body.push('', `（仅显示前 ${shown} 条，其余见原始 NDJSON）`)
  }
  if (ndjsonPath) {
    body.push('', `原始 NDJSON：${ndjsonPath}${saved ? '' : '（未落盘）'}`)
  }
  if (result.streamKeys?.length) {
    body.push(`流内数据块：${result.streamKeys.join(', ')}`)
  }
  if (result.malformedLines?.length) {
    body.push(`⚠️ 跳过了 ${result.malformedLines.length} 行畸形数据`)
  }
  return [...head, ...body].join('\n')
}

/** 把可预期的失败翻译成"该怎么办"，而不是丢一个裸错误。 */
function describeError(error) {
  const message = String(error?.message || error)
  if (/HTTP 40[13]|鉴权失败|未授权|unauthor|sessionNotFound|会话失效/i.test(message)) {
    return {
      status: 'needs_cookie',
      hint:
        '接口返回会话失效或鉴权失败，通常是 cookie 过期、与当前 UA 不匹配，或当前网络没有 WoS 访问权限。' +
        '请重新从浏览器复制 cookie，在“设置 → 文献检索（WoS）”里覆盖保存。',
    }
  }
  return { status: 'error', hint: message }
}

/**
 * 诊断用：把 apply() 期间的异常同时写到 stderr 和一个诊断文件。
 *
 * 为什么需要：loader 对插件初始化的异常是 try/catch 吞掉的，只在日志里留一行，
 * 排查时看不到真实报错。写入固定路径后可直接查看。
 * 诊断文件在工作区内（符合工作区约定），失败也不影响主流程。
 */
function reportApplyError(error) {
  const stamp = new Date().toISOString()
  const text =
    `[${stamp}] apply() 抛出异常\n` +
    `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}\n` +
    `${error?.stack ?? '(no stack)'}\n`
  try {
    process.stderr.write(`dsh-wos-fetch: apply() failed: ${error?.message ?? String(error)}\n`)
    process.stderr.write(`${error?.stack ?? ''}\n`)
  } catch {
    /* stderr 不可用时忽略 */
  }
  try {
    const file = join(dataDir(), 'plugin-apply-error.log')
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, text, 'utf8')
  } catch {
    /* 诊断写入失败绝不影响主流程 */
  }
}

export function apply(ctx, config = {}) {
  try {
    return applyInner(ctx, config)
  } catch (error) {
    reportApplyError(error)
    throw error
  }
}

/**
 * ⚠️ 关键：必须把 inject 也挂到 apply **函数对象本身**上。
 *
 * 原因（已实测确认）：cordis 的 `Registry.plugin(plugin, …)` 读取的是
 * `plugin.inject`；而 loader 会先做 `unwrapExports(moduleNamespace)`，
 * 对 ESM 模块这一步返回的是 **default 导出的那个裸函数**，
 * 模块上的命名导出 `inject` 在那时已经丢失。
 *
 * 结果就是：`export const inject = ['tools']` 看着对、但真正被读到的是
 * `undefined`，于是 `ctx.tools` 抛
 * "cannot get property \"tools\" without inject"，插件静默 failed。
 *
 * 命名导出保留（DSH 官方插件的写法，供 loader/preflight 读取），
 * 这里额外挂一份到函数上，两条路径都覆盖。
 */
apply.inject = inject

function applyInner(ctx, config = {}) {
  const tools = ctx.tools
  if (!tools || typeof tools.register !== 'function') {
    throw new Error('dsh-wos-fetch：拿不到 ctx.tools，无法注册 wos_fetch 工具')
  }

  const state = {
    cookieFileOverride: config.cookieFile ?? envOr('WOS_COOKIE_FILE', null),
    outputDirOverride: config.outputDir ?? envOr('WOS_OUTPUT_DIR', null),
    referer: config.referer ?? undefined,
    timeoutMs: Number(config.timeoutMs ?? 60000),
  }

  /**
   * Resolve the cookie for one call.
   *
   * Precedence: explicit `cookie_file` argument, then the DSH credential store,
   * then the legacy cookie file. The returned object never carries a path when
   * the value came from the credential store.
   */
  const loadCookie = async (override) => {
    if (override) {
      const file = String(override)
      const read = readCookieFile(file)
      if (read.ok) return { ok: true, text: read.text, source: 'file', path: read.path, modifiedAt: read.modifiedAt }
      try {
        ensureCookieFile(file)
      } catch (error) {
        logWarn(ctx, `dsh-wos-fetch: 无法创建 cookie 文件：${error.message}`)
      }
      return { ok: false, source: 'file', path: read.path, reason: read.reason }
    }

    const credential = await resolveCredential(ctx, FALLBACK_COOKIE_REFS)
    if (credential) {
      return {
        ok: true,
        text: credential.value,
        source: 'credential',
        ref: credential.ref,
        origin: credential.source,
        path: null,
      }
    }

    const fallbackFile = state.cookieFileOverride ?? defaultCookieFile()
    const read = readCookieFile(fallbackFile)
    if (read.ok) {
      return { ok: true, text: read.text, source: 'file', path: read.path, modifiedAt: read.modifiedAt }
    }
    try {
      ensureCookieFile(fallbackFile)
    } catch (error) {
      logWarn(ctx, `dsh-wos-fetch: 无法创建 cookie 文件：${error.message}`)
    }
    return { ok: false, source: 'file', path: read.path, reason: read.reason }
  }

  const definition = {
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: PARAMETERS,
    output: OUTPUT,
    timeoutMs: 180000,
    isConcurrencySafe: () => false,

    presentCall(args) {
      const field = args?.field || 'TS'
      return {
        card: 'generic',
        title: `WoS 检索 ${field}="${args?.query ?? ''}"`,
        kind: 'fetch',
        rawInput: args,
      }
    },

    presentResult(args, result) {
      const status = result && typeof result === 'object' ? result.status : undefined
      return {
        card: 'generic',
        title:
          status === 'ok'
            ? `WoS 检索完成：${args?.query ?? ''}`
            : status === 'needs_cookie'
              ? 'WoS 检索需要补充 cookie'
              : 'WoS 检索失败',
        content: [{ type: 'text', text: String(result?.message ?? '') }],
      }
    },

    async execute(args, exec) {
      const query = String(args?.query ?? '').trim()
      const field = String(args?.field ?? 'TS').toUpperCase()
      const sort = String(args?.sort ?? 'relevance')
      const count = Math.min(Math.max(Number(args?.count ?? 50) || 50, 1), 200)
      const page = Math.max(Number(args?.page ?? 1) || 1, 1)
      const maxRows = Math.min(Math.max(Number(args?.max_rows ?? 30) || 30, 1), 200)
      const save = args?.save !== false
      const cookieFile = args?.cookie_file
        ? String(args.cookie_file)
        : state.cookieFileOverride ?? defaultCookieFile()

      const fail = (status, message, extra = {}) => ({
        ok: false,
        status,
        message,
        data: JSON.stringify({ status, cookieFile, ...extra }),
      })

      if (!query) {
        return fail('error', 'query 不能为空。请给出检索词，例如 query="ZrVSi"。')
      }

      if (field && !Object.prototype.hasOwnProperty.call(FIELDS, field)) {
        return fail(
          'error',
          `不支持的检索字段 "${field}"。可用字段：${Object.keys(FIELDS).join(' / ')}。`,
        )
      }

      // 参数先校验一次，避免带着坏 payload 去发请求。
      try {
        buildSearchPayload({ query, field, count, sort, page })
      } catch (error) {
        return fail('error', error.message)
      }

      const cookie = await loadCookie(args?.cookie_file)
      if (!cookie.ok) {
        const guidance = cookieHelp({ path: cookie.path, reason: cookie.reason })
        return {
          ok: false,
          status: 'needs_cookie',
          message: guidance,
          data: JSON.stringify({
            status: 'needs_cookie',
            cookieFile: cookie.path ?? null,
            cookieSource: cookie.source,
            reason: cookie.reason,
          }),
        }
      }

      try {
        const result = await search({
          query,
          field,
          count,
          sort,
          page,
          cookie: cookie.text,
          signal: exec?.signal,
          timeoutMs: state.timeoutMs,
          referer: state.referer,
        })

        let ndjsonPath = null
        let saved = false
        if (save) {
          try {
            const stamp = new Date().toISOString().replace(/[:.]/g, '-')
            const safeTag = query.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 40) || 'query'
            const dir = state.outputDirOverride ?? outputDir()
            mkdirSync(dir, { recursive: true })
            ndjsonPath = join(dir, `wos-${safeTag}-p${page}-${stamp}.ndjson`)
            // 先落盘再裁剪上下文：原始流往往几十 KB 到几 MB，不该进对话。
            writeFileSync(ndjsonPath, result.rawNdjson, 'utf8')
            saved = true
          } catch (error) {
            logWarn(ctx, `dsh-wos-fetch: NDJSON 落盘失败：${error.message}`)
          }
        }

        const message = buildMessage(result, {
          query,
          field,
          sort,
          page,
          count,
          maxRows,
          ndjsonPath,
          saved,
        })

        const data = {
          status: 'ok',
          field,
          sort,
          page,
          count,
          query,
          host: BASE,
          sid: result.sid,
          qid: result.qid,
          recordsFound: result.recordsFound,
          recordsSearched: result.recordsSearched,
          recordsAvailable: result.recordsAvailable,
          recordCount: result.summaries.length,
          records: result.summaries,
          streamKeys: result.streamKeys,
          ndjsonPath: saved ? ndjsonPath : null,
          cookieFile: cookie.path ?? null,
          cookieSource: cookie.source,
          cookieRef: cookie.ref ?? null,
          cookieModifiedAt: cookie.modifiedAt ?? null,
        }

        return { ok: true, status: 'ok', message, data: JSON.stringify(data) }
      } catch (error) {
        const { status, hint } = describeError(error)
        const guidance =
          status === 'needs_cookie'
            ? `${hint}\n\n${cookieHelp({ path: cookie.path, reason: 'stale' })}`
            : `检索失败：${hint}`
        logWarn(ctx, `dsh-wos-fetch: ${hint}`)
        return fail(status, guidance, { error: String(error?.message || error) })
      }
    },
  }

  const habitsDefinition = {
    name: 'wos_habits',
    description:
      '读取、写入或重置本机 WoS 检索习惯。用户口述检索偏好时用 write 保存成条目；不要只记在对话里。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'read=读取当前习惯；write=保存新习惯；reset=恢复出厂默认。',
          enum: ['read', 'write', 'reset'],
        },
        content: {
          type: 'string',
          description: `write 时必填。完整的习惯正文，建议用编号列表；上限 ${MAX_HABITS_CHARS} 字。`,
        },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          message: { type: 'string', description: '给模型看的可读结果。' },
          data: { type: 'string', description: '结构化结果（JSON 字符串）。' },
        },
        required: ['ok', 'message'],
      },
      render(_args, value) {
        return [{ type: 'text', text: String(value?.message ?? '(无输出)') }]
      },
    },
    timeoutMs: 15000,
    isConcurrencySafe: () => false,

    async execute(args) {
      const action = String(args?.action ?? 'read').toLowerCase()
      try {
        if (action === 'read') {
          const current = readHabits()
          return {
            ok: true,
            message: `当前 WoS 检索习惯（${current.path}）：\n\n${current.content.trim()}`,
            data: JSON.stringify({ action, ...current }),
          }
        }
        if (action === 'write') {
          const next = writeHabits(args?.content)
          return {
            ok: true,
            message: `已保存 WoS 检索习惯（${next.content.trim().length} 字）到：\n${next.path}\n\n下一条消息起生效。`,
            data: JSON.stringify({ action, ...next }),
          }
        }
        if (action === 'reset') {
          const next = resetHabits()
          return {
            ok: true,
            message: `已恢复出厂默认 WoS 检索习惯。\n路径：${next.path}\n\n下一条消息起生效。`,
            data: JSON.stringify({ action, ...next }),
          }
        }
        return {
          ok: false,
          message: `不认识的 action "${action}"；可用 read / write / reset。`,
          data: JSON.stringify({ action, error: 'invalid-action' }),
        }
      } catch (error) {
        return {
          ok: false,
          message: `习惯操作失败：${error?.message || error}`,
          data: JSON.stringify({ action, error: String(error?.message || error) }),
        }
      }
    },
  }

  const disposers = [
    tools.register(definition),
    tools.register(habitsDefinition),
  ]

  /**
   * Web routes are optional: desktop Electron loads the client over file:// and
   * has no HTTP carrier. Use `ctx.inject` instead of `ctx.get` because the
   * webserver service may activate after this plugin; a one-shot `get` returns
   * undefined and the route silently never appears (observed as 404 on the
   * settings API).
   */
  try {
    const fiber = ctx.inject(['webServer'], (webCtx) => {
      try {
        const dispose = registerSettingsRoute(webCtx.webServer)
        if (typeof dispose === 'function') {
          logInfo(ctx, 'dsh-wos-fetch: 数据位置路由已注册')
          return dispose
        }
        logWarn(ctx, 'dsh-wos-fetch: webServer 不可用，跳过数据位置路由')
      } catch (error) {
        logWarn(ctx, `dsh-wos-fetch: 注册数据位置路由失败：${error.message}`)
      }
      return undefined
    })
    if (fiber && typeof fiber.dispose === 'function') disposers.push(() => fiber.dispose())
  } catch (error) {
    logWarn(ctx, `dsh-wos-fetch: 注册数据位置路由失败：${error.message}`)
  }
  logInfo(ctx, `dsh-wos-fetch: 已注册工具 ${TOOL_NAME}, wos_habits`)

  const systemPrompt = ctx.get?.('systemPrompt')
  if (systemPrompt && typeof systemPrompt.section === 'function') {
    try {
      const disposePrompt = systemPrompt.section({
        name: 'essayreader-wos-habits',
        order: 3005,
        text: () => {
          try {
            const current = readHabits()
            const body = current.content.trim()
            if (!body) return ''
            const clipped =
              body.length > 6000
                ? `${body.slice(0, 6000)}\n\n（习惯文档较长，此处截断；完整内容见 ${current.path}）`
                : body
            return [
              '## 课题组 WoS 检索习惯（本机）',
              '',
              clipped,
              '',
              `习惯文档：${current.path}`,
              '当用户要求修改检索习惯时，调用 wos_habits(action="write", content="...") 保存；不要只记在对话里。',
            ].join('\n')
          } catch {
            return ''
          }
        },
      })
      if (typeof disposePrompt === 'function') disposers.push(disposePrompt)
    } catch (error) {
      logWarn(ctx, `dsh-wos-fetch: 注册系统提示失败：${error.message}`)
    }
  }

  return () => {
    for (const dispose of disposers) {
      try {
        dispose?.()
      } catch {
        /* 卸载失败不该抛 */
      }
    }
  }
}

export default apply
