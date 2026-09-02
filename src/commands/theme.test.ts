import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { activeThemeName, setActiveTheme } from '../ui/theme.js'
import type { ThemeName } from '../ui/theme.js'
import { runTheme, themeSettingLabel } from './theme.js'
import { answerPick, cleanupTempHomes, makeCtx, skipPick } from './test-helpers.js'

// The active theme is module-level state shared with the renderer; every test
// restores whatever it found so suite order cannot leak.
let restoreTo: ThemeName

beforeEach(() => {
  restoreTo = activeThemeName()
})

afterEach(() => {
  setActiveTheme(restoreTo)
  cleanupTempHomes()
})

describe('themeSettingLabel', () => {
  it('names auto detection explicitly and defers the rest to the palette', () => {
    expect(themeSettingLabel('auto')).toBe('自动检测')
    expect(themeSettingLabel('dark')).not.toBe('')
  })
})

describe('/theme direct form', () => {
  it('applies a base word', async () => {
    const { c, settings } = makeCtx()
    await runTheme(c, 'dark')

    expect(settings.theme).toBe('dark')
    expect(activeThemeName()).toBe('dark')
  })

  it('applies the Chinese aliases', async () => {
    const { c, settings } = makeCtx()
    await runTheme(c, '深色')
    expect(settings.theme).toBe('dark')

    const second = makeCtx()
    await runTheme(second.c, '浅色')
    expect(second.settings.theme).toBe('light')
  })

  it('accepts a Ghostty id or its display name, spaces folded to hyphens', async () => {
    const { c, settings } = makeCtx()
    await runTheme(c, 'catppuccin-mocha')
    expect(settings.theme).toBe('catppuccin-mocha')

    const second = makeCtx()
    await runTheme(second.c, 'Catppuccin Mocha')
    expect(second.settings.theme).toBe('catppuccin-mocha')

    const third = makeCtx()
    await runTheme(third.c, 'TOKYONIGHT NIGHT')
    expect(third.settings.theme).toBe('tokyonight-night')
  })

  it('lists the catalogue instead of silently ignoring an unknown theme', async () => {
    const { c, log, settings } = makeCtx()
    await runTheme(c, 'nope')

    expect(settings.theme).toBe('auto')
    expect(log.panels[0]?.title).toBe('未知主题')
    expect(log.panels[0]?.lines.join('\n')).toContain('catppuccin-mocha')
  })

  it('remounts only when the rendered palette actually changes', async () => {
    setActiveTheme('light')
    const { c, log } = makeCtx()

    await runTheme(c, 'dark')
    expect(log.remountCount).toBe(1)

    // Same context a second time: the saved default and the rendered palette
    // are both already dark, so no remount and an "already set" notice.
    await runTheme(c, 'dark')
    expect(log.remountCount).toBe(1)
    expect(log.notices.at(-1)).toContain('已是')
  })
})

describe('/theme interactive form', () => {
  it('applies the base picker choice', async () => {
    const { c, store, settings } = makeCtx()
    const pending = runTheme(c, '')
    await answerPick(store, '深色')
    await pending

    expect(settings.theme).toBe('dark')
  })

  it('descends into the Ghostty list and returns to the base picker on Esc', async () => {
    const { c, store, settings } = makeCtx()
    const pending = runTheme(c, '')

    await answerPick(store, 'Ghostty 精选（14 款）')
    // Esc on the Ghostty list loops back to the base picker instead of exiting.
    await skipPick(store)
    await answerPick(store, '浅色')
    await pending

    expect(settings.theme).toBe('light')
  })
})
