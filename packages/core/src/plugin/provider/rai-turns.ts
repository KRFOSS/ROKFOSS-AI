export * as RaiTurnsClient from "./rai-turns.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { define } from "@opencode/plugin/effect/plugin"
import { RaiTurns } from "@opencode/schema/rai-turns"
import type { RaiRooms } from "@opencode/schema/rai-rooms"
import { Duration, Effect, Fiber, Ref, Scope, Stream } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import {
  authorize,
  authed,
  failureFrom,
  readMessages,
  requestURL,
  roomSegment,
  watchRoom,
  type Auth,
  type Frame,
} from "./rai-rooms.js"
import { registerRaiTools } from "./rai-tools.js"

/**
 * External response turns (spec 3.7). OpenCode calls the model itself — a free OpenCode model cannot be called by the
 * gateway — and this module only records the turn into a room: `turns` → `events` … → `done`.
 *
 * Everything stays in memory except the session binding (a room id, a title, and the last message id that was
 * reconciled). Message text, thinking text and tool arguments never reach storage or a log.
 *
 * The other direction — lines and answers written in the room from the web — is shown in the bound session through
 * `ctx.session.mirror`: a web line becomes a user message, a web answer an assistant message that streams live while
 * the room makes it. A mirrored turn runs no model and starts no execution, so it is never recorded back.
 */

const storagePrefix = "rai-turn/"
/** Room number → the session it was opened in here. Only the session id is kept. */
const roomPrefix = "rai-room/"
const flushMs = 400
/** 15 seconds is the server's hard limit; this stays under it so a stop is noticed in time. */
const heartbeatMs = 5_000
const maxEventChars = 64_000
const maxContentChars = 8_000_000
const maxQueue = 4_000
/** Attempts after a dropped connection or a 5xx (spec 3.7: "짧게 2~3번"). */
const maxRetries = 3

export const turnIDPattern = /^[0-9a-f]{32}$/
/** Spec 3.7: a model name is 1–200 characters of ASCII without whitespace. */
const modelPattern = /^[\x21-\x7e]{1,200}$/
const providerPattern = /^[a-z0-9._-]{1,64}$/

export type Binding = {
  readonly roomID: string
  readonly title: string
  readonly lastMessageID: string | null
}

export type StartBody = { readonly ok: true; readonly body: Readonly<Record<string, unknown>> } | { readonly ok: false; readonly error: string }

/**
 * Whether a turn is recorded into the room through this window. Every turn a bound session answers is made here: a
 * `rai` model only lends its model through `POST /responses`, which keeps no room, and every other provider — the
 * free `opencode` models included — never touches the gateway. So every provider is relayed (spec 3.7).
 */
export function relayable(_provider: string | undefined): boolean {
  return true
}

/** The provider name the server records for an answer an OpenCode external turn wrote (spec 3.7). */
export const externalTurnProvider = "opencode_local"

/**
 * Whether a room message is one this session recorded itself: a message number it got back from the server, or an
 * external-turn answer that follows one of its own user messages (the answer's number may be lost when the turn's
 * end answer never arrived). Such messages are never shown again as if they came from the web.
 */
export function ownRoomMessage(
  message: { readonly id: string; readonly role: string; readonly provider?: string },
  page: ReadonlyArray<{ readonly id: string; readonly role: string }>,
  own: ReadonlySet<string>,
) {
  if (own.has(message.id)) return true
  if (message.role !== "assistant" || message.provider !== externalTurnProvider) return false
  const before = page
    .filter((other) => /^\d+$/.test(other.id) && Number(other.id) < Number(message.id) && other.role === "user")
    .sort((a, b) => Number(b.id) - Number(a.id))[0]
  return before !== undefined && own.has(before.id)
}

/** Room messages written elsewhere after `last`, oldest first. Ids are the server's message numbers. */
export function messagesAfter<T extends { readonly id: string }>(messages: ReadonlyArray<T>, last: string | null): T[] {
  const floor = last !== null && /^\d+$/.test(last) ? Number(last) : 0
  return messages
    .filter((message) => /^\d+$/.test(message.id) && Number(message.id) > floor)
    .sort((a, b) => Number(a.id) - Number(b.id))
}

/**
 * The model a mirrored answer is labeled with. The server records the provider and model it called; OpenCode reaches
 * the same model as `rai/<provider>/<model>`, the label a room import uses too.
 */
export function mirrorModel(provider: string | null | undefined, model: string | null | undefined) {
  const id = model?.trim()
  const via = provider?.trim()
  if (!id) return { providerID: "rai", id: "unknown" }
  return { providerID: "rai", id: via && !id.includes("/") ? `${via}/${id}` : id }
}

/** A line somebody else wrote in a shared room carries their name; the key owner's own lines look typed here. */
export function authorOf(message: Pick<RaiRooms.Message, "role" | "author" | "mine">) {
  if (message.role !== "user" || message.mine !== false) return undefined
  return message.author
}

/**
 * Which stored room messages to skip while catching up. An answer that was mirrored live but ended before its saved
 * copy could be read is followed by that copy in the room; the copy is the same answer and is not shown twice.
 */
export function storedToMirror<T extends { readonly role: string }>(messages: ReadonlyArray<T>, liveAnswered: boolean) {
  const shown: Array<{ readonly message: T; readonly mirror: boolean }> = []
  let skipping = liveAnswered
  for (const message of messages) {
    if (skipping && message.role === "assistant") {
      shown.push({ message, mirror: false })
      skipping = false
      continue
    }
    if (message.role === "user") skipping = false
    shown.push({ message, mirror: message.role === "user" || message.role === "assistant" })
  }
  return shown
}

/**
 * Whether a prompt is the start of a new recorded turn. `steer` is the default delivery of every prompt, so it says
 * nothing on its own: input that arrives while this session's turn is being recorded belongs to that turn (a web steer
 * comes back this way too), and only a queued prompt waits for the next turn.
 */
export function promptStartsTurn(delivery: string | undefined, turnActive: boolean): boolean {
  if (!turnActive) return true
  return delivery === "queue"
}

/** `POST /rooms/{id}/turns`. Only the three fields the contract names are copied. */
export function turnStartBody(input: { readonly message: string; readonly model: string; readonly provider?: string }): StartBody {
  if (typeof input.message !== "string" || input.message.trim() === "") return { ok: false, error: "메시지를 입력하세요" }
  const model = typeof input.model === "string" ? input.model.trim() : ""
  if (!modelPattern.test(model)) return { ok: false, error: "모델 이름이 올바르지 않습니다" }
  const body: Record<string, unknown> = { message: input.message, model }
  const provider = input.provider?.trim().toLowerCase()
  if (provider !== undefined && provider !== "") {
    if (!providerPattern.test(provider)) return { ok: false, error: "공급자 이름이 올바르지 않습니다" }
    body.provider = provider
  }
  return { ok: true, body }
}

export type ToolMark = { readonly name: string; readonly state: "start" | "end"; readonly title?: string }

/** A tool mark carries the tool id only: command arguments and file contents must never leave the process. */
export function toolMark(name: string, state: "start" | "end", title?: string): ToolMark | undefined {
  const trimmed = name.trim()
  if (trimmed === "" || trimmed.length > 64 || /[^\w.:-]/.test(trimmed)) return undefined
  const shown = title?.split(/\r?\n/).find((line) => line.trim() !== "")?.trim().slice(0, 200)
  return shown ? { name: trimmed, state, title: shown } : { name: trimmed, state }
}

/**
 * The programs a shell command runs, without their arguments (spec 3.7: a title never carries arguments, environment
 * values or file contents, which may be secrets): `cd x && git cherry-pick abc | tail -3` → `git cherry-pick · tail`.
 */
export function commandTitle(command: string): string | undefined {
  const programs = command
    .split(/\r?\n|&&|\|\||[;|]/)
    .flatMap((segment) => {
      const words = segment.trim().split(/\s+/).filter((word) => word !== "" && !word.includes("="))
      const program = words[0]?.split("/").pop()
      if (!program || program === "cd" || !/^[\w.+-]{1,40}$/.test(program)) return []
      const sub = words[1]
      return [sub && /^[a-z][a-z0-9-]{0,30}$/.test(sub) ? `${program} ${sub}` : program]
    })
    .slice(0, 4)
  return programs.length > 0 ? `$ ${programs.join(" · ")}` : undefined
}

/**
 * The line the web shows for a tool call: the programs of a shell command, the path of a file tool, the pattern of a
 * search, an address without its query. Never an argument that may hold a secret.
 */
export function toolTitle(name: string, input: unknown): string | undefined {
  const args = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {}
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = args[key]
      if (typeof value === "string" && value.trim() !== "") return value.trim()
    }
    return undefined
  }
  const base = name.replace(/^rai_/, "")
  const command = pick("command", "cmd")
  if (command) return commandTitle(command)
  const url = pick("url")
  if (url) return `${base} ${url.split(/[?#]/)[0]}`
  const target = pick("filePath", "file_path", "path", "file", "pattern", "description")
  return target ? `${base} ${target}` : undefined
}

export type EventBody = {
  readonly delta?: string
  readonly thinking?: string
  readonly tool?: ToolMark
  readonly steer?: string
}

/** An empty object is a liveness signal on its own, so an empty body is valid. */
export function turnEventBody(input: EventBody) {
  const body: Record<string, unknown> = {}
  if (input.delta !== undefined && input.delta !== "") body.delta = input.delta.slice(0, maxEventChars)
  if (input.thinking !== undefined && input.thinking !== "") body.thinking = input.thinking.slice(0, maxEventChars)
  if (input.tool !== undefined) body.tool = input.tool
  if (input.steer !== undefined && input.steer.trim() !== "") body.steer = input.steer
  return body
}

export function turnDoneBody(input: {
  readonly content: string
  readonly model?: string | undefined
  readonly stopped?: boolean | undefined
  readonly error?: string | undefined
}) {
  const body: Record<string, unknown> = { content: input.content.slice(0, maxContentChars) }
  const model = input.model?.trim()
  if (model !== undefined && modelPattern.test(model)) body.model = model
  if (input.stopped === true) body.stopped = true
  const error = input.error?.trim()
  if (error !== undefined && error !== "") body.error = error.slice(0, 2_000)
  return body
}

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function integer(value: unknown) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value)
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed
  }
  return undefined
}

export type TurnStarted = {
  readonly turnID: string
  readonly userMessageID: number | undefined
  readonly heartbeatSeconds: number | undefined
}

/** A turn id that is not the documented 32 hex characters is refused instead of being pasted into a path. */
export function parseTurnStart(body: unknown): TurnStarted | undefined {
  const obj = record(body)
  if (!obj) return undefined
  const turnID = typeof obj.turn_id === "string" ? obj.turn_id.trim() : ""
  if (!turnIDPattern.test(turnID)) return undefined
  return {
    turnID,
    userMessageID: integer(obj.user_message_id),
    heartbeatSeconds: integer(obj.heartbeat_seconds),
  }
}

export type Steer = { readonly messageID: number | undefined; readonly text: string }

/** The events reply is read on every request: it is the only way a stop or an interjection arrives. */
export function parseTurnEvents(body: unknown): { readonly stop: boolean; readonly steers: ReadonlyArray<Steer> } {
  const obj = record(body)
  if (!obj) return { stop: false, steers: [] }
  const raw = Array.isArray(obj.steers) ? obj.steers : []
  const steers: Steer[] = []
  for (const item of raw) {
    const entry = record(item)
    if (!entry) continue
    const text = typeof entry.text === "string" ? entry.text : ""
    if (text.trim() === "") continue
    steers.push({ messageID: integer(entry.message_id), text })
  }
  return { stop: obj.stop === true, steers }
}

export function parseTurnDone(body: unknown) {
  const obj = record(body)
  return { assistantMessageID: integer(obj?.assistant_message_id) }
}

export type TurnURLs = { readonly start: string; readonly events: string; readonly done: string }

function turnURL(endpoint: string, roomID: string, suffix: string) {
  const segment = roomSegment(roomID)
  return segment === undefined ? undefined : requestURL(endpoint, `/rooms/${segment}${suffix}`)
}

/** Every path is built from a validated room id and a validated turn id, so the key cannot be sent elsewhere. */
export function turnURLs(endpoint: string, roomID: string, turnID: string): TurnURLs | undefined {
  if (!turnIDPattern.test(turnID)) return undefined
  const start = turnURL(endpoint, roomID, "/turns")
  const events = turnURL(endpoint, roomID, `/turns/${turnID}/events`)
  const done = turnURL(endpoint, roomID, `/turns/${turnID}/done`)
  if (!start || !events || !done) return undefined
  return { start, events, done }
}

const post = (http: HttpClient.HttpClient, url: string, auth: Auth, body: Readonly<Record<string, unknown>>) =>
  Effect.gen(function* () {
    const request = yield* HttpClientRequest.post(url).pipe(
      (self) => authed(self, auth.key, "json"),
      HttpClientRequest.bodyJson(body),
    )
    const response = yield* http.execute(request).pipe(
      Effect.timeout(Duration.seconds(20)),
      Effect.mapError(() => new Error("ROKFOSS AI 대화방에 연결하지 못했습니다")),
    )
    const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
    if (response.status < 200 || response.status >= 300) {
      const failure = failureFrom(response.status, text, "rooms_write")
      return yield* Effect.fail(failure)
    }
    if (text.trim() === "") return undefined
    try {
      return JSON.parse(text) as unknown
    } catch {
      return undefined
    }
  })

export const startTurn = (http: HttpClient.HttpClient, auth: Auth, roomID: string, body: Readonly<Record<string, unknown>>) =>
  Effect.gen(function* () {
    const segment = roomSegment(roomID)
    const url = segment === undefined ? undefined : requestURL(auth.endpoint, `/rooms/${segment}/turns`)
    if (!url) return yield* Effect.fail(new Error("대화방 번호가 올바르지 않습니다"))
    return parseTurnStart(yield* post(http, url, auth, body))
  })

export const sendEvents = (http: HttpClient.HttpClient, auth: Auth, roomID: string, turnID: string, body: Readonly<Record<string, unknown>>) =>
  Effect.gen(function* () {
    const urls = turnURLs(auth.endpoint, roomID, turnID)
    if (!urls) return undefined
    return parseTurnEvents(yield* post(http, urls.events, auth, body))
  })

export const sendDone = (http: HttpClient.HttpClient, auth: Auth, roomID: string, turnID: string, body: Readonly<Record<string, unknown>>) =>
  Effect.gen(function* () {
    const urls = turnURLs(auth.endpoint, roomID, turnID)
    if (!urls) return undefined
    return parseTurnDone(yield* post(http, urls.done, auth, body))
  })

type Queued =
  | { readonly kind: "delta" | "thinking" | "steer"; readonly text: string }
  | { readonly kind: "tool"; readonly tool: ToolMark }

export type Turn = {
  readonly sessionID: string
  readonly roomID: string
  readonly turnID: string
  readonly model: string
  readonly provider: string
  readonly texts: Map<string, string>
  /** The text part written last, so a new part starts on its own paragraph in the room. */
  lastTextKey: string | undefined
  /** Tool call id → tool name: a call's name only travels in its input-started event. */
  readonly toolNames: Map<string, string>
  /** Web steers this relay fed into the session; they come back through the prompt hook and are not sent again. */
  readonly injected: string[]
  readonly queue: Queued[]
  content: string
  stopped: boolean
  failure: string | undefined
  closed: boolean
  lastSentAt: number
  /** Consecutive retryable failures. Spec 3.7 allows two or three, so a dead gateway must not be retried forever. */
  retries: number
  readonly sent: { delta: number }
}

export function activeTurn(input: {
  readonly sessionID: string
  readonly roomID: string
  readonly turnID: string
  readonly model: string
  readonly provider: string
}): Turn {
  return {
    ...input,
    texts: new Map(),
    lastTextKey: undefined,
    toolNames: new Map(),
    injected: [],
    queue: [],
    content: "",
    stopped: false,
    failure: undefined,
    closed: false,
    lastSentAt: Date.now(),
    retries: 0,
    sent: { delta: 0 },
  }
}

/**
 * Appends a stream fragment. `text.ended` is the replayable full value for one ordinal, so it replaces whatever the
 * live deltas produced for that ordinal instead of being appended to them.
 */
export function appendText(turn: Turn, key: string, delta: string) {
  // A new text part (a later step of the same answer) starts a paragraph, as the session view shows it apart.
  if (turn.lastTextKey !== undefined && turn.lastTextKey !== key && !turn.texts.has(key))
    push(turn, { kind: "delta", text: textSeparator })
  turn.lastTextKey = key
  const previous = turn.texts.get(key) ?? ""
  turn.texts.set(key, (previous + delta).slice(0, maxContentChars))
  push(turn, { kind: "delta", text: delta })
}

const textSeparator = "\n\n"

/** Something the user typed into the session while this turn runs, recorded into the room where it was typed. */
export function appendSteer(turn: Turn, text: string) {
  push(turn, { kind: "steer", text: text.slice(0, maxContentChars) })
}

export function settleText(turn: Turn, key: string, text: string) {
  if (turn.texts.has(key) || text !== "") turn.texts.set(key, text.slice(0, maxContentChars))
}

export function appendThinking(turn: Turn, text: string) {
  push(turn, { kind: "thinking", text })
}

export function markTool(turn: Turn, tool: ToolMark) {
  push(turn, { kind: "tool", tool })
}

function push(turn: Turn, item: Queued) {
  if (turn.queue.length >= maxQueue) return
  turn.queue.push(item)
}

/** One request carries at most one delta, one thinking fragment and one tool mark, so a run of deltas is merged. */
export function drain(turn: Turn): EventBody | undefined {
  const first = turn.queue.shift()
  if (!first) return undefined
  if (first.kind === "tool") return { tool: first.tool }
  if (first.kind === "steer") return { steer: first.text }
  let text = first.text
  while (text.length < maxEventChars) {
    const next = turn.queue[0]
    if (!next || next.kind !== first.kind) break
    text += next.text
    turn.queue.shift()
  }
  return first.kind === "delta" ? { delta: text.slice(0, maxEventChars) } : { thinking: text.slice(0, maxEventChars) }
}

export function finalContent(turn: Turn) {
  if (turn.texts.size === 0) return turn.content
  return [...turn.texts.values()].join(textSeparator)
}

function withoutSession(set: ReadonlySet<string>, sessionID: string) {
  const next = new Set(set)
  next.delete(sessionID)
  return next
}

// A synthetic message shows in the session only with a description, so the notice is its own one-line description.
const notice = (ctx: Context, sessionID: string, text: string) =>
  ctx.session
    .synthetic({ sessionID: sessionID as never, text, description: text, metadata: { source: "rai-room" }, resume: false })
    .pipe(Effect.ignore)

const STATUS_MESSAGES: Record<string, string> = {
  room_busy: "이 방은 지금 다른 답이 도는 중입니다. 끝난 뒤 다시 보내 주세요",
  room_read_only: "읽기 전용 방에는 기록할 수 없습니다. 다른 방을 골라 주세요",
  // The room is being answered by something else, or the project it belongs to is moving: both are temporary.
  mcp_room_active: "다른 AI가 이 방을 쓰고 있습니다. 끝난 뒤 다시 보내 주세요",
  project_transfer_busy: "프로젝트를 옮기는 중입니다. 잠시 뒤 다시 보내 주세요",
  server_draining: "서버가 재시작을 준비하고 있습니다. 잠시 뒤 다시 보내 주세요",
  // A room that a plugin owns, or a project that needs sharing, never accepts this window's turns.
  plugin_external_room: "플러그인(디스코드 등)이 쓰는 방에는 기록할 수 없습니다. 다른 방을 골라 주세요",
  project_share_required: "이 프로젝트는 공유 설정이 필요합니다. 웹 AI 앱에서 프로젝트 공유를 설정해 주세요",
  turn_closed: "회차가 이미 닫혀 기록을 마칩니다",
  turn_not_found: "회차를 찾지 못해 기록을 마칩니다",
  invalid_provider: "공급자 이름이 올바르지 않아 기록하지 못했습니다",
  invalid_model: "모델 이름이 올바르지 않아 기록하지 못했습니다",
  invalid_tool: "도구 기록이 올바르지 않아 기록을 마칩니다",
  error_too_long: "오류 설명이 너무 깁니다",
  request_too_large: "요청 본문이 너무 큽니다. 조각을 나눠 보내 주세요",
}

/**
 * What a refused `POST /rooms/{id}/turns` means for the session (spec 3.7). `unbind` means this window can never
 * record into the room, so the binding is dropped; `notice` keeps the binding because the refusal may pass; `key` and
 * `silent` leave the turn unrecorded and let the local answer run.
 */
export type StartRefusal = "unbind" | "notice" | "key" | "silent"

const permanentRefusals = new Set(["room_read_only", "plugin_external_room", "project_share_required"])

export function startRefusal(status: number | undefined, code: string | undefined): StartRefusal {
  if (code === "scope_missing" || code === "room_read_only") return code === "room_read_only" ? "unbind" : "key"
  if (permanentRefusals.has(code ?? "")) return "unbind"
  // A room that is gone — or somebody else's now — cannot be recorded into any more.
  if (status === 404) return "unbind"
  if (status === 401) return "key"
  if (status === 403) return "key"
  if (code !== undefined && STATUS_MESSAGES[code] !== undefined) return "notice"
  return "silent"
}

function turnFailure(error: unknown): { readonly code: string | undefined; readonly status: number | undefined; readonly retry: boolean } {
  const shaped = error as { code?: string; status?: number; retry?: boolean } | undefined
  return { code: shaped?.code, status: shaped?.status, retry: shaped?.retry === true }
}

export interface TurnHandlers {
  readonly bind: (input: {
    readonly sessionID: string
    readonly roomID: string
    readonly title: string
    readonly after?: string
  }) => Effect.Effect<RaiTurns.Bound>
  readonly unbind: (input: { readonly sessionID: string }) => Effect.Effect<RaiTurns.Bound>
  readonly bound: (input: { readonly sessionID: string }) => Effect.Effect<RaiTurns.Bound>
  readonly sessionOf: (input: { readonly roomID: string }) => Effect.Effect<RaiTurns.SessionOf>
  /**
   * Reads the room once and returns; the new lines, and an answer the room is making, are mirrored into the session
   * in the background. `added` counts the stored messages found after the last reconciled one.
   */
  readonly sync: (input: { readonly sessionID: string }) => Effect.Effect<RaiTurns.Synced>
  /** The room a session is bound to, for the RAI room tools (rai-tools.ts). */
  readonly roomOf: (sessionID: string) => Effect.Effect<string | undefined>
}

const unbound: RaiTurns.Bound = { roomID: null, title: null, error: null }

type MirrorAnswer = Effect.Success<ReturnType<Context["session"]["mirror"]["answer"]>>
type ModelLabel = ReturnType<typeof mirrorModel>

/**
 * Starts the relay. A bound session records each turn it runs with a model the gateway cannot call (anything but the
 * RAI provider). Nothing is sent for an unbound session, and nothing about a turn is written to storage.
 */
export const startTurns = (ctx: Context, http: HttpClient.HttpClient) =>
  Effect.gen(function* () {
    const bindings = yield* Ref.make(new Map<string, Binding>())
    const pending = yield* Ref.make(new Map<string, { readonly text: string; readonly at: number }>())
    const turns = yield* Ref.make(new Map<string, Turn>())
    // Sessions whose finished turn is still being saved: the answer is in the room before its id is remembered.
    const settling = yield* Ref.make(new Set<string>())
    // Bound sessions running without a prompt of the user's — woken by a background result (a subagent report, for
    // example). Such a run is stopped before it calls the model, so the session never goes on alone apart from the room.
    const autoRuns = new Set<string>()
    // Room message numbers this session recorded (its user messages and answers), so catching up never shows them again.
    const ownMessages = new Map<string, Set<string>>()
    const rememberOwn = (sessionID: string, messageID: string | number | undefined) => {
      if (messageID === undefined) return
      const set = ownMessages.get(sessionID) ?? new Set<string>()
      set.add(String(messageID))
      if (set.size > 200) set.delete(set.values().next().value!)
      ownMessages.set(sessionID, set)
    }
    const scope = yield* Scope.Scope
    // Sessions catching up with the room right now. One catch-up per session, so a web line is never shown twice.
    const mirroring = yield* Ref.make(new Set<string>())
    // The background catch-up of each session, interrupted when the session starts a turn of its own.
    const followers = new Map<string, Fiber.Fiber<void>>()
    // Assistant messages the mirror wrote: their events are the web's answer, never a turn to record into the room.
    const mirrored = new Set<string>()
    // Session → the last reconciled message whose answer was mirrored live but ended before its saved copy was read.
    const liveAnswered = new Map<string, string>()

    const bindingOf = (sessionID: string) =>
      Effect.gen(function* () {
        const cached = (yield* Ref.get(bindings)).get(sessionID)
        if (cached) return cached
        const stored = yield* ctx.storage.get(storagePrefix + sessionID).pipe(Effect.orElseSucceed(() => undefined))
        const obj = record(stored)
        const roomID = typeof obj?.roomID === "string" ? obj.roomID : undefined
        if (!roomID || !roomSegment(roomID)) return undefined
        const binding: Binding = {
          roomID,
          title: typeof obj?.title === "string" ? obj.title.slice(0, 200) : roomID,
          lastMessageID: typeof obj?.lastMessageID === "string" ? obj.lastMessageID : null,
        }
        yield* Ref.update(bindings, (map) => new Map(map).set(sessionID, binding))
        return binding
      })

    const unbind = (sessionID: string) =>
      Effect.gen(function* () {
        yield* Ref.update(bindings, (map) => {
          const next = new Map(map)
          next.delete(sessionID)
          return next
        })
        yield* Ref.update(pending, (map) => {
          const next = new Map(map)
          next.delete(sessionID)
          return next
        })
        const stored = yield* ctx.storage.get(storagePrefix + sessionID).pipe(Effect.orElseSucceed(() => undefined))
        const roomID = record(stored)?.roomID
        yield* ctx.storage.remove(storagePrefix + sessionID).pipe(Effect.ignore)
        if (typeof roomID === "string") {
          const owner = yield* ctx.storage.get(roomPrefix + roomID).pipe(Effect.orElseSucceed(() => undefined))
          if (record(owner)?.sessionID === sessionID) yield* ctx.storage.remove(roomPrefix + roomID).pipe(Effect.ignore)
        }
      })

    const persist = (sessionID: string, binding: Binding) =>
      Effect.gen(function* () {
        yield* Ref.update(bindings, (map) => new Map(map).set(sessionID, binding))
        yield* ctx.storage
          .set(storagePrefix + sessionID, { roomID: binding.roomID, title: binding.title, lastMessageID: binding.lastMessageID } as never)
          .pipe(Effect.ignore)
      })

    const finish = (sessionID: string, options: { readonly stopped?: boolean; readonly error?: string }) =>
      Effect.gen(function* () {
        const turn = (yield* Ref.get(turns)).get(sessionID)
        if (!turn || turn.closed) return
        turn.closed = true
        yield* Ref.update(settling, (set) => new Set(set).add(sessionID))
        yield* Ref.update(turns, (map) => {
          const next = new Map(map)
          next.delete(sessionID)
          return next
        })
        yield* Ref.update(pending, (map) => {
          const next = new Map(map)
          next.delete(sessionID)
          return next
        })
        const auth = yield* authorize(ctx).pipe(Effect.orElseSucceed(() => undefined))
        if (!auth) {
          yield* Ref.update(settling, (set) => withoutSession(set, sessionID))
          return
        }
        yield* sendDone(
          http,
          auth,
          turn.roomID,
          turn.turnID,
          turnDoneBody({
            content: finalContent(turn),
            model: turn.model,
            stopped: options.stopped === true,
            error: options.error,
          }),
        ).pipe(
          // The saved answer is this session's own; catching up later must not add it a second time.
          Effect.tap((done) =>
            Effect.gen(function* () {
              if (done?.assistantMessageID === undefined) return
              rememberOwn(sessionID, done.assistantMessageID)
              const binding = yield* bindingOf(sessionID)
              if (binding && binding.roomID === turn.roomID)
                yield* persist(sessionID, { ...binding, lastMessageID: String(done.assistantMessageID) })
            }),
          ),
          Effect.catch((error) => {
            const failure = turnFailure(error)
            if (failure.code === "turn_closed" || failure.status === 409) return Effect.void
            if (failure.status === 401 || failure.code === "scope_missing") {
              return notice(ctx, sessionID, "서버 기록이 중단되었습니다. RAI 키 권한과 상태를 확인해 주세요")
            }
            return Effect.void
          }),
          Effect.ignore,
          Effect.ensuring(Ref.update(settling, (set) => withoutSession(set, sessionID))),
        )
        if (turn.stopped) yield* ctx.session.interrupt({ sessionID: sessionID as never }).pipe(Effect.ignore)
      })

    const pump = (turn: Turn) =>
      Effect.gen(function* () {
        const auth = yield* authorize(ctx).pipe(Effect.orElseSucceed(() => undefined))
        if (!auth) {
          turn.closed = true
          return
        }
        while (!turn.closed) {
          yield* Effect.sleep(Duration.millis(flushMs))
          if (turn.closed) break
          let body = drain(turn)
          let budget = 8
          while (!turn.closed && body !== undefined && budget > 0) {
            const reply = yield* sendEvents(http, auth, turn.roomID, turn.turnID, body).pipe(
              Effect.map((value) => ({ value, failure: undefined as unknown })),
              Effect.catch((error) => Effect.succeed({ value: undefined, failure: error })),
            )
            if (reply.failure !== undefined) {
              const failure = turnFailure(reply.failure)
              // Only a dropped connection or a gateway failure is retried; a closed turn or a bad key is final.
              if (!failure.retry) {
                turn.failure = STATUS_MESSAGES[failure.code ?? ""] ?? undefined
                const closed = failure.code === "turn_closed" || failure.status === 409
                if (closed) turn.failure = undefined
                turn.closed = true
                if (failure.status === 401 || failure.code === "scope_missing") turn.failure = undefined
                return
              }
              // Spec 3.7 retries a dropped connection or a 5xx two or three times, then gives the turn up.
              turn.retries += 1
              if (turn.retries > maxRetries) {
                turn.closed = true
                return
              }
              yield* Effect.sleep(Duration.seconds(1))
              break
            }
            turn.lastSentAt = Date.now()
            turn.retries = 0
            if (reply.value?.stop === true) turn.stopped = true
            for (const steer of reply.value?.steers ?? []) {
              const text = `웹에서 온 지시: ${steer.text}`
              turn.injected.push(text)
              yield* ctx.session.prompt({ sessionID: turn.sessionID as never, text, delivery: "steer" }).pipe(Effect.ignore)
            }
            if (turn.stopped) {
              // The web asked to stop: interrupt here, so the session ends and `done` can report `stopped`.
              yield* ctx.session.interrupt({ sessionID: turn.sessionID as never }).pipe(Effect.ignore)
              turn.closed = true
              return
            }
            budget -= 1
            body = drain(turn)
          }
          if (turn.closed) break
          if (body === undefined && Date.now() - turn.lastSentAt >= heartbeatMs) {
            const reply = yield* sendEvents(http, auth, turn.roomID, turn.turnID, {}).pipe(
              Effect.map((value) => ({ value, failure: undefined as unknown })),
              Effect.catch((error) => Effect.succeed({ value: undefined, failure: error })),
            )
            if (reply.failure !== undefined) {
              const failure = turnFailure(reply.failure)
              if (!failure.retry) {
                turn.closed = true
                return
              }
              turn.retries += 1
              if (turn.retries > maxRetries) {
                turn.closed = true
                return
              }
              yield* Effect.sleep(Duration.seconds(1))
              continue
            }
            turn.lastSentAt = Date.now()
            turn.retries = 0
            if (reply.value?.stop === true) {
              turn.stopped = true
              yield* ctx.session.interrupt({ sessionID: turn.sessionID as never }).pipe(Effect.ignore)
              turn.closed = true
              return
            }
            for (const steer of reply.value?.steers ?? []) {
              const text = `웹에서 온 지시: ${steer.text}`
              turn.injected.push(text)
              yield* ctx.session.prompt({ sessionID: turn.sessionID as never, text, delivery: "steer" }).pipe(Effect.ignore)
            }
          }
        }
      }).pipe(Effect.ignore)

    const begin = (sessionID: string) =>
      Effect.gen(function* () {
        if ((yield* Ref.get(turns)).has(sessionID)) return
        const binding = yield* bindingOf(sessionID)
        if (!binding) return
        const request = (yield* Ref.get(pending)).get(sessionID)
        if (!request) return
        const info = yield* ctx.session.get({ sessionID: sessionID as never }).pipe(Effect.orElseSucceed(() => undefined))
        const provider = (info?.model?.providerID as string | undefined) ?? "opencode"
        const model = (info?.model?.id as string | undefined) ?? ""
        // A RAI model is served by the gateway itself and recorded there; every locally answered turn — a free
        // OpenCode model included — is relayed, because the server cannot call those models itself (spec 3.7).
        if (!relayable(provider)) return
        const body = turnStartBody({ message: request.text, model, provider })
        if (!body.ok) return
        const auth = yield* authorize(ctx).pipe(Effect.orElseSucceed(() => undefined))
        if (!auth) {
          yield* notice(ctx, sessionID, "RAI를 먼저 연결해 주세요. 이 회차는 서버에 기록되지 않았습니다")
          return
        }
        const started = yield* startTurn(http, auth, binding.roomID, body.body).pipe(
          Effect.map((value) => ({ value, failure: undefined as unknown })),
          Effect.catch((error) => Effect.succeed({ value: undefined, failure: error })),
        )
        if (started.failure !== undefined) {
          const failure = turnFailure(started.failure)
          const message = STATUS_MESSAGES[failure.code ?? ""]
          const refusal = startRefusal(failure.status, failure.code)
          if (refusal === "unbind") {
            yield* unbind(sessionID)
            yield* notice(ctx, sessionID, message ?? "이 방에는 더 이상 기록할 수 없습니다")
            return
          }
          if (refusal === "key") {
            yield* notice(
              ctx,
              sessionID,
              failure.status === 401 || failure.code === "expired_api_key"
                ? "RAI 키가 만료되었거나 지워져 기록하지 못했습니다"
                : "AI 앱 설정에서 이 키의 「대화방 쓰기」 권한을 켜 주세요",
            )
            return
          }
          if (refusal === "notice") {
            yield* notice(ctx, sessionID, message ?? "이 회차는 서버에 기록되지 않았습니다")
            return
          }
          // A recording failure must never stop the local answer.
          yield* notice(ctx, sessionID, "이 회차는 서버에 기록되지 않았습니다")
          return
        }
        if (!started.value) {
          yield* notice(ctx, sessionID, "이 회차는 서버에 기록되지 않았습니다")
          return
        }
        const turn = activeTurn({
          sessionID,
          roomID: binding.roomID,
          turnID: started.value.turnID,
          model,
          provider,
        })
        yield* Ref.update(turns, (map) => new Map(map).set(sessionID, turn))
        rememberOwn(sessionID, started.value.userMessageID)
        if (started.value.userMessageID !== undefined) {
          yield* persist(sessionID, { ...binding, lastMessageID: String(started.value.userMessageID) })
        }
        yield* Effect.forkScoped(pump(turn))
      }).pipe(Effect.ignore)

    yield* ctx.session.hook("prompt", (event) =>
      Effect.gen(function* () {
        // `steer` is the default delivery of every prompt, so it cannot tell an interjection from a new turn. Input that
        // arrives while this session's turn is being recorded belongs to that turn (a web steer comes back this way too);
        // only a queued prompt waits for the next turn and is remembered for it.
        const sessionID = event.sessionID as unknown as string
        const active = (yield* Ref.get(turns)).get(sessionID)
        if (!promptStartsTurn(event.delivery, active !== undefined)) {
          // Typed here into the running turn: the room records it where it was typed, like a web steer. A web steer this
          // relay fed in comes back here too and is skipped.
          const typed = event.prompt.text
          if (!active || typeof typed !== "string" || typed.trim() === "") return
          const echoed = active.injected.indexOf(typed)
          if (echoed >= 0) {
            active.injected.splice(echoed, 1)
            return
          }
          appendSteer(active, typed)
          return
        }
        const text = event.prompt.text
        if (typeof text !== "string" || text.trim() === "") return
        yield* Ref.update(pending, (map) => new Map(map).set(sessionID, { text, at: Date.now() }))
      }).pipe(Effect.ignore),
    )

    const relay = (event: {
      readonly type: string
      readonly data: {
        readonly sessionID?: string
        readonly assistantMessageID?: string
        readonly ordinal?: number
        readonly delta?: string
        readonly text?: string
        readonly id?: string
        readonly name?: string
        readonly input?: unknown
      }
    }) =>
      Effect.gen(function* () {
        const sessionID = event.data.sessionID
        if (!sessionID) return
        if (event.data.assistantMessageID !== undefined && mirrored.has(event.data.assistantMessageID)) return
        if (event.type === "session.execution.started") {
          // A turn of this session's own owns the transcript from here; the web answer being mirrored stops.
          const follower = followers.get(sessionID)
          if (follower) yield* Fiber.interrupt(follower).pipe(Effect.forkIn(scope))
          const prompted = (yield* Ref.get(pending)).has(sessionID)
          if (!prompted && (yield* bindingOf(sessionID))) autoRuns.add(sessionID)
          else autoRuns.delete(sessionID)
          return yield* begin(sessionID)
        }
        if (event.type === "session.step.started" && autoRuns.has(sessionID)) {
          autoRuns.delete(sessionID)
          if (!(yield* Ref.get(turns)).has(sessionID)) {
            // Not a turn the user asked for: stop it before the model answers. The background result stays in the
            // session and is read with the user's next message.
            yield* ctx.session.interrupt({ sessionID: sessionID as never }).pipe(Effect.ignore)
            yield* notice(
              ctx,
              sessionID,
              "뒤로 보낸 작업의 결과가 도착했습니다. 대화방과 어긋나지 않게 혼자 이어 가지 않았습니다. 이어서 하려면 글을 보내 주세요",
            )
            return
          }
        }
        if (
          event.type === "session.execution.succeeded" ||
          event.type === "session.execution.failed" ||
          event.type === "session.execution.interrupted"
        )
          autoRuns.delete(sessionID)
        const turn = (yield* Ref.get(turns)).get(sessionID)
        if (!turn) {
          if (event.type === "session.execution.succeeded" || event.type === "session.execution.failed" || event.type === "session.execution.interrupted")
            yield* Ref.update(pending, (map) => {
              const next = new Map(map)
              next.delete(sessionID)
              return next
            })
          return
        }
        const key = `${event.data.assistantMessageID ?? ""}:${event.data.ordinal ?? 0}`
        if (event.type === "session.text.delta" && typeof event.data.delta === "string") appendText(turn, key, event.data.delta)
        if (event.type === "session.text.ended" && typeof event.data.text === "string") settleText(turn, key, event.data.text)
        if (event.type === "session.reasoning.delta" && typeof event.data.delta === "string") appendThinking(turn, event.data.delta)
        // A call's name only travels in its input-started event; the called/ended events carry the call id.
        if (event.type === "session.tool.input.started" && event.data.id && event.data.name)
          turn.toolNames.set(event.data.id, event.data.name)
        if (event.type === "session.tool.called" && event.data.id) {
          const name = turn.toolNames.get(event.data.id)
          const mark = name ? toolMark(name, "start", toolTitle(name, event.data.input)) : undefined
          if (mark) markTool(turn, mark)
        }
        if ((event.type === "session.tool.success" || event.type === "session.tool.failed") && event.data.id) {
          const name = turn.toolNames.get(event.data.id)
          turn.toolNames.delete(event.data.id)
          const mark = name ? toolMark(name, "end") : undefined
          if (mark) markTool(turn, mark)
        }
        // Compaction inside a recorded turn shows in the room like a tool line, so the web sees why the answer paused.
        if (event.type === "session.compaction.started")
          markTool(turn, { name: "compaction", state: "start", title: "대화 압축" })
        if (event.type === "session.compaction.ended") markTool(turn, { name: "compaction", state: "end", title: "대화 압축 끝" })
        if (event.type === "session.compaction.failed")
          markTool(turn, { name: "compaction", state: "end", title: "대화 압축 실패" })
        if (event.type === "session.execution.succeeded") yield* finish(sessionID, {})
        if (event.type === "session.execution.interrupted") yield* finish(sessionID, { stopped: true })
        if (event.type === "session.execution.failed") yield* finish(sessionID, { error: "생성이 실패했습니다" })
      }).pipe(Effect.ignore)

    yield* ctx.event
      .subscribe({
        types: [
          "session.execution.started",
          "session.execution.succeeded",
          "session.execution.failed",
          "session.execution.interrupted",
          "session.step.started",
          "session.text.delta",
          "session.text.ended",
          "session.reasoning.delta",
          "session.tool.input.started",
          "session.tool.called",
          "session.compaction.started",
          "session.compaction.ended",
          "session.compaction.failed",
          "session.tool.success",
          "session.tool.failed",
        ],
      })
      .pipe(
        Stream.runForEach((event) => relay(event as never)),
        Effect.forkScoped({ startImmediately: true }),
      )

    // While this session answers, saves or is about to start its own turn, what appears in the room is that turn.
    const ownTurn = (sessionID: string) =>
      Effect.gen(function* () {
        if ((yield* Ref.get(turns)).has(sessionID)) return true
        if ((yield* Ref.get(settling)).has(sessionID)) return true
        return (yield* Ref.get(pending)).has(sessionID)
      })

    const remember = (messageID: string) => {
      mirrored.add(messageID)
      if (mirrored.size > 2_000) mirrored.delete(mirrored.values().next().value!)
    }

    // The binding is written only while the session is still bound to the same room: an unbind wins over a catch-up.
    const advance = (sessionID: string, binding: Binding, messageID: string) =>
      Effect.gen(function* () {
        const current = yield* bindingOf(sessionID)
        if (current?.roomID !== binding.roomID) return undefined
        const next = { ...current, lastMessageID: messageID }
        yield* persist(sessionID, next)
        return next
      })

    const mirrorStored = (sessionID: string, roomID: string, message: RaiRooms.Message) =>
      Effect.gen(function* () {
        const metadata = { rai: { roomID, messageID: message.id } }
        if (message.role === "user") {
          if (message.text.trim() === "") return
          yield* ctx.session.mirror.user({ sessionID: sessionID as never, text: message.text, author: authorOf(message), metadata })
          return
        }
        if (message.text.trim() === "" && (message.thinking ?? "").trim() === "") return
        const answer = yield* ctx.session.mirror.answer({
          sessionID: sessionID as never,
          model: mirrorModel(message.provider, message.model) as never,
          metadata,
        })
        remember(answer.messageID)
        yield* answer.end({ text: message.text, reasoning: message.thinking })
      })

    // The saved copy of the answer that just streamed: the first answer after the last reconciled message.
    const savedAnswer = (auth: Auth, binding: Binding) =>
      Effect.gen(function* () {
        for (let attempt = 0; attempt < 4; attempt++) {
          if (attempt > 0) yield* Effect.sleep(Duration.millis(700))
          const page = yield* readMessages(http, auth, { roomID: binding.roomID, limit: 20 }).pipe(
            Effect.orElseSucceed(() => undefined),
          )
          const answer = page && messagesAfter(page.messages, binding.lastMessageID).find((m) => m.role === "assistant")
          if (answer) return answer
        }
        return undefined
      })

    /**
     * Follows the answer the room is making right now and streams it into the session as it arrives. The message
     * opens on the first fragment, so a stream that has already ended (204) leaves nothing behind.
     */
    const followAnswer = (sessionID: string, binding: Binding, model: ModelLabel) =>
      Effect.gen(function* () {
        const auth = yield* authorize(ctx)
        const state: { answer?: MirrorAnswer; failure?: string; saved: boolean } = { saved: false }
        const opened = Effect.gen(function* () {
          if (state.answer) return state.answer
          const answer = yield* ctx.session.mirror.answer({
            sessionID: sessionID as never,
            model: model as never,
            metadata: { rai: { roomID: binding.roomID } },
          })
          remember(answer.messageID)
          state.answer = answer
          return answer
        })
        const onFrame = (frame: Frame) =>
          Effect.gen(function* () {
            if (frame.kind === "error" && frame.text) state.failure = frame.text
            if ((frame.kind !== "delta" && frame.kind !== "thinking") || !frame.text) return
            const answer = yield* opened
            if (frame.kind === "delta") yield* answer.text(frame.text)
            if (frame.kind === "thinking") yield* answer.reasoning(frame.text)
          }).pipe(Effect.ignore)
        yield* Effect.gen(function* () {
          yield* watchRoom(http, auth, binding.roomID, { onFrame }).pipe(Effect.ignore)
          const answer = state.answer
          if (!answer) return
          const saved = yield* savedAnswer(auth, binding)
          if (!saved) return
          yield* answer.end({ text: saved.text, reasoning: saved.thinking })
          state.saved = true
          yield* advance(sessionID, binding, saved.id)
        }).pipe(
          // A stream that dropped, failed or was cut short by a local turn still ends its message. Its saved copy will
          // turn up in a later catch-up and is skipped there.
          Effect.ensuring(
            Effect.suspend(() => {
              const answer = state.answer
              if (!answer || state.saved) return Effect.void
              liveAnswered.set(sessionID, binding.lastMessageID ?? "")
              return answer.end(state.failure ? { error: state.failure } : {})
            }),
          ),
        )
      })

    const catchUp = (
      sessionID: string,
      binding: Binding,
      fresh: ReadonlyArray<RaiRooms.Message>,
      follow: boolean,
      model: ModelLabel,
    ) =>
      Effect.gen(function* () {
        let current = binding
        const live = liveAnswered.get(sessionID) === (binding.lastMessageID ?? "")
        for (const item of storedToMirror(fresh, live)) {
          // A local turn that starts now records into the room itself; what is left is read after it.
          if (yield* ownTurn(sessionID)) return
          if (item.mirror) yield* mirrorStored(sessionID, current.roomID, item.message)
          const next = yield* advance(sessionID, current, item.message.id)
          if (!next) return
          current = next
          if (item.message.role === "user" || item.message.role === "assistant") liveAnswered.delete(sessionID)
        }
        if (!follow || (yield* ownTurn(sessionID))) return
        // The answer after this message was already followed once; its saved copy is what comes next.
        if (liveAnswered.get(sessionID) === (current.lastMessageID ?? "")) return
        yield* followAnswer(sessionID, current, model)
      })

    const handlers: TurnHandlers = {
      bind: (input) =>
        Effect.gen(function* () {
          if (!roomSegment(input.roomID)) return unbound
          const auth = yield* authorize(ctx)
          const page = yield* readMessages(http, auth, { roomID: input.roomID, limit: 1 }).pipe(
            Effect.catch((error) => Effect.fail(error)),
          )
          if (page.access === "read") return { roomID: null, title: null, error: "읽기 전용 방에는 기록할 수 없습니다" }
          // Opening a room as a session (`after` given) may land on a running answer; it is caught up once it ends.
          if (page.room?.running === true && input.after === undefined)
            return { roomID: null, title: null, error: "이 방은 지금 다른 답이 도는 중입니다" }
          const newest = page.messages.at(-1)?.id ?? null
          const after = input.after !== undefined && /^\d+$/.test(input.after) ? input.after : newest
          const binding: Binding = { roomID: input.roomID, title: input.title.slice(0, 200), lastMessageID: after }
          yield* persist(input.sessionID, binding)
          yield* ctx.storage.set(roomPrefix + input.roomID, { sessionID: input.sessionID } as never).pipe(Effect.ignore)
          return { roomID: binding.roomID, title: binding.title, error: null } satisfies RaiTurns.Bound
        }).pipe(
          Effect.catch((error) =>
            Effect.succeed({
              roomID: null,
              title: null,
              error: error instanceof Error ? error.message : "대화방에 묶지 못했습니다",
            } satisfies RaiTurns.Bound),
          ),
        ),
      unbind: (input) =>
        Effect.gen(function* () {
          yield* unbind(input.sessionID)
          return unbound
        }),
      bound: (input) =>
        Effect.gen(function* () {
          const binding = yield* bindingOf(input.sessionID)
          return binding ? ({ roomID: binding.roomID, title: binding.title, error: null } satisfies RaiTurns.Bound) : unbound
        }).pipe(Effect.orElseSucceed(() => unbound)),
      roomOf: (sessionID) =>
        bindingOf(sessionID).pipe(
          Effect.map((binding) => binding?.roomID),
          Effect.orElseSucceed(() => undefined),
        ),
      sessionOf: (input) =>
        Effect.gen(function* () {
          if (!roomSegment(input.roomID)) return { sessionID: null }
          const owner = record(yield* ctx.storage.get(roomPrefix + input.roomID).pipe(Effect.orElseSucceed(() => undefined)))
          const sessionID = typeof owner?.sessionID === "string" ? owner.sessionID : undefined
          if (!sessionID) return { sessionID: null }
          const binding = yield* bindingOf(sessionID)
          const alive = yield* ctx.session.get({ sessionID: sessionID as never }).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          )
          if (binding?.roomID === input.roomID && alive) return { sessionID }
          // The session was removed or moved to another room: the room opens fresh next time.
          yield* ctx.storage.remove(roomPrefix + input.roomID).pipe(Effect.ignore)
          return { sessionID: null }
        }).pipe(Effect.orElseSucceed(() => ({ sessionID: null }))),
      sync: (input) =>
        Effect.gen(function* () {
          const sessionID = input.sessionID
          const binding = yield* bindingOf(sessionID)
          if (!binding) return { added: 0, error: null }
          if (yield* ownTurn(sessionID)) return { added: 0, error: null }
          // A catch-up that is still following an answer owns this session until the answer ends.
          const claimed = yield* Ref.modify(mirroring, (set) =>
            set.has(sessionID) ? ([false, set] as const) : ([true, new Set(set).add(sessionID)] as const),
          )
          if (!claimed) return { added: 0, error: null }
          const release = Ref.update(mirroring, (set) => withoutSession(set, sessionID))
          const forked = { value: false }
          return yield* Effect.gen(function* () {
            const auth = yield* authorize(ctx)
            const page = yield* readMessages(http, auth, { roomID: binding.roomID, limit: 40 })
            const after = messagesAfter(page.messages, binding.lastMessageID)
            const own = ownMessages.get(sessionID) ?? new Set<string>()
            const fresh = after.filter((message) => !ownRoomMessage(message, page.messages, own))
            const follow = page.room?.running === true
            // Only this session's own lines are new: move past them without showing anything.
            if (fresh.length === 0 && after.length > 0 && !follow) {
              yield* advance(sessionID, binding, after.at(-1)!.id)
              return { added: 0, error: null }
            }
            if (fresh.length === 0 && !follow) return { added: 0, error: null }
            // Checked again: a turn may have started while the page was read.
            if (yield* ownTurn(sessionID)) return { added: 0, error: null }
            // The call returns now; showing the lines and following a running answer go on in the background.
            const fiber = yield* catchUp(sessionID, binding, fresh, follow, mirrorModel(page.room?.provider, page.room?.model)).pipe(
              Effect.ignore,
              Effect.catchDefect(() => Effect.void),
              Effect.ensuring(
                Effect.suspend(() => {
                  followers.delete(sessionID)
                  return release
                }),
              ),
              Effect.forkIn(scope, { startImmediately: true }),
            )
            forked.value = true
            // A catch-up with nothing to wait for may already be over, and its entry already gone.
            if ((yield* Ref.get(mirroring)).has(sessionID)) followers.set(sessionID, fiber)
            return { added: fresh.length, error: null }
          }).pipe(Effect.ensuring(Effect.suspend(() => (forked.value ? Effect.void : release))))
        }).pipe(
          Effect.catch((error) =>
            Effect.succeed({ added: 0, error: error instanceof Error ? error.message : "대화방을 따라잡지 못했습니다" }),
          ),
          Effect.catchDefect(() => Effect.succeed({ added: 0, error: "대화방을 따라잡지 못했습니다" })),
        ),
    }

    return handlers
  })

export const RaiTurnsPlugin = define({
  id: "opencode.provider.rai.turns",
  effect: Effect.fn("RaiTurns.Plugin")(function* (ctx) {
    const http = yield* HttpClient.HttpClient
    const handlers = yield* startTurns(ctx, http).pipe(Effect.orDie)
    // The relay above and these three methods share one binding map: a method call sees the same state a turn uses.
    yield* ctx.rpc.register(RaiTurns.Definition, {
      bind: (input) => handlers.bind(input),
      unbind: (input) => handlers.unbind(input),
      bound: (input) => handlers.bound(input),
      sessionOf: (input) => handlers.sessionOf(input),
      sync: (input) => handlers.sync(input),
    }).pipe(Effect.orDie)
    // RAI room tools share the bindings above: a tool runs in the room its session is bound to.
    yield* registerRaiTools(ctx, http, handlers.roomOf)
  }),
})
