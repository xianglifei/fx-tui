import { afterEach, describe, expect, it } from 'vitest'
import { runStatusline } from './statusline.js'
import { answerPick, awaitCard, cleanupTempHomes, makeCtx, skipPick } from './test-helpers.js'

afterEach(() => {
  cleanupTempHomes()
})

describe('/statusline direct forms', () => {
  it('sets an explicit list in the given order and syncs', async () => {
    const { c, settings, log } = makeCtx()
    let synced = 0
    const withSync = { ...c, syncStatusLine: () => { synced++ } }
    await runStatusline(withSync, 'git model context')

    expect(settings.statusLine).toEqual(['git', 'model', 'context'])
    expect(settings.statusLineCustomized).toBe(true)
    expect(synced).toBe(1)
    expect(log.notices.some(notice => notice.includes('git 分支 · 当前模型 · 上下文水位'))).toBe(true)
  })

  it('rejects unknown ids without partial saves', async () => {
    const { c, settings, log } = makeCtx()
    await runStatusline(c, 'git bogus')

    expect(settings.statusLineCustomized).toBe(false)
    expect(log.panels.some(panel => panel.lines.some(line => line.includes('bogus')))).toBe(true)
  })

  it('accepts comma separators', async () => {
    const { c, settings } = makeCtx()
    await runStatusline(c, 'usage,effort')
    expect(settings.statusLine).toEqual(['usage', 'effort'])
  })

  it('hides everything with off and restores with default', async () => {
    const { c, settings } = makeCtx()
    await runStatusline(c, 'git')
    await runStatusline(c, 'off')
    expect(settings.statusLine).toEqual([])
    expect(settings.statusLineCustomized).toBe(true)

    await runStatusline(c, 'default')
    expect(settings.statusLine).toEqual(['context', 'usage', 'effort'])
    expect(settings.statusLineCustomized).toBe(false)
  })
})

describe('/statusline picker', () => {
  it('saves the toggled selection in canonical order', async () => {
    const pending = makeCtx()
    const { c, settings } = pending
    const run = runStatusline(c, '')
    await answerPick(c.store, 'git')
    await run

    expect(settings.statusLine).toEqual(['git'])
    expect(c.settings.statusLineCustomized).toBe(true)
  })

  it('leaves the configuration untouched when skipped', async () => {
    const { c, settings, log } = makeCtx()
    const run = runStatusline(c, '')
    await skipPick(c.store)
    await run

    expect(settings.statusLineCustomized).toBe(false)
    expect(log.notices.some(notice => notice.includes('状态栏已保存'))).toBe(false)
  })

  it('titles the card with the live configuration', async () => {
    const { c } = makeCtx()
    const run = runStatusline(c, '')
    const card = await awaitCard(c.store)
    expect(card.item.question).toContain('当前：上下文水位 · 会话用量 · 推理强度')
    c.store.skipQuestion()
    await run
  })
})

describe('/statusline custom', () => {
  it('shows usage when bare and configures a command otherwise', async () => {
    const { c, settings, log } = makeCtx()
    await runStatusline(c, 'custom')
    expect(log.panels.some(panel => panel.title.includes('custom'))).toBe(true)
    expect(settings.statusLineCommand).toBeUndefined()

    await runStatusline(c, 'custom git log --oneline -1')
    expect(settings.statusLineCommand).toEqual({ command: 'git log --oneline -1' })
    // The custom item is enabled alongside the command so it actually shows.
    expect(settings.statusLine).toContain('custom')
  })

  it('clears the command with off but keeps the item list', async () => {
    const { c, settings } = makeCtx()
    await runStatusline(c, 'custom echo hi')
    await runStatusline(c, 'custom off')

    expect(settings.statusLineCommand).toBeUndefined()
    expect(settings.statusLine).toContain('custom')
  })

  it('sets a periodic refresh interval only for an existing command', async () => {
    const { c, settings, log } = makeCtx()
    await runStatusline(c, 'custom interval 30')
    expect(log.notices.some(notice => notice.includes('尚未配置'))).toBe(true)

    await runStatusline(c, 'custom date')
    await runStatusline(c, 'custom interval 30')
    expect(settings.statusLineCommand).toEqual({ command: 'date', intervalSeconds: 30 })
  })
})
