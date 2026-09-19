/**
 * Data-only port of the fourteen most popular Ghostty terminal themes.
 *
 * Two layers per theme, both transcribed verbatim:
 *
 * - The 16-color ANSI palette, from the theme files bundled with Ghostty
 *   1.3.1 (upstream source: mbadolato/iTerm2-Color-Schemes, synced into
 *   Ghostty weekly).
 * - The syntax layer (9 editor roles), from each theme's own official
 *   editor port rather than derived from the ANSI palette: Catppuccin's
 *   nvim groups + palette.json, TokyoNight's prism extras, Gruvbox's
 *   vscode-theme-gruvbox sources, Rosé Pine's vscode themes, Dracula's
 *   vim colors, Kanagawa's theme/palette tables, Nord's vim colors,
 *   Ayu's vscode tokenColors, Everforest's vim highlight calls + palette,
 *   Solarized's vim highlight calls over the Higher-Contrast ANSI accents.
 *   These palettes are what users see in their editors; porting them keeps
 *   code blocks looking the way each theme's authors designed.
 *
 * Ghostty ships no official popularity ranking, so the selection is usage
 * in public dotfiles (GitHub code search over `theme =` in ghostty
 * configs, 2026-08): the ten most-used theme families, one variant each
 * (the family's most-used, all dark), followed by the four most-used light
 * variants — the top families' light counterparts, so light-background
 * terminals get a matching selection.
 *
 * This file is pure data: hex colors only, no chalk/ink imports. Semantic
 * token derivation lives in theme.ts.
 */

export const GHOSTTY_THEME_IDS = [
  'catppuccin-mocha', 'tokyonight-night', 'gruvbox-dark', 'rose-pine-moon', 'dracula', 'kanagawa-wave', 'nord', 'ayu', 'everforest-dark-hard', 'solarized-dark-higher-contrast', 'catppuccin-latte', 'gruvbox-light', 'rose-pine-dawn', 'tokyonight-day',
] as const

export type GhosttyThemeId = typeof GHOSTTY_THEME_IDS[number]

/** The 9 editor syntax roles, hex `#rrggbb`. Mirrors the roles the major
 * editor themes define; operators/punctuation are plain text in most
 * terminal highlighters but carried for the contract's completeness. */
export interface GhosttySyntax {
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

export interface GhosttyThemeDef {
  /** Ghostty's display name (also the upstream file name). */
  readonly name: string
  /** Short Chinese mood descriptor for the picker. */
  readonly summary: string
  readonly background: string
  readonly foreground: string
  /** ANSI palette 0–15, index-aligned (0=black … 15=bright white). */
  readonly palette: readonly string[]
  /** Editor syntax layer, verbatim from the theme's official port. */
  readonly syntax: GhosttySyntax
}

/** Definitions keyed by id; the Record type pins id↔def completeness. */
const DEFS: Record<GhosttyThemeId, GhosttyThemeDef> = {
  'catppuccin-mocha': {
    name: 'Catppuccin Mocha',
    summary: '柔和粉彩 · 深蓝紫底',
    background: '#1e1e2e',
    foreground: '#cdd6f4',
    palette: ['#45475a', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#a6adc8', '#585b70', '#f37799', '#89d88b', '#ebd391', '#74a8fc', '#f2aede', '#6bd7ca', '#bac2de'],
    syntax: {
      keyword: '#cba6f7', function: '#89b4fa', string: '#a6e3a1', number: '#fab387',
      comment: '#9399b2', type: '#f9e2af', variable: '#cdd6f4', operator: '#89dceb', punctuation: '#9399b2',
    },
  },
  'tokyonight-night': {
    name: 'TokyoNight Night',
    summary: '东京夜色 · 蓝紫',
    background: '#1a1b26',
    foreground: '#c0caf5',
    palette: ['#15161e', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#a9b1d6', '#414868', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#c0caf5'],
    syntax: {
      keyword: '#9d7cd8', function: '#7aa2f7', string: '#9ece6a', number: '#ff9e64',
      comment: '#565f89', type: '#2ac3de', variable: '#c0caf5', operator: '#89ddff', punctuation: '#bb9af7',
    },
  },
  'gruvbox-dark': {
    name: 'Gruvbox Dark',
    summary: '复古暖棕 · 经典',
    background: '#282828',
    foreground: '#ebdbb2',
    palette: ['#282828', '#cc241d', '#98971a', '#d79921', '#458588', '#b16286', '#689d6a', '#a89984', '#928374', '#fb4934', '#b8bb26', '#fabd2f', '#83a598', '#d3869b', '#8ec07c', '#ebdbb2'],
    syntax: {
      keyword: '#fb4934', function: '#fabd2f', string: '#b8bb26', number: '#d3869b',
      comment: '#928374', type: '#8ec07c', variable: '#83a598', operator: '#8ec07c', punctuation: '#ebdbb2',
    },
  },
  'rose-pine-moon': {
    name: 'Rose Pine Moon',
    summary: '玫瑰松 · 月夜灰紫',
    background: '#232136',
    foreground: '#e0def4',
    palette: ['#393552', '#eb6f92', '#3e8fb0', '#f6c177', '#9ccfd8', '#c4a7e7', '#ea9a97', '#e0def4', '#6e6a86', '#eb6f92', '#3e8fb0', '#f6c177', '#9ccfd8', '#c4a7e7', '#ea9a97', '#e0def4'],
    syntax: {
      keyword: '#3e8fb0', function: '#eb6f92', string: '#f6c177', number: '#ea9a97',
      comment: '#6e6a86', type: '#9ccfd8', variable: '#ea9a97', operator: '#e0def4', punctuation: '#908caa',
    },
  },
  dracula: {
    name: 'Dracula',
    summary: '经典德古拉 · 深紫',
    background: '#282a36',
    foreground: '#f8f8f2',
    palette: ['#21222c', '#ff5555', '#50fa7b', '#f1fa8c', '#bd93f9', '#ff79c6', '#8be9fd', '#f8f8f2', '#6272a4', '#ff6e6e', '#69ff94', '#ffffa5', '#d6acff', '#ff92df', '#a4ffff', '#ffffff'],
    syntax: {
      keyword: '#ff79c6', function: '#50fa7b', string: '#f1fa8c', number: '#bd93f9',
      comment: '#6272a4', type: '#8be9fd', variable: '#f8f8f2', operator: '#ff79c6', punctuation: '#f8f8f2',
    },
  },
  'kanagawa-wave': {
    name: 'Kanagawa Wave',
    summary: '日式水墨 · 藏蓝',
    background: '#1f1f28',
    foreground: '#dcd7ba',
    palette: ['#090618', '#c34043', '#76946a', '#c0a36e', '#7e9cd8', '#957fb8', '#6a9589', '#c8c093', '#727169', '#e82424', '#98bb6c', '#e6c384', '#7fb4ca', '#938aa9', '#7aa89f', '#dcd7ba'],
    syntax: {
      keyword: '#957fb8', function: '#7e9cd8', string: '#98bb6c', number: '#d27e99',
      comment: '#727169', type: '#7aa89f', variable: '#dcd7ba', operator: '#c0a36e', punctuation: '#9cabca',
    },
  },
  nord: {
    name: 'Nord',
    summary: '北欧极简 · 冷蓝灰',
    background: '#2e3440',
    foreground: '#d8dee9',
    palette: ['#3b4252', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#88c0d0', '#e5e9f0', '#596377', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#8fbcbb', '#eceff4'],
    syntax: {
      keyword: '#81a1c1', function: '#88c0d0', string: '#a3be8c', number: '#b48ead',
      comment: '#616e88', type: '#8fbcbb', variable: '#d8dee9', operator: '#81a1c1', punctuation: '#d8dee9',
    },
  },
  ayu: {
    name: 'Ayu',
    summary: '极简暗灰 · 柔和',
    background: '#0b0e14',
    foreground: '#bfbdb6',
    palette: ['#11151c', '#ea6c73', '#7fd962', '#f9af4f', '#53bdfa', '#cda1fa', '#90e1c6', '#c7c7c7', '#686868', '#f07178', '#aad94c', '#ffb454', '#59c2ff', '#d2a6ff', '#95e6cb', '#ffffff'],
    syntax: {
      keyword: '#ff8f40', function: '#ffb454', string: '#aad94c', number: '#d2a6ff',
      comment: '#5a6673', type: '#39bae6', variable: '#bfbdb6', operator: '#f29668', punctuation: '#bfbdb6',
    },
  },
  'everforest-dark-hard': {
    name: 'Everforest Dark Hard',
    summary: '森林绿 · 深底',
    background: '#1e2326',
    foreground: '#d3c6aa',
    palette: ['#7a8478', '#e67e80', '#a7c080', '#dbbc7f', '#7fbbb3', '#d699b6', '#83c092', '#f2efdf', '#a6b0a0', '#f85552', '#8da101', '#dfa000', '#3a94c5', '#df69ba', '#35a77c', '#fffbef'],
    syntax: {
      keyword: '#e67e80', function: '#a7c080', string: '#a7c080', number: '#d699b6',
      comment: '#859289', type: '#dbbc7f', variable: '#7fbbb3', operator: '#e69875', punctuation: '#d3c6aa',
    },
  },
  'solarized-dark-higher-contrast': {
    name: 'Solarized Dark HC',
    summary: '经典 Solarized · 高对比',
    background: '#001e27',
    foreground: '#9cc2c3',
    palette: ['#002831', '#d11c24', '#6cbe6c', '#a57706', '#2176c7', '#c61c6f', '#259286', '#eae3cb', '#006488', '#f5163b', '#51ef84', '#b27e28', '#178ec8', '#e24d8e', '#00b39e', '#fcf4dc'],
    syntax: {
      keyword: '#6cbe6c', function: '#2176c7', string: '#259286', number: '#259286',
      comment: '#006488', type: '#a57706', variable: '#2176c7', operator: '#259286', punctuation: '#9cc2c3',
    },
  },
  'catppuccin-latte': {
    name: 'Catppuccin Latte',
    summary: '柔和粉彩 · 奶白底',
    background: '#eff1f5',
    foreground: '#4c4f69',
    palette: ['#5c5f77', '#d20f39', '#40a02b', '#df8e1d', '#1e66f5', '#ea76cb', '#179299', '#acb0be', '#6c6f85', '#de293e', '#49af3d', '#eea02d', '#456eff', '#fe85d8', '#2d9fa8', '#bcc0cc'],
    syntax: {
      keyword: '#8839ef', function: '#1e66f5', string: '#40a02b', number: '#fe640b',
      comment: '#7c7f93', type: '#df8e1d', variable: '#4c4f69', operator: '#04a5e5', punctuation: '#7c7f93',
    },
  },
  'gruvbox-light': {
    name: 'Gruvbox Light',
    summary: '复古暖米 · 亮底',
    background: '#fbf1c7',
    foreground: '#3c3836',
    palette: ['#fbf1c7', '#cc241d', '#98971a', '#d79921', '#458588', '#b16286', '#689d6a', '#7c6f64', '#928374', '#9d0006', '#79740e', '#b57614', '#076678', '#8f3f71', '#427b58', '#3c3836'],
    syntax: {
      keyword: '#cc241d', function: '#b57614', string: '#79740e', number: '#8f3f71',
      comment: '#7c6f64', type: '#427b58', variable: '#076678', operator: '#427b58', punctuation: '#3c3836',
    },
  },
  'rose-pine-dawn': {
    name: 'Rose Pine Dawn',
    summary: '玫瑰松 · 晨曦暖底',
    background: '#faf4ed',
    foreground: '#575279',
    palette: ['#f2e9e1', '#b4637a', '#286983', '#ea9d34', '#56949f', '#907aa9', '#d7827e', '#575279', '#9893a5', '#b4637a', '#286983', '#ea9d34', '#56949f', '#907aa9', '#d7827e', '#575279'],
    syntax: {
      keyword: '#286983', function: '#b4637a', string: '#ea9d34', number: '#d7827e',
      comment: '#9893a5', type: '#56949f', variable: '#d7827e', operator: '#575279', punctuation: '#797593',
    },
  },
  'tokyonight-day': {
    name: 'TokyoNight Day',
    summary: '东京日间 · 亮蓝底',
    background: '#e1e2e7',
    foreground: '#3760bf',
    palette: ['#e9e9ed', '#f52a65', '#587539', '#8c6c3e', '#2e7de9', '#9854f1', '#007197', '#6172b0', '#a1a6c5', '#f52a65', '#587539', '#8c6c3e', '#2e7de9', '#9854f1', '#007197', '#3760bf'],
    syntax: {
      keyword: '#7847bd', function: '#2e7de9', string: '#587539', number: '#b15c00',
      comment: '#848cb5', type: '#188092', variable: '#3760bf', operator: '#006a83', punctuation: '#9854f1',
    },
  },
}

export const GHOSTTY_THEMES: readonly (GhosttyThemeDef & { id: GhosttyThemeId })[] =
  GHOSTTY_THEME_IDS.map(id => Object.assign({ id }, DEFS[id]))

export function ghosttyThemeDef(id: GhosttyThemeId): GhosttyThemeDef {
  return DEFS[id]
}
