/**
 * macOS system clipboard access with zero dependencies: text arrives through
 * pbpaste; images through an AppleScript snippet that writes the clipboard's
 * PNG (or TIFF, converted to PNG via sips) into a scratch file. The clipboard
 * classes only exist on macOS — failures resolve to "no image" so callers can
 * fall through to a notice.
 */

import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TOOL_TIMEOUT_MS = 5000

export interface ClipboardImage {
  data: Uint8Array
  name: string
}

function run(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf8', timeout: TOOL_TIMEOUT_MS }, (error, stdout) => {
      if (error !== null) reject(error)
      else resolve(stdout)
    })
  })
}

/** Clipboard text, or '' when the clipboard holds no text (pbpaste is text-only). */
export function readClipboardText(): Promise<string> {
  return new Promise(resolve => {
    execFile('pbpaste', [], { encoding: 'utf8', timeout: TOOL_TIMEOUT_MS }, (error, stdout) => {
      resolve(error === null ? stdout : '')
    })
  })
}

/** Write one clipboard data class (AppleScript «class …») to a file. */
function writeClipboardClass(classExpr: string, path: string): Promise<void> {
  const script =
    `set theData to (the clipboard as ${classExpr})\n` +
    `set fp to open for access (POSIX file "${path}") with write permission\n` +
    'set eof of fp to 0\n' +
    'write theData to fp\n' +
    'close access fp'
  return run('osascript', ['-e', script]).then(() => undefined)
}

function stampNow(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

/**
 * Clipboard image as PNG bytes, or null when the clipboard holds no bitmap.
 * Some apps publish TIFF only; that path converts through sips (built into
 * macOS). The scratch file is always removed.
 */
export async function readClipboardImage(): Promise<ClipboardImage | null> {
  const base = join(tmpdir(), `fx-tui-clip-${randomUUID().slice(0, 8)}`)
  const pngPath = `${base}.png`
  const tiffPath = `${base}.tiff`
  try {
    try {
      await writeClipboardClass('«class PNGf»', pngPath)
    } catch {
      await writeClipboardClass('«class TIFF»', tiffPath)
      await run('sips', ['-s', 'format', 'png', tiffPath, '--out', pngPath])
    }
    const data = new Uint8Array(readFileSync(pngPath))
    // PNG signature: a zero-byte or non-PNG write means no usable bitmap.
    if (data.length < 8 || data[0] !== 0x89 || data[1] !== 0x50) return null
    return { data, name: `clipboard-${stampNow()}.png` }
  } catch {
    return null
  } finally {
    for (const path of [pngPath, tiffPath]) {
      try {
        unlinkSync(path)
      } catch {
        // scratch cleanup is best-effort
      }
    }
  }
}

/** Fire-and-forget a detached helper; used by the notify module's osascript path. */
export function spawnDetached(command: string, args: readonly string[]): void {
  const child = spawn(command, [...args], { stdio: 'ignore', detached: true })
  child.unref()
}
