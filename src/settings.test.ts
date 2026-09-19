import { readFileSync, writeFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { FxSettings } from './settings.js'
import { cleanupTempHomes, tempDshHome } from './commands/test-helpers.js'

afterEach(() => {
  cleanupTempHomes()
})

describe('FxSettings status line', () => {
  it('ships the default list and no command', () => {
    const settings = new FxSettings(tempDshHome())
    expect(settings.statusLine).toEqual(['context', 'usage', 'effort'])
    expect(settings.statusLineCustomized).toBe(false)
    expect(settings.statusLineCommand).toBeUndefined()
  })

  it('persists an explicit list and command, omitting defaults from the file', () => {
    const home = tempDshHome()
    const settings = new FxSettings(home)
    settings.setStatusLine(['git', 'model'])
    settings.setStatusLineCommand({ command: 'date', intervalSeconds: 30 })

    const raw = JSON.parse(readFileSync(`${home}/fx-tui-settings.json`, 'utf8')) as { statusLine?: string[]; statusLineCommand?: { command: string; intervalSeconds?: number } }
    expect(raw.statusLine).toEqual(['git', 'model'])
    expect(raw.statusLineCommand).toEqual({ command: 'date', intervalSeconds: 30 })

    const reloaded = new FxSettings(home)
    expect(reloaded.statusLine).toEqual(['git', 'model'])
    expect(reloaded.statusLineCustomized).toBe(true)
    expect(reloaded.statusLineCommand).toEqual({ command: 'date', intervalSeconds: 30 })
  })

  it('removes the statusLine key when reset to the default', () => {
    const home = tempDshHome()
    const settings = new FxSettings(home)
    settings.setStatusLine(['git'])
    settings.setStatusLine(null)

    const raw = JSON.parse(readFileSync(`${home}/fx-tui-settings.json`, 'utf8')) as { statusLine?: unknown }
    expect(raw.statusLine).toBeUndefined()
    expect(new FxSettings(home).statusLine).toEqual(['context', 'usage', 'effort'])
  })

  it('degrades a malformed file to the defaults', () => {
    const home = tempDshHome()
    writeFileSync(`${home}/fx-tui-settings.json`, 'not json at all', 'utf8')
    const settings = new FxSettings(home)
    expect(settings.statusLine).toEqual(['context', 'usage', 'effort'])
    expect(settings.statusLineCustomized).toBe(false)
  })
})
