/**
 * Which languages the TUI can render its own interface in.
 *
 * Adding a language is two steps, and neither touches an existing component:
 *   1. add an entry here, with the name shown *in that language* (never translated), and
 *   2. add `src/i18n/<code>.ts` holding the dictionary, then register it in `src/i18n/index.ts`.
 *
 * Unknown codes fall back to English, so a dictionary that lags behind upstream only loses
 * coverage; it never breaks the interface.
 */
export const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "ko", label: "한국어" },
] as const

export type Language = (typeof LANGUAGES)[number]["code"]

export const DEFAULT_LANGUAGE: Language = "en"

const codes: ReadonlySet<string> = new Set(LANGUAGES.map((language) => language.code))

/**
 * Environment variables read, in order, when the config does not name a language. The terminal
 * locale is only a hint: `LANG` is often inherited from a shell the user never configured.
 */
const environmentKeys = ["OPENCODE_TUI_LANGUAGE", "LC_ALL", "LC_MESSAGES", "LANG"] as const

/** `"ko-KR"`, `"ko_KR.UTF-8"` and `"KO"` all become `"ko"`; an unsupported locale becomes `undefined`. */
export function normalizeLanguage(value: string | undefined): Language | undefined {
  const code = value
    ?.trim()
    .toLowerCase()
    .split(/[._@-]/)[0]
  if (!code) return
  return codes.has(code) ? (code as Language) : undefined
}

/**
 * Resolves the display language. An explicitly configured language wins over the environment, and
 * the environment wins over English, so an unset config on an English machine stays English.
 */
export function detectLanguage(
  configured?: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Language {
  const explicit = normalizeLanguage(configured)
  if (explicit) return explicit

  for (const key of environmentKeys) {
    const normalized = normalizeLanguage(environment[key])
    if (normalized) return normalized
  }

  return DEFAULT_LANGUAGE
}

export function isSupported(language: string): language is Language {
  return codes.has(language)
}
