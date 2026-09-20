import { describe, expect, it } from 'vitest'
import { printFarewell } from './farewell.js'

interface Capture {
  isTTY?: boolean
  write(chunk: string): unknown
  chunks: string[]
}

function makeCapture(isTTY?: boolean): Capture & { readonly text: string } {
  const chunks: string[] = []
  return {
    isTTY,
    chunks,
    write(chunk: string): unknown {
      chunks.push(chunk)
      return chunks
    },
    get text(): string {
      return chunks.join('')
    },
  }
}

describe('printFarewell', () => {
  it('wipes viewport and scrollback on a TTY, then prints the resume hint', () => {
    const out = makeCapture(true)
    printFarewell('session-abc', '0.33.0', out)
    expect(out.text).toBe('\x1b[H\x1b[2J\x1b[3Jfx-tui v0.33.0 会话已保存 ✓\n  恢复对话：fx --resume session-abc\n')
  })

  it('keeps the escape sequence out of a non-TTY writer', () => {
    const out = makeCapture(false)
    printFarewell('session-abc', '0.33.0', out)
    expect(out.text).not.toContain('\x1b')
    expect(out.text).toContain('--resume session-abc')
  })

  it('drops the resume line when the session id is unavailable', () => {
    const out = makeCapture(true)
    printFarewell('', '0.33.0', out)
    expect(out.text).toContain('会话已保存')
    expect(out.text).not.toContain('--resume')
  })
})
