export * as SessionMirror from "./mirror.js"

import { Effect } from "effect"
import { Agent } from "@opencode/schema/agent"
import type { Model } from "@opencode/schema/model"
import { Money } from "@opencode/schema/money"
import { UserPayload } from "@opencode/schema/session-inbox"
import type { Bus } from "../bus.js"
import { BusyError, type NotFoundError } from "./error.js"
import { SessionEvent } from "./event.js"
import { SessionInbox } from "./inbox.js"
import { SessionMessage } from "./message.js"
import type { SessionSchema } from "./schema.js"

/**
 * Shows a turn that happened somewhere else — a user line and an answer written by another client of the same
 * conversation — as this Session's own messages, without running a model.
 *
 * A mirrored turn publishes the same events the runner publishes for its own work (inbox admission and delivery for
 * the user line; step, text and reasoning events for the answer), so every client draws it exactly like a local turn.
 * It never publishes `session.execution.*`, never wakes the execution and never runs the `prompt` hook, so nothing
 * that reacts to a local turn (a relay, a title, a continuation) starts because of it.
 */

export type UserInput = {
  readonly sessionID: SessionSchema.ID
  readonly text: string
  /** Who wrote the line, when it was not the person using this Session. Shown before the text. */
  readonly author?: string
  readonly metadata?: Record<string, unknown>
}

export type AnswerInput = {
  readonly sessionID: SessionSchema.ID
  readonly model: Model.Ref
  /** Defaults to the Session's selected agent, then `build`. */
  readonly agent?: Agent.ID
  readonly metadata?: Record<string, unknown>
}

export type AnswerEnd = {
  /** The saved answer. Replaces what the deltas built, so the message ends exactly as it was stored. */
  readonly text?: string
  /** The saved reasoning. Replaces what the reasoning deltas built. */
  readonly reasoning?: string
  /** The answer failed or was stopped elsewhere; the message ends as a failed step with this message. */
  readonly error?: string
}

export interface Answer {
  readonly messageID: SessionMessage.ID
  readonly text: (delta: string) => Effect.Effect<void>
  readonly reasoning: (delta: string) => Effect.Effect<void>
  /** Idempotent: only the first call ends the message. */
  readonly end: (input?: AnswerEnd) => Effect.Effect<void>
}

export interface Interface {
  readonly user: (input: UserInput) => Effect.Effect<SessionMessage.ID, NotFoundError | BusyError>
  readonly answer: (input: AnswerInput) => Effect.Effect<Answer, NotFoundError | BusyError>
}

const noTokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

export function make(input: {
  readonly bus: Pick<Bus.Interface, "publish">
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<SessionSchema.Info, NotFoundError>
  readonly isActive: (sessionID: SessionSchema.ID) => Effect.Effect<boolean>
}): Interface {
  const bus = input.bus
  // A local turn or a staged revert owns the transcript's tail; a mirrored turn waits until it is settled.
  const idle = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
    const session = yield* input.get(sessionID)
    if (session.revert || (yield* input.isActive(sessionID))) return yield* new BusyError({ sessionID })
    return session
  })

  const user = Effect.fn("SessionMirror.user")(function* (request: UserInput) {
    yield* idle(request.sessionID)
    const id = SessionMessage.ID.create()
    const author = request.author?.trim()
    const text = author ? `${author}: ${request.text}` : request.text
    const metadata = { ...request.metadata, mirror: author ? { author } : {} }
    // Admission and delivery share the inbox lock, so a runner promoting input never sees the row in between.
    yield* SessionInbox.serialized(
      request.sessionID,
      Effect.gen(function* () {
        yield* bus.publish(SessionEvent.InboxEnqueued, {
          sessionID: request.sessionID,
          inboxID: id,
          item: { type: "user", payload: UserPayload.make({ text, metadata }), delivery: "queue" },
        })
        yield* bus.publish(SessionEvent.InboxDelivered, { sessionID: request.sessionID, inboxID: id })
      }),
    ).pipe(Effect.uninterruptible)
    return id
  })

  const answer = Effect.fn("SessionMirror.answer")(function* (request: AnswerInput) {
    const session = yield* idle(request.sessionID)
    const sessionID = request.sessionID
    const messageID = SessionMessage.ID.create()
    yield* bus.publish(
      SessionEvent.Step.Started,
      {
        sessionID,
        assistantMessageID: messageID,
        agent: request.agent ?? session.agent ?? Agent.ID.make("build"),
        model: request.model,
        started: Date.now(),
      },
      { metadata: { ...request.metadata, mirror: {} } },
    )
    // One text part and one reasoning part, each opened by its first delta, like the stored answer they end as.
    const blocks = {
      text: { open: false, value: "" },
      reasoning: { open: false, value: "" },
    }
    const state = { closed: false }
    const fragment = (kind: "text" | "reasoning", delta: string) =>
      Effect.gen(function* () {
        if (state.closed || delta === "") return
        const block = blocks[kind]
        const events = kind === "text" ? SessionEvent.Text : SessionEvent.Reasoning
        if (!block.open) {
          block.open = true
          yield* bus.publish(events.Started, { sessionID, assistantMessageID: messageID, ordinal: 0 })
        }
        block.value += delta
        yield* bus.publish(events.Delta, { sessionID, assistantMessageID: messageID, ordinal: 0, delta })
      }).pipe(Effect.uninterruptible)
    const settle = (kind: "text" | "reasoning", final: string | undefined) =>
      Effect.gen(function* () {
        const block = blocks[kind]
        const text = final ?? block.value
        if (!block.open && text.trim() === "") return
        const events = kind === "text" ? SessionEvent.Text : SessionEvent.Reasoning
        if (!block.open) yield* bus.publish(events.Started, { sessionID, assistantMessageID: messageID, ordinal: 0 })
        yield* bus.publish(events.Ended, { sessionID, assistantMessageID: messageID, ordinal: 0, text })
      })
    const end = (final: AnswerEnd = {}) =>
      Effect.gen(function* () {
        if (state.closed) return
        state.closed = true
        yield* settle("reasoning", final.reasoning)
        yield* settle("text", final.text)
        if (final.error !== undefined) {
          yield* bus.publish(SessionEvent.Step.Failed, {
            sessionID,
            assistantMessageID: messageID,
            error: { type: "mirror", message: final.error },
          })
          return
        }
        yield* bus.publish(SessionEvent.Step.Ended, {
          sessionID,
          assistantMessageID: messageID,
          finish: "stop",
          cost: Money.USD.zero,
          tokens: noTokens,
        })
      }).pipe(Effect.uninterruptible)
    return {
      messageID,
      text: (delta) => fragment("text", delta),
      reasoning: (delta) => fragment("reasoning", delta),
      end,
    } satisfies Answer
  })

  return { user, answer }
}
