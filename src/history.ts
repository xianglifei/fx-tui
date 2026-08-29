/**
 * Persistent input history: submitted prompts kept across sessions as a JSON
 * array in `$DSH_HOME/fx-tui-input-history.json`, capped at the newest 500
 * entries (consecutive duplicates collapse).
 *
 * The editor consumes the live `entries` array by reference — browsing is a
 * read of `entries[index]` at keypress time, so pushes need no React
 * notification path. Deleting the file is the documented reset.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const MAX_ENTRIES = 500

export class InputHistory {
  /** Live newest-last array; mutated in place so the editor's prop stays current. */
  readonly entries: string[] = []
  private readonly filePath: string

  constructor(dshHome: string | undefined) {
    const home = dshHome !== undefined && dshHome !== '' ? dshHome : join(homedir(), '.dsh')
    this.filePath = join(home, 'fx-tui-input-history.json')
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'))
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item === 'string' && item.trim() !== '') this.entries.push(item)
          if (this.entries.length >= MAX_ENTRIES) break
        }
      }
    } catch {
      // absent or malformed file starts empty
    }
  }

  /** Record one submitted prompt; consecutive duplicates collapse. */
  push(text: string): void {
    const trimmed = text.trim()
    if (trimmed === '') return
    if (this.entries[this.entries.length - 1] === trimmed) return
    this.entries.push(trimmed)
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES)
    this.save()
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      writeFileSync(this.filePath, `${JSON.stringify(this.entries)}\n`, { encoding: 'utf8' })
    } catch {
      // persistence is best-effort; the in-memory list still applies
    }
  }
}
