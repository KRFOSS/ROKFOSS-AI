import { describe, expect, test } from "bun:test"
import type { SessionStatsInfo } from "@opencode/client"
import { statsMetrics, statsNumber } from "../src/feature-plugins/system/stats-data"
import { setLanguage, t } from "../src/i18n"

const stats: SessionStatsInfo = {
  range: { from: new Date(2026, 0, 1).getTime(), to: new Date(2026, 0, 8).getTime() },
  sessions: 12,
  subagents: 99,
  prompts: 24,
  steps: 50,
  activeDays: 2,
  streak: 2,
  tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } },
  cost: 0,
  tools: { mode: "none" },
  models: [],
  activity: [
    { date: "2026-01-01", steps: 1 },
    { date: "2026-01-02", steps: 50 },
  ],
}

describe("stats poster", () => {
  test("formats and translates metrics in Korean without changing English", () => {
    try {
      setLanguage("ko")
      expect([8400, 12345, 120_000_000].map(statsNumber)).toEqual(["8,400", "1.2만", "1.2억"])
      expect(["best streak", "active days", "sessions"].map((label) => t(label))).toEqual([
        "최장 연속 활동", "활동 일수", "세션",
      ])
      expect(t("No matching commands")).toBe("일치하는 명령이 없습니다")
      expect(t("{{count}} days", { count: "2" })).toBe("2일")
    } finally {
      setLanguage("en")
    }
    expect(statsNumber(5284)).toBe("5.3K")
  })

  test("includes all token categories and replaces subagents with tokens", () => {
    expect(statsMetrics(stats)).toEqual([
      { label: "tokens", value: 15 },
      { label: "best streak", value: 2 },
      { label: "active days", value: 2 },
      { label: "sessions", value: 12 },
    ])
    expect([0, 685, 5284, 9_200_000_000].map(statsNumber)).toEqual(["0", "685", "5.3K", "9.2B"])
  })
})
