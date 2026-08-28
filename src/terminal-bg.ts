/**
 * Terminal background detection for automatic theme selection.
 *
 * Primary channel: an OSC 11 background-color query. The escape sequence is
 * written to stdout and the reply is collected off stdin (briefly in raw
 * mode) with a short timeout — terminals that do not implement the query
 * simply cost the timeout and never fail startup.
 *
 * Fallback: the COLORFGBG environment convention (fg;background color
 * indexes, set by a minority of terminals and already present when running
 * inside some multiplexers).
 *
 * null means undetermined; callers then default to the light palette.
 */

export type TerminalTone = 'light' | 'dark'

/** Kept short: an unresponsive terminal pays this on every startup. */
const OSC_TIMEOUT_MS = 120

const OSC_QUERY = '\x1b]11;?\x1b\\'

// The reply is `ESC ] 11 ; rgb:RRRR/GGGG/BBBB` terminated by BEL or ST;
// channel widths of 1–4 hex digits all occur across terminal implementations.
const OSC_RESPONSE = /\x1b]11;rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})(?:\x07|\x1b\\)/i

/**
 * Matches an OSC 11 query or reply remnant, optionally ESC-stripped by ink's
 * key parser: a terminal responding slower than the detection timeout leaks
 * its reply into ink's input stream, where the unknown escape sequence is
 * delivered to useInput as literal text. Input handling drops such chunks.
 */
export const OSC11_REMNANT_RE = /^\x1b?\]?11;(?:\?|rgb:[0-9a-f]{1,4}\/[0-9a-f]{1,4}\/[0-9a-f]{1,4})(?:\x07|\x1b\\)?$/i

/** Detect the terminal's background tone, or null when unknowable. */
export async function detectTerminalBackground(): Promise<TerminalTone | null> {
  if (process.stdout.isTTY !== true || process.stdin.isTTY !== true) return null
  const viaOsc = await queryBackgroundOsc11()
  if (viaOsc !== null) return viaOsc
  return colorFgbgTone()
}

async function queryBackgroundOsc11(): Promise<TerminalTone | null> {
  const stdin = process.stdin
  const stdout = process.stdout
  let previousRaw: boolean | undefined
  return new Promise<TerminalTone | null>(resolve => {
    let buffer = ''
    let timer: ReturnType<typeof setTimeout> | null = null
    let settled = false
    const onData = (chunk: Buffer | string): void => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      const match = OSC_RESPONSE.exec(buffer)
      if (match !== null) {
        finish(toneFromRgb(match[1] ?? '', match[2] ?? '', match[3] ?? ''))
      }
    }
    const finish = (tone: TerminalTone | null): void => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      stdin.off('data', onData)
      // With the listener gone nothing should keep draining stdin between
      // here and ink's own setup; resume is ink's job.
      try { stdin.pause() } catch { /* best-effort */ }
      resolve(tone)
    }
    try {
      previousRaw = stdin.isRaw
      stdin.setRawMode(true)
    } catch {
      // setRawMode can throw even behind the isTTY guard; without raw mode
      // the reply would be line-buffered/echoed, so querying is pointless.
      finish(colorFgbgTone())
      return
    }
    stdin.on('data', onData)
    timer = setTimeout(() => finish(null), OSC_TIMEOUT_MS)
    try {
      stdout.write(OSC_QUERY)
    } catch {
      finish(null)
    }
  }).finally(() => {
    if (previousRaw !== undefined) {
      try { process.stdin.setRawMode(previousRaw) } catch { /* best-effort */ }
    }
  })
}

/** sRGB relative luminance (> 0.5 means light) from hex channel strings of
 * equal, arbitrary digit width (1–4). */
function toneFromRgb(rHex: string, gHex: string, bHex: string): TerminalTone | null {
  const luminance =
    0.2126 * channel(rHex) + 0.7152 * channel(gHex) + 0.0722 * channel(bHex)
  if (!Number.isFinite(luminance)) return null
  return luminance > 0.5 ? 'light' : 'dark'
}

function channel(hex: string): number {
  const max = 16 ** hex.length - 1
  if (max <= 0) return Number.NaN
  const raw = Number.parseInt(hex, 16)
  if (!Number.isFinite(raw)) return Number.NaN
  const srgb = raw / max
  return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4
}

/** Classic rxvt convention, e.g. `15;0` = white on black. Only the last
 * field (background index) matters: 7 and 15 are the light slots of the
 * 16-color palette, everything else reads as dark. */
function colorFgbgTone(): TerminalTone | null {
  const raw = process.env.COLORFGBG
  if (raw === undefined || raw === '') return null
  const fields = raw.split(';')
  const bg = Number.parseInt(fields[fields.length - 1] ?? '', 10)
  if (!Number.isFinite(bg)) return null
  return bg === 7 || bg === 15 ? 'light' : 'dark'
}
