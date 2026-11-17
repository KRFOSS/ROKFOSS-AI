import { expect, test } from "bun:test"
import { currentLanguage, setLanguage } from "../../src/i18n"
import { uiText } from "../../src/i18n/ui"
import { Locale } from "../../src/util/locale"

test("session rows and tool summaries follow the interface language", () => {
  // These labels come from @opencode/session-ui, which reads the UI dictionary; before the terminal app
  // provided that context they stayed English next to Korean text ("Explored", "Thought").
  const previous = currentLanguage()
  try {
    setLanguage("ko")
    expect(uiText("ui.sessionTurn.status.gatheredContext")).toBe("탐색 완료")
    setLanguage("en")
    expect(uiText("ui.sessionTurn.status.gatheredContext")).toBe("Explored")
  } finally {
    setLanguage(previous)
  }
})

test("uses Korean count units when the interface is Korean", () => {
  // Korean steps by ten thousand, so an English "K" next to Korean labels reads as a foreign unit.
  const previous = currentLanguage()
  try {
    setLanguage("ko")
    expect(Locale.number(8400)).toBe("8,400")
    expect(Locale.number(9999)).toBe("9,999")
    expect(Locale.number(10_000)).toBe("1만")
    expect(Locale.number(12_345)).toBe("1.2만")
    expect(Locale.number(120_000_000)).toBe("1.2억")
    expect(Locale.number(2_500_000_000_000)).toBe("2.5조")
  } finally {
    setLanguage(previous)
  }
})

test("keeps the English compact form for other languages", () => {
  const previous = currentLanguage()
  try {
    setLanguage("en")
    expect(Locale.number(8400)).toBe("8.4K")
  } finally {
    setLanguage(previous)
  }
})

test("formats times and dates in the active interface language", () => {
  const previous = currentLanguage()
  const at = new Date(2026, 10, 18, 9, 16).getTime()
  try {
    setLanguage("ko")
    expect(Locale.time(at)).toBe("오전 9:16")
    expect(Locale.datetime(at)).toBe("오전 9:16 · 2026. 11. 18.")
    setLanguage("en")
    expect(Locale.time(at)).toBe("9:16 AM")
    expect(Locale.datetime(at)).toBe("9:16 AM · 11/18/2026")
  } finally {
    setLanguage(previous)
  }
})

test("truncates text from the right by terminal width", () => {
  expect(Locale.truncateWidth("abcdefgh", 5)).toBe("abcd…")
  expect(Locale.truncateWidth("ab界cd", 5)).toBe("ab界…")
  expect(Locale.truncateWidth("abcdefgh", 1)).toBe("…")
  expect(Locale.truncateWidth("abcdefgh", 0)).toBe("")
})

test("takes whole graphemes within terminal width", () => {
  expect(Locale.takeWidth("ab界cd", 4)).toBe("ab界")
  expect(Locale.graphemes("a👨‍👩‍👧‍👦b")).toEqual(["a", "👨‍👩‍👧‍👦", "b"])
})

test("rolls the compact form over at the rounding boundary", () => {
  expect(Locale.number(999949)).toBe("999.9K")
  expect(Locale.number(999950)).toBe("1.0M")
  expect(Locale.number(1000000)).toBe("1.0M")
})

test("truncates text in the middle without overflowing small widths", () => {
  expect(Locale.truncateMiddle("abcdefghij", 0)).toBe("")
  expect(Locale.truncateMiddle("abcdefghij", 1)).toBe("…")
  expect(Locale.truncateMiddle("abcdefghij", 2)).toBe("a…")
  expect(Locale.truncateMiddle("abcdefghij", 3)).toBe("a…j")
  expect(Locale.truncateMiddle("abcdefghij", 4)).toBe("ab…j")
  expect(Locale.truncateMiddle("abcdefghij", 9)).toBe("abcd…ghij")
  expect(Locale.truncateMiddle("abcd", 4)).toBe("abcd")
  expect(Locale.truncateMiddle("abcd", 10)).toBe("abcd")
  expect(Locale.truncateMiddle("a", 1)).toBe("a")
})
