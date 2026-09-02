import { afterEach, describe, expect, it } from 'vitest'
import { modeLabel, runConfig } from './config.js'
import { answerPick, cleanupTempHomes, makeCtx, skipPick } from './test-helpers.js'

afterEach(cleanupTempHomes)

describe('modeLabel', () => {
  it('renders the two approval modes in Chinese', () => {
    expect(modeLabel('auto')).toBe('自动允许')
    expect(modeLabel('ask')).toBe('每次询问')
  })
})

describe('/config direct form', () => {
  it('switches the saved default and the running session together', async () => {
    const { c, settings, store } = makeCtx()
    await runConfig(c, 'permission ask')

    expect(settings.approvalMode).toBe('ask')
    expect(store.getSnapshot().approvalMode).toBe('ask')
  })

  it('accepts the Chinese aliases', async () => {
    const { c, settings } = makeCtx()
    await runConfig(c, 'permission 每次询问')
    expect(settings.approvalMode).toBe('ask')

    const second = makeCtx()
    await runConfig(second.c, 'permission 自动允许')
    expect(second.settings.approvalMode).toBe('auto')
  })

  it('rejects an unknown value with the usage line', async () => {
    const { c, log, settings } = makeCtx()
    await runConfig(c, 'permission sometimes')

    expect(log.notices[0]).toContain('用法：/config')
    expect(settings.approvalMode).toBe('auto')
  })

  it('covers the autoupdate, notify and autocompact keys', async () => {
    const { c, settings } = makeCtx()
    await runConfig(c, 'autoupdate off')
    expect(settings.autoUpdate).toBe(false)

    await runConfig(c, 'notify system')
    expect(settings.notify).toBe('system')

    await runConfig(c, 'autocompact on')
    expect(settings.autoCompact).toBe(true)
  })

  it('reports a redundant write as already set', async () => {
    const { c, log } = makeCtx()
    // The store starts a session at 'ask' while the saved default is 'auto',
    // so the first write is a real change and only the repeat is a no-op.
    await runConfig(c, 'permission ask')
    expect(log.notices.at(-1)).toContain('已保存为')

    await runConfig(c, 'permission ask')
    expect(log.notices.at(-1)).toContain('已是')
  })

  it('falls through to the usage line for an unknown key', async () => {
    const { c, log } = makeCtx()
    await runConfig(c, 'wat')
    expect(log.notices[0]).toContain('/config permission')
  })
})

describe('/config interactive form', () => {
  it('applies a picked mode and leaves skipped questions untouched', async () => {
    const { c, store, settings } = makeCtx()
    const pending = runConfig(c, '')
    await answerPick(store, '每次询问')
    await skipPick(store)
    await skipPick(store)
    await skipPick(store)
    await pending

    expect(settings.approvalMode).toBe('ask')
    expect(settings.notify).toBe('bell')
    expect(settings.autoUpdate).toBe(true)
  })

  it('a skipped mode picker changes nothing', async () => {
    const { c, store, settings } = makeCtx()
    const pending = runConfig(c, '')
    await skipPick(store)
    await skipPick(store)
    await skipPick(store)
    await skipPick(store)
    await pending

    expect(settings.approvalMode).toBe('auto')
  })
})
