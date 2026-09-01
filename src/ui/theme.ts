/**
 * Semantic color palette and active-theme state.
 *
 * Built-in palettes keyed by the terminal's background tone:
 *
 * - light keeps the original named ANSI colors: terminal themes remap them
 *   towards their own palette, which reads well on light backgrounds and
 *   degrades gracefully on 256-color terminals.
 * - dark uses literal hex colors instead. Named ANSI colors are the reason
 *   dark terminals rendered fx-tui poorly: themes for dark backgrounds remap
 *   e.g. "blue"/"gray" to low-luminance tones that vanish against black. Hex
 *   values bypass the remap (chalk degrades them on non-truecolor terminals)
 *   and pin readability to the palette itself.
 *
 * On top of the two built-ins, the fourteen most popular Ghostty terminal
 * themes are ported verbatim (see ghostty-themes.ts): their 16-color ANSI
 * palettes are mapped onto the semantic tokens at module load.
 *
 * The dark tones stay in the brand's ~181° teal-cyan family and sit at a
 * pastel-bright lightness (readable on near-black), with the user message bar
 * inverted: a deep teal background carrying near-white text.
 *
 * The palette is read at render time through the `theme` getters; switching
 * themes is paired with a full remount, so no reactive plumbing is needed.
 */

import chalk from 'chalk'
import { DEFAULT_THEME } from 'cli-highlight'
import type { Theme } from 'cli-highlight'
import { GHOSTTY_THEMES, GHOSTTY_THEME_IDS, ghosttyThemeDef } from './ghostty-themes.js'
import type { GhosttyThemeDef, GhosttyThemeId } from './ghostty-themes.js'

export type ThemeName = 'light' | 'dark' | GhosttyThemeId
export type ThemeSetting = 'auto' | ThemeName

/** Chalk style chain as used by the non-React render paths (diff/markdown). */
export type ChalkStyle = typeof chalk.green

export interface Palette {
  /** Brand emphasis: banner, panel/input borders, spinner active, titles. */
  readonly accent: string
  /** Warnings, queued/pending states, the auto-approval mode line. */
  readonly warning: string
  /** Success results, allow keys, diff card borders. */
  readonly success: string
  /** Errors, reject keys, exit-armed warning. */
  readonly danger: string
  /** Neutral prompts: question borders, selected options. */
  readonly info: string
  /** Approval prompts, plan review, image attachments. */
  readonly approval: string
  /** Dimmed facts: info notices, frozen input border. */
  readonly muted: string
  /** User message bar: hex by design, see the module comment. */
  readonly userBarBackground: string
  readonly userBarForeground: string
  /** Diff render paths (chalk). */
  readonly diff: {
    readonly add: ChalkStyle
    readonly del: ChalkStyle
    readonly context: ChalkStyle
    readonly more: ChalkStyle
  }
  /** Markdown render paths (chalk). */
  readonly md: {
    readonly heading: ChalkStyle
    readonly codespan: ChalkStyle
    readonly link: ChalkStyle
    readonly image: ChalkStyle
  }
  /** Code-block highlighting; light keeps cli-highlight's default theme. */
  readonly highlight: Theme
}

const LIGHT: Palette = {
  accent: 'cyan',
  warning: 'yellow',
  success: 'green',
  danger: 'red',
  info: 'blue',
  approval: 'magenta',
  muted: 'gray',
  userBarBackground: '#bdeef2',
  userBarForeground: 'black',
  diff: {
    add: chalk.green,
    del: chalk.red,
    context: chalk.dim,
    more: chalk.greenBright,
  },
  md: {
    heading: chalk.bold.cyanBright,
    codespan: chalk.yellowBright,
    link: chalk.cyanBright.underline,
    image: chalk.cyan,
  },
  highlight: DEFAULT_THEME,
}

/** Code-block highlighting derived from a palette's hex tokens: the default
 * theme's chalk.blue keywords and chalk.green comments vanish on dark
 * terminals, so every token that maps to a named color is re-mapped to the
 * palette's own tones; the rest inherits the default theme. */
function highlightFromTokens(tokens: {
  accent: string
  warning: string
  success: string
  danger: string
  info: string
  approval: string
  muted: string
}): Theme {
  const { accent, warning, success, danger, info, approval, muted } = tokens
  return {
    ...DEFAULT_THEME,
    keyword: chalk.hex(info),
    literal: chalk.hex(approval),
    built_in: chalk.hex(accent),
    type: chalk.hex(accent).dim,
    number: chalk.hex(success),
    string: chalk.hex(danger),
    regexp: chalk.hex(danger),
    class: chalk.hex(info),
    function: chalk.hex(warning),
    name: chalk.hex(info),
    attr: chalk.hex(warning),
    tag: chalk.hex(approval),
    comment: chalk.hex(muted),
    doctag: chalk.hex(muted),
    meta: chalk.hex(muted),
    addition: chalk.hex(success),
    deletion: chalk.hex(danger),
  }
}

const DARK_TOKENS = {
  accent: '#67e8f9',
  warning: '#fcd34d',
  success: '#86efac',
  danger: '#fca5a5',
  info: '#93c5fd',
  approval: '#f0abfc',
  muted: '#94a3b8',
} as const

const DARK: Palette = {
  ...DARK_TOKENS,
  userBarBackground: '#0f3a40',
  userBarForeground: '#d9f7fa',
  diff: {
    add: chalk.hex(DARK_TOKENS.success),
    del: chalk.hex(DARK_TOKENS.danger),
    context: chalk.dim,
    more: chalk.hex('#a7f3d0'),
  },
  md: {
    heading: chalk.bold.hex(DARK_TOKENS.accent),
    codespan: chalk.hex(DARK_TOKENS.warning),
    link: chalk.hex(DARK_TOKENS.accent).underline,
    image: chalk.hex(DARK_TOKENS.accent),
  },
  highlight: highlightFromTokens(DARK_TOKENS),
}

// -- Color math over #rrggbb ---------------------------------------------------

/** sRGB relative luminance (0–1) as used by WCAG contrast. Exported for tests. */
export function hexLuminance(hex: string): number {
  return (
    0.2126 * linearChannel(hex, 1) +
    0.7152 * linearChannel(hex, 3) +
    0.0722 * linearChannel(hex, 5)
  )
}

function linearChannel(hex: string, at: number): number {
  const v = Number.parseInt(hex.slice(at, at + 2), 16) / 255
  if (!Number.isFinite(v)) return 0
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}

export function contrastRatio(a: string, b: string): number {
  const la = hexLuminance(a)
  const lb = hexLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** Linear interpolation between two hex colors; t is the weight of `b`. */
function mixHex(a: string, b: string, t: number): string {
  const mix = (at: number): string => {
    const from = Number.parseInt(a.slice(at, at + 2), 16)
    const to = Number.parseInt(b.slice(at, at + 2), 16)
    const v = Math.round(from + (to - from) * t)
    return Math.min(255, Math.max(0, v)).toString(16).padStart(2, '0')
  }
  return `#${mix(1)}${mix(3)}${mix(5)}`
}

// -- Ghostty theme adapter -----------------------------------------------------

/**
 * Map a Ghostty theme's 16-color ANSI palette onto the semantic tokens.
 * Each token keeps its semantic slot — cyan→accent (the brand family),
 * yellow→warning, green→success, red→danger, blue→info, magenta→approval —
 * but the normal/bright variant choice is per-slot adaptive: whichever of
 * the pair reads better against the theme's own background wins. Slot
 * conventions vary wildly across light palettes (Gruvbox Light keeps the
 * darker tones in the bright slots, Rose Pine repeats one tone into both,
 * TokyoNight Day makes them identical), so no blanket rule fits.
 *
 * Softly-calibrated palettes (Rose Pine's gold on cream) can still land
 * below a readable ratio; such tones are nudged towards the theme's own
 * foreground — which by definition reads on this background — until they
 * clear the floor, keeping the hue. Dark palettes never trip the floor.
 *
 * The user message bar is the theme background tinted towards the accent
 * (deeper for dark, lighter for light), carrying the theme foreground.
 */
function ghosttyPalette(def: GhosttyThemeDef): Palette {
  const dark = hexLuminance(def.background) <= 0.5
  const pal = def.palette
  const tone = (normal: number, bright: number): string => {
    const a = pal[normal]!
    const b = pal[bright]!
    return contrastRatio(b, def.background) > contrastRatio(a, def.background) ? b : a
  }
  const readable = (hex: string, floor: number): string => {
    let out = hex
    for (let step = 0; step < 8 && contrastRatio(out, def.background) < floor; step++) {
      out = mixHex(out, def.foreground, 0.25)
    }
    return out
  }
  const accent = readable(tone(6, 14), 2.5)
  const warning = readable(tone(3, 11), 2.5)
  const success = readable(tone(2, 10), 2.5)
  const danger = readable(tone(1, 9), 2.5)
  const info = readable(tone(4, 12), 2.5)
  const approval = readable(tone(5, 13), 2.5)
  // Bright black (index 8) is the natural "muted" slot, but it regularly
  // sits too close to the background (Nord, Catppuccin, Solarized HC) — and
  // muted text also carries ink's dimColor, which darkens further, so it
  // gets a stronger floor than the other tokens.
  const muted = readable(pal[8]!, 3.5)
  return {
    accent,
    warning,
    success,
    danger,
    info,
    approval,
    muted,
    userBarBackground: mixHex(def.background, accent, dark ? 0.32 : 0.28),
    userBarForeground: def.foreground,
    diff: {
      add: chalk.hex(success),
      del: chalk.hex(danger),
      context: chalk.dim,
      more: chalk.hex(mixHex(success, dark ? '#ffffff' : def.foreground, 0.25)),
    },
    md: {
      heading: chalk.bold.hex(accent),
      codespan: chalk.hex(warning),
      link: chalk.hex(accent).underline,
      image: chalk.hex(accent),
    },
    highlight: highlightFromTokens({ accent, warning, success, danger, info, approval, muted }),
  }
}

const GHOSTTY_PALETTES = {} as Record<GhosttyThemeId, Palette>
for (const def of GHOSTTY_THEMES) GHOSTTY_PALETTES[def.id] = ghosttyPalette(def)

const PALETTES: Readonly<Record<ThemeName, Palette>> = { light: LIGHT, dark: DARK, ...GHOSTTY_PALETTES }

let active: ThemeName = 'light'

/** Apply a resolved theme; takes effect on subsequent renders. */
export function setActiveTheme(name: ThemeName): void {
  active = name
}

export function activeThemeName(): ThemeName {
  return active
}

/** Resolve a persisted setting against startup detection: explicit choices
 * win, `auto` falls back to the detected tone and finally to light (the
 * palette the UI was originally designed against). */
export function resolveTheme(setting: ThemeSetting, detected: ThemeName | null): ThemeName {
  if (setting === 'auto') return detected ?? 'light'
  return setting
}

/** Live view of the active palette: every read resolves at call time, so a
 * theme switch is picked up by the next render without re-subscription. */
export const theme = {
  get accent(): string { return PALETTES[active].accent },
  get warning(): string { return PALETTES[active].warning },
  get success(): string { return PALETTES[active].success },
  get danger(): string { return PALETTES[active].danger },
  get info(): string { return PALETTES[active].info },
  get approval(): string { return PALETTES[active].approval },
  get muted(): string { return PALETTES[active].muted },
  get userBarBackground(): string { return PALETTES[active].userBarBackground },
  get userBarForeground(): string { return PALETTES[active].userBarForeground },
  get diff(): Palette['diff'] { return PALETTES[active].diff },
  get md(): Palette['md'] { return PALETTES[active].md },
  get highlight(): Theme { return PALETTES[active].highlight },
}

const THEME_SETTINGS: readonly ThemeSetting[] = ['auto', 'light', 'dark', ...GHOSTTY_THEME_IDS]

/** Settings-file validation; unknown or missing values stay 'auto'. */
export function isThemeSetting(value: unknown): value is ThemeSetting {
  return typeof value === 'string' && (THEME_SETTINGS as readonly string[]).includes(value)
}

/** Human label for a resolved theme: 浅色 / 深色 / `<Ghostty name> · 深色`. */
export function themeDisplayLabel(name: ThemeName): string {
  if (name === 'light') return '浅色'
  if (name === 'dark') return '深色'
  const def = ghosttyThemeDef(name)
  return `${def.name} · ${hexLuminance(def.background) <= 0.5 ? '深色' : '浅色'}`
}

/** Picker-ready view of the Ghostty themes (id + display info + tone tag). */
export const GHOSTTY_PICKER_ENTRIES: readonly {
  readonly id: GhosttyThemeId
  readonly name: string
  readonly summary: string
  readonly dark: boolean
}[] = GHOSTTY_THEMES.map(def => ({
  id: def.id,
  name: def.name,
  summary: def.summary,
  dark: hexLuminance(def.background) <= 0.5,
}))
