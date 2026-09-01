/** /theme: the palette picker. Direct forms accept base words plus every
 * Ghostty id and display name (normalized: lowercase, runs of spaces become
 * hyphens); the bare command opens the interactive pickers. */

import { draftCapture } from '../ui/Input.js'
import { GHOSTTY_PICKER_ENTRIES, themeDisplayLabel } from '../ui/theme.js'
import type { GhosttyThemeId } from '../ui/ghostty-themes.js'
import { activeThemeName, resolveTheme, setActiveTheme } from '../ui/theme.js'
import type { ThemeSetting } from '../ui/theme.js'
import type { CommandCtx } from './types.js'
import { pick } from './pick.js'

/** Direct-form lookup: base words plus every Ghostty id and display name. */
const THEME_WORDS: Record<string, ThemeSetting> = {
  auto: 'auto', light: 'light', dark: 'dark',
  自动: 'auto', 自动检测: 'auto',
  浅色: 'light', 深色: 'dark',
}
for (const entry of GHOSTTY_PICKER_ENTRIES) {
  THEME_WORDS[entry.id] = entry.id
  THEME_WORDS[entry.name.toLowerCase().replace(/\s+/g, '-')] = entry.id
}

export function themeSettingLabel(setting: ThemeSetting): string {
  return setting === 'auto' ? '自动检测' : themeDisplayLabel(setting)
}

/** Persist a theme choice and re-render everything in its palette. */
function applyTheme(c: CommandCtx, setting: ThemeSetting): void {
  const resolved = resolveTheme(setting, c.detectedTheme())
  const savedChanged = c.settings.theme !== setting
  const activeChanged = activeThemeName() !== resolved
  c.settings.setTheme(setting)
  setActiveTheme(resolved)
  if (!savedChanged && !activeChanged) {
    c.store.addNotice(`主题已是${themeSettingLabel(setting)}（${c.settings.location}）`)
    return
  }
  c.store.addNotice(
    `主题已保存为${themeSettingLabel(setting)}`
    + (setting === 'auto'
      ? c.detectedTheme() !== null ? `：当前终端检测为${themeDisplayLabel(resolved)}背景` : '：未能检测终端背景色，本次按浅色处理'
      : '')
    + `（${c.settings.location}）`,
  )
  if (!activeChanged) return
  // The submitted command text is consumed, not a draft to carry over: the
  // module-level capture would otherwise restore it into the fresh editor.
  draftCapture.state = null
  void c.remountForThemeChange()
}

/** Ghostty picker: the question card scrolls, so all 14 themes fit in one
 * flat list — the 8-per-page pagination the digit-key era needed is gone. */
async function pickGhosttyTheme(c: CommandCtx): Promise<GhosttyThemeId | undefined> {
  const options = GHOSTTY_PICKER_ENTRIES.map(entry => ({
    label: entry.name,
    description: `${entry.dark ? '深色' : '浅色'} · ${entry.summary}`,
  }))
  const chosen = await pick(c, 'Ghostty 精选主题（深色 10 · 浅色 4）', options)
  if (chosen === undefined) return undefined
  return GHOSTTY_PICKER_ENTRIES.find(entry => entry.name === chosen)?.id
}

export async function runTheme(c: CommandCtx, arg: string): Promise<void> {
  const raw = arg.trim()
  if (raw !== '') {
    const key = raw.toLowerCase().replace(/\s+/g, '-')
    const target = THEME_WORDS[key]
    if (target === undefined) {
      c.store.addPanel('未知主题', [
        `未找到主题「${raw}」。基础主题：auto / light / dark（自动检测 / 浅色 / 深色）`,
        '',
        'Ghostty 精选：',
        ...GHOSTTY_PICKER_ENTRIES.map(entry => `· ${entry.id}（${entry.name} · ${entry.dark ? '深色' : '浅色'}）`),
        '',
        '或直接运行 /theme 用菜单选择。',
      ])
      return
    }
    applyTheme(c, target)
    return
  }
  for (;;) {
    const current = c.settings.theme
    const currentTone = resolveTheme(current, c.detectedTheme())
    const chosen = await pick(
      c,
      `配色主题（当前 ${themeSettingLabel(current)}，显示为${themeDisplayLabel(currentTone)}）`,
      [
        { label: '自动检测', description: '启动时探测终端背景色（OSC 11），测不出按浅色' },
        { label: '浅色', description: '内置浅色配色（跟随终端 ANSI 色映射）' },
        { label: '深色', description: '内置深色配色（hex 定色，黑底可读）' },
        { label: 'Ghostty 精选（14 款）', description: '社区最热门主题移植（10 深 + 4 浅）' },
      ],
    )
    if (chosen === undefined) return
    if (chosen === 'Ghostty 精选（14 款）') {
      const id = await pickGhosttyTheme(c)
      if (id === undefined) continue // back / Esc: return to the base picker
      applyTheme(c, id)
      return
    }
    const target = THEME_WORDS[chosen]
    if (target !== undefined) applyTheme(c, target)
    return
  }
}
