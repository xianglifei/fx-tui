/**
 * Data-only port of the fourteen most popular Ghostty terminal themes.
 *
 * Colors are transcribed verbatim from the theme files bundled with Ghostty
 * 1.3.1 (upstream source: mbadolato/iTerm2-Color-Schemes, synced into Ghostty
 * weekly). Ghostty ships no official popularity ranking, so the selection is
 * usage in public dotfiles (GitHub code search over `theme =` in ghostty
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

export interface GhosttyThemeDef {
  /** Ghostty's display name (also the upstream file name). */
  readonly name: string
  /** Short Chinese mood descriptor for the picker. */
  readonly summary: string
  readonly background: string
  readonly foreground: string
  /** ANSI palette 0–15, index-aligned (0=black … 15=bright white). */
  readonly palette: readonly string[]
}

/** Definitions keyed by id; the Record type pins id↔def completeness. */
const DEFS: Record<GhosttyThemeId, GhosttyThemeDef> = {
  'catppuccin-mocha': {
    name: 'Catppuccin Mocha',
    summary: '柔和粉彩 · 深蓝紫底',
    background: '#1e1e2e',
    foreground: '#cdd6f4',
    palette: ['#45475a', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#a6adc8', '#585b70', '#f37799', '#89d88b', '#ebd391', '#74a8fc', '#f2aede', '#6bd7ca', '#bac2de'],
  },
  'tokyonight-night': {
    name: 'TokyoNight Night',
    summary: '东京夜色 · 蓝紫',
    background: '#1a1b26',
    foreground: '#c0caf5',
    palette: ['#15161e', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#a9b1d6', '#414868', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#c0caf5'],
  },
  'gruvbox-dark': {
    name: 'Gruvbox Dark',
    summary: '复古暖棕 · 经典',
    background: '#282828',
    foreground: '#ebdbb2',
    palette: ['#282828', '#cc241d', '#98971a', '#d79921', '#458588', '#b16286', '#689d6a', '#a89984', '#928374', '#fb4934', '#b8bb26', '#fabd2f', '#83a598', '#d3869b', '#8ec07c', '#ebdbb2'],
  },
  'rose-pine-moon': {
    name: 'Rose Pine Moon',
    summary: '玫瑰松 · 月夜灰紫',
    background: '#232136',
    foreground: '#e0def4',
    palette: ['#393552', '#eb6f92', '#3e8fb0', '#f6c177', '#9ccfd8', '#c4a7e7', '#ea9a97', '#e0def4', '#6e6a86', '#eb6f92', '#3e8fb0', '#f6c177', '#9ccfd8', '#c4a7e7', '#ea9a97', '#e0def4'],
  },
  'dracula': {
    name: 'Dracula',
    summary: '经典德古拉 · 深紫',
    background: '#282a36',
    foreground: '#f8f8f2',
    palette: ['#21222c', '#ff5555', '#50fa7b', '#f1fa8c', '#bd93f9', '#ff79c6', '#8be9fd', '#f8f8f2', '#6272a4', '#ff6e6e', '#69ff94', '#ffffa5', '#d6acff', '#ff92df', '#a4ffff', '#ffffff'],
  },
  'kanagawa-wave': {
    name: 'Kanagawa Wave',
    summary: '日式水墨 · 藏蓝',
    background: '#1f1f28',
    foreground: '#dcd7ba',
    palette: ['#090618', '#c34043', '#76946a', '#c0a36e', '#7e9cd8', '#957fb8', '#6a9589', '#c8c093', '#727169', '#e82424', '#98bb6c', '#e6c384', '#7fb4ca', '#938aa9', '#7aa89f', '#dcd7ba'],
  },
  'nord': {
    name: 'Nord',
    summary: '北欧极简 · 冷蓝灰',
    background: '#2e3440',
    foreground: '#d8dee9',
    palette: ['#3b4252', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#88c0d0', '#e5e9f0', '#596377', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#8fbcbb', '#eceff4'],
  },
  'ayu': {
    name: 'Ayu',
    summary: '极简暗灰 · 柔和',
    background: '#0b0e14',
    foreground: '#bfbdb6',
    palette: ['#11151c', '#ea6c73', '#7fd962', '#f9af4f', '#53bdfa', '#cda1fa', '#90e1c6', '#c7c7c7', '#686868', '#f07178', '#aad94c', '#ffb454', '#59c2ff', '#d2a6ff', '#95e6cb', '#ffffff'],
  },
  'everforest-dark-hard': {
    name: 'Everforest Dark Hard',
    summary: '森林绿 · 深底',
    background: '#1e2326',
    foreground: '#d3c6aa',
    palette: ['#7a8478', '#e67e80', '#a7c080', '#dbbc7f', '#7fbbb3', '#d699b6', '#83c092', '#f2efdf', '#a6b0a0', '#f85552', '#8da101', '#dfa000', '#3a94c5', '#df69ba', '#35a77c', '#fffbef'],
  },
  'solarized-dark-higher-contrast': {
    name: 'Solarized Dark HC',
    summary: '经典 Solarized · 高对比',
    background: '#001e27',
    foreground: '#9cc2c3',
    palette: ['#002831', '#d11c24', '#6cbe6c', '#a57706', '#2176c7', '#c61c6f', '#259286', '#eae3cb', '#006488', '#f5163b', '#51ef84', '#b27e28', '#178ec8', '#e24d8e', '#00b39e', '#fcf4dc'],
  },
  'catppuccin-latte': {
    name: 'Catppuccin Latte',
    summary: '柔和粉彩 · 奶白底',
    background: '#eff1f5',
    foreground: '#4c4f69',
    palette: ['#5c5f77', '#d20f39', '#40a02b', '#df8e1d', '#1e66f5', '#ea76cb', '#179299', '#acb0be', '#6c6f85', '#de293e', '#49af3d', '#eea02d', '#456eff', '#fe85d8', '#2d9fa8', '#bcc0cc'],
  },
  'gruvbox-light': {
    name: 'Gruvbox Light',
    summary: '复古暖米 · 亮底',
    background: '#fbf1c7',
    foreground: '#3c3836',
    palette: ['#fbf1c7', '#cc241d', '#98971a', '#d79921', '#458588', '#b16286', '#689d6a', '#7c6f64', '#928374', '#9d0006', '#79740e', '#b57614', '#076678', '#8f3f71', '#427b58', '#3c3836'],
  },
  'rose-pine-dawn': {
    name: 'Rose Pine Dawn',
    summary: '玫瑰松 · 晨曦暖底',
    background: '#faf4ed',
    foreground: '#575279',
    palette: ['#f2e9e1', '#b4637a', '#286983', '#ea9d34', '#56949f', '#907aa9', '#d7827e', '#575279', '#9893a5', '#b4637a', '#286983', '#ea9d34', '#56949f', '#907aa9', '#d7827e', '#575279'],
  },
  'tokyonight-day': {
    name: 'TokyoNight Day',
    summary: '东京日间 · 亮蓝底',
    background: '#e1e2e7',
    foreground: '#3760bf',
    palette: ['#e9e9ed', '#f52a65', '#587539', '#8c6c3e', '#2e7de9', '#9854f1', '#007197', '#6172b0', '#a1a6c5', '#f52a65', '#587539', '#8c6c3e', '#2e7de9', '#9854f1', '#007197', '#3760bf'],
  },
}

export const GHOSTTY_THEMES: readonly (GhosttyThemeDef & { id: GhosttyThemeId })[] =
  GHOSTTY_THEME_IDS.map(id => ({ id, ...DEFS[id] }))

export function ghosttyThemeDef(id: GhosttyThemeId): GhosttyThemeDef {
  return DEFS[id]
}
