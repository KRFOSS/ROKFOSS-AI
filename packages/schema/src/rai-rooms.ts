export * as RaiRooms from "./rai-rooms.js"

import { Schema } from "effect"
import { Rpc } from "./rpc.js"

/** Providers a room continuation may name. The gateway rejects anything else. */
export const providers = ["codex", "xai", "opencode", "groq", "ollama"] as const
export type Provider = (typeof providers)[number]

export function isProvider(value: string): value is Provider {
  return (providers as readonly string[]).includes(value)
}

/** `read` may list and follow a room, but must not POST /chat. Missing access is left to the server. */
export function canSend(access: string | null | undefined) {
  return access !== "read"
}

/**
 * Room text is remote data. Strip terminal controls so a title or message cannot change the cursor, open a link, or
 * hide characters. The result stays in memory; callers must not write it to a file or a log.
 */
export function displayText(value: string, max = 8_000) {
  const stripped = value
    .replace(/\u001B\][\s\S]*?(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001B[@-_]/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
  if (stripped.length <= max) return stripped
  return `${stripped.slice(0, max)}…`
}

export const Project = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
}).annotate({ identifier: "RaiRooms.Project" })
export interface Project extends Schema.Schema.Type<typeof Project> {}

export const Room = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  projectID: Schema.NullOr(Schema.String),
  provider: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  updatedAt: Schema.NullOr(Schema.String),
  running: Schema.Boolean,
  sharedBy: Schema.NullOr(Schema.String),
  perm: Schema.NullOr(Schema.String),
}).annotate({ identifier: "RaiRooms.Room" })
export interface Room extends Schema.Schema.Type<typeof Room> {}

export const Message = Schema.Struct({
  id: Schema.String,
  role: Schema.String,
  text: Schema.String,
  createdAt: Schema.NullOr(Schema.String),
}).annotate({ identifier: "RaiRooms.Message" })
export interface Message extends Schema.Schema.Type<typeof Message> {}

export const Access = Schema.NullOr(Schema.Literals(["owner", "write", "read"]))

export const ProjectsResult = Schema.Struct({
  projects: Schema.Array(Project),
  error: Schema.NullOr(Schema.String),
}).annotate({ identifier: "RaiRooms.ProjectsResult" })
export interface ProjectsResult extends Schema.Schema.Type<typeof ProjectsResult> {}

export const RoomsResult = Schema.Struct({
  rooms: Schema.Array(Room),
  error: Schema.NullOr(Schema.String),
}).annotate({ identifier: "RaiRooms.RoomsResult" })
export interface RoomsResult extends Schema.Schema.Type<typeof RoomsResult> {}

export const Page = Schema.Struct({
  messages: Schema.Array(Message),
  hasMore: Schema.Boolean,
  oldestID: Schema.NullOr(Schema.String),
  access: Access,
  owner: Schema.NullOr(Schema.String),
  me: Schema.NullOr(Schema.String),
  room: Schema.NullOr(Room),
  error: Schema.NullOr(Schema.String),
}).annotate({ identifier: "RaiRooms.Page" })
export interface Page extends Schema.Schema.Type<typeof Page> {}

export const SendInput = Schema.Struct({
  roomID: Schema.String,
  provider: Schema.Literals(providers),
  model: Schema.String,
  message: Schema.String,
  effort: Schema.NullOr(Schema.String),
  projectID: Schema.NullOr(Schema.String),
  credentialOwnerID: Schema.NullOr(Schema.Int),
  search: Schema.Boolean,
  /** Caller-only stream token. Null disables live delivery. Never copied onto the gateway body or the event bus. */
  audience: Schema.NullOr(Schema.String),
}).annotate({ identifier: "RaiRooms.SendInput" })
export interface SendInput extends Schema.Schema.Type<typeof SendInput> {}

export const ToolLine = Schema.Struct({
  label: Schema.String,
  done: Schema.Boolean,
  ok: Schema.NullOr(Schema.Boolean),
}).annotate({ identifier: "RaiRooms.ToolLine" })
export interface ToolLine extends Schema.Schema.Type<typeof ToolLine> {}

export const SendResult = Schema.Struct({
  roomID: Schema.String,
  text: Schema.String,
  notice: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  done: Schema.Boolean,
  thought: Schema.Boolean,
  tools: Schema.Array(ToolLine),
}).annotate({ identifier: "RaiRooms.SendResult" })
export interface SendResult extends Schema.Schema.Type<typeof SendResult> {}

export const WatchResult = Schema.Struct({
  roomID: Schema.String,
  active: Schema.Boolean,
  reconnect: Schema.Boolean,
  done: Schema.Boolean,
  text: Schema.String,
  error: Schema.NullOr(Schema.String),
  thought: Schema.Boolean,
}).annotate({ identifier: "RaiRooms.WatchResult" })
export interface WatchResult extends Schema.Schema.Type<typeof WatchResult> {}

export const Chunk = Schema.Struct({
  roomID: Schema.String,
  kind: Schema.Literals([
    "delta",
    "thinking",
    "tool",
    "tool_done",
    "notice",
    "error",
    "done",
    "approval",
    "approval_done",
  ]),
  text: Schema.NullOr(Schema.String),
  label: Schema.NullOr(Schema.String),
  ok: Schema.NullOr(Schema.Boolean),
  /** Tool name, so a `tool_done` can close the matching line instead of the newest one. */
  name: Schema.NullOr(Schema.String),
  /** Approval id, so `approval_done` finds the line the server opened. */
  approvalID: Schema.NullOr(Schema.String),
  title: Schema.NullOr(Schema.String),
  purpose: Schema.NullOr(Schema.String),
  /** Raw approval decision (`allow`, `allow-room`, `deny`, …). The screen maps it, it never interprets it. */
  decision: Schema.NullOr(Schema.String),
}).annotate({ identifier: "RaiRooms.Chunk" })
export interface Chunk extends Schema.Schema.Type<typeof Chunk> {}

export const BindResult = Schema.Struct({
  ok: Schema.Boolean,
}).annotate({ identifier: "RaiRooms.BindResult" })
export interface BindResult extends Schema.Schema.Type<typeof BindResult> {}

/** `create`: an empty room made up front, so a model on this computer can record into it (spec 3.7). */
export const CreateResult = Schema.Struct({
  room: Schema.NullOr(Room),
  error: Schema.NullOr(Schema.String),
}).annotate({ identifier: "RaiRooms.CreateResult" })
export interface CreateResult extends Schema.Schema.Type<typeof CreateResult> {}

export const TakeResult = Schema.Struct({
  chunk: Schema.NullOr(Chunk),
  open: Schema.Boolean,
}).annotate({ identifier: "RaiRooms.TakeResult" })
export interface TakeResult extends Schema.Schema.Type<typeof TakeResult> {}

const standard = Schema.toStandardSchemaV1

/**
 * Room list, history, and continuation. The key never travels except as the existing RAI bearer token, and nothing
 * returned here is written to the session store.
 *
 * Live text is not an RPC event. `rpc.*` events are published on the server bus and the public `/api/event` stream
 * forwards them to every connected client, including other locations. `bind` reserves a caller-only mailbox, `take`
 * reads it, and `release` drops it. Thinking text and tool arguments are still omitted from each chunk.
 */
export const Definition = Rpc.define({
  id: "opencode.rai.rooms",
  methods: {
    projects: {
      input: standard(Schema.Struct({})),
      output: standard(ProjectsResult),
    },
    rooms: {
      input: standard(Schema.Struct({})),
      output: standard(RoomsResult),
    },
    messages: {
      input: standard(
        Schema.Struct({
          roomID: Schema.String,
          limit: Schema.Int,
          before: Schema.NullOr(Schema.String),
        }),
      ),
      output: standard(Page),
    },
    send: {
      input: standard(SendInput),
      output: standard(SendResult),
    },
    create: {
      input: standard(Schema.Struct({ title: Schema.String, projectID: Schema.NullOr(Schema.String) })),
      output: standard(CreateResult),
    },
    watch: {
      input: standard(Schema.Struct({ roomID: Schema.String, audience: Schema.NullOr(Schema.String) })),
      output: standard(WatchResult),
    },
    bind: {
      input: standard(Schema.Struct({ audience: Schema.String })),
      output: standard(BindResult),
    },
    take: {
      input: standard(Schema.Struct({ audience: Schema.String })),
      output: standard(TakeResult),
    },
    release: {
      input: standard(Schema.Struct({ audience: Schema.String })),
      output: standard(BindResult),
    },
  },
  // Empty on purpose: a chunk event here would be broadcast to every event-stream subscriber.
  events: {},
})
