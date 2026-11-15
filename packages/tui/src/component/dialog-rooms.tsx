import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { RaiRooms } from "@opencode/schema/rai-rooms"
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
import type { JsonValue } from "@opencode/client"
import { accessOf, nextRoomToken, rememberRoomsReturn } from "./rooms-nav"

const rpcID = "opencode.rai.rooms"

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
 * `/rooms` — project and room list. Opening a room leaves this dialog and continues in the
 * full-screen session view. Transcripts are not kept here.
 */
export function DialogRooms() {
  const client = useClient()
  const data = useData()
  const location = useLocation()
  const local = useLocal()
  const route = useRoute()
  const dialog = useDialog()
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

  function seededModel() {
    const current = local.model.current()
    return current?.providerID === "rai" ? splitModel(current.modelID) : undefined
  }

  function enter(next: RoomsRoute) {
    rememberRoomsReturn(route.data)
    dialog.clear()
    route.navigate({ ...next, openToken: nextRoomToken() })
  }

  function openRoom(room: RaiRooms.Room) {
    const seeded = seededModel()
    enter({
      type: "rooms",
      roomID: room.id,
      title: room.title,
      provider: room.provider ?? seeded?.provider ?? "xai",
      model: room.model ?? "",
      access: accessOf(room.perm),
      ...(room.projectID ? { projectID: room.projectID } : {}),
      running: room.running,
    })
  }

  function openNew() {
    const seeded = seededModel()
    const projectID = selectedProject()
    enter({
      type: "rooms",
      roomID: "0",
      title: t("New room"),
      provider: seeded?.provider ?? "xai",
      model: seeded?.model ?? "",
      access: "write",
      ...(projectID ? { projectID } : {}),
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
          if (room) openRoom(room)
        },
      },
      { bind: "n", title: t("New room"), group: "Dialog", run: openNew },
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
                if (room) openRoom(room)
              },
            },
            { title: "New room", key: "n", onTrigger: openNew },
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
                onMouseUp={() => openRoom(room)}
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
