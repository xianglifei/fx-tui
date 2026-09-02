/** Account introspection: /provider, /login, /logout, /balance.
 *
 * All four are read-only, and /login and /logout deliberately stay that way.
 * A key passed on a command line would reach the debug log before any handler
 * could refuse it, so fx-tui never accepts one — it reports where the current
 * credential lives and lets the user manage it out of band.
 */

// Type-only: the host provides the credentials service; the bundle ships no
// runtime dependency on it.
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { truncateLine } from '../ui/estimate.js'
import type { CommandCtx } from './types.js'

/** The credential every DeepSeek route resolves. */
const API_KEY_REF = 'DEEPSEEK_API_KEY'
const BALANCE_ENDPOINT = 'https://api.deepseek.com/user/balance'
const BALANCE_TIMEOUT_MS = 8000

/** `CredentialRef` is a compile-time brand over the environment-variable name. */
function asCredentialRef(name: string): CredentialRef {
  return name as CredentialRef
}

export function runProvider(c: CommandCtx): void {
  const route = c.selectionRef.current ?? c.selection
  let providers: readonly { id: string; name?: string }[] = []
  try {
    providers = c.ctx.llm.listProviders()
  } catch { /* the registry is display-optional */ }
  let configurable: readonly { provider: string; displayName?: string; settingsNs?: string; declared?: boolean }[] = []
  try {
    configurable = c.ctx.llm.listConfigurableProviders()
  } catch { /* the directory is display-optional */ }

  const lines: string[] = [
    `当前路由：${c.modelLabel()}`,
    '',
    `已注册 provider（${providers.length}）：`,
    ...providers.map(entry => `· ${entry.id}${entry.name !== undefined && entry.name !== entry.id ? `（${entry.name}）` : ''}${entry.id === route.provider ? ' ← 当前' : ''}`),
  ]
  if (configurable.length > 0) {
    lines.push(
      '',
      `可配置 provider（${configurable.length}）：`,
      ...configurable.map(entry => `· ${entry.provider}${entry.displayName !== undefined && entry.displayName !== entry.provider ? `（${entry.displayName}）` : ''}${entry.declared === false ? '' : entry.settingsNs !== undefined ? ` · 设置段 ${entry.settingsNs}` : ''}`),
    )
  }
  lines.push(
    '',
    'fx-tui 不在运行时新增 provider：设置 DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL 环境变量，',
    '或在 dsh 的设置文件里配置 provider 后重启 fx-tui（/model 只在此处已注册的路由间切换）。',
  )
  c.store.addPanel('Provider', lines)
}

export async function runLogin(c: CommandCtx): Promise<void> {
  const info = await describeKey(c)
  const envSet = (process.env[API_KEY_REF] ?? '') !== ''
  const lines: string[] = [
    `环境变量 ${API_KEY_REF}：${envSet ? '已设置' : '未设置'}`,
    `凭证服务：${info === undefined ? '不可用（当前 dsh 未提供 credentials）' : '可用'}`,
  ]
  if (info !== undefined) {
    lines.push(
      `解析结果：${info.configured ? '已配置' : '未配置'}`,
      `来源：${info.source ?? '—'}`,
      `可写：${info.writable ? '是' : '否'}`,
    )
  }
  lines.push(
    '',
    'fx-tui 不接受密钥作为参数（命令行参数会落到调试日志里）。要配置凭证：',
    `· 环境变量：export ${API_KEY_REF}=…（重启 fx-tui 生效）`,
    `· 凭证文件：${credentialFile()}`,
    `· 项目 / 用户 .env：由 dsh 的凭证服务按 project-env / user-env 分层读取`,
  )
  c.store.addPanel('登录状态', lines)
}

export async function runLogout(c: CommandCtx): Promise<void> {
  const info = await describeKey(c)
  const source = info?.source ?? ((process.env[API_KEY_REF] ?? '') !== '' ? 'env' : undefined)
  const lines: string[] = [
    `当前来源：${source ?? '未配置'}`,
    '',
    'fx-tui 不改动凭证，按来源清掉即可：',
  ]
  if (source === undefined || source === 'env') {
    lines.push(`· 环境变量：unset ${API_KEY_REF}（重启 fx-tui 生效）`)
  }
  if (source === undefined || source === 'file') {
    lines.push(`· 凭证文件：删除 ${credentialFile()} 里的 ${API_KEY_REF} 条目`)
  }
  if (source === undefined || source === 'project-env' || source === 'user-env') {
    lines.push('· .env 文件：删掉对应项目 / 用户 .env 里的该变量')
  }
  if (source !== undefined && source !== 'env' && source !== 'file' && source !== 'project-env' && source !== 'user-env') {
    lines.push(`· 来源层 ${source} 由 dsh 的凭证插件管理`)
  }
  c.store.addPanel('清除凭证', lines)
}

export async function runBalance(c: CommandCtx): Promise<void> {
  const key = await resolveKey(c)
  const result = await fetchBalance(key)
  if (result.kind === 'ok') {
    c.store.addPanel('DeepSeek 账户余额', [
      `账户可用性：${result.available ? '正常' : '不可用'}`,
      '',
      ...result.balances.map(entry => `· ${entry.currency} 余额 ${entry.total}（赠送 ${entry.granted} · 充值 ${entry.toppedUp}）`),
      '',
      '赠送余额优先于充值余额扣费 · 该查询为只读接口，不消耗额度',
    ])
    return
  }
  c.store.addNotice(`查询余额失败：${BALANCE_FAILURES[result.kind]}`, 'warn')
}

const BALANCE_FAILURES: Record<Exclude<BalanceResult['kind'], 'ok'>, string> = {
  missing: `没有可用的 ${API_KEY_REF}（/login 查看凭证来源）`,
  unauthorized: '密钥被拒绝（401/403），请检查密钥是否有效',
  http: '服务端返回了错误状态码',
  invalid: '响应格式无法识别',
  network: '网络不可达或超时（8s）',
}

interface Balance {
  readonly currency: string
  readonly total: number
  readonly granted: number
  readonly toppedUp: number
}

type BalanceResult =
  | { readonly kind: 'ok'; readonly available: boolean; readonly balances: readonly Balance[] }
  | { readonly kind: 'missing' | 'unauthorized' | 'invalid' | 'network' }
  | { readonly kind: 'http'; readonly status: number }

/** The key goes only into the request header — never into a panel, a notice, or
 * the debug log. */
async function fetchBalance(key: string): Promise<BalanceResult> {
  if (key === '') return { kind: 'missing' }
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, BALANCE_TIMEOUT_MS)
  try {
    const response = await fetch(BALANCE_ENDPOINT, {
      headers: { authorization: `Bearer ${key}` },
      signal: controller.signal,
    })
    if (response.status === 401 || response.status === 403) return { kind: 'unauthorized' }
    if (!response.ok) return { kind: 'http', status: response.status }
    const payload = await response.json().catch(() => undefined) as unknown
    return parseBalance(payload) ?? { kind: 'invalid' }
  } catch {
    return { kind: 'network' }
  } finally {
    clearTimeout(timer)
  }
}

function parseBalance(payload: unknown): BalanceResult | undefined {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  const infos = (payload as { balance_infos?: unknown }).balance_infos
  if (!Array.isArray(infos)) return undefined
  const balances: Balance[] = []
  for (const raw of infos) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
    const info = raw as Record<string, unknown>
    const currency = info.currency
    const total = amount(info.total_balance)
    const granted = amount(info.granted_balance)
    const toppedUp = amount(info.topped_up_balance)
    if (typeof currency !== 'string' || currency === '' || total === undefined || granted === undefined || toppedUp === undefined) return undefined
    balances.push({ currency, total, granted, toppedUp })
  }
  return { kind: 'ok', available: (payload as { is_available?: unknown }).is_available === true, balances }
}

/** Balance fields arrive as decimal strings; anything non-finite is a bad payload. */
function amount(value: unknown): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

interface KeyInfo {
  readonly configured: boolean
  readonly source?: string
  readonly writable: boolean
}

async function describeKey(c: CommandCtx): Promise<KeyInfo | undefined> {
  const credentials = c.ctx.get('credentials') as
    | { describe(ref: CredentialRef): Promise<KeyInfo> }
    | undefined
  if (credentials === undefined) return undefined
  try {
    return await credentials.describe(asCredentialRef(API_KEY_REF))
  } catch { /* the credential service is display-optional */ }
  return undefined
}

async function resolveKey(c: CommandCtx): Promise<string> {
  const credentials = c.ctx.get('credentials') as
    | { resolve(ref: CredentialRef): Promise<{ value: string } | undefined> }
    | undefined
  if (credentials !== undefined) {
    try {
      const resolved = await credentials.resolve(asCredentialRef(API_KEY_REF))
      if (resolved?.value !== undefined && resolved.value !== '') return resolved.value
    } catch { /* fall through to the environment */ }
  }
  return process.env[API_KEY_REF] ?? ''
}

function credentialFile(): string {
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
  return truncateLine(join(home, '.credentials.yaml'), 72)
}
