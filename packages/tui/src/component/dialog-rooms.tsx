import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { RaiRooms } from "@opencode/schema/rai-rooms"
import { RaiTurns } from "@opencode/schema/rai-turns"
import { SessionID } from "@opencode/schema/session-id"
import { batch, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useClient } from "../context/client"
import { useData } from "../context/data"
import { Keymap } from "../context/keymap"
import { useLocal } from "../context/local"
import { useLocation } from "../context/location"
import { useRoute, type RoomsRoute } from "../context/route"
import { useTheme } from "../context/theme"
import { t } from "../i18n"
import { DialogHeader, DialogLayout, useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import type { JsonValue } from "@opencode/client"
import { accessOf, nextRoomToken, rememberRoomSession, rememberRoomsReturn, roomsReturn, setBoundRoom } from "./rooms-nav"
import { roomSeed } from "./rooms-seed"
import { newestRoomMessage, roomImport } from "./rooms-import"

const rpcID = "opencode.rai.rooms"
const turnsID = "opencode.rai.turns"

/** Pages of saved messages a room brings into its session when it is opened here the first time. */
const historyPages = 3

/**
 * `/rooms` — project and room list. Opening a room continues it as an ordinary OpenCode session: the room's saved
 * conversation becomes the session's history, every answer the session makes is recorded into the room, and what
 * the web writes there is added while the session is open.
 */
export function DialogRooms() {
  const client = useClient()
  const data = useData()
  const location = useLocation()
  const local = useLocal()
  const route = useRoute()
  const dialog = useDialog()
  const toast = useToast()
  const theme = useTheme().surface("dialog")
  const dimensions = useTerminalDimensions()
  const directory = location.current?.directory ?? data.location.default().directory
  const height = () => Math.max(6, Math.floor(dimensions().height * 0.45))

  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal("")
  const [projects, setProjects] = createSignal<RaiRooms.Project[]>([])
  const [rooms, setRooms] = createSignal<RaiRooms.Room[]>([])
  const [projectIndex, setProjectIndex] = createSignal(0)
  const [index, setIndex] = createSignal(0)
  const [saving, setSaving] = createSignal(false)
  let disposed = false
  const calls = new AbortController()

  dialog.setSize("xlarge")
  onCleanup(() => {
    disposed = true
    calls.abort()
  })

  const projectChoices = createMemo(() => [{ id: "", title: t("All projects") }, ...projects()])
  const selectedProject = () => projectChoices()[projectIndex()]?.id || undefined
  const visibleRooms = createMemo(() => {
    const projectID = selectedProject()
    const all = rooms()
    return projectID ? all.filter((room) => room.projectID === projectID) : all
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

  async function callTurns<T>(method: string, input: Record<string, unknown>) {
    const result = await client.api.rpc.call(
      {
        rpcID: turnsID,
        method,
        input: input as JsonValue,
        location: { directory },
      },
      { signal: calls.signal },
    )
    return result.output as T
  }

  /** The session the next turn would be recorded from: the open one, or the one `/rooms` was opened over. */
  function boundSession() {
    const current = route.data
    if (current.type === "session") return current.sessionID
    const back = roomsReturn()
    return back.type === "session" ? back.sessionID : undefined
  }

  /**
   * A room behaves like a chat tab: choosing it binds the open session, and the answer the session produces locally is
   * relayed into the room. Recording never owns the screen, so the session stays open.
   */
  async function bind(room: RaiRooms.Room) {
    const sessionID = boundSession()
    if (!sessionID || saving()) return false
    if (room.perm === "read") {
      setError(t("Read-only rooms cannot be recorded into"))
      return false
    }
    setSaving(true)
    try {
      const bound = await callTurns<RaiTurns.Bound>("bind", { sessionID, roomID: room.id, title: room.title })
      if (!bound.roomID) {
        setError(bound.error ?? t("Could not bind this room"))
        return false
      }
      setBoundRoom(sessionID, bound.title ?? room.title)
      rememberRoomSession(bound.roomID, sessionID)
      dialog.clear()
      toast.show({
        variant: "success",
        message: t("Recording this session into room {{room}}", { room: RaiRooms.displayText(bound.title ?? room.id, 40) }),
      })
      return true
    } catch (cause) {
      showError(cause)
      return false
    } finally {
      setSaving(false)
    }
  }

  /** The room's saved conversation, oldest first, up to `historyPages` pages. */
  async function history(roomID: string) {
    const pages: RaiRooms.Message[][] = []
    let before: string | null = null
    for (let page = 0; page < historyPages; page++) {
      const result: RaiRooms.Page & { error?: string | null } = await call("messages", { roomID, limit: 100, before })
      if (result.error) throw new Error(result.error)
      pages.unshift([...result.messages])
      if (!result.hasMore || !result.oldestID) break
      before = result.oldestID
    }
    return pages.flat()
  }

  /**
   * Opens the room as a session. A room opened here before goes back to its session; otherwise a new session is made
   * from the room's conversation and bound to it. A read-only room cannot be recorded into, so it opens the room view.
   */
  async function openRoomSession(room: RaiRooms.Room) {
    if (saving()) return
    if (room.perm === "read") return openRoom(room)
    setSaving(true)
    setError("")
    try {
      const known = await callTurns<RaiTurns.SessionOf>("sessionOf", { roomID: room.id })
      if (disposed) return
      if (known.sessionID) {
        await callTurns<RaiTurns.Synced>("sync", { sessionID: known.sessionID }).catch(() => undefined)
        dialog.clear()
        route.navigate({ type: "session", sessionID: known.sessionID })
        return
      }
      const messages = await history(room.id)
      if (disposed) return
      const sessionID = SessionID.create()
      const bound = await callTurns<RaiTurns.Bound>("bind", {
        sessionID,
        roomID: room.id,
        title: room.title,
        after: newestRoomMessage(messages),
      })
      if (!bound.roomID) {
        setError(bound.error ?? t("Could not bind this room"))
        return
      }
      const agent = local.agent.current()?.id ?? "build"
      const current = local.model.current()
      const variant = local.model.variant.current()
      try {
        await client.api.experimental.session.import(
          roomImport({
            sessionID,
            roomID: room.id,
            title: bound.title ?? room.title,
            messages,
            agent,
            ...(current ? { model: { id: current.modelID, providerID: current.providerID, ...(variant ? { variant } : {}) } } : {}),
            projectID: data.location.info(location.ref)?.project.id ?? "",
            directory,
            now: Date.now(),
          }) as never,
          { signal: calls.signal },
        )
      } catch (cause) {
        await callTurns("unbind", { sessionID }).catch(() => undefined)
        throw cause
      }
      if (disposed) return
      setBoundRoom(sessionID, bound.title ?? room.title)
      rememberRoomSession(bound.roomID, sessionID)
      dialog.clear()
      route.navigate({ type: "session", sessionID })
    } catch (cause) {
      if (!disposed) showError(cause)
    } finally {
      if (!disposed) setSaving(false)
    }
  }

  /** `n`: a new empty room on the server, opened as a session like any other room. */
  async function newRoomSession() {
    if (saving()) return
    setSaving(true)
    setError("")
    let made: RaiRooms.CreateResult
    try {
      made = await call<RaiRooms.CreateResult>("create", { title: t("New room"), projectID: selectedProject() ?? null })
    } catch (cause) {
      if (!disposed) showError(cause)
      return
    } finally {
      if (!disposed) setSaving(false)
    }
    if (disposed) return
    if (!made.room) {
      setError(made.error ?? t("Could not create the room"))
      return
    }
    await openRoomSession(made.room)
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

  /**
   * The room model starts from the model picked for ordinary chat. A local provider is mapped to the
   * gateway's entry for the same upstream model, so choosing an OpenCode free model no longer leaves a
   * new room on an unrelated gateway default.
   */
  function seededModel() {
    const gateway = (data.location.model.list(location.ref) ?? []).map((item) => ({
      providerID: item.providerID,
      modelID: item.id,
    }))
    return roomSeed(local.model.current() ?? undefined, gateway)
  }

  function enter(next: RoomsRoute) {
    rememberRoomsReturn(route.data)
    dialog.clear()
    route.navigate({ ...next, openToken: nextRoomToken() })
  }

  function openRoom(room: RaiRooms.Room) {
    const seeded = seededModel()
    const savedProvider = room.provider ?? ""
    enter({
      type: "rooms",
      roomID: room.id,
      title: room.title,
      // A saved room keeps the model it was created with; the seed only fills a room that has none.
      provider: RaiRooms.isProvider(savedProvider) ? savedProvider : seeded.provider,
      model: room.model || seeded.model,
      access: accessOf(room.perm),
      ...(room.projectID ? { projectID: room.projectID } : {}),
      running: room.running,
    })
  }

  onMount(() => {
    void refresh()
  })

  Keymap.createLayer(() => ({
    mode: "modal",
    commands: [
      { bind: "up", title: t("Previous room"), group: "Dialog", run: () => setIndex((value) => Math.max(0, value - 1)) },
      {
        bind: "down",
        title: t("Next room"),
        group: "Dialog",
        run: () => setIndex((value) => Math.min(visibleRooms().length - 1, value + 1)),
      },
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
          if (room) void openRoomSession(room)
        },
      },
      {
        bind: "b",
        title: t("Record this session into the room"),
        group: "Dialog",
        run: () => {
          const room = visibleRooms()[index()]
          if (room) void bind(room)
        },
      },
      {
        bind: "v",
        title: t("Open room view"),
        group: "Dialog",
        run: () => {
          const room = visibleRooms()[index()]
          if (room) openRoom(room)
        },
      },
      { bind: "n", title: t("New room"), group: "Dialog", run: () => void newRoomSession() },
      { bind: "r", title: t("Refresh"), group: "Dialog", run: () => void refresh() },
    ],
  }))

  const status = () => error() || projectChoices()[projectIndex()]?.title || ""

  return (
    <DialogLayout
      header={<DialogHeader title={t("ROKFOSS AI rooms")} description={status()} />}
      footer={{
        actions: {
          secondary: [
            {
              title: "Open room",
              key: "enter",
              onTrigger: () => {
                const room = visibleRooms()[index()]
                if (room) void openRoomSession(room)
              },
            },
            {
              title: "Record this session into the room",
              key: "b",
              onTrigger: () => {
                const room = visibleRooms()[index()]
                if (room) void bind(room)
              },
            },
            {
              title: "Open room view",
              key: "v",
              onTrigger: () => {
                const room = visibleRooms()[index()]
                if (room) openRoom(room)
              },
            },
            { title: "New room", key: "n", onTrigger: () => void newRoomSession() },
            { title: "Refresh", key: "r", onTrigger: () => void refresh() },
          ],
          primary: [],
        },
      }}
    >
      <box flexDirection="column" gap={1}>
        <text fg={theme.text.muted} wrapMode="word">
          {loading() ? t("Loading rooms…") : t("Projects") + ": " + (projectChoices()[projectIndex()]?.title ?? "")}
        </text>
        <scrollbox ref={(_element: ScrollBoxRenderable) => undefined} maxHeight={height()}>
          <Show when={!loading() && visibleRooms().length === 0}>
            <text fg={theme.text.muted}>{t("No rooms")}</text>
          </Show>
          <For each={visibleRooms()}>
            {(room, roomIndex) => (
              <text
                fg={roomIndex() === index() ? theme.text.base : theme.text.muted}
                attributes={roomIndex() === index() ? TextAttributes.BOLD : undefined}
                wrapMode="word"
                onMouseUp={() => void openRoomSession(room)}
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
    </DialogLayout>
  )
}
