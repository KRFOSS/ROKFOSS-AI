import type { SessionStatsInfo } from "@opencode/client"
import { TokenUsage } from "@opencode/schema/token-usage"
import { currentLanguage } from "../../i18n"
import { number } from "../../util/locale"

export function statsMetrics(stats: SessionStatsInfo) {
  return [
    {
      label: "tokens",
      value: TokenUsage.total(stats.tokens),
    },
    { label: "best streak", value: stats.streak },
    { label: "active days", value: stats.activeDays },
    { label: "sessions", value: stats.sessions },
  ]
}

export function statsNumber(value: number) {
  if (currentLanguage() === "ko") return number(value)
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value)
}
