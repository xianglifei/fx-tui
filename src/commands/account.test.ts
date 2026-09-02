import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runBalance, runLogin, runLogout, runProvider } from './account.js'
import { cleanupTempHomes, makeCtx } from './test-helpers.js'

afterEach(() => {
  cleanupTempHomes()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

const KEY = 'sk-secret-value'

function ctxWithLlm(providers: readonly unknown[], configurable: readonly unknown[] = []): Context {
  return {
    llm: {
      listProviders: () => providers,
      listConfigurableProviders: () => configurable,
    },
  } as unknown as Context
}

function provider(id: string, name = id): unknown {
  return { id, name }
}

type FetchMock = (url: unknown, init?: { headers?: Record<string, string> }) => Promise<unknown>

function response(status: number, payload: unknown): unknown {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  }
}

const BALANCE = {
  is_available: true,
  balance_infos: [{ currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' }],
}

describe('runProvider', () => {
  it('marks the active route and lists the dormant ones', () => {
    // The harness selection is p/m, so one entry has to be `p` for the marker.
    const ctx = ctxWithLlm(
      [provider('deepseek-official', 'DeepSeek'), provider('p', '当前 provider'), provider('other')],
      [{ provider: 'gateway', displayName: '自建网关', settingsNs: 'llm-pi-ai', declared: true }],
    )
    const { c, log } = makeCtx({ ctx })

    runProvider(c)

    const body = (log.panels[0]?.lines ?? []).join('\n')
    expect(body).toContain('当前路由：p/m')
    expect(body).toContain('· p（当前 provider） ← 当前')
    // A provider whose display name repeats its id is not spelled out twice.
    expect(body).toContain('· other')
    expect(body).toContain('自建网关')
    expect(body).toContain('不在运行时新增 provider')
  })

  it('survives a provider registry that refuses to list', () => {
    const ctx = {
      llm: {
        listProviders: () => { throw new Error('nope') },
        listConfigurableProviders: () => { throw new Error('nope') },
      },
    } as unknown as Context
    const { c, log } = makeCtx({ ctx })

    runProvider(c)

    expect(log.panels[0]?.lines.join('\n')).toContain('已注册 provider（0）')
  })
})

describe('runLogin', () => {
  it('reports the environment variable state without ever echoing a key', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', KEY)
    const { c, log } = makeCtx()

    await runLogin(c)

    const body = (log.panels[0]?.lines ?? []).join('\n')
    expect(body).toContain('已设置')
    expect(body).not.toContain(KEY)
  })

  it('says so when the host provides no credential service', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    const { c, log } = makeCtx()

    await runLogin(c)

    const body = (log.panels[0]?.lines ?? []).join('\n')
    expect(body).toContain('未设置')
    expect(body).toContain('不可用')
  })

  it('surfaces the resolved source when the credential service answers', async () => {
    const ctx = {
      get: () => ({ describe: async () => ({ configured: true, source: 'file', writable: true }) }),
    } as unknown as Context
    const { c, log } = makeCtx({ ctx })

    await runLogin(c)

    const body = (log.panels[0]?.lines ?? []).join('\n')
    expect(body).toContain('已配置')
    expect(body).toContain('来源：file')
  })
})

describe('runLogout', () => {
  it('points at the layer the credential actually came from', async () => {
    const ctx = {
      get: () => ({ describe: async () => ({ configured: true, source: 'file', writable: true }) }),
    } as unknown as Context
    const { c, log } = makeCtx({ ctx })

    await runLogout(c)

    const body = (log.panels[0]?.lines ?? []).join('\n')
    expect(body).toContain('当前来源：file')
    expect(body).toContain('.credentials.yaml')
    expect(body).not.toContain('unset DEEPSEEK_API_KEY')
  })

  it('offers every layer when nothing is configured', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    const { c, log } = makeCtx()

    await runLogout(c)

    const body = (log.panels[0]?.lines ?? []).join('\n')
    expect(body).toContain('unset DEEPSEEK_API_KEY')
    expect(body).toContain('.credentials.yaml')
  })
})

describe('runBalance', () => {
  it('renders the balances and never prints the key', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', KEY)
    const fetchMock = vi.fn<FetchMock>(async () => response(200, BALANCE))
    vi.stubGlobal('fetch', fetchMock)
    const { c, log } = makeCtx()

    await runBalance(c)

    const body = (log.panels[0]?.lines ?? []).join('\n')
    expect(body).toContain('CNY 余额 110')
    expect(body).toContain('赠送 10')
    expect(body).not.toContain(KEY)
    // The key travels in the header only.
    expect(fetchMock.mock.calls[0]?.[1]?.headers?.authorization).toBe(`Bearer ${KEY}`)
  })

  it('asks for a key instead of calling the endpoint without one', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    const fetchMock = vi.fn<FetchMock>()
    vi.stubGlobal('fetch', fetchMock)
    const { c, log } = makeCtx()

    await runBalance(c)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(log.notices[0]).toContain('没有可用的 DEEPSEEK_API_KEY')
  })

  it('distinguishes an invalid key from a server error', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', KEY)

    vi.stubGlobal('fetch', vi.fn(async () => response(401, {})))
    const unauthorized = makeCtx()
    await runBalance(unauthorized.c)
    expect(unauthorized.log.notices[0]).toContain('401/403')

    vi.stubGlobal('fetch', vi.fn(async () => response(500, {})))
    const http = makeCtx()
    await runBalance(http.c)
    expect(http.log.notices[0]).toContain('状态码')
  })

  it('reports an unparseable payload and a dead network separately', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', KEY)

    vi.stubGlobal('fetch', vi.fn(async () => response(200, { nope: true })))
    const invalid = makeCtx()
    await runBalance(invalid.c)
    expect(invalid.log.notices[0]).toContain('响应格式')

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    const offline = makeCtx()
    await runBalance(offline.c)
    expect(offline.log.notices[0]).toContain('网络')
  })

  it('prefers the credential service over the environment', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    const ctx = {
      get: () => ({ resolve: async () => ({ value: KEY, source: 'file' }) }),
    } as unknown as Context
    const fetchMock = vi.fn<FetchMock>(async () => response(200, BALANCE))
    vi.stubGlobal('fetch', fetchMock)
    const { c, log } = makeCtx({ ctx })

    await runBalance(c)

    expect(fetchMock).toHaveBeenCalled()
    expect(log.panels[0]?.lines.join('\n')).toContain('余额 110')
  })
})
