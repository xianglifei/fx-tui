/**
 * Semantic color palette and active-theme state.
 *
 * Two palettes keyed by the terminal's background tone:
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

export type ThemeName = 'light' | 'dark'
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

/** Code-block highlighting tuned for near-black backgrounds: the default
 * theme's chalk.blue keywords and chalk.green comments vanish on dark
 * terminals, so every token that maps to a named color is re-mapped to the
 * palette's hex tones; the rest inherits the default theme. */
const DARK_HIGHLIGHT: Theme = {
  ...DEFAULT_THEME,
  keyword: chalk.hex('#93c5fd'),
  literal: chalk.hex('#f0abfc'),
  built_in: chalk.hex('#67e8f9'),
  type: chalk.hex('#67e8f9').dim,
  number: chalk.hex('#86efac'),
  string: chalk.hex('#fca5a5'),
  regexp: chalk.hex('#fca5a5'),
  class: chalk.hex('#93c5fd'),
  function: chalk.hex('#fcd34d'),
  name: chalk.hex('#93c5fd'),
  attr: chalk.hex('#fcd34d'),
  tag: chalk.hex('#f0abfc'),
  comment: chalk.hex('#94a3b8'),
  doctag: chalk.hex('#94a3b8'),
  meta: chalk.hex('#94a3b8'),
  addition: chalk.hex('#86efac'),
  deletion: chalk.hex('#fca5a5'),
}

const DARK: Palette = {
  accent: '#67e8f9',
  warning: '#fcd34d',
  success: '#86efac',
  danger: '#fca5a5',
  info: '#93c5fd',
  approval: '#f0abfc',
  muted: '#94a3b8',
  userBarBackground: '#0f3a40',
  userBarForeground: '#d9f7fa',
  diff: {
    add: chalk.hex('#86efac'),
    del: chalk.hex('#fca5a5'),
    context: chalk.dim,
    more: chalk.hex('#a7f3d0'),
  },
  md: {
    heading: chalk.bold.hex('#67e8f9'),
    codespan: chalk.hex('#fcd34d'),
    link: chalk.hex('#67e8f9').underline,
    image: chalk.hex('#67e8f9'),
  },
  highlight: DARK_HIGHLIGHT,
}

const PALETTES: Readonly<Record<ThemeName, Palette>> = { light: LIGHT, dark: DARK }

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

const THEME_SETTINGS: readonly ThemeSetting[] = ['auto', 'light', 'dark']

/** Settings-file validation; unknown or missing values stay 'auto'. */
export function isThemeSetting(value: unknown): value is ThemeSetting {
  return typeof value === 'string' && (THEME_SETTINGS as readonly string[]).includes(value)
}
