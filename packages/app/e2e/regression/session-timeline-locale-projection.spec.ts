import { expect, test } from "@playwright/test"
import { assistantMessage, setupTimeline, toolPart, userMessage } from "../utils/timeline"

for (const locale of ["en", "ko"] as const) {
  test(`projects localized tool names with an English fallback in ${locale}`, async ({ page }) => {
    const ids = [`prt_locale_${locale}_01_read`, `prt_locale_${locale}_02_glob`]
    await setupTimeline(page, {
      messages: [
        userMessage(),
        assistantMessage([
          toolPart(ids[0]!, "read", "completed", { path: "src/a.ts" }),
          toolPart(ids[1]!, "glob", "completed", { path: ".", pattern: "**/*.ts" }),
        ]),
      ],
      locale,
    })

    const group = page.locator(`[data-timeline-part-ids="${ids.join(",")}"]`)
    const label = locale === "en" ? "Used 2 Read, Glob" : "2 읽기 및 Glob 사용됨"
    await expect(group.getByRole("button")).toHaveAccessibleName(label)
    await expect(group.locator('[data-component="context-tool-group-trigger"]')).toHaveAttribute("aria-label", label)
    await expect(page.locator("html")).toHaveAttribute("lang", locale)
  })
}
