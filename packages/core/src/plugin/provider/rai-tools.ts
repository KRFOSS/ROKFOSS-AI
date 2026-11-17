import { SystemPart, ToolFailure } from "@opencode/ai/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { Tool } from "@opencode/schema/tool"
import { Duration, Effect, FiberSet, type JsonSchema, Option, Schedule, Schema, Semaphore, Stream } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { authed, authorize, failureFrom, requestURL, roomSegment, RoomsRequestError, type Auth } from "./rai-rooms.js"
import { ProviderRefresh } from "./refresh.js"

/**
 * RAI room tools (box and integrated-system tools of the ROKFOSS AI room a session is bound to). Registered by the
 * RAI turns plugin so the tools see the same session → room bindings. See the contract in docs/rai-api.md.
 *
 * - `GET /tools` lists what the key's account may call; each becomes `rai_<name>`.
 * - `POST /rooms/{id}/tools/call` runs one in the room's box. A `rai.tool_approval` answer is asked through
 *   OpenCode's permission prompt, then the same call is repeated with the approval token.
 * - Only sessions bound to a room see the tools; an unbound session's request has them removed.
 */

export const prefix = "rai_"
export const descriptionPrefix = "[RAI 대화방] "
export const approvalAction = "rai_tool"
export const unboundMessage = "RAI 대화방에 묶인 세션에서만 쓸 수 있습니다"
export const rejectedMessage = "사용자가 거절했습니다"
const scopeMessage = "RAI 키에 「대화방 도구」(rooms_tools) 권한이 없습니다 — RAI 앱의 키 설정에서 켜 주세요"
/** List refresh period. A new key or a changed tool switch shows up within this time. */
const refreshEvery = Duration.minutes(3)
const listTimeout = Duration.seconds(15)
/** The server pings every 10 seconds while a tool runs; this long without a byte means the stream is gone. */
const idleMs = 60_000
/** One answer, images included. The server caps request bodies at 8 MiB; answers carry base64 images. */
const maxBody = 32 * 1024 * 1024
const maxTools = 200
const maxDescription = 8_000
/** Model APIs cap function names at 64 characters, so `rai_<name>` must fit: the server name gets 60. */
const maxID = 64
const NAME = /^[a-z][a-z0-9_]*$/
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))
const imageMimes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])

export type RaiTool = {
  readonly name: string
  readonly description: string
  readonly parameters: Readonly<Record<string, unknown>>
  readonly group: string
  readonly approval: "never" | "ask"
}

export type ToolContent = { readonly type: "text"; readonly text: string } | Tool.FileContent

export type Approval = {
  readonly type: "approval"
  readonly token: string
  readonly tool: string
  readonly title: string
  /** What the model said the call is for, as written by the model. */
  readonly purpose?: string
  /** What the server checked and will do, written by the server — shown apart from the model's purpose. */
  readonly details?: readonly string[]
  /** The content that will be sent (a GitHub change, for example), cut by the server. */
  readonly preview?: string
  readonly expiresIn?: number
}

export type Outcome =
  | { readonly type: "result"; readonly content: readonly ToolContent[]; readonly isError: boolean }
  | Approval

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function str(value: unknown) {
  return typeof value === "string" ? value : undefined
}

/** `shell_run` → `rai_shell_run`. Names outside the pattern, or whose id would pass 64 characters, are refused. */
export function toolID(name: string) {
  const id = `${prefix}${name}`
  return NAME.test(name) && id.length <= maxID ? id : undefined
}

/** `rai_shell_run` → `shell_run`, for ids this plugin registered. */
export function serverName(id: string) {
  if (!id.startsWith(prefix)) return undefined
  const name = id.slice(prefix.length)
  return toolID(name) ? name : undefined
}

/** A tool's argument schema. Anything but an object schema becomes an empty object schema. */
export function parametersOf(value: unknown): Readonly<Record<string, unknown>> {
  const schema = record(value)
  if (!schema || schema.type !== "object") return { type: "object", properties: {} }
  return record(schema.properties) ? schema : { ...schema, properties: {} }
}

/**
 * `GET /tools` body. Undefined when it is not a list. Bad entries and duplicate names are skipped; names that cannot
 * become a tool id are returned in `skipped` so the caller can log them.
 */
export function parseTools(body: unknown): { readonly tools: RaiTool[]; readonly skipped: string[] } | undefined {
  const root = record(body)
  const data = Array.isArray(body) ? body : root?.data
  if (!Array.isArray(data)) return undefined
  const seen = new Set<string>()
  const tools: RaiTool[] = []
  const skipped: string[] = []
  for (const item of data) {
    if (tools.length >= maxTools) break
    const entry = record(item)
    const name = str(entry?.name)
    if (!entry || !name || seen.has(name)) continue
    if (!toolID(name)) {
      skipped.push(name.slice(0, 100))
      continue
    }
    seen.add(name)
    tools.push({
      name,
      description: (str(entry.description) ?? "").slice(0, maxDescription),
      parameters: parametersOf(entry.parameters),
      group: str(entry.group) ?? "",
      approval: entry.approval === "ask" ? "ask" : "never",
    })
  }
  return { tools, skipped }
}

/** Same names, descriptions, and schemas: the registry need not reload. */
export function sameTools(left: readonly RaiTool[], right: readonly RaiTool[]) {
  return left.length === right.length && JSON.stringify(left) === JSON.stringify(right)
}

/** The description OpenCode shows the model. */
export function describeTool(tool: RaiTool) {
  const text = tool.description.trim() || tool.name
  return `${descriptionPrefix}${text}`
}

/** `POST /rooms/{id}/tools/call` body. */
export function callBody(name: string, args: unknown, token?: string) {
  const argumentsValue = record(args) ?? {}
  return token ? { name, arguments: argumentsValue, approval_token: token } : { name, arguments: argumentsValue }
}

/**
 * The last `data:` event of an SSE body. Comment lines (`: ping`) are skipped; multi-line data is joined with `\n`.
 * Undefined when the body has no data event, so a plain JSON body can be read as is.
 */
export function lastSseData(text: string) {
  let last: string | undefined
  for (const block of text.split(/\r?\n\r?\n/)) {
    const lines = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(line.startsWith("data: ") ? 6 : 5))
    if (lines.length > 0) last = lines.join("\n")
  }
  return last
}

/** Tool result content: text stays text, images become files the model can see, anything else a marker. */
export function contentOf(value: unknown): ToolContent[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item): ToolContent[] => {
    const part = record(item)
    if (!part) return []
    if (part.type === "text") {
      const text = str(part.text)
      return text === undefined ? [] : [{ type: "text", text }]
    }
    if (part.type === "image") {
      const mime = (str(part.mime_type) ?? str(part.mimeType) ?? "").split(";", 1)[0].trim().toLowerCase()
      const data = str(part.data)
      if (data && imageMimes.has(mime) && /^[A-Za-z0-9+/=\s]+$/.test(data))
        return [{ type: "file", uri: `data:${mime};base64,${data.replace(/\s+/g, "")}`, mime }]
      return [{ type: "text", text: "[그림]" }]
    }
    return []
  })
}

/** An error object sent as an SSE event after the stream began. */
function errorOf(root: Record<string, unknown>) {
  const error = root.error
  if (error === undefined) return undefined
  const body = record(error)
  const code = str(body?.code) ?? str(root.code)
  const message = str(body?.message)?.trim() || str(error)?.trim() || "RAI 대화방 도구를 실행하지 못했습니다"
  return new RoomsRequestError(code === "scope_missing" ? scopeMessage : message, { code })
}

/** `rai.tool_result` or `rai.tool_approval`. Fails with the server's error when the body is an error object. */
export function parseOutcome(body: unknown): Outcome | RoomsRequestError {
  const root = record(body)
  if (!root) return new RoomsRequestError("대화방 도구 응답을 읽지 못했습니다")
  const error = errorOf(root)
  if (error) return error
  if (root.object === "rai.tool_approval") {
    const token = str(root.approval_token)?.trim()
    if (!token) return new RoomsRequestError("대화방 도구 허가 응답에 토큰이 없습니다")
    const tool = str(root.tool) ?? ""
    const purpose = str(root.purpose)?.trim()
    const details = (Array.isArray(root.details) ? root.details : typeof root.details === "string" ? [root.details] : [])
      .flatMap((line) => (typeof line === "string" && line.trim() !== "" ? [line.trim().slice(0, 2_000)] : []))
      .slice(0, 40)
    const preview = str(root.preview)?.trim().slice(0, 20_000)
    const expires = typeof root.expires_in === "number" && Number.isFinite(root.expires_in) ? root.expires_in : undefined
    return {
      type: "approval",
      token,
      tool,
      title: str(root.title)?.trim() || `${tool || "도구"} 실행 허가`,
      ...(purpose ? { purpose } : {}),
      ...(details.length > 0 ? { details } : {}),
      ...(preview ? { preview } : {}),
      ...(expires === undefined ? {} : { expiresIn: expires }),
    }
  }
  if (root.object === "rai.tool_result" || Array.isArray(root.content))
    return { type: "result", content: contentOf(root.content), isError: root.is_error === true }
  return new RoomsRequestError("대화방 도구 응답을 읽지 못했습니다")
}

/** Reads a whole call answer, SSE or plain JSON, into an outcome. */
export function outcomeFromText(text: string): Outcome | RoomsRequestError {
  const trimmed = text.trim()
  if (trimmed.startsWith("<")) return new RoomsRequestError("대화방 도구 응답을 읽지 못했습니다")
  const data = lastSseData(text) ?? trimmed
  if (data === "") return new RoomsRequestError("대화방 도구가 결과 없이 끝났습니다")
  return Option.match(decodeJson(data), {
    onNone: () => new RoomsRequestError("대화방 도구 응답을 읽지 못했습니다"),
    onSome: parseOutcome,
  })
}

/** A failure answer, with the tools scope named for `scope_missing`. */
export function toolsFailure(status: number, body: string) {
  const failure = failureFrom(status, body, "rooms_read")
  if (failure.code !== "scope_missing") return failure
  return new RoomsRequestError(scopeMessage, { status, code: failure.code })
}

export const isApprovalInvalid = (error: unknown) =>
  error instanceof RoomsRequestError && error.code === "approval_invalid"

/** How many times one call may be asked about: the server asks again when its plan changed after an approval. */
export const maxApprovals = 3

/**
 * Runs one call with the approval flow: a `rai.tool_approval` answer is asked through `approve`, then the same call
 * is repeated with the token. If the server's plan changed in between it answers with a new approval, which is asked
 * again (up to `maxApprovals`). `approval_invalid` (token expired, server restarted) starts over once. The token only
 * ever travels between this function and the server; the model never sees it.
 */
export const callWithApproval = <E>(input: {
  readonly call: (token?: string) => Effect.Effect<Outcome, RoomsRequestError | E>
  readonly approve: (approval: Approval) => Effect.Effect<void, E>
}) => {
  const attempt = (again: boolean): Effect.Effect<Extract<Outcome, { type: "result" }>, RoomsRequestError | E> =>
    Effect.gen(function* () {
      let outcome = yield* input.call()
      for (let asked = 0; outcome.type === "approval"; asked++) {
        if (asked >= maxApprovals)
          return yield* Effect.fail(new RoomsRequestError("허가한 뒤에도 서버가 계속 다시 허가를 요청했습니다"))
        yield* input.approve(outcome)
        const next = yield* input.call(outcome.token).pipe(
          Effect.catchIf(
            (error): error is RoomsRequestError => again && isApprovalInvalid(error),
            () => Effect.succeed(undefined),
          ),
        )
        if (next === undefined) return yield* attempt(false)
        outcome = next
      }
      return outcome
    })
  return attempt(true)
}

/** Lists the tools. 401/403/404 mean "no tools for this key"; other failures keep the last list. */
export const fetchTools = (http: HttpClient.HttpClient, auth: Auth) =>
  Effect.gen(function* () {
    const url = requestURL(auth.endpoint, "/tools")
    if (!url) return []
    const response = yield* http
      .execute(authed(HttpClientRequest.get(url), auth.key, "json"))
      .pipe(Effect.timeout(listTimeout), Effect.option)
    if (response._tag === "None") return undefined
    const text = yield* response.value.text.pipe(Effect.orElseSucceed(() => ""))
    const status = response.value.status
    if (status === 401 || status === 403 || status === 404) {
      // No tools for this key. Said once in the log, so "the model does not know the RAI tools" can be traced to the key.
      const code = toolsFailure(status, text).code
      yield* Effect.logWarning("RAI room tools are not available for this key", { status, code })
      return []
    }
    if (status < 200 || status >= 300) {
      yield* Effect.logWarning("RAI room tool list failed; keeping the last list", { status })
      return undefined
    }
    const listed = Option.match(decodeJson(text), { onNone: () => undefined, onSome: parseTools })
    if (!listed) return undefined
    if (listed.skipped.length > 0)
      yield* Effect.logWarning("Skipping RAI room tools whose names do not fit a tool id", { skipped: listed.skipped })
    return listed.tools
  })

/** Reads the body with an idle timer: pings keep it alive, silence past `idleMs` fails. */
const readBody = (stream: Stream.Stream<Uint8Array, unknown>) =>
  Effect.gen(function* () {
    const decoder = new TextDecoder()
    let text = ""
    let size = 0
    let done = false
    const last = { at: Date.now() }
    const read = Stream.runForEach(stream, (chunk) =>
      Effect.gen(function* () {
        last.at = Date.now()
        size += chunk.byteLength
        if (size > maxBody) return yield* Effect.fail(new RoomsRequestError("대화방 도구 결과가 너무 큽니다"))
        text += decoder.decode(chunk, { stream: true })
      }),
    ).pipe(Effect.ensuring(Effect.sync(() => (done = true))))
    const idle = Effect.gen(function* () {
      while (!done) {
        yield* Effect.sleep(Duration.seconds(1))
        if (Date.now() - last.at > idleMs)
          return yield* Effect.fail(new RoomsRequestError("대화방 도구 연결이 끊어졌습니다"))
      }
    })
    yield* Effect.raceFirst(read, idle).pipe(
      Effect.mapError((error) =>
        error instanceof RoomsRequestError ? error : new RoomsRequestError("대화방 도구 연결이 끊어졌습니다"),
      ),
    )
    return text + decoder.decode()
  })

export const postCall = (http: HttpClient.HttpClient, auth: Auth, url: string, body: ReturnType<typeof callBody>) =>
  Effect.gen(function* () {
    const request = yield* HttpClientRequest.bodyJson(authed(HttpClientRequest.post(url), auth.key, "sse"), body).pipe(
      Effect.mapError(() => new RoomsRequestError("대화방 도구 요청을 만들지 못했습니다")),
    )
    const response = yield* http
      .execute(request)
      .pipe(Effect.mapError(() => new RoomsRequestError("ROKFOSS AI 대화방에 연결하지 못했습니다")))
    if (response.status < 200 || response.status >= 300) {
      const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
      return yield* Effect.fail(toolsFailure(response.status, text))
    }
    const outcome = outcomeFromText(yield* readBody(response.stream))
    if (outcome instanceof RoomsRequestError) return yield* Effect.fail(outcome)
    return outcome
  })

/** Local tools that act on the user's own computer, as opposed to the room's box. */
const localToolNames = ["shell", "bash", "read", "write", "edit", "patch", "glob", "grep"]

/**
 * The note a bound session's model gets: the room's box (the same Linux box the web AI uses, with /work, /project and
 * the box's own git setup) is reached only through the rai_ tools; the unprefixed tools run on the user's computer.
 * Only tools that are actually offered are named.
 */
export function roomToolsGuide(raiTools: readonly string[], allTools: readonly string[]): string | undefined {
  const has = (name: string) => raiTools.includes(name)
  const named = (names: string[]) => names.filter(has).join(", ")
  const box = [
    named(["rai_shell_run", "rai_shell_job_start", "rai_shell_job"]) && `명령은 ${named(["rai_shell_run", "rai_shell_job_start", "rai_shell_job"])}`,
    named(["rai_shell_read_file", "rai_shell_write_file", "rai_shell_edit_file", "rai_search", "rai_fetch"]) &&
      `파일은 ${named(["rai_shell_read_file", "rai_shell_write_file", "rai_shell_edit_file", "rai_search", "rai_fetch"])}`,
    named(["rai_shell_outputs"]) && "결과 파일 공유는 rai_shell_outputs",
  ].filter(Boolean)
  if (box.length === 0) return undefined
  const local = localToolNames.filter((name) => allTools.includes(name))
  return [
    "이 세션은 ROKFOSS AI 대화방에 묶여 있습니다. 그 방의 터미널 상자 — 웹의 AI 가 쓰는 것과 같은 리눅스 상자로, /work 작업 폴더, /project 프로젝트 자료, 상자 안의 git 설정·인증이 여기에 있습니다 — 는 이름이 rai_ 로 시작하는 도구로만 다룹니다.",
    `${box.join(", ")} 를 씁니다.`,
    local.length > 0
      ? `rai_ 가 붙지 않은 ${local.join(", ")} 도구는 사용자의 컴퓨터(로컬)에서 돌며, 그 상자와는 파일·저장소·인증이 다릅니다. 대화방·상자·/work·/project 의 일에는 rai_ 도구를 쓰고, 로컬 도구로 본 결과를 상자의 상태로 여기지 마세요.`
      : "",
  ]
    .filter(Boolean)
    .join("\n")
}

export function registerRaiTools(
  ctx: Context,
  http: HttpClient.HttpClient,
  roomOf: (sessionID: string) => Effect.Effect<string | undefined>,
) {
  return Effect.gen(function* () {
    let tools: readonly RaiTool[] = []
    let names = new Set<string>()

    const execute = (tool: RaiTool, input: unknown, context: Tool.Context) =>
      Effect.gen(function* () {
        const roomID = yield* roomOf(context.sessionID)
        const segment = roomID ? roomSegment(roomID) : undefined
        if (!roomID || !segment) return yield* new ToolFailure({ message: unboundMessage })
        const auth = yield* authorize(ctx).pipe(Effect.mapError((error) => new ToolFailure({ message: error.message })))
        const url = requestURL(auth.endpoint, `/rooms/${segment}/tools/call`)
        if (!url) return yield* new ToolFailure({ message: "게이트웨이 주소가 올바르지 않습니다" })
        const id = toolID(tool.name) ?? tool.name
        const result = yield* callWithApproval<Tool.Error>({
          call: (token) => postCall(http, auth, url, callBody(tool.name, input, token)),
          // A plain rejection ends the step like any other tool; a rejection with feedback fails the call with it.
          approve: (approval) =>
            ctx.permission
              .assert({
                sessionID: context.sessionID,
                agent: context.agent,
                action: approvalAction,
                resources: [id],
                save: [id],
                metadata: {
                  tool: id,
                  title: approval.title,
                  ...(approval.purpose ? { purpose: approval.purpose } : {}),
                  ...(approval.details ? { details: approval.details } : {}),
                  ...(approval.preview ? { preview: approval.preview } : {}),
                  roomID,
                },
                source: { type: "tool", messageID: context.messageID, id: context.id },
              })
              .pipe(
                Effect.mapError(
                  (error) =>
                    new ToolFailure({ message: `${rejectedMessage}: ${error.message}`, error }) as Tool.Error,
                ),
              ),
        }).pipe(
          Effect.mapError((error) =>
            error instanceof RoomsRequestError ? new ToolFailure({ message: error.message }) : error,
          ),
        )
        const text = result.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
        if (result.isError)
          return yield* new ToolFailure({ message: text.join("\n").trim() || `${id} 도구가 실패했습니다` })
        return {
          content: result.content.length > 0 ? result.content : [{ type: "text" as const, text: "(출력 없음)" }],
          metadata: { roomID, tool: tool.name },
        }
      })

    yield* ctx.tool.transform((editor) => {
      for (const tool of tools) {
        const name = toolID(tool.name)
        if (!name) continue
        editor.add({
          name,
          // Direct tools, so the session context hook below can hide them from unbound sessions.
          options: { codemode: false },
          description: describeTool(tool),
          input: tool.parameters as JsonSchema.JsonSchema,
          execute: (input, context) => execute(tool, input, context),
        })
      }
    })

    // Hide the tools from sessions that are not bound to a room; execution checks the binding again. A bound session
    // is told which tools reach the room's box, so the model does not take the local shell for the box.
    yield* ctx.session.hook("context", (event) =>
      Effect.gen(function* () {
        const present = Object.keys(event.tools).filter((name) => names.has(name))
        if (present.length === 0) return
        if (yield* roomOf(event.sessionID)) {
          const guide = roomToolsGuide(present, Object.keys(event.tools))
          if (guide) event.system.push(SystemPart.make(guide))
          return
        }
        for (const name of present) delete event.tools[name]
      }),
    )

    // The timer and a key switch can overlap; one refresh at a time keeps the list and the registry in step.
    const lock = Semaphore.makeUnsafe(1)
    const refresh = lock
      .withPermit(
        Effect.gen(function* () {
          const auth = yield* authorize(ctx).pipe(Effect.option)
          const next = auth._tag === "None" ? [] : yield* fetchTools(http, auth.value)
          if (next === undefined || sameTools(next, tools)) return
          tools = next
          names = new Set(next.flatMap((tool) => toolID(tool.name) ?? []))
          yield* ctx.tool.reload()
        }),
      )
      .pipe(Effect.catchCause(() => Effect.void))

    yield* refresh.pipe(Effect.repeat(Schedule.spaced(refreshEvery)), Effect.forkScoped)
    // A newly saved or removed key shows or hides the tools at once instead of at the next timer tick.
    const background = yield* FiberSet.make()
    yield* ProviderRefresh.onSwitch("rai", FiberSet.run(background, refresh))
  })
}
