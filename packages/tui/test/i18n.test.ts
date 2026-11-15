import { expect, test, describe, beforeEach } from "bun:test"
import { dict } from "../src/i18n/ko"
import { LANGUAGES, detectLanguage, normalizeLanguage } from "../src/i18n/language"
import { interpolate, translate } from "../src/i18n/translate"
import { currentLanguage, hasTranslation, setLanguage, t } from "../src/i18n"

const placeholders = (value: string) => [...value.matchAll(/{{\s*([A-Za-z0-9_$.-]+)\s*}}/g)].map((match) => match[1]!)

describe("language resolution", () => {
  test("normalizes locale tags to a language code", () => {
    expect(normalizeLanguage("ko")).toBe("ko")
    expect(normalizeLanguage("ko-KR")).toBe("ko")
    expect(normalizeLanguage("ko_KR.UTF-8")).toBe("ko")
    expect(normalizeLanguage("KO")).toBe("ko")
    expect(normalizeLanguage(" en_US ")).toBe("en")
  })

  test("reports unsupported locales instead of guessing", () => {
    expect(normalizeLanguage("de-DE")).toBeUndefined()
    expect(normalizeLanguage("")).toBeUndefined()
    expect(normalizeLanguage(undefined)).toBeUndefined()
  })

  test("prefers the configured language over the environment", () => {
    expect(detectLanguage("ko", { LANG: "en_US.UTF-8" })).toBe("ko")
    expect(detectLanguage(undefined, { LANG: "ko_KR.UTF-8" })).toBe("ko")
    expect(detectLanguage(undefined, { LC_ALL: "ko_KR.UTF-8" })).toBe("ko")
    expect(detectLanguage(undefined, { OPENCODE_TUI_LANGUAGE: "ko" })).toBe("ko")
  })

  test("falls back to English", () => {
    expect(detectLanguage(undefined, {})).toBe("en")
    expect(detectLanguage("xx", { LANG: "de_DE.UTF-8" })).toBe("en")
    // A configured language wins even when the environment would resolve to something else.
    expect(detectLanguage("en", { LANG: "ko_KR.UTF-8" })).toBe("en")
  })
})

describe("translation", () => {
  test("translates a known string and passes unknown ones through", () => {
    expect(translate("New session", dict)).toBe("새 세션")
    expect(translate("claude-sonnet-4-5", dict)).toBe("claude-sonnet-4-5")
    expect(translate("", dict)).toBe("")
  })

  test("an English dictionary is a no-op, so the source text stays the fallback", () => {
    expect(translate("New session", undefined)).toBe("New session")
  })

  test("fills placeholders and drops missing ones", () => {
    expect(interpolate("+{{count}} more", { count: 3 })).toBe("+3 more")
    expect(interpolate("{{a}}/{{b}}", { a: "x" })).toBe("x/")
    expect(interpolate("no placeholders", { a: 1 })).toBe("no placeholders")
  })

  test("translates a templated key before interpolating", () => {
    expect(translate("+{{count}} more", dict, { count: 2 })).toBe("+2개 더")
  })

  test("does not treat inherited object keys as translations", () => {
    expect(translate("toString", dict)).toBe("toString")
    expect(translate("constructor", dict)).toBe("constructor")
  })
})

describe("korean dictionary", () => {
  test("has no empty, padded or duplicated-by-accident values", () => {
    for (const [key, value] of Object.entries(dict)) {
      expect(value.trim(), key).toBe(value)
      expect(value.length, key).toBeGreaterThan(0)
      expect(key.trim(), key).toBe(key)
    }
  })

  test("introduces no placeholder the source string does not have", () => {
    for (const [key, value] of Object.entries(dict)) {
      const known = placeholders(key)
      for (const name of placeholders(value)) expect(known, `${key} -> ${value}`).toContain(name)
    }
  })

  test("keeps the language picker labels untranslated", () => {
    for (const language of LANGUAGES) expect(Object.hasOwn(dict, language.label)).toBe(false)
  })

  // A permission prompt the user cannot read is a safety problem, not a cosmetic gap, so these are
  // pinned: rewording one upstream makes the coverage script report it instead of silently dropping it.
  test("covers the permission flow", () => {
    for (const source of [
      "Permission required",
      "Allow once",
      "Always allow",
      "Reject",
      "Confirm",
      "Cancel",
      "Reject permission",
      "Tell OpenCode what to do differently",
      "No diff provided",
      "Patterns",
    ])
      expect(Object.hasOwn(dict, source), source).toBe(true)
  })

  // The settings dialog is where a user picks a subscription and turns high-speed output on, so a
  // missing entry would leave them reading English in the middle of a Korean screen.
  test("covers the ROKFOSS AI settings dialog", () => {
    for (const source of [
      "ROKFOSS AI settings",
      "Subscription",
      "Options",
      "High-speed output",
      "Applies to codex and xai models only.",
      "High-speed output enabled",
      "High-speed output disabled",
      "Using subscription {{label}}",
      "on",
      "off",
      "No subscriptions available",
      "Connect a ROKFOSS AI key first.",
      "Run /connect and add ROKFOSS AI.",
      "Loading ROKFOSS AI settings…",
      "Could not load ROKFOSS AI settings.",
    ])
      expect(Object.hasOwn(dict, source), source).toBe(true)
  })
})

describe("active language", () => {
  beforeEach(() => setLanguage("en"))

  test("t() follows the active language", () => {
    expect(t("New session")).toBe("New session")
    setLanguage("ko")
    expect(currentLanguage()).toBe("ko")
    expect(t("New session")).toBe("새 세션")
    expect(hasTranslation("New session")).toBe(true)
    expect(hasTranslation("claude-sonnet-4-5")).toBe(false)
  })

  test("accepts locale tags and falls back to English for unknown values", () => {
    expect(setLanguage("ko-KR")).toBe("ko")
    expect(setLanguage("de-DE")).toBe("en")
    expect(setLanguage(undefined)).toBe("en")
  })
})
