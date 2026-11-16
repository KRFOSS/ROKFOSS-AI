import type { JsonValue } from "@opencode/client"
import type { RaiRooms } from "@opencode/schema/rai-rooms"
import { SessionMessage } from "@opencode/schema/session-message"

type ModelRef = { readonly id: string; readonly providerID: string; readonly variant?: string }

function timeOf(value: string | null) {
  if (!value) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * The model an imported answer is labeled with. The server records the provider and model it called; OpenCode reaches
 * the same model as `rai/<provider>/<model>`, so the label names a model this session can actually pick.
 */
export function importedModel(message: Pick<RaiRooms.Message, "provider" | "model">): ModelRef {
  const model = message.model?.trim()
  const provider = message.provider?.trim()
  if (!model) return { providerID: "rai", id: "unknown" }
  return { providerID: "rai", id: provider && !model.includes("/") ? `${provider}/${model}` : model }
}

/**
 * `session.import` input that makes a room's saved conversation the history of a new session: user lines become user
 * messages and answers become assistant messages with their reasoning, so the session view and the next model call
 * see the room as if it had been answered here. Tool lines are not imported.
 */
export function roomImport(input: {
  readonly sessionID: string
  readonly roomID: string
  readonly title: string
  readonly messages: ReadonlyArray<RaiRooms.Message>
  readonly agent: string
  readonly model?: ModelRef
  readonly projectID: string
  readonly directory: string
  readonly now: number
}) {
  const messages: JsonValue[] = []
  for (const message of input.messages) {
    const created = timeOf(message.createdAt) ?? input.now
    const metadata = { rai: { roomID: input.roomID, messageID: message.id } }
    if (message.role === "user") {
      if (message.text.trim() === "") continue
      messages.push({ id: SessionMessage.ID.create(), type: "user", text: message.text, time: { created }, metadata })
      continue
    }
    if (message.role !== "assistant") continue
    const content: JsonValue[] = []
    if (message.thinking && message.thinking.trim() !== "")
      content.push({ type: "reasoning", text: message.thinking, time: { created, completed: created } })
    if (message.text.trim() !== "") content.push({ type: "text", text: message.text })
    if (content.length === 0) continue
    const model = importedModel(message)
    messages.push({
      id: SessionMessage.ID.create(),
      type: "assistant",
      agent: input.agent,
      model: { id: model.id, providerID: model.providerID },
      content,
      time: { created, completed: created },
      metadata,
    })
  }
  return {
    info: {
      id: input.sessionID,
      projectID: input.projectID,
      agent: input.agent,
      ...(input.model ? { model: input.model } : {}),
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: input.now, updated: input.now },
      title: input.title,
      metadata: { rai: { roomID: input.roomID } },
      location: { directory: input.directory },
    },
    messages,
    location: { directory: input.directory },
  }
}

/** The newest server message number among `messages`, which catching up starts after. "0" for an empty room. */
export function newestRoomMessage(messages: ReadonlyArray<{ readonly id: string }>) {
  let newest = 0
  for (const message of messages) if (/^\d+$/.test(message.id)) newest = Math.max(newest, Number(message.id))
  return String(newest)
}
