import { TextAttributes, type KeyEvent, type ScrollBoxRenderable, type TextareaRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { randomBytes } from "node:crypto"
import { RaiRooms } from "@opencode/schema/rai-rooms"
import type { JsonValue } from "@opencode/client"
import { batch, createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js"
import { useConfig, useCursorStyle } from "../config"
import { useClient } from "../context/client"
import { useData } from "../context/data"
import { Keymap } from "../context/keymap"
import { useLocal } from "../context/local"
import { useLocation } from "../context/location"
import { useRoute, useRouteData } from "../context/route"
import { useTheme, useThemes } from "../context/theme"
import { t } from "../i18n"
import { usePlugin } from "../plugin/context"
import { EmptyBorder, SplitBorder } from "../ui/border"
import { useDialog } from "../ui/dialog"
import { DialogRooms } from "./dialog-rooms"
import { PromptMetadataRow } from "./prompt/metadata"
import { accessOf, roomsReturn } from "./rooms-nav"
import { roomSeed } from "./rooms-seed"
import { roomSlashCommands, roomSlashDirect, type SlashShape } from "./rooms-slash"

type Line = {
  readonly id: string
  readonly role: string
  readonly text: string
  /** Tool name, so a `tool_done` closes the line the server opened rather than the newest one. */
  readonly name?: string
  readonly state?: "pending" | "ok" | "fail"
  readonly decision?: "pending" | "allow" | "deny" | "none"
  readonly purpose?: string
}

const rpcID = "opencode.rai.rooms"
const maxLines = 260
const maxChars = 48_000
/** The web app folds older tool lines past this many in one turn; the transcript does the same. */
const maxLiveTools = 50

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

/**
 * Full-screen RAI room. Same shape as a session (header, scrolling transcript, prompt) but the
 * transcript lives only in this component. Nothing here is written to `data.session`.
 */
export function RoomsView() {
  const route = useRouteData("rooms")
  const navigate = useRoute().navigate
  const client = useClient()
  const data = useData()
  const location = useLocation()
  const local = useLocal()
  const dialog = useDialog()
  const theme = useTheme()
  const { currentSyntax: syntax } = useThemes()
  const plugins = usePlugin()
  const config = useConfig().data
  const cursorStyle = useCursorStyle()
  const dimensions = useTerminalDimensions()
  const modelKey = Keymap.useShortcut("model.list")
  // A room gets the same `/` commands a session offers, minus the ones that need a session.
  const commandList = Keymap.useCommands()
  const directory = location.current?.directory ?? data.location.default().directory
  const pad = () => (dimensions().width < 44 ? 1 : 2)
  const markdownMode = () => config.session?.markdown ?? "rendered"

  const [roomID, setRoomID] = createSignal(route.roomID)
  const [title, setTitle] = createSignal(route.title)
  const [access, setAccess] = createSignal(route.access)
  const [provider, setProvider] = createSignal<RaiRooms.Provider>(
    RaiRooms.isProvider(route.provider) ? route.provider : "xai",
  )
  const [model, setModel] = createSignal(route.model)
  const [lines, setLines] = createSignal<Line[]>([])
  const [foldedTools, setFoldedTools] = createSignal(0)
  const [hasMore, setHasMore] = createSignal(false)
  const [oldestID, setOldestID] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  const [phase, setPhase] = createSignal("")
  const [search, setSearch] = createSignal(false)
  const [live, setLive] = createSignal(true)
  const [draft, setDraft] = createSignal("")
  const [slashIndex, setSlashIndex] = createSignal(0)
  // Escape hides the list without discarding what was typed; the next keystroke brings it back.
  const [slashDismissed, setSlashDismissed] = createSignal(false)
  let streamed = false
  let liveText = ""
  let liveSeq = 0
  let streamToken: string | undefined
  let sending = false
  // A transcript page that reports a running turn is followed immediately, so a room opened while the web
  // is answering keeps updating instead of showing a frozen transcript.
  let following = false
  let autoFollows = 0
  let leaving = false
  let disposed = false
  let scroll: ScrollBoxRenderable | undefined
  let textarea: TextareaRenderable | undefined
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  const calls = new AbortController()

  const writable = () => RaiRooms.canSend(access())
  const fresh = () => roomID() === "0"
  const canPickModel = () => fresh() || !model().trim()
  const promptBg = createMemo(() => theme.decrease(theme.background.raised.base))
  const heading = () => {
    const value = title()
    if (fresh() && (value === "" || value === "New room")) return t("New room")
    return RaiRooms.displayText(value || t("New room"), 80)
  }
  const accessLabel = () => {
    const value = access()
    if (value === "owner") return t("Owner")
    if (value === "write") return t("Can send")
    if (value === "read") return t("Read only")
    return ""
  }

  onCleanup(() => {
    disposed = true
    if (reconnectTimer) clearTimeout(reconnectTimer)
    const token = streamToken
    streamToken = undefined
    calls.abort()
    if (!token) return
    void client.api.rpc
      .call({ rpcID, method: "release", input: { audience: token }, location: { directory } })
      .catch(() => undefined)
  })

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

  function publish() {
    if (navigate === undefined) return
    const current = roomID()
    navigate({
      type: "rooms",
      roomID: current,
      title: title(),
      provider: provider(),
      model: model(),
      access: access(),
      ...(route.projectID ? { projectID: route.projectID } : {}),
      ...(route.openToken ? { openToken: route.openToken } : {}),
      running: live(),
    })
  }

  function stick() {
    queueMicrotask(() => scroll?.scrollTo(Infinity))
  }

  function pushLine(line: Line) {
    setLines((current) => remember([...current, line]))
    stick()
  }

  function appendDelta(text: string) {
    const clean = RaiRooms.displayText(text)
    if (!clean) return
    liveText += clean
    setLines((current) => {
      const last = current.at(-1)
      if (last?.role === "assistant" && last.id.startsWith("live-text-")) {
        const next = current.slice(0, -1)
        next.push({ ...last, text: RaiRooms.displayText(last.text + clean, 8_000) })
        return remember(next)
      }
      return remember([...current, { id: `live-text-${++liveSeq}`, role: "assistant", text: clean }])
    })
    stick()
  }

  /**
   * One line per tool, in the order the server reports them. Text that arrives between two tools starts a new
   * block, so the transcript reads text → tool → text like the web app instead of one merged answer.
   */
  function pushTool(name: string | undefined, label: string) {
    const clean = RaiRooms.displayText(label, 80)
    if (!clean) return
    let folded = false
    setLines((current) => {
      const live = current.filter((line) => line.role === "tool" && line.id.startsWith("live-tool-"))
      const next = [...current]
      if (live.length >= maxLiveTools) {
        const oldest = live[0]
        const index = oldest ? next.findIndex((line) => line.id === oldest.id) : -1
        if (index >= 0) {
          next.splice(index, 1)
          folded = true
        }
      }
      next.push({
        id: `live-tool-${++liveSeq}`,
        role: "tool",
        text: clean,
        state: "pending",
        ...(name ? { name } : {}),
      })
      return remember(next)
    })
    if (folded) setFoldedTools((value) => value + 1)
    stick()
  }

  /** Closes the most recent unfinished line with the same tool name, the way the web app matches them. */
  function finishTool(name: string | undefined, ok: boolean | undefined, label: string | undefined) {
    setLines((current) => {
      const next = [...current]
      let index = -1
      for (let cursor = next.length - 1; cursor >= 0; cursor--) {
        const line = next[cursor]
        if (!line || line.role !== "tool" || !line.id.startsWith("live-tool-")) continue
        if (line.state !== "pending") continue
        if (name && line.name && line.name !== name) continue
        index = cursor
        break
      }
      if (index < 0) return current
      const line = next[index]
      if (!line) return current
      next[index] = {
        ...line,
        state: ok === false ? "fail" : "ok",
        ...(label ? { text: RaiRooms.displayText(label, 80) } : {}),
      }
      return next
    })
  }

  function decisionOf(value: string | null | undefined): Line["decision"] {
    if (!value) return "pending"
    if (value === "allow" || value === "allow-room") return "allow"
    return "deny"
  }

  function startApproval(
    id: string,
    title: string | null | undefined,
    purpose: string | null | undefined,
    decision: string | null | undefined,
  ) {
    const key = `live-approval-${id}`
    const line: Line = {
      id: key,
      role: "approval",
      text: RaiRooms.displayText(title || t("Approval needed"), 200),
      decision: decisionOf(decision),
      ...(purpose ? { purpose: RaiRooms.displayText(purpose, 200) } : {}),
    }
    setLines((current) => {
      const index = current.findIndex((entry) => entry.id === key)
      if (index < 0) return remember([...current, line])
      const next = [...current]
      next[index] = line
      return next
    })
    stick()
  }

  function finishApproval(id: string, decision: string | null | undefined) {
    const key = `live-approval-${id}`
    setLines((current) => {
      const index = current.findIndex((line) => line.id === key)
      const line = index >= 0 ? current[index] : undefined
      if (index < 0 || !line) return current
      const next = [...current]
      next[index] = { ...line, decision: decisionOf(decision) }
      return next
    })
  }

  /** An approval still open when the turn ended never got a decision. */
  function settleApprovals() {
    setLines((current) =>
      current.map((line) =>
        line.role === "approval" && line.decision === "pending" ? { ...line, decision: "none" } : line,
      ),
    )
  }

  /** Drops everything the live turn drew, so a replayed stream redraws it from the start without duplicates. */
  function clearLive() {
    streamed = false
    setFoldedTools(0)
    setLines((current) => current.filter((line) => !line.id.startsWith("live-")))
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

  function applyChunk(chunk: RaiRooms.Chunk) {
    streamed = true
    if (chunk.roomID && chunk.roomID !== "0" && (roomID() === "0" || roomID() === chunk.roomID)) {
      if (roomID() === "0") setRoomID(chunk.roomID)
    } else if (chunk.roomID !== roomID()) return
    if (chunk.kind === "delta" && chunk.text) {
      setPhase("")
      appendDelta(chunk.text)
    } else if (chunk.kind === "thinking") setPhase(t("thinking…"))
    else if (chunk.kind === "tool") {
      const label = chunk.label ?? chunk.name ?? t("Tool")
      setPhase(`${t("Tool")}: ${RaiRooms.displayText(label, 80)}`)
      pushTool(chunk.name ?? undefined, label)
    } else if (chunk.kind === "tool_done") {
      setPhase("")
      finishTool(chunk.name ?? undefined, chunk.ok ?? undefined, chunk.label ?? undefined)
    } else if (chunk.kind === "approval" && chunk.approvalID)
      startApproval(chunk.approvalID, chunk.title, chunk.purpose, chunk.decision)
    else if (chunk.kind === "approval_done" && chunk.approvalID)
      finishApproval(chunk.approvalID, chunk.decision)
    else if (chunk.kind === "notice" && chunk.text)
      pushLine({ id: `notice-${Date.now()}`, role: "notice", text: RaiRooms.displayText(chunk.text, 500) })
    else if (chunk.kind === "error" && chunk.text) setError(RaiRooms.displayText(chunk.text, 500))
    else if (chunk.kind === "done") setPhase("")
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
        setFoldedTools(0)
        if (page.access) setAccess(accessOf(page.access))
        if (page.room) {
          setTitle(page.room.title)
          if (page.room.provider && RaiRooms.isProvider(page.room.provider)) setProvider(page.room.provider)
          if (page.room.model) setModel(page.room.model)
        }
      })
      if (!older) stick()
      publish()
      // No polling: a follow is started only when a fetched page says the room is answering right now.
      if (!older && page.room?.running && !following && !sending && autoFollows < 20) {
        autoFollows++
        if (reconnectTimer) clearTimeout(reconnectTimer)
        reconnectTimer = setTimeout(() => {
          if (!disposed && !following && !sending) void follow(id)
        }, 300)
      } else if (!page.room?.running) autoFollows = 0
    } catch (cause) {
      if (!disposed) showError(cause)
    } finally {
      if (!disposed) setBusy(false)
    }
  }

  /**
   * Replaces the live turn with the saved transcript once it ends. The server writes the reply as `done` arrives,
   * so a page that still ends on the user's line raced that write and is fetched again.
   */
  async function reloadSaved(id: string, attempt = 0) {
    if (disposed || id === "" || id === "0") return
    await loadMessages(id, null, false)
    if (disposed) return
    const last = lines().at(-1)
    if (last?.role === "user" && attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)))
      return reloadSaved(id, attempt + 1)
    }
  }

  async function follow(id: string) {
    // A turn's stream replays from its start, so anything already drawn for it is dropped and drawn again.
    following = true
    clearLive()
    liveText = ""
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
      if (!streamed) finishLive(watched.text)
      if (watched.thought) setPhase(t("thinking…"))
      if (watched.done || watched.error) {
        settleApprovals()
        void reloadSaved(id)
      } else if (watched.reconnect) {
        // The turn is still running, so the stream is attached again whether or not the live badge is on:
        // reconnecting is what keeps the transcript in sync with the web while a reply is streaming.
        reconnectTimer = setTimeout(() => {
          if (!disposed) void follow(roomID())
        }, 1_000)
      }
    } finally {
      await stream?.done()
      following = false
    }
  }

  async function send() {
    if (sending || busy()) return
    const message = (textarea?.plainText ?? draft()).trim()
    if (!message) return
    if (!writable()) {
      setError(t("Read only"))
      return
    }
    if (!model().trim() || !RaiRooms.isProvider(provider())) {
      setError(t("Model is required"))
      return
    }
    sending = true
    clearLive()
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
        projectID: roomID() === "0" ? route.projectID ?? null : null,
        credentialOwnerID: null,
        search: search(),
        audience: stream?.token ?? null,
      })
      if (disposed) return
      if (result.roomID && result.roomID !== "0") {
        setRoomID(result.roomID)
        // Registering a tab needs the room id on the route. The open token is kept, so this view stays
        // mounted and the transcript already on screen survives.
        if (route.openToken) navigate({ ...route, roomID: result.roomID })
      }
      if (!streamed) {
        if (result.notice)
          pushLine({ id: `notice-${Date.now()}`, role: "notice", text: RaiRooms.displayText(result.notice, 500) })
        for (const tool of result.tools) {
          pushLine({
            id: `tool-${tool.label}`,
            role: "tool",
            text: `${t("Tool")}: ${RaiRooms.displayText(tool.label, 80)}`,
            state: tool.done ? (tool.ok === false ? "fail" : "ok") : "pending",
          })
        }
        finishLive(result.text)
      }
      if (result.thought) setPhase(t("thinking…"))
      if (result.error) setError(result.error)
      else setPhase("")
      publish()
    } catch (cause) {
      if (!disposed) showError(cause)
    } finally {
      await stream?.done()
      sending = false
      if (!disposed) setBusy(false)
      settleApprovals()
      void reloadSaved(roomID())
    }
  }

  function leave() {
    if (leaving) return
    leaving = true
    // Unmount aborts the in-flight call and releases the audience. The transcript is not stored.
    navigate(roomsReturn())
    dialog.replace(() => <DialogRooms />, undefined, { size: "xlarge" })
  }

  function cycleProvider() {
    if (!fresh()) return
    const values = RaiRooms.providers
    const next = values[(values.indexOf(provider()) + 1) % values.length] ?? "xai"
    setProvider(next)
    publish()
  }

  function loadOlder() {
    const before = oldestID()
    if (hasMore() && before && !busy()) void loadMessages(roomID(), before, true)
  }

  // A new room follows the model the user already picked for ordinary chat, instead of a second form.
  // The picked model may belong to a local provider, which the room maps to the gateway's entry for the
  // same upstream model (see `roomSeed`).
  createEffect(
    on(
      () => local.model.current(),
      (current) => {
        if (!fresh()) return
        const gateway = (data.location.model.list(location.ref) ?? []).map((item) => ({
          providerID: item.providerID,
          modelID: item.id,
        }))
        const seed = roomSeed(current ?? undefined, gateway)
        setProvider(seed.provider)
        setModel(seed.model)
      },
    ),
  )

  onMount(() => {
    const timer = setTimeout(() => textarea?.focus(), 30)
    onCleanup(() => clearTimeout(timer))
    // Saved messages are drawn first, then a running turn is attached below them as its own live block.
    void (async () => {
      if (route.roomID !== "0") await loadMessages(route.roomID, null, false)
      if (!disposed && route.running) await follow(route.roomID)
    })()
  })

  Keymap.createLayer(() => ({
    enabled: dialog.stack.length === 0,
    commands: [
      { bind: "escape", title: t("Back to rooms"), group: "Dialog", run: leave },
      { bind: "ctrl+enter", title: t("Send"), group: "Dialog", run: () => void send() },
      { bind: "ctrl+o", title: t("Older messages"), group: "Dialog", run: loadOlder },
      { bind: "ctrl+p", title: t("Provider"), group: "Dialog", enabled: fresh() && !busy(), run: cycleProvider },
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
    ],
  }))

  /** Keymap commands report an `id`, so they are mapped onto the shape the slash helpers take. */
  const slashShapes = createMemo<SlashShape[]>(() =>
    commandList().flatMap((command) => {
      if (!command.slash) return []
      const enabled = command.enabled
      if (enabled === false || (typeof enabled === "function" && enabled() === false)) return []
      return [
        {
          name: command.id ?? command.slash.name,
          title: command.title,
          slash: command.slash,
          run: (input?: string) => command.run(input),
        },
      ]
    }),
  )
  const slashCandidates = createMemo(() => (slashDismissed() ? [] : roomSlashCommands(slashShapes(), draft())))
  const slashPick = () => slashCandidates()[Math.min(slashIndex(), slashCandidates().length - 1)]

  function runSlash(command: SlashShape, input: string) {
    textarea?.setText("")
    setDraft("")
    setSlashIndex(0)
    setSlashDismissed(false)
    void Promise.resolve(command.run?.(input)).catch(showError)
  }

  /** Enter runs a command when the line names one, and sends a message otherwise. */
  function submit() {
    if (slashCandidates().length > 0) {
      const picked = slashPick()
      if (picked) runSlash(picked, "")
      return
    }
    const direct = roomSlashDirect(slashShapes(), (textarea?.plainText ?? draft()).trim())
    if (direct) {
      runSlash(direct.command, direct.input)
      return
    }
    void send()
  }

  /** While the server waits on a browser decision the turn is frozen, so the reason has to stay on screen. */
  const waitingApproval = createMemo(() =>
    lines().some((line) => line.role === "approval" && line.decision === "pending"),
  )

  const toolIcon = (line: Line) => (line.state === "fail" ? "✗" : line.state === "pending" ? "⋯" : "✓")

  const toolColor = (line: Line) => (line.state === "fail" ? theme.text.feedback.error.base : theme.text.muted)

  const approvalLabel = (line: Line) => {
    const title = line.text
    if (line.decision === "allow") return t("Allowed: {{title}}", { title })
    if (line.decision === "deny") return t("Denied: {{title}}", { title })
    if (line.decision === "none") return t("Not decided: {{title}}", { title })
    return t("Approval needed: {{title}} — allow or deny it in the web AI app", { title })
  }

  const approvalColor = (line: Line) => {
    if (line.decision === "allow") return theme.text.feedback.success.base
    if (line.decision === "deny") return theme.text.feedback.error.base
    if (line.decision === "none") return theme.text.muted
    return theme.text.feedback.warning.base
  }

  const statusText = () =>
    error() || (waitingApproval() ? t("Waiting for approval in the web app") : phase())

  const placeholder = () => {
    if (!writable()) return t("Read only")
    if (busy()) return t("Writing…")
    if (!model().trim()) return t("Model is required")
    return t("Ask anything…")
  }

  return (
    <box flexGrow={1} minHeight={0} flexDirection="column" backgroundColor={theme.background.base}>
      <box
        flexShrink={0}
        paddingLeft={pad()}
        paddingRight={pad()}
        paddingTop={1}
        paddingBottom={1}
        border={["bottom"]}
        borderColor={theme.border.base}
        flexDirection="row"
        gap={1}
      >
        <text fg={theme.text.base} attributes={TextAttributes.BOLD} wrapMode="none" truncate flexShrink={1}>
          {heading()}
        </text>
        <text fg={theme.text.muted} wrapMode="none" truncate flexShrink={1}>
          {provider()}/{model() || t("Model")}
        </text>
        <Show when={accessLabel()}>
          <text fg={access() === "read" ? theme.text.feedback.warning.base : theme.text.muted} wrapMode="none">
            {accessLabel()}
          </text>
        </Show>
        <Show when={search()}>
          <text fg={theme.text.muted} wrapMode="none">
            {t("Search")} {t("on")}
          </text>
        </Show>
        <Show when={live()}>
          <text fg={theme.text.muted} wrapMode="none">
            {t("Live")} {t("on")}
          </text>
        </Show>
      </box>
      <box flexGrow={1} minHeight={0} paddingLeft={pad()} paddingRight={pad()} paddingBottom={1}>
        <scrollbox ref={(element: ScrollBoxRenderable) => (scroll = element)} flexGrow={1}>
          <Show when={hasMore()}>
            <text fg={theme.text.muted} wrapMode="word" onMouseUp={loadOlder}>
              {t("Older messages")}
            </text>
          </Show>
          <Show when={lines().length === 0 && busy()}>
            <text fg={theme.text.muted}>{t("Loading messages…")}</text>
          </Show>
          <Show when={lines().length === 0 && !busy()}>
            <text fg={theme.text.muted}>{t("No messages")}</text>
          </Show>
          <Show when={foldedTools() > 0}>
            <text fg={theme.text.muted} wrapMode="word">
              {t("More tools: {{count}}", { count: foldedTools() })}
            </text>
          </Show>
          <For each={lines()}>
            {(line) => (
              <box marginTop={1} flexShrink={0}>
                <Show
                  when={line.role === "user"}
                  fallback={
                    <Show
                      when={line.role === "tool"}
                      fallback={
                        <Show
                          when={line.role === "approval"}
                          fallback={
                            <Show
                              when={line.role === "notice"}
                              fallback={
                                <box paddingLeft={1} paddingRight={1}>
                                  <markdown
                                    syntaxStyle={syntax()}
                                    renderNode={plugins.markdown()}
                                    streaming={line.id.startsWith("live-text-")}
                                    content={line.text}
                                    conceal={markdownMode() === "rendered"}
                                    fg={theme.markdown.text}
                                    bg={theme.background.base}
                                  />
                                </box>
                              }
                            >
                              <text fg={theme.text.muted} wrapMode="word">
                                {line.text}
                              </text>
                            </Show>
                          }
                        >
                          <box flexDirection="column">
                            <text fg={approvalColor(line)} wrapMode="word">
                              {approvalLabel(line)}
                            </text>
                            <Show when={line.purpose}>
                              <text fg={theme.text.muted} wrapMode="word">
                                {line.purpose}
                              </text>
                            </Show>
                          </box>
                        </Show>
                      }
                    >
                      <text fg={toolColor(line)} wrapMode="word">
                        {toolIcon(line)} {line.text}
                      </text>
                    </Show>
                  }
                >
                  <box
                    border={["left"]}
                    borderColor={theme.text.base}
                    customBorderChars={SplitBorder.customBorderChars}
                    backgroundColor={theme.background.raised.base}
                    paddingTop={1}
                    paddingBottom={1}
                    paddingLeft={2}
                    paddingRight={2}
                    flexShrink={0}
                  >
                    <text fg={theme.text.base} wrapMode="word">
                      {line.text}
                    </text>
                  </box>
                </Show>
              </box>
            )}
          </For>
        </scrollbox>
      </box>
      <box flexShrink={0} paddingLeft={pad()} paddingRight={pad()} paddingBottom={1} gap={1}>
        <Show when={slashCandidates().length > 0}>
          <box
            flexShrink={0}
            flexDirection="column"
            border={["left"]}
            borderColor={theme.text.base}
            customBorderChars={SplitBorder.customBorderChars}
            backgroundColor={theme.background.raised.base}
            paddingLeft={1}
            paddingRight={1}
          >
            <For each={slashCandidates()}>
              {(command, index) => (
                <text fg={index() === slashIndex() ? theme.text.base : theme.text.muted} wrapMode="none" truncate>
                  {index() === slashIndex() ? "› " : "  "}/{command.slash!.name}  {command.title ?? command.slash!.name}
                </text>
              )}
            </For>
          </box>
        </Show>
        <Show when={statusText() !== ""}>
          <text
            fg={
              error()
                ? theme.text.feedback.error.base
                : waitingApproval()
                  ? theme.text.feedback.warning.base
                  : theme.text.muted
            }
            wrapMode="word"
          >
            {statusText()}
          </text>
        </Show>
        <Show when={!model().trim() && canPickModel()}>
          <text fg={theme.text.feedback.warning.base} wrapMode="word">
            {t("Model is required")}
            {modelKey() ? ` (${modelKey()})` : ""}
          </text>
        </Show>
        <box width="100%">
          <box
            width="100%"
            border={["left"]}
            borderColor={theme.text.base}
            customBorderChars={{ ...SplitBorder.customBorderChars, bottomLeft: "╹" }}
          >
            <box
              paddingLeft={pad()}
              paddingRight={pad()}
              paddingTop={1}
              flexShrink={0}
              backgroundColor={promptBg()}
              width="100%"
            >
              <textarea
                width="100%"
                minHeight={1}
                maxHeight={Math.max(4, Math.floor(dimensions().height / 3))}
                wrapMode="word"
                ref={(element: TextareaRenderable) => (textarea = element)}
                onContentChange={() => {
                  setDraft(textarea?.plainText ?? "")
                  setSlashDismissed(false)
                  setSlashIndex(0)
                }}
                onSubmit={() => {
                  setTimeout(() => setTimeout(() => submit(), 0), 0)
                }}
                onKeyDown={(event: KeyEvent) => {
                  const candidates = slashCandidates()
                  if (candidates.length > 0) {
                    if (event.name === "up" || event.name === "down") {
                      event.preventDefault()
                      const step = event.name === "up" ? -1 : 1
                      setSlashIndex((index) => (index + step + candidates.length) % candidates.length)
                      return
                    }
                    if (event.name === "tab") {
                      event.preventDefault()
                      const picked = slashPick()
                      if (!picked) return
                      const line = `/${picked.slash!.name} `
                      textarea?.setText(line)
                      setDraft(line)
                      return
                    }
                  }
                  if (event.name !== "escape") return
                  event.preventDefault()
                  // Escape closes the command list first, and leaves the room only when it is closed.
                  if (candidates.length > 0) {
                    setSlashDismissed(true)
                    return
                  }
                  leave()
                }}
                placeholder={placeholder()}
                placeholderColor={theme.text.muted}
                textColor={theme.text.base}
                focusedTextColor={theme.text.base}
                focusedBackgroundColor="transparent"
                cursorColor={theme.text.base}
                cursorStyle={cursorStyle()}
                syntaxStyle={syntax()}
              />
              <box flexDirection="row" flexShrink={0} paddingTop={1} gap={1}>
                <PromptMetadataRow
                  mode="normal"
                  agent={accessLabel() || t("Rooms")}
                  auto={false}
                  model={model() || t("Model")}
                  provider={provider()}
                  muted={!writable() || busy()}
                  highlight={theme.text.base}
                  agentAlpha={1}
                  modelAlpha={1}
                  variantAlpha={1}
                />
              </box>
            </box>
          </box>
          <box
            height={1}
            border={["left"]}
            borderColor={theme.text.base}
            customBorderChars={{ ...EmptyBorder, vertical: promptBg().a !== 0 ? "╹" : " " }}
          >
            <box
              height={1}
              border={["bottom"]}
              borderColor={promptBg()}
              customBorderChars={{ ...EmptyBorder, horizontal: promptBg().a !== 0 ? "▀" : " " }}
            />
          </box>
        </box>
        <text fg={theme.text.muted} wrapMode="none" truncate>
          {t("Send")} enter · {t("Back to rooms")} esc · {t("Commands")} /
          {hasMore() ? ` · ${t("Older messages")} ctrl+o` : ""}
        </text>
      </box>
    </box>
  )
}
