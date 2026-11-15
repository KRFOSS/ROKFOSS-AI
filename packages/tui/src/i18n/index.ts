import { createSignal, type JSX } from "solid-js"
import { dict as ko } from "./ko"
import { DEFAULT_LANGUAGE, detectLanguage, normalizeLanguage, type Language } from "./language"
import { lookup, translate, type Dictionary, type TranslationParams } from "./translate"

/**
 * Registered dictionaries. Adding a language means adding its file and one line here; nothing in
 * `component/`, `routes/` or `ui/` has to change, which is what keeps upstream merges cheap.
 */
const dictionaries: Partial<Record<Language, Dictionary>> = { ko }

/**
 * The active language lives in a module-level signal rather than a context.
 *
 * TUI code asks for a translation from places Solid has no context for -- keymap command
 * registries, toast helpers and plain `.ts` modules -- and a signal read inside JSX is still
 * tracked, so components re-render when the language changes. A context would have forced either a
 * second, non-reactive path or a `useT()` call in every touched file.
 */
const [language, setLanguageSignal] = createSignal<Language>(detectLanguage())

/** Reactive accessor for the active language. */
export const currentLanguage = language

export { LANGUAGES, normalizeLanguage, detectLanguage } from "./language"
export { interpolate, lookup, createTranslator, translate } from "./translate"
export type { Dictionary, Language, TranslationParams, Translator } from "./translate"

/** Switches language. Unknown or missing values fall back to English instead of failing. */
export function setLanguage(value: string | undefined): Language {
  const next = normalizeLanguage(value) ?? DEFAULT_LANGUAGE
  setLanguageSignal(next)
  return next
}

/**
 * Translates an English UI string into the active language.
 *
 * The English source *is* the key, so an untranslated string, a model name, a path or a session
 * title that happens to pass through a shared renderer simply comes back unchanged. That is also
 * why a merge with a newer upstream cannot break anything: new strings show in English.
 */
export function t(source: string, params?: TranslationParams): string {
  return translate(source, dictionaries[language()], params)
}

/** Whether the active language has an entry for `source`. Used by tooling and tests. */
export function hasTranslation(source: string): boolean {
  return lookup(dictionaries[language()], source) !== undefined
}

/**
 * Translates a JSX child only when it is a plain string. Titles built as nodes (styled spans,
 * highlighted matches) keep their own markup.
 */
export function tChild(value: string | JSX.Element): string | JSX.Element {
  return typeof value === "string" ? t(value) : value
}

/** Everything a component or plugin needs to localise its own copy. */
export function useI18n() {
  return { language, setLanguage, t }
}
