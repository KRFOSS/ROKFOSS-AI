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
}).annotate({ identifier: "RaiTurns.BindInput" })
export interface BindInput extends Schema.Schema.Type<typeof BindInput> {}

export const SessionInput = Schema.Struct({ sessionID: Schema.String }).annotate({
  identifier: "RaiTurns.SessionInput",
})
export interface SessionInput extends Schema.Schema.Type<typeof SessionInput> {}

const standard = Schema.toStandardSchemaV1

export const Definition = Rpc.define({
  id: "opencode.rai.turns",
  methods: {
    bind: { input: standard(BindInput), output: standard(Bound) },
    unbind: { input: standard(SessionInput), output: standard(Bound) },
    bound: { input: standard(SessionInput), output: standard(Bound) },
  },
  events: {},
})
