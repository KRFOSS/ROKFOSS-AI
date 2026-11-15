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
  const [hasMore, setHasMore] = createSignal(false)
  const [oldestID, setOldestID] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  const [phase, setPhase] = createSignal("")
  const [search, setSearch] = createSignal(false)
  const [live, setLive] = createSignal(false)
  const [draft, setDraft] = createSignal("")
  let streamed = false
  let liveText = ""
  let streamToken: string | undefined
  let sending = false
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
      if (last?.role === "assistant" && last.id.startsWith("live-")) {
        const next = current.slice(0, -1)
        next.push({ ...last, text: RaiRooms.displayText(last.text + clean, 8_000) })
        return remember(next)
      }
      return remember([...current, { id: `live-${Date.now()}`, role: "assistant", text: clean }])
    })
    stick()
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
    else if (chunk.kind === "tool" && chunk.label) setPhase(`${t("Tool")}: ${RaiRooms.displayText(chunk.label, 80)}`)
    else if (chunk.kind === "tool_done") setPhase("")
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
        if (page.access) setAccess(accessOf(page.access))
        if (page.room) {
          setTitle(page.room.title)
          if (page.room.provider && RaiRooms.isProvider(page.room.provider)) setProvider(page.room.provider)
          if (page.room.model) setModel(page.room.model)
        }
      })
      if (!older) stick()
      publish()
    } catch (cause) {
      if (!disposed) showError(cause)
    } finally {
      if (!disposed) setBusy(false)
    }
  }

  async function follow(id: string) {
    streamed = false
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
      finishLive(watched.text)
      if (watched.thought) setPhase(t("thinking…"))
      if (watched.reconnect && live()) {
        reconnectTimer = setTimeout(() => {
          if (!disposed && live()) void follow(roomID())
        }, 1_000)
      }
    } finally {
      await stream?.done()
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
        projectID: roomID() === "0" ? route.projectID ?? null : null,
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
      publish()
    } catch (cause) {
      if (!disposed) showError(cause)
    } finally {
      await stream?.done()
      sending = false
      if (!disposed) setBusy(false)
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
  createEffect(
    on(
      () => local.model.current(),
      (current) => {
        if (!fresh()) return
        const split = current?.providerID === "rai" ? splitModel(current.modelID) : undefined
        if (!split) return
        setProvider(split.provider)
        setModel(split.model)
      },
    ),
  )

  onMount(() => {
    const timer = setTimeout(() => textarea?.focus(), 30)
    onCleanup(() => clearTimeout(timer))
    if (route.roomID !== "0") void loadMessages(route.roomID, null, false)
    if (route.running) void follow(route.roomID)
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
          <For each={lines()}>
            {(line) => (
              <box marginTop={1} flexShrink={0}>
                <Show
                  when={line.role === "user"}
                  fallback={
                    <Show
                      when={line.role !== "tool" && line.role !== "notice"}
                      fallback={
                        <text fg={theme.text.muted} wrapMode="word">
                          {line.text}
                        </text>
                      }
                    >
                      <box paddingLeft={1} paddingRight={1}>
                        <markdown
                          syntaxStyle={syntax()}
                          renderNode={plugins.markdown()}
                          streaming={line.id.startsWith("live-")}
                          content={line.text}
                          conceal={markdownMode() === "rendered"}
                          fg={theme.markdown.text}
                          bg={theme.background.base}
                        />
                      </box>
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
        <Show when={error() || phase()}>
          <text fg={error() ? theme.text.feedback.error.base : theme.text.muted} wrapMode="word">
            {error() || phase()}
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
                onContentChange={() => setDraft(textarea?.plainText ?? "")}
                onSubmit={() => {
                  setTimeout(() => setTimeout(() => void send(), 0), 0)
                }}
                onKeyDown={(event: KeyEvent) => {
                  if (event.name !== "escape") return
                  event.preventDefault()
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
          {t("Send")} enter · {t("Back to rooms")} esc
          {hasMore() ? ` · ${t("Older messages")} ctrl+o` : ""}
        </text>
      </box>
    </box>
  )
}
