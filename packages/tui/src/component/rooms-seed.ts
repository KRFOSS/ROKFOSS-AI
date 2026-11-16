import { RaiRooms } from "@opencode/schema/rai-rooms"

/** A model the TUI can select, reduced to the fields a room seed needs. */
export interface ModelRef {
  readonly providerID: string
  readonly modelID: string
}

export interface RoomSeed {
  readonly provider: RaiRooms.Provider
  readonly model: string
}

/** Room provider used only when neither the chosen model nor the gateway model list can name one. */
const fallback: RoomSeed = { provider: "xai", model: "" }

/**
 * Splits a gateway model id (`opencode/opencode-go/glm-5`) at its **first** slash: the part before it is the
 * provider the gateway routes to, everything after it is the upstream model name (spec 3.4).
 */
export function splitModel(modelID: string | undefined): RoomSeed | undefined {
  if (!modelID) return undefined
  const slash = modelID.indexOf("/")
  if (slash <= 0) return undefined
  const provider = modelID.slice(0, slash)
  const model = modelID.slice(slash + 1)
  if (!RaiRooms.isProvider(provider) || model.trim() === "") return undefined
  return { provider, model }
}

/**
 * The room model to start from, given the model the user picked for ordinary chat and the models the
 * gateway offers.
 *
 * A gateway model (`rai` provider) is used as-is. A model from one of the local providers is matched to
 * the gateway's own entry for the same upstream model, because the room is answered by the gateway and
 * cannot call a local provider: `opencode-go/deepseek-v4.1-flash` (local) and
 * `opencode/opencode-go/deepseek-v4.1-flash` (gateway) are the same model, and picking the local one must
 * not silently leave the room on an unrelated default.
 */
export function roomSeed(current: ModelRef | undefined, gateway: readonly ModelRef[]): RoomSeed {
  // A gateway model (`rai/xai/grok-4.7`) names its routed provider inside the model id. Checking only
  // `isProvider(providerID)` missed it, so every gateway pick fell through to the first listed model.
  const direct =
    current && (current.providerID === "rai" || RaiRooms.isProvider(current.providerID))
      ? splitModel(current.modelID)
      : undefined
  if (direct) return direct

  if (current) {
    const exact = `${current.providerID}/${current.modelID}`
    const match =
      gateway.find((item) => item.providerID === "rai" && item.modelID === exact) ??
      gateway.find((item) => item.providerID === "rai" && item.modelID.endsWith(`/${current.modelID}`))
    const mapped = match && splitModel(match.modelID)
    if (mapped) return mapped
  }

  // Nothing to seed from: start on a model the gateway actually lists instead of a provider that may be
  // absent for this account.
  const first = gateway.find((item) => item.providerID === "rai")
  return (first && splitModel(first.modelID)) ?? fallback
}

/**
 * Who answers a room turn for the model the user picked. The gateway (`POST /chat`) answers only its own
 * `rai` models; any other provider — a free OpenCode model included — answers on this computer and the
 * room only records the turn through a bound session (spec 3.7). Mirrors `relayable` in `rai-turns.ts`.
 */
export function answersLocally(current: ModelRef | undefined): boolean {
  return current !== undefined && current.providerID.trim().toLowerCase() !== "rai"
}
