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
import type { NotifyMode } from './notify.js'
import { isNotifyMode } from './notify.js'
import type { ApprovalMode } from './store.js'
import { DEFAULT_STATUS_LINE, parseStatusLineItems } from './statusline.js'
import type { StatusLineItemId } from './statusline.js'
import type { ThemeSetting } from './ui/theme.js'
import { isThemeSetting } from './ui/theme.js'

export const DEFAULT_APPROVAL_MODE: ApprovalMode = 'auto'

/** Auto-update ships ON: opt-out lives in this file (and /config), not in code. */
export const DEFAULT_AUTO_UPDATE = true

/** Theme ships as 'auto': startup background detection picks light/dark. */
export const DEFAULT_THEME: ThemeSetting = 'auto'

/** Long-turn completion rings the terminal bell by default; 'system' opts into the macOS popup. */
export const DEFAULT_NOTIFY: NotifyMode = 'bell'

/** Auto-compaction stays opt-in: it rewrites history, so the user turns it on deliberately. */
export const DEFAULT_AUTO_COMPACT = false

/** The custom status command: run under the user's shell, first stdout line
 * becomes the `custom` segment. Absent means the segment is unconfigured. */
export interface StatusLineCommandConfig {
  readonly command: string
  readonly intervalSeconds?: number
}

interface SettingsFile {
  version: 1
  approvalMode: ApprovalMode
  autoUpdate?: boolean
  theme?: ThemeSetting
  notify?: NotifyMode
  autoCompact?: boolean
  statusLine?: readonly string[]
  statusLineCommand?: { command: string; intervalSeconds?: number }
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
  private notifyValue: NotifyMode
  private autoCompactValue: boolean
  private statusLineValue: StatusLineItemId[]
  private statusLineExplicit: boolean
  private statusLineCommandValue: StatusLineCommandConfig | undefined
  private readonly filePath: string

  constructor(dshHome: string | undefined) {
    const home = dshHome !== undefined && dshHome !== '' ? dshHome : join(homedir(), '.dsh')
    this.filePath = join(home, 'fx-tui-settings.json')
    const loaded = loadSettings(this.filePath)
    this.mode = loaded.approvalMode
    this.auto = loaded.autoUpdate
    this.themeValue = loaded.theme
    this.notifyValue = loaded.notify
    this.autoCompactValue = loaded.autoCompact
    this.statusLineValue = loaded.statusLine
    this.statusLineExplicit = loaded.statusLineExplicit
    this.statusLineCommandValue = loaded.statusLineCommand
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

  get notify(): NotifyMode {
    return this.notifyValue
  }

  get autoCompact(): boolean {
    return this.autoCompactValue
  }

  /** Configured right-side items, in display order. */
  get statusLine(): StatusLineItemId[] {
    return [...this.statusLineValue]
  }

  /** True once the user has saved an explicit list; `false` means the file
   * carries no `statusLine` key and the shipped default applies. */
  get statusLineCustomized(): boolean {
    return this.statusLineExplicit
  }

  get statusLineCommand(): StatusLineCommandConfig | undefined {
    return this.statusLineCommandValue
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

  setNotify(mode: NotifyMode): void {
    this.notifyValue = mode
    this.save()
  }

  setAutoCompact(enabled: boolean): void {
    this.autoCompactValue = enabled
    this.save()
  }

  /** Persist the item list; `null` removes the key so the shipped default
   * applies again (and the file stays minimal). */
  setStatusLine(items: StatusLineItemId[] | null): void {
    this.statusLineExplicit = items !== null
    this.statusLineValue = items !== null ? [...items] : [...DEFAULT_STATUS_LINE]
    this.save()
  }

  setStatusLineCommand(config: StatusLineCommandConfig | null): void {
    this.statusLineCommandValue = config !== null
      ? { command: config.command, ...(config.intervalSeconds !== undefined ? { intervalSeconds: config.intervalSeconds } : {}) }
      : undefined
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
        ...(this.notifyValue === DEFAULT_NOTIFY ? {} : { notify: this.notifyValue }),
        ...(this.autoCompactValue === DEFAULT_AUTO_COMPACT ? {} : { autoCompact: this.autoCompactValue }),
        ...(this.statusLineExplicit ? { statusLine: [...this.statusLineValue] } : {}),
        ...(this.statusLineCommandValue !== undefined ? { statusLineCommand: { ...this.statusLineCommandValue } } : {}),
      }
      writeFileSync(this.filePath, `${JSON.stringify(file, null, 2)}\n`, { encoding: 'utf8' })
    } catch {
      // persistence is best-effort; the in-memory default still applies
    }
  }
}

function loadSettings(filePath: string): {
  approvalMode: ApprovalMode
  autoUpdate: boolean
  theme: ThemeSetting
  notify: NotifyMode
  autoCompact: boolean
  statusLine: StatusLineItemId[]
  statusLineExplicit: boolean
  statusLineCommand: StatusLineCommandConfig | undefined
} {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'))
    if (typeof parsed === 'object' && parsed !== null) {
      const raw = parsed as SettingsFile
      const approvalMode = isApprovalMode(raw.approvalMode) ? raw.approvalMode : DEFAULT_APPROVAL_MODE
      const autoUpdate = typeof raw.autoUpdate === 'boolean' ? raw.autoUpdate : DEFAULT_AUTO_UPDATE
      const theme = isThemeSetting(raw.theme) ? raw.theme : DEFAULT_THEME
      const notify = isNotifyMode(raw.notify) ? raw.notify : DEFAULT_NOTIFY
      const autoCompact = typeof raw.autoCompact === 'boolean' ? raw.autoCompact : DEFAULT_AUTO_COMPACT
      const statusLineExplicit = Array.isArray(raw.statusLine)
      const statusLine = parseStatusLineItems(raw.statusLine)
      const statusLineCommand = parseStatusLineCommand(raw.statusLineCommand)
      return { approvalMode, autoUpdate, theme, notify, autoCompact, statusLine, statusLineExplicit, statusLineCommand }
    }
  } catch {
    // absent or malformed file starts at the built-in defaults
  }
  return {
    approvalMode: DEFAULT_APPROVAL_MODE,
    autoUpdate: DEFAULT_AUTO_UPDATE,
    theme: DEFAULT_THEME,
    notify: DEFAULT_NOTIFY,
    autoCompact: DEFAULT_AUTO_COMPACT,
    statusLine: [...DEFAULT_STATUS_LINE],
    statusLineExplicit: false,
    statusLineCommand: undefined,
  }
}

function parseStatusLineCommand(raw: { command: string; intervalSeconds?: number } | undefined): StatusLineCommandConfig | undefined {
  if (typeof raw !== 'object' || raw === null || typeof raw.command !== 'string' || raw.command.trim() === '') return undefined
  const intervalSeconds = typeof raw.intervalSeconds === 'number' && Number.isFinite(raw.intervalSeconds) && raw.intervalSeconds >= 0
    ? raw.intervalSeconds
    : undefined
  return { command: raw.command, ...(intervalSeconds !== undefined ? { intervalSeconds } : {}) }
}
