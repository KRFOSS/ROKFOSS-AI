import { describe, expect, test } from "bun:test"
import type { IntegrationInfo } from "@opencode/client"
import { integrationOptions } from "../src/component/dialog-integration"
import { sortModelOptions } from "../src/component/model-options"

// ROKFOSS AI is what a user of this fork opens either picker for, so its rank is pinned here. The
// option objects carry only the fields the comparators read (`providerID`/`providerName`/`free` for
// the model list, `id`/`name` for the integration list).

type ModelOption = {
  providerID: string
  providerName: string
  modelID: string
  free?: boolean
}

const model = (providerID: string, providerName: string, modelID: string): ModelOption => ({
  providerID,
  providerName,
  modelID,
})

// Deliberately listed so that neither the input order nor the names could put ROKFOSS AI first: it
// arrives last, and "ROKFOSS AI" sorts after every other provider name here.
const models: ModelOption[] = [
  model("anthropic", "Anthropic", "claude-opus-4"),
  model("openai", "OpenAI", "gpt-5"),
  model("opencode", "OpenCode Zen", "claude-sonnet-4"),
  model("google", "Google", "gemini-2.5-pro"),
  model("opencode-go", "OpenCode Go", "kimi-k3"),
  model("rai", "ROKFOSS AI", "codex/gpt-6.1-sol"),
]

const ids = (options: readonly ModelOption[]) => options.map((option) => option.modelID)

const integration = (value: Partial<IntegrationInfo> & Pick<IntegrationInfo, "id" | "name">): IntegrationInfo => ({
  methods: [],
  connections: [],
  ...value,
})

describe("sortModelOptions", () => {
  test("moves the ROKFOSS AI models to the top and keeps the other providers' order", () => {
    const sorted = sortModelOptions([...models])

    expect(sorted[0]?.providerID).toBe("rai")
    expect(ids(sorted)).toEqual([
      "codex/gpt-6.1-sol",
      "kimi-k3",
      "claude-sonnet-4",
      "claude-opus-4",
      "gemini-2.5-pro",
      "gpt-5",
    ])
    // Without rai the rest keeps exactly the order it had before the fork's provider was added:
    // opencode-go, then opencode, then the remaining providers by name.
    expect(ids(sorted.slice(1))).toEqual(
      ids(sortModelOptions(models.filter((option) => option.providerID !== "rai"))),
    )
  })

  test("keeps the given order when grouping is off, so the ungrouped mode is unchanged", () => {
    const input = [...models]
    const sorted = sortModelOptions(input, false)

    expect(ids(sorted)).toEqual(ids(input))
    // Ungrouped results start with whatever the server sent, not with rai.
    expect(sorted[0]?.providerID).toBe("anthropic")
    // The same list grouped is what pulls rai forward, so the difference is grouping alone.
    expect(sortModelOptions(input)[0]?.providerID).toBe("rai")
  })
})

describe("integrationOptions", () => {
  test("places the ROKFOSS AI integration ahead of opencode, openai and anthropic", () => {
    const sorted = integrationOptions([
      integration({ id: "anthropic", name: "Anthropic" }),
      integration({ id: "openai", name: "OpenAI" }),
      integration({ id: "opencode", name: "OpenCode Zen" }),
      integration({ id: "rai", name: "ROKFOSS AI" }),
    ])

    // Alphabetically this would be Anthropic, OpenAI, OpenCode Zen, ROKFOSS AI, so the leading
    // position can only come from the priority table.
    expect(sorted.map((item) => item.id)).toEqual(["rai", "opencode", "openai", "anthropic"])
  })
})
