import { currentLanguage } from "../i18n"
import { stringWidth } from "./string-width"

export function titlecase(str: string) {
  return str.replace(/\b\w/g, (c) => c.toUpperCase())
}

export function time(input: number): string {
  const date = new Date(input)
  return date.toLocaleTimeString(undefined, { timeStyle: "short" })
}

export function datetime(input: number): string {
  const date = new Date(input)
  const localTime = time(input)
  const localDate = date.toLocaleDateString()
  return `${localTime} · ${localDate}`
}

/**
 * Korean counts step by ten thousand rather than by thousand, so the English "K" shorthand reads as a
 * foreign unit next to Korean labels: 8,400 is written out, 12,345 is "1.2만", 120,000,000 is "1.2억".
 */
const KOREAN_SCALES = [
  { unit: "조", size: 1_000_000_000_000 },
  { unit: "억", size: 100_000_000 },
  { unit: "만", size: 10_000 },
] as const

export function number(num: number): string {
  if (currentLanguage() === "ko") {
    // Nobody writes 천 as a shorthand below 만, so small counts keep grouped digits.
    if (num < 10_000) return num.toLocaleString("ko-KR")
    const scale = KOREAN_SCALES.find((item) => num >= item.size)
    if (!scale) return num.toLocaleString("ko-KR")
    const value = num / scale.size
    // One decimal keeps a footer short; past a hundred the fraction is noise and the text too wide.
    const rounded = value < 100 ? value.toFixed(1).replace(/\.0$/, "") : String(Math.round(value))
    return rounded + scale.unit
  }
  // 999950+ would round to "1000.0K"
  if (num >= 999950) {
    return (num / 1000000).toFixed(1) + "M"
  } else if (num >= 1000) {
    return (num / 1000).toFixed(1) + "K"
  }
  return num.toString()
}

import { duration } from "@opencode/util/duration"
export { duration }

/** Localized compact elapsed time for session activity headers. */
export function localizedDuration(input: number): string {
  const value = duration(input)
  if (currentLanguage() !== "ko") return value
  const units: Record<string, string> = { ms: "밀리초", s: "초", m: "분", h: "시간", d: "일" }
  return value.replace(/(ms|s|m|h|d)\b/g, (unit) => units[unit] ?? unit)
}

export function truncate(str: string, len: number): string {
  if (str.length <= len) return str
  return str.slice(0, len - 1) + "…"
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })

export function graphemes(str: string) {
  return Array.from(graphemeSegmenter.segment(str), (item) => item.segment)
}

export function takeWidth(str: string, width: number) {
  if (width <= 0) return ""
  if (stringWidth(str) <= width) return str

  const result: string[] = []
  let used = 0
  for (const segment of graphemes(str)) {
    const next = stringWidth(segment)
    if (used + next > width) break
    result.push(segment)
    used += next
  }
  return result.join("")
}

export function truncateWidth(str: string, width: number): string {
  if (width <= 0) return ""
  if (stringWidth(str) <= width) return str
  if (width === 1) return "…"
  return takeWidth(str, width - 1) + "…"
}

export function truncateLeft(str: string, len: number): string {
  if (str.length <= len) return str
  return "…" + str.slice(-(len - 1))
}

export function truncateMiddle(str: string, maxLength: number = 35): string {
  if (maxLength <= 0) return ""
  if (str.length <= maxLength) return str

  const ellipsis = "…"
  const keepStart = Math.ceil((maxLength - ellipsis.length) / 2)
  const keepEnd = Math.floor((maxLength - ellipsis.length) / 2)
  if (keepEnd <= 0) return str.slice(0, keepStart) + ellipsis

  return str.slice(0, keepStart) + ellipsis + str.slice(-keepEnd)
}

export * as Locale from "./locale"
