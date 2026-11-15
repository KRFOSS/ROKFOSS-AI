export * as Rai from "./rai.js"

import { Schema } from "effect"
import { Rpc } from "./rpc.js"

/**
 * One `GET /credentials` entry: a subscription the signed-in account may spend from. `ownerID` 0 is the account's own
 * quota and is always listed; shared entries appear only while the owner actually shares a connected provider.
 */
export const Credential = Schema.Struct({
  ownerID: Schema.Int,
  label: Schema.String,
  providers: Schema.Array(Schema.String),
}).annotate({ identifier: "Rai.Credential" })
export interface Credential extends Schema.Schema.Type<typeof Credential> {}

/**
 * One reasoning step the plugin checked against the gateway. The gateway advertises steps the upstream may still
 * reject (live: `ultra` on every codex model), so a step is offered only after it answered `200` once.
 */
export const Effort = Schema.Struct({
  modelID: Schema.String,
  effort: Schema.String,
  supported: Schema.Boolean,
}).annotate({ identifier: "Rai.Effort" })
export interface Effort extends Schema.Schema.Type<typeof Effort> {}

/**
 * Everything the settings dialog shows. `ownerID` is the subscription the user picked (0 is their own, absent means
 * "whatever the config file says"), `fast` is high-speed output, and `error` carries the gateway's own message when the
 * subscription list could not be read.
 */
export const Settings = Schema.Struct({
  connected: Schema.Boolean,
  ownerID: Schema.NullOr(Schema.Int),
  fast: Schema.Boolean,
  credentials: Schema.Array(Credential),
  efforts: Schema.Array(Effort),
  error: Schema.NullOr(Schema.String),
}).annotate({ identifier: "Rai.Settings" })
export interface Settings extends Schema.Schema.Type<typeof Settings> {}

/**
 * The RAI plugin's RPC, which is how a client shows and changes the subscription and high-speed output without editing
 * the config file. Every method answers the full settings snapshot, so a dialog renders from one reply.
 */
export const Definition = Rpc.define({
  id: "opencode.rai",
  methods: {
    /** The last snapshot, without touching the gateway. */
    state: {
      input: Schema.toStandardSchemaV1(Schema.Struct({})),
      output: Schema.toStandardSchemaV1(Settings),
    },
    /** Re-reads `/credentials` and `/models` with the saved key, then answers the new snapshot. */
    refresh: {
      input: Schema.toStandardSchemaV1(Schema.Struct({})),
      output: Schema.toStandardSchemaV1(Settings),
    },
    /** Uses one subscription (`null` returns to the config file's choice) for every later request. */
    select: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ ownerID: Schema.NullOr(Schema.Int) })),
      output: Schema.toStandardSchemaV1(Settings),
    },
    /** Enables or disables high-speed output (`service_tier: "priority"`). */
    setFast: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ enabled: Schema.Boolean })),
      output: Schema.toStandardSchemaV1(Settings),
    },
    /** Forgets what was learned about advertised reasoning steps and checks them again. */
    verify: {
      input: Schema.toStandardSchemaV1(Schema.Struct({})),
      output: Schema.toStandardSchemaV1(Settings),
    },
  },
  events: {},
})
