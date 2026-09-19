/**
 * Semantic color palette and active-theme state.
 *
 * Built-in palettes keyed by the terminal's background tone:
 *
 * - light keeps named ANSI colors for its interface domain: terminal themes
 *   remap them towards their own palette, which reads well on light
 *   backgrounds and degrades gracefully on 256-color terminals.
 * - dark uses literal hex colors instead. Named ANSI colors are the reason
 *   dark terminals rendered fx-tui poorly: themes for dark backgrounds remap
 *   e.g. "blue"/"gray" to low-luminance tones that vanish against black. Hex
 *   values bypass the remap (chalk degrades them on non-truecolor terminals)
 *   and pin readability to the palette itself.
 *
 * On top of the two built-ins, the fourteen most popular Ghostty terminal
 * themes are ported (see ghostty-themes.ts).
 *
 * Every palette splits into two domains:
 *
 * - The INTERFACE domain (accent/status colors/borders/selection/user bar)
 *   is brand-pinned. Ghostty themes reuse the brand token sets verbatim —
 *   pastel-bright hexes for dark backgrounds, named ANSI for light — so
 *   switching themes recolors the *content* while the app chrome stays in
 *   the brand's ~181° teal-cyan family. Only the background-mixed tokens
 *   (user bar, selection) lean on the theme's own background, keeping them
 *   harmonized with the terminal.
 * - The CONTENT domain (editor syntax/diff/markdown hues) follows the
 *   selected theme. Code blocks render in the theme's official editor
 *   syntax palette, diffs and markdown in the theme's own ANSI hues with a
 *   contrast floor; that separation is what keeps a fourteen-theme picker
 *   from reading as fourteen different apps.
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

/** The 9 editor syntax roles a palette's code-block highlighting is built
 * from. Shape-mirrors GhosttySyntax so theme data passes through unchanged. */
export interface SyntaxGroup {
  readonly keyword: string
  readonly function: string
  readonly string: string
  readonly number: string
  readonly comment: string
  readonly type: string
  readonly variable: string
  readonly operator: string
  readonly punctuation: string
}

export interface Palette {
  // -- Interface domain: brand chrome. Two tone variants only (see
  //    BRAND_DARK_TOKENS/BRAND_LIGHT_TOKENS); Ghostty palettes spread one of
  //    them, so these tokens never vary within a background tone.
  /** Brand emphasis: banner, input/menu borders, spinner, titles. Decorative
   * identity — distinct from `info` (neutral prompts: question cards,
   * selected options) and `approval` (permission states). */
  readonly accent: string
  /** Warnings, queued/pending states, the auto-approval mode line. */
  readonly warning: string
  /** Success results, allow keys, tool-card ok state. */
  readonly success: string
  /** Errors, reject keys, exit-armed warning. */
  readonly danger: string
  /** Neutral prompts: question/plan borders, selected options. */
  readonly info: string
  /** Approval prompts, plan review, image attachments. */
  readonly approval: string
  /** Dimmed facts: info notices, secondary text. Reads ≥3.5:1 against the
   * background because call sites often stack ink's dimColor on top. */
  readonly muted: string
  /** Recessed rules, inline HTML passthrough — visually quieter than
   * `muted` and never carrying meaning on its own. */
  readonly dim: ChalkStyle
  /** Emphasized structural frames: the active input border. */
  readonly borderAccent: string
  /** Recessed structural frames: the frozen input border, the completion
   * menu pane. */
  readonly borderMuted: string
  /** Cursor/selection row background: a tint of the palette's own
   * background, always lighter than it. */
  readonly selectedBg: string
  /** User message bar: hex by design, see the module comment. */
  readonly userBarBackground: string
  readonly userBarForeground: string
  // -- Content domain: follows the selected theme.
  /** Editor syntax roles for code blocks; see the module comment. */
  readonly syntax: SyntaxGroup
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
    /** The parenthesized URL after a link label. */
    readonly linkUrl: ChalkStyle
    readonly image: ChalkStyle
    /** Code-fence rules above/below a block. */
    readonly codeBlockBorder: ChalkStyle
    readonly quote: ChalkStyle
    readonly quoteBorder: ChalkStyle
    /** Horizontal rules and table separators. */
    readonly hr: ChalkStyle
    readonly listBullet: ChalkStyle
  }
  /** Code-block highlighting, built from `syntax` + diff add/del. */
  readonly highlight: Theme
}

const LIGHT_SYNTAX: SyntaxGroup = {
  // VS Code Light+, the light counterpart of the Dark+ roles below.
  keyword: '#0000ff',
  function: '#795e26',
  string: '#a31515',
  number: '#098658',
  comment: '#008000',
  type: '#267f99',
  variable: '#001080',
  operator: '#000000',
  punctuation: '#000000',
}

const DARK_SYNTAX: SyntaxGroup = {
  // VS Code Dark+ — the syntax palette the entire industry's users already
  // know; also pi/coding-agent's choice for its dark theme.
  keyword: '#569cd6',
  function: '#dcdcaa',
  string: '#ce9178',
  number: '#b5cea8',
  comment: '#6a9955',
  type: '#4ec9b0',
  variable: '#9cdcfe',
  operator: '#d4d4d4',
  punctuation: '#d4d4d4',
}

/** Interface-domain brand tokens for dark backgrounds: pastel-bright hexes
 * in the ~181° teal-cyan family, readable on near-black. Shared by the dark
 * built-in and every dark Ghostty palette. */
const BRAND_DARK_TOKENS = {
  accent: '#67e8f9',
  warning: '#fcd34d',
  success: '#86efac',
  danger: '#fca5a5',
  info: '#93c5fd',
  approval: '#f0abfc',
  muted: '#94a3b8',
} as const

/** Interface-domain brand tokens for light backgrounds: named ANSI colors
 * the terminal remaps into its own (light-tuned) palette. */
const BRAND_LIGHT_TOKENS = {
  accent: 'cyan',
  warning: 'yellow',
  success: 'green',
  danger: 'red',
  info: 'blue',
  approval: 'magenta',
  muted: 'gray',
} as const

/** Brand accent as mix targets for background-tinted tokens (user bar,
 * selection): bright teal over dark backgrounds, deep teal (dark ink) over
 * light ones. */
const BRAND_DARK_ACCENT_HEX = '#67e8f9'
const BRAND_LIGHT_ACCENT_HEX = '#0e7490'

/** Recessed rules/borders for the dark built-in: slate-600, quiet but
 * present on near-black (≈2.8:1). */
const DARK_RULE_HEX = '#475569'

const LIGHT: Palette = {
  ...BRAND_LIGHT_TOKENS,
  dim: chalk.dim,
  borderAccent: BRAND_LIGHT_TOKENS.accent,
  borderMuted: BRAND_LIGHT_TOKENS.muted,
  selectedBg: '#e2eef2',
  userBarBackground: '#bdeef2',
  userBarForeground: 'black',
  syntax: LIGHT_SYNTAX,
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
    linkUrl: chalk.dim,
    image: chalk.cyan,
    codeBlockBorder: chalk.dim,
    quote: chalk.dim,
    quoteBorder: chalk.dim,
    hr: chalk.dim,
    listBullet: chalk.cyan,
  },
  highlight: highlightFromSyntax(LIGHT_SYNTAX, chalk.green, chalk.red),
}

/** Build the cli-highlight theme from a palette's independent syntax group:
 * every token that carries a hue is sourced from the 9 roles, so code blocks
 * render in the selected theme's own editor conventions; diff markers keep
 * the diff colors so `git diff` blocks inside code stay green/red. Tokens
 * not listed here inherit cli-highlight's default (plain text). */
function highlightFromSyntax(syntax: SyntaxGroup, addition: ChalkStyle, deletion: ChalkStyle): Theme {
  return {
    ...DEFAULT_THEME,
    keyword: chalk.hex(syntax.keyword),
    built_in: chalk.hex(syntax.type),
    literal: chalk.hex(syntax.number),
    type: chalk.hex(syntax.type),
    class: chalk.hex(syntax.type),
    number: chalk.hex(syntax.number),
    string: chalk.hex(syntax.string),
    regexp: chalk.hex(syntax.string),
    subst: chalk.hex(syntax.string),
    comment: chalk.hex(syntax.comment),
    doctag: chalk.hex(syntax.comment),
    meta: chalk.hex(syntax.comment),
    'meta-keyword': chalk.hex(syntax.keyword),
    'meta-string': chalk.hex(syntax.string),
    function: chalk.hex(syntax.function),
    title: chalk.hex(syntax.function),
    name: chalk.hex(syntax.keyword),
    attr: chalk.hex(syntax.variable),
    variable: chalk.hex(syntax.variable),
    params: chalk.hex(syntax.variable),
    tag: chalk.hex(syntax.keyword),
    addition,
    deletion,
  }
}

const DARK: Palette = {
  ...BRAND_DARK_TOKENS,
  dim: chalk.hex('#64748b'),
  borderAccent: BRAND_DARK_TOKENS.accent,
  borderMuted: BRAND_DARK_TOKENS.muted,
  selectedBg: '#1c383f',
  userBarBackground: '#0f3a40',
  userBarForeground: '#d9f7fa',
  syntax: DARK_SYNTAX,
  diff: {
    add: chalk.hex(BRAND_DARK_TOKENS.success),
    del: chalk.hex(BRAND_DARK_TOKENS.danger),
    context: chalk.dim,
    more: chalk.hex('#a7f3d0'),
  },
  md: {
    heading: chalk.bold.hex(BRAND_DARK_TOKENS.accent),
    codespan: chalk.hex(BRAND_DARK_TOKENS.warning),
    link: chalk.hex(BRAND_DARK_TOKENS.accent).underline,
    linkUrl: chalk.hex(BRAND_DARK_TOKENS.muted),
    image: chalk.hex(BRAND_DARK_TOKENS.accent),
    codeBlockBorder: chalk.hex(DARK_RULE_HEX),
    quote: chalk.hex(BRAND_DARK_TOKENS.muted),
    quoteBorder: chalk.hex(DARK_RULE_HEX),
    hr: chalk.hex(DARK_RULE_HEX),
    listBullet: chalk.hex(BRAND_DARK_TOKENS.accent),
  },
  highlight: highlightFromSyntax(
    DARK_SYNTAX,
    chalk.hex(BRAND_DARK_TOKENS.success),
    chalk.hex(BRAND_DARK_TOKENS.danger),
  ),
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
 * Assemble a Ghostty theme's palette from the two domains:
 *
 * - Interface: the brand token set for the theme's background tone, spread
 *   verbatim. Only `selectedBg`/`userBarBackground` lean on the theme —
 *   mixed towards the brand accent over the theme's own background so the
 *   selection and the user bar stay harmonized with the terminal while
 *   carrying the brand hue.
 * - Content: the theme's own hues. Syntax comes verbatim from the official
 *   editor port (def.syntax); markdown/diff tones map the theme's ANSI
 *   slots by design intent — cyan→headings/links/bullets, yellow→inline
 *   code, green/red→diff — each keeping whichever of the normal/bright pair
 *   reads better against the theme's background. Slot conventions vary
 *   wildly across light palettes (Gruvbox Light keeps the darker tones in
 *   the bright slots, Rose Pine repeats one tone into both, TokyoNight Day
 *   makes them identical), so no blanket rule fits.
 *
 * Softly-calibrated palettes (Rose Pine's gold on cream) can still land
 * below a readable ratio; such tones are nudged towards the theme's own
 * foreground — which by definition reads on this background — until they
 * clear the floor, keeping the hue. Dark palettes never trip the floor.
 * `recessed` (bright black) drives the quiet rules; it gets a floor of its
 * own, milder than `muted`'s because nothing stacks dimColor on top.
 */
function ghosttyPalette(def: GhosttyThemeDef): Palette {
  const dark = hexLuminance(def.background) <= 0.5
  const pal = def.palette
  const brand = dark ? BRAND_DARK_TOKENS : BRAND_LIGHT_TOKENS
  const brandAccentHex = dark ? BRAND_DARK_ACCENT_HEX : BRAND_LIGHT_ACCENT_HEX
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
  const mdHue = readable(tone(6, 14), 2.5)
  const codeHue = readable(tone(3, 11), 2.5)
  const success = readable(tone(2, 10), 2.5)
  const danger = readable(tone(1, 9), 2.5)
  const recessed = readable(pal[8]!, 2.5)
  return {
    // Interface domain: brand-pinned chrome.
    ...brand,
    dim: dark ? chalk.hex('#64748b') : chalk.dim,
    borderAccent: brand.accent,
    borderMuted: brand.muted,
    selectedBg: mixHex(def.background, brandAccentHex, dark ? 0.22 : 0.18),
    userBarBackground: mixHex(def.background, brandAccentHex, dark ? 0.32 : 0.28),
    userBarForeground: def.foreground,
    // Content domain: the theme's own hues.
    syntax: def.syntax,
    diff: {
      add: chalk.hex(success),
      del: chalk.hex(danger),
      context: chalk.dim,
      more: chalk.hex(mixHex(success, dark ? '#ffffff' : def.foreground, 0.25)),
    },
    md: {
      heading: chalk.bold.hex(mdHue),
      codespan: chalk.hex(codeHue),
      link: chalk.hex(mdHue).underline,
      linkUrl: chalk.hex(recessed),
      image: chalk.hex(mdHue),
      codeBlockBorder: chalk.hex(recessed),
      quote: chalk.hex(recessed),
      quoteBorder: chalk.hex(recessed),
      hr: chalk.hex(recessed),
      listBullet: chalk.hex(mdHue),
    },
    highlight: highlightFromSyntax(def.syntax, chalk.hex(success), chalk.hex(danger)),
  }
}

const GHOSTTY_PALETTES = {} as Record<GhosttyThemeId, Palette>
for (const def of GHOSTTY_THEMES) GHOSTTY_PALETTES[def.id] = ghosttyPalette(def)

const PALETTES: Readonly<Record<ThemeName, Palette>> = { light: LIGHT, dark: DARK, ...GHOSTTY_PALETTES }

/** Palette lookup by resolved theme name; exported for tests. */
export function paletteFor(name: ThemeName): Palette {
  return PALETTES[name]!
}

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
  get dim(): ChalkStyle { return PALETTES[active].dim },
  get borderAccent(): string { return PALETTES[active].borderAccent },
  get borderMuted(): string { return PALETTES[active].borderMuted },
  get selectedBg(): string { return PALETTES[active].selectedBg },
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
