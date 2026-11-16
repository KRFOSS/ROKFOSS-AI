export * as RaiRoomsClient from "./rai-rooms.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { define } from "@opencode/plugin/effect/plugin"
import { Document } from "@opencode/schema/config"
import { RaiRooms } from "@opencode/schema/rai-rooms"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { Deferred, Duration, Effect, Option, Schema, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import path from "node:path"
import { Config } from "../../config.js"
import { ConfigDiscovery } from "../../config/discovery.js"
import { ConfigIntegration } from "../../config/integration.js"
import type { PluginInternal } from "../internal.js"
import { activeCredential } from "./credential-settings.js"
import { foldSettings } from "./configured.js"
import { describe, gatewayBaseURL, parseBaseURL, userAgent } from "./rai.js"

const providerID = "rai"
export const defaultBaseURL = "https://project.krfoss.org/api/rai/v1"
export const connectFirst = "RAI를 먼저 연결해 주세요"
const listTimeout = Duration.seconds(15)
const defaultIdleMs = 120_000
const maxRooms = 200
const maxText = 32_000
const maxTools = 20
/** Frames a caller mailbox holds before the oldest are dropped. One turn can record 1000 tool lines. */
const maxQueuedFrames = 2_048
/** Attempts after a dropped stream. 401, 403, and share_limited are never in this set. */
const streamRetries = 2

const ErrorBody = Schema.Struct({
  message: Schema.optional(Schema.String),
  code: Schema.optional(Schema.String),
  error: Schema.optional(
    Schema.Union([
      Schema.String,
      Schema.Struct({ message: Schema.optional(Schema.String), code: Schema.optional(Schema.String) }),
    ]),
  ),
})
const decodeError = Schema.decodeUnknownOption(Schema.fromJsonString(ErrorBody))

export class RoomsRequestError extends Error {
  readonly status?: number
  readonly code?: string
  readonly retry: boolean
  constructor(message: string, options?: { readonly status?: number; readonly code?: string; readonly retry?: boolean }) {
    super(message)
    this.name = "RoomsRequestError"
    this.status = options?.status
    this.code = options?.code
    this.retry = options?.retry ?? false
  }
}

export type Scope = "rooms_read" | "rooms_write"

/** Shown for `scope_missing`: the shared guidance, plus the room scope and the web-approval wait. */
export function roomsMessage(code: string | undefined, message: string, scope: Scope) {
  const base = describe(code, message)
  if (code !== "scope_missing") return base
  return `${base} — 웹에서 승인을 기다리는 중이면 RAI 앱에서 ${scope} 권한을 승인해 주세요`
}

/**
 * Address rule shared with the model provider and web search: env and user config may name any `https:` host, a
 * project config only the gateway, and anything else falls back to the canonical endpoint. `http:` never wins.
 */
export function pickEndpoint(input: { readonly env?: unknown; readonly user?: unknown; readonly project?: unknown }) {
  const environment = parseBaseURL(input.env)
  if (environment.url) return environment.url
  const user = parseBaseURL(input.user)
  if (user.url) return user.url
  const project = gatewayBaseURL(input.project)
  return project.url ?? defaultBaseURL
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** One path segment. Slashes, `..`, and an empty id are refused so the key cannot be sent to another route. */
export function roomSegment(id: string) {
  const trimmed = id.trim()
  if (trimmed === "" || trimmed === "0") return undefined
  if (!SAFE_ID.test(trimmed) || trimmed.includes("..")) return undefined
  return encodeURIComponent(trimmed)
}

export function pageLimit(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(parsed)) return 40
  return Math.min(100, Math.max(1, Math.trunc(parsed)))
}

/** Joins a relative path onto the API root without letting an absolute path replace the prefix. */
export function requestURL(endpoint: string, suffix: string) {
  if (!suffix.startsWith("/") || suffix.includes("..") || suffix.includes("\\") || suffix.includes("?")) return undefined
  let base: URL
  try {
    base = new URL(endpoint)
  } catch {
    return undefined
  }
  if (base.protocol !== "https:" || base.username !== "" || base.password !== "") return undefined
  const root = endpoint.replace(/\/+$/, "")
  let url: URL
  try {
    url = new URL(root + suffix)
  } catch {
    return undefined
  }
  if (url.origin !== base.origin || !url.href.startsWith(`${root}/`)) return undefined
  return url.href
}

export function messagesURL(endpoint: string, roomID: string, limit: number, before?: string) {
  const segment = roomSegment(roomID)
  if (!segment) return undefined
  const href = requestURL(endpoint, `/rooms/${segment}`)
  if (!href) return undefined
  const url = new URL(href)
  url.searchParams.set("limit", String(pageLimit(limit)))
  if (before !== undefined && before !== "") {
    const token = roomSegment(before)
    if (!token) return undefined
    url.searchParams.set("before", before.trim())
  }
  return url.toString()
}

export type ChatBody =
  | { readonly ok: true; readonly body: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly error: string }

function idValue(value: string) {
  return /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : value
}

/**
 * The continuation body. Only the fields the room contract names are copied; session history, `store`, and Responses
 * fields are never added.
 */
export function chatBody(input: {
  readonly roomID: string
  readonly provider: string
  readonly model: string
  readonly message: string
  readonly effort?: string | null
  readonly projectID?: string | null
  readonly credentialOwnerID?: number | null
  readonly search?: boolean
}): ChatBody {
  const provider = input.provider.trim().toLowerCase()
  if (!RaiRooms.isProvider(provider)) return { ok: false, error: "지원하지 않는 공급자입니다" }
  const model = input.model.trim()
  if (model === "" || model.length > 200 || /[\r\n]/.test(model)) return { ok: false, error: "모델 이름이 올바르지 않습니다" }
  if (typeof input.message !== "string" || input.message.trim() === "") return { ok: false, error: "메시지를 입력하세요" }
  if (input.message.length > 100_000) return { ok: false, error: "메시지가 너무 깁니다" }

  const roomID = input.roomID.trim()
  let room_id: string | number
  if (roomID === "0") room_id = 0
  else if (!roomSegment(roomID)) return { ok: false, error: "대화방 번호가 올바르지 않습니다" }
  else room_id = idValue(roomID)

  const body: Record<string, unknown> = { room_id, provider, model, message: input.message }
  const effort = input.effort?.trim()
  if (effort) {
    if (effort.length > 32 || /[\r\n]/.test(effort)) return { ok: false, error: "추론 단계가 올바르지 않습니다" }
    body.effort = effort
  }
  const projectID = input.projectID?.trim()
  if (projectID) {
    if (!roomSegment(projectID)) return { ok: false, error: "프로젝트 번호가 올바르지 않습니다" }
    body.project_id = idValue(projectID)
  }
  if (input.credentialOwnerID != null) {
    if (!Number.isSafeInteger(input.credentialOwnerID) || input.credentialOwnerID <= 0)
      return { ok: false, error: "구독 번호가 올바르지 않습니다" }
    body.credential_owner_id = input.credentialOwnerID
  }
  // The gateway treats a missing `search` as true. The dialog's off state is false, so the field is always sent.
  body.search = input.search === true
  return { ok: true, body }
}

export type Frame = {
  readonly roomID?: string
  readonly kind:
    | "delta"
    | "thinking"
    | "tool"
    | "tool_done"
    | "notice"
    | "error"
    | "done"
    | "approval"
    | "approval_done"
  readonly text?: string
  readonly label?: string
  readonly ok?: boolean
  readonly name?: string
  readonly approvalID?: string
  readonly title?: string
  readonly purpose?: string
  readonly decision?: string
}

function cap(value: string, max = 4_000) {
  return RaiRooms.displayText(value, max)
}

function stringField(value: unknown) {
  if (typeof value === "string") {
    const trimmed = value.trim()
    return trimmed === "" ? undefined : trimmed
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  return undefined
}

function toolLabel(value: unknown) {
  if (typeof value === "string") {
    const trimmed = value.trim()
    if (trimmed === "" || trimmed.length > 80 || /[\r\n]/.test(trimmed)) return "tool"
    return trimmed
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    const label = stringField(record.label) ?? stringField(record.name)
    if (label && label.length <= 80 && !/[\r\n]/.test(label)) return label
    return "tool"
  }
  return undefined
}

function errorText(value: unknown) {
  if (typeof value === "string") {
    const trimmed = value.trim()
    if (trimmed === "" || trimmed.startsWith("<")) return undefined
    return cap(trimmed, 500)
  }
  if (value && typeof value === "object") {
    const message = stringField((value as Record<string, unknown>).message)
    if (!message || message.startsWith("<")) return undefined
    return cap(message, 500)
  }
  return undefined
}

function toolName(value: unknown) {
  if (typeof value === "string") {
    const trimmed = value.trim()
    return trimmed === "" || trimmed.length > 128 || /[\r\n]/.test(trimmed) ? undefined : trimmed
  }
  if (value && typeof value === "object") {
    const name = stringField((value as Record<string, unknown>).name)
    if (name && name.length <= 128 && !/[\r\n]/.test(name)) return name
  }
  return undefined
}

/**
 * The web app opens an approval card while a server turn waits for a decision. The key can only show it; the
 * decision itself is made in the browser, so this carries the id and the wording and nothing else.
 */
function approvalFrame(value: Record<string, unknown>, roomID: string | undefined): Frame | undefined {
  const id = stringField(value.id)
  if (!id) return undefined
  const title = stringField(value.title)
  const purpose = stringField(value.purpose)
  const decision = stringField(value.decision)
  return {
    kind: "approval",
    approvalID: cap(id, 128),
    ...(title ? { title: cap(title, 200) } : {}),
    ...(purpose ? { purpose: cap(purpose, 200) } : {}),
    ...(decision ? { decision: cap(decision, 32) } : {}),
    roomID,
  }
}

function framesFromObject(value: Record<string, unknown>): Frame[] {
  const roomID = stringField(value.room_id)
  const frames: Frame[] = []
  if (typeof value.delta === "string" && value.delta !== "") frames.push({ kind: "delta", text: cap(value.delta), roomID })
  // Thinking text is intentionally dropped. The dialog may show that thinking happened, not what it said.
  if (value.thinking !== undefined && value.thinking !== null && value.thinking !== "") frames.push({ kind: "thinking", roomID })
  // A `tool_done` may carry the closing line's label; that must not open a second tool line.
  const closesTool = value.tool_done !== undefined
  if (!closesTool && (value.tool !== undefined || typeof value.label === "string")) {
    const label = typeof value.label === "string" && value.label.trim() !== "" ? cap(value.label.trim(), 80) : toolLabel(value.tool)
    const name = toolName(value.tool)
    if (label) frames.push({ kind: "tool", label, ...(name ? { name } : {}), roomID })
  }
  if (value.tool_done !== undefined) {
    const ok = value.ok === true ? true : value.ok === false ? false : undefined
    const name = toolName(value.tool_done)
    const label = stringField(value.label)
    frames.push({ kind: "tool_done", ok, ...(name ? { name } : {}), ...(label ? { label: cap(label, 80) } : {}), roomID })
  }
  const approval = value.approval
  if (approval && typeof approval === "object" && !Array.isArray(approval)) {
    const frame = approvalFrame(approval as Record<string, unknown>, roomID)
    if (frame) frames.push(frame)
  }
  if (value.approval_done !== undefined) {
    const id = stringField(value.approval_done)
    const decision = stringField(value.decision)
    if (id) frames.push({ kind: "approval_done", approvalID: cap(id, 128), ...(decision ? { decision: cap(decision, 32) } : {}), roomID })
  }
  if (typeof value.notice === "string" && value.notice.trim() !== "") frames.push({ kind: "notice", text: cap(value.notice, 500), roomID })
  const error = errorText(value.error)
  if (error) frames.push({ kind: "error", text: error, roomID })
  if (value.done === true) frames.push({ kind: "done", roomID })
  return frames
}

function framesFromBlock(block: string): Frame[] {
  const data: string[] = []
  for (const raw of block.split(/\r?\n/)) {
    if (raw.startsWith(":")) continue
    if (raw.startsWith("data:")) data.push(raw.slice(5).replace(/^ /, ""))
  }
  if (data.length === 0) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(data.join("\n"))
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return []
  return framesFromObject(parsed as Record<string, unknown>)
}

/** Pulls complete SSE blocks. Comment lines, including `: ping`, produce no frames and are not retained. */
export function pushSse(buffer: string, chunk: string) {
  const merged = buffer + chunk
  const parts = merged.split(/\r?\n\r?\n/)
  const rest = parts.pop() ?? ""
  const frames = parts.flatMap(framesFromBlock)
  return { buffer: rest.length > 64_000 ? rest.slice(-64_000) : rest, frames }
}

export function finishSse(buffer: string) {
  const trimmed = buffer.trim()
  if (trimmed === "") return []
  return framesFromBlock(trimmed)
}

export type Auth = { readonly endpoint: string; readonly key: string }

export function keyOf(credential: { readonly type?: string; readonly key?: string } | undefined) {
  if (credential?.type !== "key" || typeof credential.key !== "string" || credential.key === "") return undefined
  return credential.key
}

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function listOf(body: unknown, keys: readonly string[]) {
  if (Array.isArray(body)) return body
  const obj = record(body)
  if (!obj) return undefined
  for (const key of keys) if (Array.isArray(obj[key])) return obj[key]
  return undefined
}

function titleOf(value: Record<string, unknown>, id: string) {
  return stringField(value.title) ?? stringField(value.name) ?? stringField(value.label) ?? id
}

export function parseProjects(body: unknown): RaiRooms.Project[] | undefined {
  const list = listOf(body, ["data", "projects"])
  if (!list) return undefined
  const projects: RaiRooms.Project[] = []
  for (const item of list) {
    const obj = record(item)
    if (!obj) continue
    const id = stringField(obj.id) ?? stringField(obj.project_id)
    if (!id || !roomSegment(id)) continue
    projects.push({ id, title: RaiRooms.displayText(titleOf(obj, id), 200) })
  }
  return projects
}

function boolOf(value: unknown) {
  return value === true || value === 1 || value === "1" || value === "true"
}

export function parseRoom(value: unknown): RaiRooms.Room | undefined {
  const obj = record(value)
  if (!obj) return undefined
  const id = stringField(obj.id) ?? stringField(obj.room_id)
  if (!id || !roomSegment(id)) return undefined
  const perm = stringField(obj.perm)
  return {
    id,
    title: RaiRooms.displayText(titleOf(obj, id), 200),
    projectID: stringField(obj.project_id) ?? null,
    provider: stringField(obj.provider) ?? null,
    model: stringField(obj.model) ?? null,
    updatedAt: stringField(obj.updated_at) ?? stringField(obj.updatedAt) ?? null,
    running: boolOf(obj.running),
    sharedBy: stringField(obj.shared_by) ?? stringField(obj.sharedBy) ?? null,
    perm: perm === "owner" || perm === "write" || perm === "read" ? perm : null,
  }
}

export function parseRooms(body: unknown) {
  const list = listOf(body, ["data", "rooms"])
  if (!list) return undefined
  const rooms: RaiRooms.Room[] = []
  for (const item of list) {
    const room = parseRoom(item)
    if (room) rooms.push(room)
    if (rooms.length >= maxRooms) break
  }
  return rooms
}

function messageText(value: unknown) {
  if (typeof value === "string") return RaiRooms.displayText(value)
  if (Array.isArray(value)) {
    const parts = value.flatMap((part) => {
      if (typeof part === "string") return [part]
      const obj = record(part)
      if (!obj) return []
      if (obj.type === "tool" || obj.tool !== undefined) return []
      const text = stringField(obj.text) ?? stringField(obj.content)
      return text ? [text] : []
    })
    return RaiRooms.displayText(parts.join(""))
  }
  const obj = record(value)
  if (!obj) return ""
  return RaiRooms.displayText(stringField(obj.text) ?? stringField(obj.content) ?? "")
}

function parseMessage(value: unknown, index: number): RaiRooms.Message | undefined {
  const obj = record(value)
  if (!obj) return undefined
  const id = stringField(obj.id) ?? stringField(obj.message_id) ?? `m${index}`
  if (id.includes("..") || id.includes("/") || id.includes("\\")) return undefined
  return {
    id: id.slice(0, 128),
    role: stringField(obj.role) ?? stringField(obj.author) ?? "assistant",
    text: messageText(obj.text ?? obj.content ?? obj.message ?? obj.body),
    createdAt: stringField(obj.created_at) ?? stringField(obj.createdAt) ?? null,
  }
}

export function parsePage(body: unknown): Omit<RaiRooms.Page, "error"> | undefined {
  const obj = record(body)
  if (!obj) return undefined
  const raw = Array.isArray(obj.messages) ? obj.messages : Array.isArray(obj.data) ? obj.data : undefined
  if (!raw) return undefined
  const messages = raw.flatMap((item, index) => {
    const message = parseMessage(item, index)
    return message ? [message] : []
  })
  const hasMore = boolOf(obj.has_more ?? obj.hasMore)
  const oldest = stringField(obj.oldest_id) ?? stringField(obj.oldestID)
  const accessRaw = stringField(obj.access)
  const access = accessRaw === "owner" || accessRaw === "write" || accessRaw === "read" ? accessRaw : null
  return {
    messages,
    hasMore,
    oldestID: oldest ?? (hasMore ? messages[0]?.id ?? null : null),
    access,
    owner: stringField(obj.owner) ?? stringField(record(obj.owner)?.label) ?? stringField(record(obj.owner)?.name) ?? null,
    me: stringField(obj.me) ?? stringField(record(obj.me)?.label) ?? stringField(record(obj.me)?.name) ?? null,
    room: parseRoom(obj.room) ?? null,
  }
}

export function failureFrom(status: number, body: string, scope: Scope) {
  const retry = status === 502 || status === 503 || status === 504
  if (body.trim() === "" || body.trim().startsWith("<")) {
    return new RoomsRequestError(`ROKFOSS AI request failed (${status})`, { status, retry })
  }
  const decoded = Option.getOrUndefined(decodeError(body))
  const error = decoded?.error
  const code = decoded?.code ?? (typeof error === "object" ? error?.code : undefined)
  const message =
    decoded?.message?.trim() ||
    (typeof error === "string" ? error.trim() : error?.message?.trim()) ||
    `ROKFOSS AI request failed (${status})`
  if (message.startsWith("<")) return new RoomsRequestError(`ROKFOSS AI request failed (${status})`, { status, code, retry: false })
  const share = code === "share_limited"
  return new RoomsRequestError(roomsMessage(code, message, scope), {
    status,
    code,
    retry: share || status === 401 || status === 403 || status === 400 || status === 429 ? false : retry,
  })
}

export function authed(request: HttpClientRequest.HttpClientRequest, key: string, accept: "json" | "sse") {
  const withAccept =
    accept === "json"
      ? HttpClientRequest.acceptJson(request)
      : HttpClientRequest.setHeader(request, "Accept", "text/event-stream")
  return HttpClientRequest.setHeader(HttpClientRequest.bearerToken(withAccept, key), "User-Agent", userAgent)
}

export const jsonGet = (http: HttpClient.HttpClient, url: string, auth: Auth, scope: Scope) =>
  Effect.gen(function* () {
    const response = yield* http.execute(authed(HttpClientRequest.get(url), auth.key, "json")).pipe(
      Effect.timeout(listTimeout),
      Effect.mapError(() => new RoomsRequestError("ROKFOSS AI 대화방에 연결하지 못했습니다", { retry: true })),
    )
    const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
    if (response.status < 200 || response.status >= 300) return yield* Effect.fail(failureFrom(response.status, text, scope))
    if (text.trim().startsWith("<")) return yield* Effect.fail(new RoomsRequestError(`ROKFOSS AI request failed (${response.status})`, { status: response.status }))
    try {
      return JSON.parse(text) as unknown
    } catch {
      return yield* Effect.fail(new RoomsRequestError("대화방 응답을 읽지 못했습니다", { status: response.status }))
    }
  })

export const listProjects = (http: HttpClient.HttpClient, auth: Auth) =>
  Effect.gen(function* () {
    const url = requestURL(auth.endpoint, "/projects")
    if (!url) return yield* Effect.fail(new RoomsRequestError("게이트웨이 주소가 올바르지 않습니다"))
    const body = yield* jsonGet(http, url, auth, "rooms_read")
    const projects = parseProjects(body)
    if (!projects) return yield* Effect.fail(new RoomsRequestError("대화방 응답을 읽지 못했습니다"))
    return projects
  })

export const listRooms = (http: HttpClient.HttpClient, auth: Auth) =>
  Effect.gen(function* () {
    const url = requestURL(auth.endpoint, "/rooms")
    if (!url) return yield* Effect.fail(new RoomsRequestError("게이트웨이 주소가 올바르지 않습니다"))
    const body = yield* jsonGet(http, url, auth, "rooms_read")
    const rooms = parseRooms(body)
    if (!rooms) return yield* Effect.fail(new RoomsRequestError("대화방 응답을 읽지 못했습니다"))
    return rooms
  })

export const readMessages = (
  http: HttpClient.HttpClient,
  auth: Auth,
  input: { readonly roomID: string; readonly limit: number; readonly before?: string },
) =>
  Effect.gen(function* () {
    const url = messagesURL(auth.endpoint, input.roomID, input.limit, input.before)
    if (!url) return yield* Effect.fail(new RoomsRequestError("대화방 번호가 올바르지 않습니다"))
    const body = yield* jsonGet(http, url, auth, "rooms_read")
    const page = parsePage(body)
    if (!page) return yield* Effect.fail(new RoomsRequestError("대화방 응답을 읽지 못했습니다"))
    return page
  })

type ToolState = { label: string; done: boolean; ok: boolean | null }

export type Transcript = {
  roomID: string
  text: string
  notice: string | null
  error: string | null
  done: boolean
  thought: boolean
  tools: ToolState[]
}

function blankTranscript(roomID: string): Transcript {
  return { roomID, text: "", notice: null, error: null, done: false, thought: false, tools: [] }
}

function applyFrame(transcript: Transcript, frame: Frame) {
  if (frame.roomID && frame.roomID !== "0") transcript.roomID = frame.roomID
  if (frame.kind === "delta" && frame.text && transcript.text.length < maxText) {
    transcript.text += frame.text.slice(0, maxText - transcript.text.length)
  }
  if (frame.kind === "thinking") transcript.thought = true
  if (frame.kind === "tool" && frame.label && transcript.tools.length < maxTools) {
    transcript.tools.push({ label: frame.label, done: false, ok: null })
  }
  if (frame.kind === "tool_done") {
    const open = [...transcript.tools].reverse().find((tool) => !tool.done)
    if (open) {
      open.done = true
      open.ok = frame.ok ?? null
    }
  }
  if (frame.kind === "notice" && frame.text) transcript.notice = frame.text
  if (frame.kind === "error" && frame.text) transcript.error = frame.text
  if (frame.kind === "done") transcript.done = true
}

export type SseOptions = {
  readonly idleMs?: number
  readonly onFrame?: (frame: Frame) => Effect.Effect<void>
}

/** Reads one SSE body. Ping resets the idle timer. Thinking text never leaves this function. */
export const readSse = (
  response: HttpClientResponse.HttpClientResponse,
  transcript: Transcript,
  options: SseOptions = {},
) =>
  Effect.gen(function* () {
    const idleMs = options.idleMs ?? defaultIdleMs
    const decoder = new TextDecoder()
    let buffer = ""
    let stop = false
    const last = { at: Date.now() }
    const consume = (frames: readonly Frame[]) =>
      Effect.gen(function* () {
        for (const frame of frames) {
          applyFrame(transcript, frame)
          if (options.onFrame) yield* options.onFrame(frame).pipe(Effect.ignore)
          if (frame.kind === "done" || frame.kind === "error") stop = true
        }
      })
    const read = Stream.runForEach(response.stream, (chunk) =>
      Effect.gen(function* () {
        if (stop) return
        last.at = Date.now()
        const text = decoder.decode(chunk, { stream: true })
        if (transcript.text === "" && buffer === "" && text.trim().startsWith("<")) {
          stop = true
          transcript.error = `ROKFOSS AI request failed (${response.status})`
          return
        }
        const pulled = pushSse(buffer, text)
        buffer = pulled.buffer
        yield* consume(pulled.frames)
      }),
    )
    const idle = Effect.gen(function* () {
      const tick = Math.min(1_000, Math.max(10, Math.floor(idleMs / 3)))
      while (!stop) {
        yield* Effect.sleep(Duration.millis(tick))
        if (Date.now() - last.at > idleMs) {
          return yield* Effect.fail(new RoomsRequestError("연결이 끊어졌습니다. 다시 연결할 수 있습니다", { retry: true }))
        }
      }
    })
    yield* Effect.raceFirst(read, idle).pipe(
      Effect.mapError((error) =>
        error instanceof RoomsRequestError
          ? error
          : new RoomsRequestError("연결이 끊어졌습니다. 다시 연결할 수 있습니다", { retry: true }),
      ),
    )
    if (!stop) yield* consume(finishSse(buffer + decoder.decode()))
  })

const openSse = (http: HttpClient.HttpClient, request: HttpClientRequest.HttpClientRequest, scope: Scope) =>
  Effect.gen(function* () {
    const response = yield* http.execute(request).pipe(
      Effect.mapError(() => new RoomsRequestError("연결이 끊어졌습니다. 다시 연결할 수 있습니다", { retry: true })),
    )
    if (response.status === 204) return { response, empty: true as const }
    if (response.status < 200 || response.status >= 300) {
      const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
      return yield* Effect.fail(failureFrom(response.status, text, scope))
    }
    return { response, empty: false as const }
  })

export const postChat = (
  http: HttpClient.HttpClient,
  auth: Auth,
  input: RaiRooms.SendInput,
  options: SseOptions = {},
) =>
  Effect.gen(function* () {
    const built = chatBody(input)
    if (!built.ok) return yield* Effect.fail(new RoomsRequestError(built.error))
    const url = requestURL(auth.endpoint, "/chat")
    if (!url) return yield* Effect.fail(new RoomsRequestError("게이트웨이 주소가 올바르지 않습니다"))
    const request = yield* HttpClientRequest.post(url).pipe(
      (self) => HttpClientRequest.setHeader(self, "Accept", "text/event-stream"),
      (self) => HttpClientRequest.bearerToken(self, auth.key),
      (self) => HttpClientRequest.setHeader(self, "User-Agent", userAgent),
      HttpClientRequest.bodyJson(built.body),
    )
    const opened = yield* openSse(http, request, "rooms_write")
    const transcript = blankTranscript(input.roomID === "0" ? "0" : input.roomID)
    if (opened.empty) {
      transcript.done = true
      return transcript
    }
    yield* readSse(opened.response, transcript, options)
    return transcript
  })

export const watchRoom = (http: HttpClient.HttpClient, auth: Auth, roomID: string, options: SseOptions = {}) =>
  Effect.gen(function* () {
    const segment = roomSegment(roomID)
    const url = segment ? requestURL(auth.endpoint, `/rooms/${segment}/stream`) : undefined
    if (!url) return yield* Effect.fail(new RoomsRequestError("대화방 번호가 올바르지 않습니다"))
    const request = authed(HttpClientRequest.get(url), auth.key, "sse")
    const opened = yield* openSse(http, request, "rooms_read")
    if (opened.empty) return { active: false as const, transcript: blankTranscript(roomID) }
    const transcript = blankTranscript(roomID)
    yield* readSse(opened.response, transcript, options)
    return { active: true as const, transcript }
  })

function userScoped(entry: Document, roots: readonly string[]) {
  if (entry instanceof ConfigIntegration.Document) return false
  if (entry instanceof ConfigIntegration.WellKnownDocument) return false
  const file = entry.path
  return file === undefined || roots.some((root) => FSUtil.contains(root, file))
}

export const resolveEndpoint = Effect.fn("RaiRooms.endpoint")(function* () {
  const environment = parseBaseURL(process.env.RAI_BASE_URL)
  if (environment.url) return environment.url
  const config = yield* Effect.serviceOption(Config.Service)
  if (Option.isNone(config)) return defaultBaseURL
  const global = yield* Effect.serviceOption(Global.Service)
  const roots = Option.isNone(global)
    ? []
    : [path.resolve(global.value.config), path.resolve(ConfigDiscovery.systemDirectory())]
  const entries = (yield* config.value.entries()).filter((entry): entry is Document => entry.type === "document")
  const user = foldSettings(
    entries.filter((entry) => userScoped(entry, roots)),
    providerID,
    undefined,
  )
  const configured = foldSettings(entries, providerID, undefined)
  return pickEndpoint({ user: user?.baseURL, project: configured?.baseURL })
})

export const authorize = (ctx: Context) =>
  Effect.gen(function* () {
    const { credential } = yield* activeCredential(ctx, providerID)
    const key = keyOf(credential)
    if (!key) return yield* Effect.fail(new RoomsRequestError(connectFirst))
    const endpoint = yield* resolveEndpoint()
    return { endpoint, key } satisfies Auth
  })

function toChunk(frame: Frame, roomID: string): RaiRooms.Chunk {
  return {
    roomID: frame.roomID && frame.roomID !== "0" ? frame.roomID : roomID,
    kind: frame.kind,
    text:
      frame.kind === "delta" || frame.kind === "notice" || frame.kind === "error" ? (frame.text ?? null) : null,
    label: frame.kind === "tool" || frame.kind === "tool_done" ? (frame.label ?? null) : null,
    ok: frame.kind === "tool_done" ? (frame.ok ?? null) : null,
    name: frame.kind === "tool" || frame.kind === "tool_done" ? (frame.name ?? null) : null,
    approvalID: frame.kind === "approval" || frame.kind === "approval_done" ? (frame.approvalID ?? null) : null,
    title: frame.kind === "approval" ? (frame.title ?? null) : null,
    purpose: frame.kind === "approval" ? (frame.purpose ?? null) : null,
    decision: frame.kind === "approval" || frame.kind === "approval_done" ? (frame.decision ?? null) : null,
  }
}

function publicMessage(error: unknown) {
  if (error instanceof RoomsRequestError) return error.message
  return "ROKFOSS AI 대화방 요청이 실패했습니다"
}

const emptyPage = (error: string): RaiRooms.Page => ({
  messages: [],
  hasMore: false,
  oldestID: null,
  access: null,
  owner: null,
  me: null,
  room: null,
  error,
})

const emptySend = (roomID: string, error: string): RaiRooms.SendResult => ({
  roomID,
  text: "",
  notice: null,
  error,
  done: false,
  thought: false,
  tools: [],
})

/**
 * Live room text must not use RPC events. `Rpc.emit` publishes on the server bus, and `/api/event` forwards every
 * `rpc.*` event to all connected clients. A mailbox is read only by `take` on the caller's own HTTP response.
 */
type RoomWaiter = Deferred.Deferred<RaiRooms.Chunk | null>
type RoomBox = {
  frames: RaiRooms.Chunk[]
  waiters: RoomWaiter[]
  closed: boolean
  at: number
}
const roomMailboxes = new Map<string, RoomBox>()
const maxRoomMailboxes = 16
const roomMailboxTtlMs = 180_000
const audiencePattern = /^[A-Za-z0-9_-]{22,128}$/

export function audienceOf(value: string | null | undefined) {
  if (!value || !audiencePattern.test(value)) return undefined
  return value
}

function enqueueChunk(box: RoomBox, chunk: RaiRooms.Chunk) {
  if (chunk.kind === "delta" && chunk.text) {
    const last = box.frames.at(-1)
    if (last?.kind === "delta" && last.roomID === chunk.roomID) {
      box.frames[box.frames.length - 1] = { ...last, text: `${last.text ?? ""}${chunk.text}`.slice(0, maxText) }
      return
    }
  }
  box.frames.push(chunk)
  // Only adjacent deltas are merged. A delta folded into the front of the queue would move ahead of the tool or
  // approval lines that arrived between them, and the room renders its lines in arrival order.
  if (box.frames.length <= maxQueuedFrames) return
  box.frames.splice(0, box.frames.length - maxQueuedFrames)
}

function reserveBox(token: string) {
  const existing = roomMailboxes.get(token)
  if (existing && !existing.closed) {
    existing.at = Date.now()
    return existing
  }
  const box: RoomBox = { frames: [], waiters: [], closed: false, at: Date.now() }
  roomMailboxes.set(token, box)
  return box
}

const sweepMailboxes = Effect.gen(function* () {
  const now = Date.now()
  for (const [token, box] of [...roomMailboxes]) {
    if (now - box.at < roomMailboxTtlMs) continue
    box.closed = true
    const waiters = box.waiters.splice(0)
    roomMailboxes.delete(token)
    for (const waiter of waiters) yield* Deferred.succeed(waiter, null).pipe(Effect.ignore)
  }
})

function closeAudience(token: string | undefined) {
  if (!token) return Effect.void
  return Effect.gen(function* () {
    const box = roomMailboxes.get(token)
    if (!box || box.closed) return
    box.closed = true
    box.at = Date.now()
    const waiters = box.waiters.splice(0)
    for (const waiter of waiters) {
      const frame = box.frames.shift() ?? null
      yield* Deferred.succeed(waiter, frame).pipe(Effect.ignore)
    }
  })
}

function deliver(token: string | undefined, chunk: RaiRooms.Chunk) {
  return Effect.gen(function* () {
    if (!token) return
    const box = roomMailboxes.get(token)
    if (!box || box.closed) return
    box.at = Date.now()
    const waiter = box.waiters.shift()
    if (waiter) {
      yield* Deferred.succeed(waiter, chunk).pipe(Effect.ignore)
      return
    }
    enqueueChunk(box, chunk)
  })
}

const onFrame = (roomID: string, token: string | undefined) => (frame: Frame) => deliver(token, toChunk(frame, roomID))

function waitChunk(audience: string) {
  return Effect.gen(function* () {
    yield* sweepMailboxes
    const token = audienceOf(audience)
    const box = token ? roomMailboxes.get(token) : undefined
    if (!box) return { chunk: null, open: false } satisfies RaiRooms.TakeResult
    const queued = box.frames.shift()
    if (queued) return { chunk: queued, open: !box.closed || box.frames.length > 0 } satisfies RaiRooms.TakeResult
    if (box.closed) return { chunk: null, open: false } satisfies RaiRooms.TakeResult
    const waiter = yield* Deferred.make<RaiRooms.Chunk | null>()
    box.waiters.push(waiter)
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        const index = box.waiters.indexOf(waiter)
        if (index >= 0) box.waiters.splice(index, 1)
      }),
    )
    const arrived = yield* Deferred.await(waiter).pipe(
      Effect.timeout("15 seconds"),
      Effect.orElseSucceed(() => null as RaiRooms.Chunk | null),
    )
    const index = box.waiters.indexOf(waiter)
    if (index >= 0) box.waiters.splice(index, 1)
    if (arrived) return { chunk: arrived, open: !box.closed || box.frames.length > 0 } satisfies RaiRooms.TakeResult
    const late = box.frames.shift()
    if (late) return { chunk: late, open: !box.closed || box.frames.length > 0 } satisfies RaiRooms.TakeResult
    if (box.closed) return { chunk: null, open: false } satisfies RaiRooms.TakeResult
    return { chunk: null, open: true } satisfies RaiRooms.TakeResult
  })
}

export function registerRooms(ctx: Context, http: HttpClient.HttpClient) {
  return Effect.gen(function* () {
    const registered = yield* ctx.rpc.register(RaiRooms.Definition, {
      projects: () =>
        authorize(ctx).pipe(
          Effect.flatMap((auth) => listProjects(http, auth)),
          Effect.map((projects) => ({ projects, error: null })),
          Effect.catch((error) => Effect.succeed({ projects: [], error: publicMessage(error) })),
          Effect.catchDefect(() => Effect.succeed({ projects: [], error: "ROKFOSS AI 대화방 요청이 실패했습니다" })),
        ),
      rooms: () =>
        authorize(ctx).pipe(
          Effect.flatMap((auth) => listRooms(http, auth)),
          Effect.map((rooms) => ({ rooms, error: null })),
          Effect.catch((error) => Effect.succeed({ rooms: [], error: publicMessage(error) })),
          Effect.catchDefect(() => Effect.succeed({ rooms: [], error: "ROKFOSS AI 대화방 요청이 실패했습니다" })),
        ),
      messages: (input) =>
        authorize(ctx).pipe(
          Effect.flatMap((auth) =>
            readMessages(http, auth, {
              roomID: input.roomID,
              limit: input.limit,
              before: input.before ?? undefined,
            }),
          ),
          Effect.map((page) => ({ ...page, error: null })),
          Effect.catch((error) => Effect.succeed(emptyPage(publicMessage(error)))),
          Effect.catchDefect(() => Effect.succeed(emptyPage("ROKFOSS AI 대화방 요청이 실패했습니다"))),
        ),
      send: (input) => {
        const token = audienceOf(input.audience)
        if (token) reserveBox(token)
        return authorize(ctx).pipe(
          Effect.flatMap((auth) => postChat(http, auth, input, { onFrame: onFrame(input.roomID, token) })),
          Effect.map((transcript) => ({
            roomID: transcript.roomID,
            text: transcript.text,
            notice: transcript.notice,
            error: transcript.error,
            done: transcript.done,
            thought: transcript.thought,
            tools: transcript.tools,
          })),
          Effect.catch((error) => Effect.succeed(emptySend(input.roomID, publicMessage(error)))),
          Effect.catchDefect(() => Effect.succeed(emptySend(input.roomID, "ROKFOSS AI 대화방 요청이 실패했습니다"))),
          Effect.ensuring(closeAudience(token)),
        )
      },
      watch: (input) => {
        const token = audienceOf(input.audience)
        if (token) reserveBox(token)
        return Effect.gen(function* () {
          const auth = yield* authorize(ctx)
          let last = blankTranscript(input.roomID)
          let active = false
          for (let attempt = 0; attempt <= streamRetries; attempt++) {
            const watched = yield* watchRoom(http, auth, input.roomID, { onFrame: onFrame(input.roomID, token) }).pipe(
              Effect.map((result) => ({ result, dropped: false as const })),
              Effect.catch((error) =>
                error instanceof RoomsRequestError && error.retry
                  ? Effect.succeed({ result: undefined, dropped: true as const, error })
                  : Effect.fail(error),
              ),
            )
            if (watched.dropped) {
              if (attempt === streamRetries) {
                return {
                  roomID: last.roomID,
                  active,
                  reconnect: true,
                  done: last.done,
                  text: last.text,
                  error: null,
                  thought: last.thought,
                } satisfies RaiRooms.WatchResult
              }
              yield* Effect.sleep("1 second")
              continue
            }
            if (!watched.result.active) {
              return {
                roomID: input.roomID,
                active: false,
                reconnect: false,
                done: false,
                text: "",
                error: null,
                thought: false,
              } satisfies RaiRooms.WatchResult
            }
            last = watched.result.transcript
            active = true
            if (last.done || last.error) break
            return {
              roomID: last.roomID,
              active: true,
              reconnect: true,
              done: false,
              text: last.text,
              error: null,
              thought: last.thought,
            } satisfies RaiRooms.WatchResult
          }
          return {
            roomID: last.roomID,
            active,
            reconnect: false,
            done: last.done,
            text: last.text,
            error: last.error,
            thought: last.thought,
          } satisfies RaiRooms.WatchResult
        }).pipe(
          Effect.catch((error) =>
            Effect.succeed({
              roomID: input.roomID,
              active: false,
              reconnect: false,
              done: false,
              text: "",
              error: publicMessage(error),
              thought: false,
            } satisfies RaiRooms.WatchResult),
          ),
          Effect.catchDefect(() =>
            Effect.succeed({
              roomID: input.roomID,
              active: false,
              reconnect: false,
              done: false,
              text: "",
              error: "ROKFOSS AI 대화방 요청이 실패했습니다",
              thought: false,
            } satisfies RaiRooms.WatchResult),
          ),
          Effect.ensuring(closeAudience(token)),
        )
      },
      bind: (input) =>
        authorize(ctx).pipe(
          Effect.flatMap(() => sweepMailboxes),
          Effect.map(() => {
            const token = audienceOf(input.audience)
            if (!token) return { ok: false }
            if (!roomMailboxes.has(token) && roomMailboxes.size >= maxRoomMailboxes) return { ok: false }
            reserveBox(token)
            return { ok: true }
          }),
          Effect.orElseSucceed(() => ({ ok: false })),
          Effect.catchDefect(() => Effect.succeed({ ok: false })),
        ),
      take: (input) =>
        authorize(ctx).pipe(
          Effect.flatMap(() => Effect.scoped(waitChunk(input.audience))),
          Effect.orElseSucceed(() => ({ chunk: null, open: false })),
          Effect.catchDefect(() => Effect.succeed({ chunk: null, open: false })),
        ),
      // The token is the capability. Closing must still work if the key check fails, or a dropped dialog waits out the TTL.
      release: (input) => closeAudience(audienceOf(input.audience)).pipe(Effect.as({ ok: true })),
    })
    return registered
  })
}

export const RaiRoomsPlugin = define({
  id: "opencode.provider.rai.rooms",
  effect: Effect.fn("RaiRooms.Plugin")(function* (ctx) {
    const http = yield* HttpClient.HttpClient
    // Registration only. A room is fetched when /rooms asks, never at startup, and never written to storage.
    yield* registerRooms(ctx, http).pipe(Effect.orDie)
  }),
}) satisfies PluginInternal.InternalPlugin
