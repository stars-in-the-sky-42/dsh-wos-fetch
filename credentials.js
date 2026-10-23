/**
 * 从 DSH 凭据库解析 WoS cookie。
 *
 * 设置页把 cookie 写进 `DSH_WOS_COOKIE`；这里按顺序尝试几个引用名，
 * 读不到再回退到旧文件。任何情况下都不把明文写进日志或工具输出。
 */

/** 设置页写入的引用名，放在第一位。 */
export const PRIMARY_COOKIE_REF = 'DSH_WOS_COOKIE'

/** 兼容用户自己用环境变量提供 cookie 的情况。 */
export const FALLBACK_COOKIE_REFS = ['DSH_WOS_COOKIE', 'WOS_COOKIE']

/**
 * Resolve the first configured credential among `refs`.
 *
 * @param {object} ctx - plugin context; `credentials` is read optionally.
 * @param {readonly string[]} refs - credential reference names.
 * @returns {Promise<{value: string, ref: string, source?: string} | undefined>}
 */
export async function resolveCredential(ctx, refs = FALLBACK_COOKIE_REFS) {
  const store = ctx?.get?.('credentials')
  if (!store || typeof store.resolve !== 'function') return undefined
  for (const ref of refs) {
    try {
      const got = await store.resolve(ref)
      const value = got && typeof got.value === 'string' ? got.value.trim() : ''
      if (value) return { value, ref, source: got.source }
    } catch {
      /* 某个引用读失败不影响下一个 */
    }
  }
  return undefined
}
