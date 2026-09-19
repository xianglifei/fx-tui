import { describe, expect, it } from 'vitest'
import { launchShellPassthrough, parseShellBang, runShellCommand, shellPanel } from './shell-bang.js'
import type { ShellPassthroughUi } from './shell-bang.js'

describe('parseShellBang', () => {
  it('parses the single-bang gesture', () => {
    expect(parseShellBang('!ls -la')).toEqual({ command: 'ls -la', quiet: false })
  })

  it('parses the double-bang gesture as quiet', () => {
    expect(parseShellBang('!!npm test')).toEqual({ command: 'npm test', quiet: true })
  })

  it('trims surrounding whitespace', () => {
    expect(parseShellBang('  !git status  ')).toEqual({ command: 'git status', quiet: false })
  })

  it('returns an empty command for a bare bang', () => {
    expect(parseShellBang('!')).toEqual({ command: '', quiet: false })
    expect(parseShellBang('!!  ')).toEqual({ command: '', quiet: true })
  })

  it('rejects non-bang text and mid-line bangs', () => {
    expect(parseShellBang('ls')).toBeUndefined()
    expect(parseShellBang('say !hi')).toBeUndefined()
    expect(parseShellBang('')).toBeUndefined()
  })
})

describe('runShellCommand', () => {
  it('captures stdout and a zero exit', async () => {
    const outcome = await runShellCommand('echo hello', { shell: '/bin/bash' })
    expect(outcome.exitCode).toBe(0)
    expect(outcome.output).toBe('hello\n')
    expect(outcome.timedOut).toBe(false)
    expect(outcome.truncated).toBe(false)
  })

  it('merges stderr into the output and keeps non-zero exits', async () => {
    const outcome = await runShellCommand('echo boom >&2; exit 3', { shell: '/bin/bash' })
    expect(outcome.exitCode).toBe(3)
    expect(outcome.output).toContain('boom')
  })

  it('reports the signal for a killed child', async () => {
    const outcome = await runShellCommand('kill -TERM $$', { shell: '/bin/bash' })
    expect(outcome.exitCode).not.toBe(0)
    expect(outcome.signalName).toBe('SIGTERM')
  })

  it('kills a hanging command at the timeout and flags it', async () => {
    const outcome = await runShellCommand('sleep 30', { shell: '/bin/bash', timeoutMs: 150 })
    expect(outcome.timedOut).toBe(true)
    expect(outcome.exitCode).not.toBe(0)
    expect(outcome.durationMs).toBeLessThan(10_000)
  }, 15_000)

  it('stops capturing beyond the byte cap and flags truncation', async () => {
    const outcome = await runShellCommand('yes fx | head -c 100000', { shell: '/bin/bash', maxOutputBytes: 1000 })
    expect(outcome.truncated).toBe(true)
    expect(outcome.output.length).toBeLessThanOrEqual(1100)
  })

  it('survives a nonexistent shell without throwing', async () => {
    const outcome = await runShellCommand('echo hi', { shell: '/nonexistent-fx-shell' })
    expect(outcome.exitCode).toBeNull()
    expect(outcome.output).toContain('nonexistent-fx-shell')
  })
})

describe('shellPanel', () => {
  it('formats a successful run', () => {
    const { title, lines } = shellPanel({
      command: 'echo hi', exitCode: 0, signalName: null, timedOut: false,
      timeoutMs: 600_000, durationMs: 12, output: 'hi\n', truncated: false,
    }, 20)
    expect(title).toBe('$ echo hi')
    expect(lines[0]).toContain('✓ 退出 0')
    expect(lines).toContain('hi')
  })

  it('marks a timeout in the header', () => {
    const { lines } = shellPanel({
      command: 'sleep', exitCode: null, signalName: 'SIGTERM', timedOut: true,
      timeoutMs: 60_000, durationMs: 60_000, output: '', truncated: false,
    }, 20)
    expect(lines[0]).toContain('超时')
  })

  it('head+tail caps long output so end-of-stream failures stay visible', () => {
    const output = Array.from({ length: 100 }, (_, i) => `line-${i}`).join('\n')
    const { lines } = shellPanel({
      command: 'gen', exitCode: 1, signalName: null, timedOut: false,
      timeoutMs: 600_000, durationMs: 5, output, truncated: false,
    }, 10)
    const body = lines.slice(1)
    expect(body).toContain('line-0')
    expect(body).toContain('line-99')
    expect(body.some(line => line.includes('省略'))).toBe(true)
    expect(body.length).toBeLessThanOrEqual(11)
  })
})

describe('launchShellPassthrough', () => {
  function makeUi(): ShellPassthroughUi & { notices: string[]; panels: { title: string; lines: readonly string[] }[] } {
    const notices: string[] = []
    const panels: { title: string; lines: readonly string[] }[] = []
    return {
      notices,
      panels,
      addNotice: (text, _tone) => { notices.push(text) },
      addPanel: (title, lines) => { panels.push({ title, lines }) },
    }
  }

  it('a fast run produces only the result panel, no running marker', async () => {
    const ui = makeUi()
    await launchShellPassthrough('echo done', ui, { shell: '/bin/bash' })
    expect(ui.notices).toEqual([])
    expect(ui.panels).toHaveLength(1)
    expect(ui.panels[0]!.title).toBe('$ echo done')
  })
})
