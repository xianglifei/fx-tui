/**
 * Persistent user settings: the startup defaults that outlive a session,
 * written to `$DSH_HOME/fx-tui-settings.json`.
 *
 * Shift+Tab mode cycling is session-scoped on purpose — this file is only
 * touched by `/config`, so a one-off in-session switch never silently changes
 * what future launches start with. A missing or malformed file falls back to
 * the built-in defaults: deleting the file is therefore also the documented
 * way to reset settings.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ApprovalMode } from './store.js'
import type { ThemeSetting } from './ui/theme.js'
import { isThemeSetting } from './ui/theme.js'

export const DEFAULT_APPROVAL_MODE: ApprovalMode = 'auto'

/** Auto-update ships ON: opt-out lives in this file (and /config), not in code. */
export const DEFAULT_AUTO_UPDATE = true

/** Theme ships as 'auto': startup background detection picks light/dark. */
export const DEFAULT_THEME: ThemeSetting = 'auto'

interface SettingsFile {
  version: 1
  approvalMode: ApprovalMode
  autoUpdate?: boolean
  theme?: ThemeSetting
}

const FILE_VERSION = 1

const APPROVAL_MODES: readonly ApprovalMode[] = ['ask', 'auto']

function isApprovalMode(value: unknown): value is ApprovalMode {
  return typeof value === 'string' && (APPROVAL_MODES as readonly string[]).includes(value)
}

export class FxSettings {
  private mode: ApprovalMode
  private auto: boolean
  private themeValue: ThemeSetting
  private readonly filePath: string

  constructor(dshHome: string | undefined) {
    const home = dshHome !== undefined && dshHome !== '' ? dshHome : join(homedir(), '.dsh')
    this.filePath = join(home, 'fx-tui-settings.json')
    const loaded = loadSettings(this.filePath)
    this.mode = loaded.approvalMode
    this.auto = loaded.autoUpdate
    this.themeValue = loaded.theme
  }

  get approvalMode(): ApprovalMode {
    return this.mode
  }

  get autoUpdate(): boolean {
    return this.auto
  }

  get theme(): ThemeSetting {
    return this.themeValue
  }

  /** The path surfaced by `/config` so users know where to look / reset. */
  get location(): string {
    return this.filePath
  }

  setApprovalMode(mode: ApprovalMode): void {
    this.mode = mode
    this.save()
  }

  setAutoUpdate(enabled: boolean): void {
    this.auto = enabled
    this.save()
  }

  setTheme(setting: ThemeSetting): void {
    this.themeValue = setting
    this.save()
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      const file: SettingsFile = {
        version: FILE_VERSION,
        approvalMode: this.mode,
        ...(this.auto === DEFAULT_AUTO_UPDATE ? {} : { autoUpdate: this.auto }),
        ...(this.themeValue === DEFAULT_THEME ? {} : { theme: this.themeValue }),
      }
      writeFileSync(this.filePath, `${JSON.stringify(file, null, 2)}\n`, { encoding: 'utf8' })
    } catch {
      // persistence is best-effort; the in-memory default still applies
    }
  }
}

function loadSettings(filePath: string): { approvalMode: ApprovalMode; autoUpdate: boolean; theme: ThemeSetting } {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'))
    if (typeof parsed === 'object' && parsed !== null) {
      const raw = parsed as SettingsFile
      const approvalMode = isApprovalMode(raw.approvalMode) ? raw.approvalMode : DEFAULT_APPROVAL_MODE
      const autoUpdate = typeof raw.autoUpdate === 'boolean' ? raw.autoUpdate : DEFAULT_AUTO_UPDATE
      const theme = isThemeSetting(raw.theme) ? raw.theme : DEFAULT_THEME
      return { approvalMode, autoUpdate, theme }
    }
  } catch {
    // absent or malformed file starts at the built-in defaults
  }
  return { approvalMode: DEFAULT_APPROVAL_MODE, autoUpdate: DEFAULT_AUTO_UPDATE, theme: DEFAULT_THEME }
}
