import { describe, expect, test } from "bun:test"
import { answersLocally, roomSeed, splitModel, type ModelRef } from "../src/component/rooms-seed"

// The gateway lists its models as `<routed provider>/<upstream model>` (spec 3.4), while the local
// providers name the same model without that prefix. A room is answered by the gateway, so the local
// name has to resolve to the gateway entry for the same upstream model instead of a default.

const gatewayModel = (modelID: string): ModelRef => ({ providerID: "rai", modelID })
const localModel = (providerID: string, modelID: string): ModelRef => ({ providerID, modelID })

const gateway: ModelRef[] = [
  gatewayModel("codex/gpt-6.1-sol"),
  gatewayModel("xai/grok-4.7"),
  gatewayModel("opencode/opencode-go/deepseek-v4.1-flash"),
  gatewayModel("groq/openai/gpt-oss-120b"),
]

describe("splitModel", () => {
  test("splits a gateway id at its first slash only", () => {
    expect(splitModel("opencode/opencode-go/glm-5")).toEqual({ provider: "opencode", model: "opencode-go/glm-5" })
    expect(splitModel("groq/openai/gpt-oss-120b")).toEqual({ provider: "groq", model: "openai/gpt-oss-120b" })
    expect(splitModel("xai/grok-4.7")).toEqual({ provider: "xai", model: "grok-4.7" })
  })

  test("refuses a model without a routed provider", () => {
    expect(splitModel(undefined)).toBeUndefined()
    expect(splitModel("")).toBeUndefined()
    expect(splitModel("grok-4.7")).toBeUndefined()
    expect(splitModel("ollama/llama3")).toEqual({ provider: "ollama", model: "llama3" })
    expect(splitModel("unknown/xyz")).toBeUndefined()
    expect(splitModel("xai/")).toBeUndefined()
  })
})

describe("roomSeed", () => {
  test("uses the gateway model the user already picked", () => {
    expect(roomSeed(localModel("rai", "codex/gpt-6.1-sol"), gateway)).toEqual({
      provider: "codex",
      model: "gpt-6.1-sol",
    })
  })

  // A gateway pick that is not the first listed model used to fall through to that first model.
  test("keeps any gateway model the user picked, not just the first listed one", () => {
    expect(roomSeed(gatewayModel("xai/grok-4.7"), gateway)).toEqual({ provider: "xai", model: "grok-4.7" })
    expect(roomSeed(gatewayModel("opencode/opencode-go/deepseek-v4.1-flash"), gateway)).toEqual({
      provider: "opencode",
      model: "opencode-go/deepseek-v4.1-flash",
    })
  })

  // The reported bug: picking the OpenCode free model left a new room on the hardcoded `xai` default.
  test("maps a local provider model to the gateway's entry for the same upstream model", () => {
    expect(roomSeed(localModel("opencode", "opencode-go/deepseek-v4.1-flash"), gateway)).toEqual({
      provider: "opencode",
      model: "opencode-go/deepseek-v4.1-flash",
    })
  })

  test("maps by upstream model name when the provider ids differ", () => {
    // A local provider keeps the upstream id; the gateway routes the same model under its own provider.
    expect(roomSeed(localModel("opencode-go", "deepseek-v4.1-flash"), gateway)).toEqual({
      provider: "opencode",
      model: "opencode-go/deepseek-v4.1-flash",
    })
  })

  test("starts on a listed gateway model when nothing was picked", () => {
    expect(roomSeed(undefined, gateway)).toEqual({ provider: "codex", model: "gpt-6.1-sol" })
  })

  test("falls back only when the gateway listed no model at all", () => {
    expect(roomSeed(localModel("opencode", "unknown-model"), [])).toEqual({ provider: "xai", model: "" })
    // A local model the gateway does not offer does not silently pick that provider.
    expect(roomSeed(localModel("opencode", "unknown-model"), gateway)).toEqual({
      provider: "codex",
      model: "gpt-6.1-sol",
    })
  })
})

// Who answers a room turn (spec 3.7): only a gateway model goes through `POST /chat`; anything else — a free
// OpenCode model included — answers on this computer and is recorded through a bound session.
describe("answersLocally", () => {
  test("a gateway model is answered by the gateway", () => {
    expect(answersLocally(gatewayModel("opencode/opencode-go/deepseek-v4.1-flash"))).toBe(false)
    expect(answersLocally({ providerID: " RAI ", modelID: "xai/grok-4.7" })).toBe(false)
  })

  test("a free OpenCode model or any other provider answers on this computer", () => {
    expect(answersLocally(localModel("opencode", "deepseek-v4.1-flash-free"))).toBe(true)
    expect(answersLocally(localModel("opencode-go", "deepseek-v4.1-flash"))).toBe(true)
    expect(answersLocally(localModel("anthropic", "claude-sonnet-5-5"))).toBe(true)
  })

  test("nothing picked is not a local answer", () => {
    expect(answersLocally(undefined)).toBe(false)
  })
})
