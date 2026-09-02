import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCommandRunner } from './index.js'
import type { SkillCatalog } from './menu.js'
import { cleanupTempHomes, makeCtx } from './test-helpers.js'

// /update shells out to git against the real checkout; the dispatcher's own
// argument validation is what is under test here, so the runner is stubbed.
vi.mock(import('./update.js'), () => ({
  runUpdate: vi.fn<typeof import('./update.js')['runUpdate']>(async () => {}),
}))

afterEach(() => {
  cleanupTempHomes()
  vi.unstubAllGlobals()
})

const emptyCatalog: SkillCatalog = {
  list: () => [],
  refresh: async () => {},
  lookup: () => ({ cwd: process.cwd(), scope: {} }),
}

describe('createCommandRunner routing', () => {
  it('routes the lifecycle built-ins to their injected callbacks', async () => {
    const { c, log } = makeCtx()
    const run = createCommandRunner(c, emptyCatalog)

    await run('/help')
    expect(log.panels.some(panel => panel.title.includes('按键与命令'))).toBe(true)

    await run('/edit')
    expect(log.editorCount).toBe(1)

    await run('/exit')
    await run('/quit')
    await run('/bye')
    expect(log.exitCount).toBe(3)
  })

  it('matches command names case-insensitively', async () => {
    const { c, log } = makeCtx()
    await createCommandRunner(c, emptyCatalog)('/HELP')
    expect(log.panels.length).toBe(1)
  })

  it('/forget points at the allowlist file instead of pretending to clear it', async () => {
    const { c, log } = makeCtx()
    await createCommandRunner(c, emptyCatalog)('/forget-approvals')
    expect(log.notices[0]).toContain('fx-tui-allowlist.json')
  })

  it('reaches a handler for every lifecycle and account command', async () => {
    // /balance is the only one that would touch the network for real.
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })))
    const { c, log } = makeCtx()
    const run = createCommandRunner(c, emptyCatalog)

    for (const name of ['new', 'clear', 'resume', 'fork', 'rewind', 'tree', 'trace', 'skills', 'provider', 'login', 'logout', 'balance']) {
      await run(`/${name}`)
      expect(log.notices.some(notice => notice.includes(`未知命令：/${name}`))).toBe(false)
    }
  })

  it('masks a key typed as a /login argument before it reaches the debug log', async () => {
    const seen: string[] = []
    const { c } = makeCtx({ debugLog: (label, data) => { seen.push(`${label} ${String(data)}`) } })

    await createCommandRunner(c, emptyCatalog)('/login sk-should-never-be-logged')

    expect(seen.join('\n')).not.toContain('sk-should-never-be-logged')
    expect(seen[0]).toContain('/login ***')
  })
})

describe('createCommandRunner /update argument validation', () => {
  it('rejects anything that is not --force without running the updater', async () => {
    const { runUpdate } = await import('./update.js')
    const { c, log } = makeCtx()
    await createCommandRunner(c, emptyCatalog)('/update --now')

    expect(log.notices[0]).toContain('用法：/update')
    expect(runUpdate).not.toHaveBeenCalled()
  })

  it('passes the force flag through', async () => {
    const { runUpdate } = await import('./update.js')
    vi.mocked(runUpdate).mockClear()
    const { c } = makeCtx()
    await createCommandRunner(c, emptyCatalog)('/update --force')

    expect(runUpdate).toHaveBeenCalledWith(expect.anything(), true)
  })
})

describe('createCommandRunner fallbacks', () => {
  const withRegistries = (commands: unknown, skills: unknown): Context =>
    ({ commands, skills } as unknown as Context)

  it('executes a name the dsh registry knows and reports the result', async () => {
    const ctx = withRegistries(
      {
        find: (_agent: unknown, name: string) => (name === 'compact' ? { name } : undefined),
        execute: async () => ({ result: { kind: 'ok', text: '已压缩' } }),
      },
      { get: async () => undefined },
    )
    const { c, log } = makeCtx({ ctx })
    await createCommandRunner(c, emptyCatalog)('/compact')

    expect(log.panels[0]?.title).toBe('/compact')
    expect(log.panels[0]?.lines[0]).toBe('已压缩')
  })

  it('surfaces a registry error as a panel, and an empty result as a notice', async () => {
    const errorCtx = withRegistries(
      { find: () => ({}), execute: async () => ({ result: { kind: 'error', text: 'boom' } }) },
      { get: async () => undefined },
    )
    const { c, log } = makeCtx({ ctx: errorCtx })
    await createCommandRunner(c, emptyCatalog)('/compact')
    expect(log.panels[0]?.title).toContain('执行失败')

    const silentCtx = withRegistries(
      { find: () => ({}), execute: async () => ({ result: { kind: 'ok' } }) },
      { get: async () => undefined },
    )
    const second = makeCtx({ ctx: silentCtx })
    await createCommandRunner(second.c, emptyCatalog)('/compact')
    expect(second.log.notices[0]).toContain('/compact 完成')
  })

  it('treats an unknown name that is a user-invocable skill as a message', async () => {
    const ctx = withRegistries(
      { find: () => undefined },
      { get: async (name: string) => (name === 'review' ? { name, invocation: { userInvocable: true } } : undefined) },
    )
    const { c, log } = makeCtx({ ctx })
    await createCommandRunner(c, emptyCatalog)('/review 这段代码')

    expect(log.submitted).toEqual(['/review 这段代码'])
    expect(log.notices).toEqual([])
  })

  it('rejects a name that is neither a command nor an invocable skill', async () => {
    const ctx = withRegistries(
      { find: () => undefined },
      { get: async () => ({ name: 'x', invocation: { userInvocable: false } }) },
    )
    const { c, log } = makeCtx({ ctx })
    await createCommandRunner(c, emptyCatalog)('/nope')

    expect(log.notices[0]).toContain('未知命令：/nope')
    expect(log.submitted).toEqual([])
  })

  it('converts a thrown handler into an error notice instead of rejecting', async () => {
    const ctx = withRegistries(
      { find: () => { throw new Error('registry exploded') } },
      { get: async () => undefined },
    )
    const { c, log } = makeCtx({ ctx })
    await expect(createCommandRunner(c, emptyCatalog)('/compact')).resolves.toBeUndefined()
    expect(log.notices[0]).toContain('命令执行失败：registry exploded')
  })
})
