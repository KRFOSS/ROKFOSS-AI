import { pluralCategory, resolveTemplate, type UiI18nParams, type UiI18nSource } from "@opencode/ui/context/i18n-core"
import { dict as uiEn } from "@opencode/ui/i18n/en"
import { dict as uiKo } from "@opencode/ui/i18n/ko"
import { currentLanguage } from "./index"

const english = uiEn as Record<string, string>
const korean = uiKo as Record<string, string>

function table(locale: string) {
  return locale.toLowerCase().split("-")[0] === "ko" ? korean : english
}

/**
 * Text that `@opencode/session-ui` renders — turn rows, tool summaries, the "Explored" and "Thought"
 * labels — reads its dictionary from the UI i18n context, not from this package. Translating it here
 * keeps one dictionary for both the desktop app and the terminal app instead of a parallel copy.
 *
 * The language is read on every call rather than captured, so `/settings` switches these labels in
 * place and reading the signal during render also subscribes the component that asked for the text.
 */
export function uiText(key: string, params?: UiI18nParams) {
  const locale = currentLanguage()
  const value = table(locale)[key] ?? english[key] ?? key
  return resolveTemplate(value, params)
}

export function uiPlural(key: string, category: string, params?: UiI18nParams) {
  const locale = currentLanguage()
  const value =
    table(locale)[`${key}.${category}`] ??
    table(locale)[`${key}.other`] ??
    english[`${key}.${category}`] ??
    english[`${key}.other`] ??
    key
  return resolveTemplate(value, params)
}

/** The source `@opencode/ui/context/i18n` needs; every reader resolves the current language. */
export const uiSource: UiI18nSource = {
  locale: () => currentLanguage(),
  t: (key, params) => uiText(key, params),
  plural: (key, count, params) => uiPlural(key, pluralCategory(currentLanguage(), count), { ...params, count }),
  pluralForm: (key, category, params) => uiPlural(key, category, params),
}
