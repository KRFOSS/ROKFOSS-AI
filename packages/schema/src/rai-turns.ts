export * as RaiTurns from "./rai-turns.js"

import { Schema } from "effect"
import { Rpc } from "./rpc.js"

/**
 * Session binding for external response turns (spec 3.7). A bound session records each turn it answers locally into a
 * room; an unbound session sends nothing. Only the room number and its title are kept — never message text.
 */
export const Bound = Schema.Struct({
  roomID: Schema.NullOr(Schema.String),
  title: Schema.NullOr(Schema.String),
  /** Set when the room could not be bound; the text is the guidance to show. */
  error: Schema.NullOr(Schema.String),
}).annotate({ identifier: "RaiTurns.Bound" })
export interface Bound extends Schema.Schema.Type<typeof Bound> {}

export const BindInput = Schema.Struct({
  sessionID: Schema.String,
  roomID: Schema.String,
  title: Schema.String,
  /** The newest room message the session already holds. Catching up starts after it; absent means the newest now. */
  after: Schema.optional(Schema.String),
}).annotate({ identifier: "RaiTurns.BindInput" })
export interface BindInput extends Schema.Schema.Type<typeof BindInput> {}

export const SessionInput = Schema.Struct({ sessionID: Schema.String }).annotate({
  identifier: "RaiTurns.SessionInput",
})
export interface SessionInput extends Schema.Schema.Type<typeof SessionInput> {}

/** `sessionOf`: the session a room was opened in on this machine, while it is still bound to that room. */
export const RoomInput = Schema.Struct({ roomID: Schema.String }).annotate({ identifier: "RaiTurns.RoomInput" })
export interface RoomInput extends Schema.Schema.Type<typeof RoomInput> {}

export const SessionOf = Schema.Struct({ sessionID: Schema.NullOr(Schema.String) }).annotate({
  identifier: "RaiTurns.SessionOf",
})
export interface SessionOf extends Schema.Schema.Type<typeof SessionOf> {}

/**
 * `sync`: room messages written elsewhere (the web) since this session last caught up. The call returns once they are
 * found; they, and an answer the room is still making, are shown in the session in the background.
 */
export const Synced = Schema.Struct({
  added: Schema.Int,
  error: Schema.NullOr(Schema.String),
}).annotate({ identifier: "RaiTurns.Synced" })
export interface Synced extends Schema.Schema.Type<typeof Synced> {}

const standard = Schema.toStandardSchemaV1

export const Definition = Rpc.define({
  id: "opencode.rai.turns",
  methods: {
    bind: { input: standard(BindInput), output: standard(Bound) },
    unbind: { input: standard(SessionInput), output: standard(Bound) },
    bound: { input: standard(SessionInput), output: standard(Bound) },
    sessionOf: { input: standard(RoomInput), output: standard(SessionOf) },
    sync: { input: standard(SessionInput), output: standard(Synced) },
  },
  events: {},
})
