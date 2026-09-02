/**
 * Remembered approval grants: "session" scope lives in memory for this
 * process, "always" scope persists to `$DSH_HOME/fx-tui-allowlist.json`.
 *
 * A key is a semantic signature of the call — for bash the exact command
 * string, for path-shaped tools the path, otherwise the raw arguments — so a
 * remembered grant covers the same action without matching incidental fields
 * like a one-off escalation justification.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

interface AllowlistFile {
  version: 1
  always: string[]
}

const FILE_VERSION = 1

export class ApprovalMemory {
  private readonly sessionKeys = new Set<string>()
  private readonly persistentKeys = new Set<string>()
  private readonly filePath: string

  constructor(dshHome: string | undefined) {
    const home = dshHome !== undefined && dshHome !== '' ? dshHome : join(homedir(), '.dsh')
    this.filePath = join(home, 'fx-tui-allowlist.json')
    this.persistentKeys = new Set(loadAlways(this.filePath))
  }

  /** The semantic memory key for one approval decision. */
  static key(toolName: string, rawArgs: string): string {
    try {
      const parsed: unknown = rawArgs === '' ? undefined : JSON.parse(rawArgs)
      if (typeof parsed === 'object' && parsed !== null) {
        const record = parsed as Record<string, unknown>
        if (typeof record.command === 'string') return `${toolName}:command:${record.command}`
        if (typeof record.path === 'string') return `${toolName}:path:${record.path}`
      }
    } catch {
      // fall through to the raw-args key
    }
    return `${toolName}:${rawArgs}`
  }

  isAllowed(key: string): boolean {
    return this.sessionKeys.has(key) || this.persistentKeys.has(key)
  }

  allowSession(key: string): void {
    this.sessionKeys.add(key)
  }

  allowAlways(key: string): void {
    this.persistentKeys.add(key)
    this.sessionKeys.add(key)
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      const file: AllowlistFile = { version: FILE_VERSION, always: [...this.persistentKeys].toSorted() }
      writeFileSync(this.filePath, `${JSON.stringify(file, null, 2)}\n`, { encoding: 'utf8' })
    } catch {
      // persistence is best-effort; the in-memory grant still applies
    }
  }
}

function loadAlways(filePath: string): string[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'))
    if (typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as AllowlistFile).always)) {
      return (parsed as AllowlistFile).always.filter((k): k is string => typeof k === 'string')
    }
  } catch {
    // absent or malformed file starts empty
  }
  return []
}
