import type { Language } from "./language"

/**
 * A dictionary maps the *English source text* the TUI already renders to the same sentence in
 * another language. Using the source text as the key is deliberate:
 *
 *   - a component edit stays a one-token change (`"New session"` -> `t("New session")`), which
 *     keeps upstream merges small, and
 *   - when upstream rewords a string the lookup simply misses and English shows through, instead
 *     of a placeholder such as `missing.key` or a crash at startup.
 *
 * Values may use `{{name}}` placeholders; `interpolate` fills them from the call site.
 */
export type Dictionary = Readonly<Record<string, string>>

export type TranslationParams = Record<string, string | number | boolean | null | undefined>

const placeholder = /{{\s*([A-Za-z0-9_$.-]+)\s*}}/g

export function interpolate(template: string, params?: TranslationParams): string {
  if (!params) return template
  return template.replace(placeholder, (_, name: string) => {
    const value = params[name]
    return value === undefined || value === null ? "" : String(value)
  })
}

/** The translation of `source`, or `undefined` when the dictionary has no entry for it. */
export function lookup(dictionary: Dictionary | undefined, source: string): string | undefined {
  if (!dictionary) return
  if (!Object.hasOwn(dictionary, source)) return
  return dictionary[source]
}

/**
 * Translates `source`, falling back to the source text itself. A missing entry is a normal state,
 * not an error: it is how an untranslated upstream string (or a model name, session title or path
 * that happens to pass through a shared renderer) reaches the screen unchanged.
 */
export function translate(source: string, dictionary: Dictionary | undefined, params?: TranslationParams): string {
  if (!source) return source
  const template = lookup(dictionary, source) ?? source
  return params ? interpolate(template, params) : template
}

/**
 * A translator bound to one dictionary. Used by the reactive `t` in `index.ts`, by tests, and by the
 * coverage script; it keeps the lookup rules in exactly one place.
 */
export function createTranslator(dictionary: Dictionary | undefined) {
  return (source: string, params?: TranslationParams) => translate(source, dictionary, params)
}

export type Translator = ReturnType<typeof createTranslator>

/** No-op translator; the shape tests and non-localised code paths can share. */
export const identity = createTranslator(undefined)

export type { Language }
