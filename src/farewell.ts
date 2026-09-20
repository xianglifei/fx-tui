/**
 * Post-exit screen hygiene. A finished session leaves the terminal exactly
 * as clean as the manual `clear` it replaces: after Ink unmounts, wipe the
 * viewport AND the scrollback buffer (ESC[H ESC[2J ESC[3J), then print a
 * short farewell carrying the resume hint. Only the final exit calls this —
 * the launch path (wipeViewport) deliberately preserves pre-launch
 * scrollback, and the restart respawn skips it so the child inherits a live
 * terminal instead of an empty one.
 */

/** The writer contract: process.stdout satisfies it; tests pass a capture. */
export interface FarewellWriter {
  isTTY?: boolean
  write(chunk: string): unknown
}

export function printFarewell(
  sessionId: string,
  version: string,
  out: FarewellWriter = process.stdout,
): void {
  if (out.isTTY === true) {
    out.write('\x1b[H\x1b[2J\x1b[3J')
  }
  const resume = sessionId === '' ? '' : `\n  恢复对话：fx --resume ${sessionId}`
  out.write(`fx-tui v${version} 会话已保存 ✓${resume}\n`)
}
