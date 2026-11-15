import { TextAttributes, type ScrollBoxRenderable, type TextareaRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { randomBytes } from "node:crypto"
import { RaiRooms } from "@opencode/schema/rai-rooms"
import { batch, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useCursorStyle } from "../config"
import { useClient } from "../context/client"
import { useData } from "../context/data"
import { Keymap } from "../context/keymap"
import { useLocal } from "../context/local"
import { useLocation } from "../context/location"
import { useTheme } from "../context/theme"
import { t } from "../i18n"
import { DialogHeader, DialogLayout, useDialog } from "../ui/dialog"
import type { JsonValue } from "@opencode/client"

type View = "list" | "thread"
type Line = { readonly id: string; readonly role: string; readonly text: string }

const rpcID = "opencode.rai.rooms"
const maxLines = 180
const maxChars = 48_000

function remember(lines: readonly Line[]) {
  const capped = lines.slice(-maxLines)
  let chars = 0
  const kept: Line[] = []
  for (let index = capped.length - 1; index >= 0; index--) {
    const line = capped[index]
    if (!line) continue
    chars += line.text.length
    if (chars > maxChars && kept.length > 0) break
    kept.push(line)
  }
  return kept.reverse()
}

function splitModel(modelID: string | undefined) {
  if (!modelID) return undefined
  const slash = modelID.indexOf("/")
  if (slash <= 0) return undefined
  const provider = modelID.slice(0, slash)
  const model = modelID.slice(slash + 1)
  if (!RaiRooms.isProvider(provider) || model.trim() === "") return undefined
  return { provider, model }
}

/**
 * `/rooms` — project and room list, paged history, and POST /chat continuation.
 * Transcripts live in component memory only. Closing the dialog drops them.
 * Live deltas come from `take` on this client's RPC calls, never from the shared event stream.
 */
export function DialogRooms() {
  const client = useClient()
  const data = useData()
  const location = useLocation()
  const local = useLocal()
  const dialog = useDialog()
  const theme = useTheme().surface("dialog")
  const cursorStyle = useCursorStyle()
  const dimensions = useTerminalDimensions()
  const directory = location.current?.directory ?? data.location.default().directory
  const height = () => Math.max(6, Math.floor(dimensions().height * 0.45))

  const [view, setView] = createSignal<View>("list")
  const [loading, setLoading] = createSignal(true)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  const [projects, setProjects] = createSignal<RaiRooms.Project[]>([])
  const [rooms, setRooms] = createSignal<RaiRooms.Room[]>([])
  const [projectIndex, setProjectIndex] = createSignal(0)
  const [index, setIndex] = createSignal(0)
  const [roomID, setRoomID] = createSignal("0")
  const [title, setTitle] = createSignal("New room")
  const [access, setAccess] = createSignal<string | null>(null)
  const [hasMore, setHasMore] = createSignal(false)
  const [oldestID, setOldestID] = createSignal<string | null>(null)
  const [lines, setLines] = createSignal<Line[]>([])
  const [provider, setProvider] = createSignal<RaiRooms.Provider>("xai")
  const [model, setModel] = createSignal("")
  const [draft, setDraft] = createSignal("")
  const [search, setSearch] = createSignal(false)
  const [live, setLive] = createSignal(false)
  const [phase, setPhase] = createSignal("")
  let streamed = false
  let liveText = ""
  let streamToken: string | undefined
  let scroll: ScrollBoxRenderable | undefined
  let textarea: TextareaRenderable | undefined
  let disposed = false
  const calls = new AbortController()

  dialog.setSize("xlarge")
  onCleanup(() => {
    disposed = true
    const token = streamToken
    streamToken = undefined
    calls.abort()
    if (!token) return
    void client.api.rpc
      .call({ rpcID, method: "release", input: { audience: token }, location: { directory } })
      .catch(() => undefined)
  })

  const projectChoices = createMemo(() => [{ id: "", title: t("All projects") }, ...projects()])
  const selectedProject = () => projectChoices()[projectIndex()]?.id || undefined
  const visibleRooms = createMemo(() => {
    const projectID = selectedProject()
    const all = rooms()
    return projectID ? all.filter((room) => room.projectID === projectID) : all
  })
  const writable = () => RaiRooms.canSend(access())

  async function call<T>(method: string, input: Record<string, unknown>) {
    const result = await client.api.rpc.call(
      {
        rpcID,
        method,
        input: input as JsonValue,
        location: { directory },
      },
      { signal: calls.signal },
    )
    return result.output as T
  }

  function showError(cause: unknown) {
    const message = cause instanceof Error ? cause.message : t("Could not load rooms.")
    if (message.includes("rai-")) {
      setError(t("Could not load rooms."))
      return
    }
    setError(message)
  }

  async function refresh() {
    setLoading(true)
    setError("")
    try {
      const [listedProjects, listedRooms] = await Promise.all([
        call<RaiRooms.ProjectsResult>("projects", {}),
        call<RaiRooms.RoomsResult>("rooms", {}),
      ])
      if (disposed) return
      batch(() => {
        setProjects([...listedProjects.projects])
        setRooms([...listedRooms.rooms])
        setError(listedProjects.error ?? listedRooms.error ?? "")
        setIndex(0)
      })
    } catch (cause) {
      if (!disposed) showError(cause)
    } finally {
      if (!disposed) setLoading(false)
    }
  }

  function adoptModel(nextProvider: string | null, nextModel: string | null) {
    if (nextProvider && RaiRooms.isProvider(nextProvider)) setProvider(nextProvider)
    if (nextModel) setModel(nextModel)
  }

  function pushLine(line: Line) {
    setLines((current) => remember([...current, line]))
    queueMicrotask(() => scroll?.scrollTo(Infinity))
  }

  function appendDelta(text: string) {
    const clean = RaiRooms.displayText(text)
    if (!clean) return
    liveText += clean
    setLines((current) => {
      const last = current.at(-1)
      if (last?.role === "assistant" && last.id.startsWith("live-")) {
        const next = current.slice(0, -1)
        next.push({ ...last, text: RaiRooms.displayText(last.text + clean, 8_000) })
        return remember(next)
      }
      return remember([...current, { id: `live-${Date.now()}`, role: "assistant", text: clean }])
    })
    queueMicrotask(() => scroll?.scrollTo(Infinity))
  }

  function finishLive(text: string | null | undefined) {
    if (!text) return
    const clean = RaiRooms.displayText(text)
    if (!clean) return
    if (liveText && clean.startsWith(liveText)) {
      const rest = clean.slice(liveText.length)
      if (rest) appendDelta(rest)
      return
    }
    if (!liveText) appendDelta(clean)
  }

  function mintAudience() {
    return randomBytes(16).toString("base64url")
  }

  async function pump(token: string) {
    while (!disposed && streamToken === token) {
      let next: RaiRooms.TakeResult | undefined
      try {
        next = await call<RaiRooms.TakeResult>("take", { audience: token })
      } catch {
        return
      }
      if (disposed || streamToken !== token || !next) return
      if (next.chunk) applyChunk(next.chunk)
      if (!next.open && !next.chunk) return
    }
  }

  async function openStream() {
    const token = mintAudience()
    try {
      const armed = await call<RaiRooms.BindResult>("bind", { audience: token })
      if (!armed.ok) return undefined
    } catch {
      return undefined
    }
    streamToken = token
    const pumping = pump(token)
    return {
      token,
      done: async () => {
        await call("release", { audience: token }).catch(() => undefined)
        await pumping
        if (streamToken === token) streamToken = undefined
      },
    }
  }

  async function openRoom(room: RaiRooms.Room) {
    setView("thread")
    setRoomID(room.id)
    setTitle(room.title)
    setAccess(room.perm)
    setLines([])
    setHasMore(false)
    setOldestID(null)
    adoptModel(room.provider, room.model)
    await loadMessages(room.id, null, false)
    if (room.running) void follow(room.id)
  }

  async function loadMessages(id: string, before: string | null, older: boolean) {
    setBusy(true)
    setError("")
    try {
      const page = await call<RaiRooms.Page>("messages", { roomID: id, limit: 40, before })
      if (disposed) return
      if (page.error) {
        setError(page.error)
        return
      }
      const incoming = page.messages.map((message) => ({
        id: message.id,
        role: message.role,
        text: RaiRooms.displayText(message.text),
      }))
      batch(() => {
        setLines((current) => remember(older ? [...incoming, ...current] : incoming))
        setHasMore(page.hasMore)
        setOldestID(page.oldestID)
        if (page.access) setAccess(page.access)
        if (page.room) {
          setTitle(page.room.title)
          adoptModel(page.room.provider, page.room.model)
        }
      })
    } catch (cause) {
      if (!disposed) showError(cause)
    } finally {
      if (!disposed) setBusy(false)
    }
  }

  function applyChunk(chunk: RaiRooms.Chunk) {
    streamed = true
    if (chunk.roomID && chunk.roomID !== "0" && (roomID() === "0" || roomID() === chunk.roomID)) {
      if (roomID() === "0") setRoomID(chunk.roomID)
    } else if (chunk.roomID !== roomID()) return
    if (chunk.kind === "delta" && chunk.text) {
      setPhase("")
      appendDelta(chunk.text)
    } else if (chunk.kind === "thinking") setPhase(t("thinking…"))
    else if (chunk.kind === "tool" && chunk.label) setPhase(`${t("Tool")}: ${RaiRooms.displayText(chunk.label, 80)}`)
    else if (chunk.kind === "tool_done") setPhase("")
    else if (chunk.kind === "notice" && chunk.text) pushLine({ id: `notice-${Date.now()}`, role: "notice", text: RaiRooms.displayText(chunk.text, 500) })
    else if (chunk.kind === "error" && chunk.text) setError(RaiRooms.displayText(chunk.text, 500))
    else if (chunk.kind === "done") setPhase("")
  }

  onMount(() => {
    const current = local.model.current()
    const split = current?.providerID === "rai" ? splitModel(current.modelID) : undefined
    if (split) {
      setProvider(split.provider)
      setModel(split.model)
    }
    void refresh()
  })

  async function follow(id: string) {
    streamed = false
    liveText = ""
    if (!live() && !rooms().find((room) => room.id === id)?.running) return
    const stream = await openStream()
    try {
      const watched = await call<RaiRooms.WatchResult>("watch", { roomID: id, audience: stream?.token ?? null }).catch(
        (cause: unknown) => {
          if (!disposed) showError(cause)
          return undefined
        },
      )
      if (disposed || !watched || watched.error) {
        if (watched?.error) setError(watched.error)
        return
      }
      finishLive(watched.text)
      if (watched.thought) setPhase(t("thinking…"))
      if (watched.reconnect && live()) {
        setTimeout(() => {
          if (!disposed && live()) void follow(roomID())
        }, 1_000)
      }
    } finally {
      await stream?.done()
    }
  }

  async function send() {
    const message = (textarea?.plainText ?? draft()).trim()
    if (!message || busy()) return
    if (!writable()) {
      setError(t("Read only"))
      return
    }
    if (!model().trim()) {
      setError(t("Model is required"))
      return
    }
    streamed = false
    liveText = ""
    setBusy(true)
    setError("")
    setPhase(t("Writing…"))
    pushLine({ id: `user-${Date.now()}`, role: "user", text: RaiRooms.displayText(message) })
    textarea?.setText("")
    setDraft("")
    const stream = await openStream()
    try {
      const result = await call<RaiRooms.SendResult>("send", {
        roomID: roomID(),
        provider: provider(),
        model: model().trim(),
        message,
        effort: null,
        projectID: roomID() === "0" ? selectedProject() ?? null : null,
        credentialOwnerID: null,
        search: search(),
        audience: stream?.token ?? null,
      })
      if (disposed) return
      if (result.roomID && result.roomID !== "0") setRoomID(result.roomID)
      if (!streamed && result.notice)
        pushLine({ id: `notice-${Date.now()}`, role: "notice", text: RaiRooms.displayText(result.notice, 500) })
      if (!streamed) {
        for (const tool of result.tools) {
          pushLine({
            id: `tool-${tool.label}`,
            role: "tool",
            text: `${t("Tool")}: ${RaiRooms.displayText(tool.label, 80)}`,
          })
        }
      }
      finishLive(result.text)
      if (result.thought) setPhase(t("thinking…"))
      if (result.error) setError(result.error)
      else setPhase("")
    } catch (cause) {
      if (!disposed) showError(cause)
    } finally {
      await stream?.done()
      if (!disposed) setBusy(false)
    }
  }

  function openNew() {
    batch(() => {
      setView("thread")
      setRoomID("0")
      setTitle(t("New room"))
      setAccess("write")
      setLines([])
      setHasMore(false)
      setOldestID(null)
      setError("")
    })
  }

  Keymap.createLayer(() => ({
    mode: "modal",
    enabled: view() === "list" && !busy(),
    commands: [
      { bind: "up", title: t("Previous room"), group: "Dialog", run: () => setIndex((value) => Math.max(0, value - 1)) },
      { bind: "down", title: t("Next room"), group: "Dialog", run: () => setIndex((value) => Math.min(visibleRooms().length - 1, value + 1)) },
      {
        bind: "left",
        title: t("Previous project"),
        group: "Dialog",
        run: () => {
          setProjectIndex((value) => Math.max(0, value - 1))
          setIndex(0)
        },
      },
      {
        bind: "right",
        title: t("Next project"),
        group: "Dialog",
        run: () => {
          setProjectIndex((value) => Math.min(projectChoices().length - 1, value + 1))
          setIndex(0)
        },
      },
      {
        bind: "return",
        title: t("Open room"),
        group: "Dialog",
        run: () => {
          const room = visibleRooms()[index()]
          if (room) void openRoom(room)
        },
      },
      { bind: "n", title: t("New room"), group: "Dialog", run: openNew },
      { bind: "r", title: t("Refresh"), group: "Dialog", run: () => void refresh() },
    ],
  }))

  Keymap.createLayer(() => ({
    mode: "modal",
    enabled: view() === "thread",
    priority: 1,
    commands: [
      {
        bind: "escape",
        title: t("Back"),
        group: "Dialog",
        run: () => {
          if (busy()) return
          setView("list")
          void refresh()
        },
      },
      { bind: "ctrl+enter", title: t("Send"), group: "Dialog", run: () => void send() },
      { bind: "ctrl+p", title: t("Provider"), group: "Dialog", run: () => cycleProvider() },
      { bind: "ctrl+f", title: t("Search"), group: "Dialog", run: () => setSearch((value) => !value) },
      {
        bind: "ctrl+l",
        title: t("Live"),
        group: "Dialog",
        run: () => {
          const next = !live()
          setLive(next)
          if (next && roomID() !== "0") void follow(roomID())
        },
      },
      {
        bind: "ctrl+o",
        title: t("Older messages"),
        group: "Dialog",
        run: () => {
          const before = oldestID()
          if (hasMore() && before) void loadMessages(roomID(), before, true)
        },
      },
    ],
  }))

  function cycleProvider() {
    const values = RaiRooms.providers
    const next = values[(values.indexOf(provider()) + 1) % values.length] ?? "xai"
    setProvider(next)
  }

  const status = () => {
    if (phase()) return phase()
    if (error()) return error()
    if (view() === "list") return projectChoices()[projectIndex()]?.title ?? ""
    return writable() ? `${provider()}/${model() || t("Model")}` : t("Read only")
  }

  return (
    <DialogLayout
      header={
        <DialogHeader
          title={view() === "list" ? t("ROKFOSS AI rooms") : RaiRooms.displayText(title(), 80)}
          description={status()}
        />
      }
      footer={{
        actions: {
          secondary:
            view() === "list"
              ? [
                  { title: "open", key: "enter", onTrigger: () => visibleRooms()[index()] && void openRoom(visibleRooms()[index()]!) },
                  { title: "new", key: "n", onTrigger: openNew },
                  { title: "refresh", key: "r", onTrigger: () => void refresh() },
                ]
              : [
                  { title: "back", key: "esc", onTrigger: () => !busy() && setView("list") },
                  { title: "send", key: "ctrl+enter", disabled: busy() || !writable(), onTrigger: () => void send() },
                  { title: "older", key: "ctrl+o", disabled: !hasMore(), onTrigger: () => oldestID() && void loadMessages(roomID(), oldestID(), true) },
                  { title: "provider", key: "ctrl+p", onTrigger: cycleProvider },
                ],
          primary:
            view() === "thread"
              ? [
                  { title: search() ? "search on" : "search off", key: "ctrl+f", onTrigger: () => setSearch((value) => !value) },
                  {
                    title: live() ? "live on" : "live off",
                    key: "ctrl+l",
                    onTrigger: () => {
                      const next = !live()
                      setLive(next)
                      if (next && roomID() !== "0") void follow(roomID())
                    },
                  },
                ]
              : [],
        },
      }}
    >
      <Show
        when={view() === "thread"}
        fallback={
          <box flexDirection="column" gap={1}>
            <text fg={theme.text.muted} wrapMode="word">
              {loading() ? t("Loading rooms…") : t("Projects") + ": " + (projectChoices()[projectIndex()]?.title ?? "")}
            </text>
            <scrollbox ref={(element: ScrollBoxRenderable) => (scroll = element)} maxHeight={height()}>
              <Show when={!loading() && visibleRooms().length === 0}>
                <text fg={theme.text.muted}>{t("No rooms")}</text>
              </Show>
              <For each={visibleRooms()}>
                {(room, roomIndex) => (
                  <text
                    fg={roomIndex() === index() ? theme.text.base : theme.text.muted}
                    attributes={roomIndex() === index() ? TextAttributes.BOLD : undefined}
                    wrapMode="word"
                    onMouseUp={() => void openRoom(room)}
                  >
                    {(roomIndex() === index() ? "> " : "  ") +
                      RaiRooms.displayText(room.title, 60) +
                      (room.running ? " · " + t("Running") : "") +
                      (room.perm === "read" ? " · " + t("Read only") : "") +
                      (room.sharedBy ? " · " + RaiRooms.displayText(room.sharedBy, 40) : "")}
                  </text>
                )}
              </For>
            </scrollbox>
          </box>
        }
      >
        <box flexDirection="column" gap={1}>
          <scrollbox ref={(element: ScrollBoxRenderable) => (scroll = element)} maxHeight={height()}>
            <Show when={lines().length === 0 && !busy()}>
              <text fg={theme.text.muted}>{t("No messages")}</text>
            </Show>
            <For each={lines()}>
              {(line) => (
                <text fg={line.role === "user" ? theme.text.base : theme.text.muted} wrapMode="word">
                  {line.role === "tool" || line.role === "notice" ? "" : `${line.role}: `}
                  {line.text}
                </text>
              )}
            </For>
          </scrollbox>
          <text fg={theme.text.muted}>
            {t("Provider")}: {provider()} · {t("Model")}
          </text>
          <input
            value={model()}
            onInput={(value: string) => setModel(value)}
            placeholder={t("Model")}
            placeholderColor={theme.text.muted}
            focusedTextColor={theme.text.base}
            cursorColor={theme.text.base}
            cursorStyle={cursorStyle()}
          />
          <textarea
            height={2}
            wrapMode="word"
            ref={(element: TextareaRenderable) => (textarea = element)}
            onContentChange={() => setDraft(textarea?.plainText ?? "")}
            placeholder={writable() ? t("Message") : t("Read only")}
            placeholderColor={theme.text.muted}
            textColor={theme.text.base}
            focusedTextColor={theme.text.base}
            cursorColor={theme.text.base}
            cursorStyle={cursorStyle()}
          />
        </box>
      </Show>
    </DialogLayout>
  )
}
