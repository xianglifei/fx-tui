/**
 * Persistent user settings: the startup defaults that outlive a session,
 * written to `$DSH_HOME/fx-tui-settings.json`.
 *
 * Shift+Tab mode cycling is session-scoped on purpose — this file is only
 * touched by `/config`, so a one-off in-session switch never silently changes
 * what future launches start with. A missing or malformed file falls back to
 * `DEFAULT_APPROVAL_MODE` ('auto'): deleting the file is therefore also the
 * documented way to reset settings.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ApprovalMode } from './store.js'

export const DEFAULT_APPROVAL_MODE: ApprovalMode = 'auto'

interface SettingsFile {
  version: 1
  approvalMode: ApprovalMode
}

const FILE_VERSION = 1

const APPROVAL_MODES: readonly ApprovalMode[] = ['ask', 'auto']

function isApprovalMode(value: unknown): value is ApprovalMode {
  return typeof value === 'string' && (APPROVAL_MODES as readonly string[]).includes(value)
}

export class FxSettings {
  private mode: ApprovalMode
  private readonly filePath: string

  constructor(dshHome: string | undefined) {
    const home = dshHome !== undefined && dshHome !== '' ? dshHome : join(homedir(), '.dsh')
    this.filePath = join(home, 'fx-tui-settings.json')
    this.mode = loadApprovalMode(this.filePath)
  }

  get approvalMode(): ApprovalMode {
    return this.mode
  }

  /** The path surfaced by `/config` so users know where to look / reset. */
  get location(): string {
    return this.filePath
  }

  setApprovalMode(mode: ApprovalMode): void {
    this.mode = mode
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      const file: SettingsFile = { version: FILE_VERSION, approvalMode: this.mode }
      writeFileSync(this.filePath, `${JSON.stringify(file, null, 2)}\n`, { encoding: 'utf8' })
    } catch {
      // persistence is best-effort; the in-memory default still applies
    }
  }
}

function loadApprovalMode(filePath: string): ApprovalMode {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'))
    if (typeof parsed === 'object' && parsed !== null) {
      const raw = (parsed as SettingsFile).approvalMode
      if (isApprovalMode(raw)) return raw
    }
  } catch {
    // absent or malformed file starts at the built-in default
  }
  return DEFAULT_APPROVAL_MODE
}
