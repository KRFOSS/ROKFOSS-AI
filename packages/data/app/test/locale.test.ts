import { describe, expect, test } from "bun:test"
import {
  detectFromAcceptLanguage,
  detectFromLanguages,
  localeFromRequest,
  parseLocale,
  route,
} from "../src/lib/locale"

describe("data site language selection", () => {
  test.each([
    [["ko-KR", "en-US"], "ko"],
    [["en-GB", "ko-KR"], "en"],
    [["fr-FR", "ko-KR"], "ko"],
    [["zh-TW", "ja-JP"], "en"],
  ] as const)("detects %p as %s", (languages, expected) => {
    expect(detectFromLanguages(languages)).toBe(expected)
  })

  test("ignores removed language preferences when selecting a supported language", () => {
    expect(parseLocale("fr")).toBeNull()
    expect(detectFromAcceptLanguage("fr-FR,ko-KR;q=0.8,en;q=0.5")).toBe("ko")
    expect(
      localeFromRequest(
        new Request("https://opencode.ai/data/", {
          headers: { cookie: "oc_locale=fr", "accept-language": "ko-KR" },
        }),
      ),
    ).toBe("ko")
  })

  test("uses the selected language for data and documentation links", () => {
    expect(route("en", "/data/")).toBe("/data/")
    expect(route("ko", "/data/")).toBe("/ko/data/")
    expect(route("ko", "/docs/config")).toBe("/docs/ko/config")
  })
})
