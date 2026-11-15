import { createStore, reconcile } from "solid-js/store"
import type { LocationRef } from "@opencode/client"
import { createSimpleContext } from "./helper"
import type { PromptInfo } from "../prompt/history"
import { useTuiStartup } from "./runtime"

export type HomeRoute = {
  type: "home"
  prompt?: PromptInfo
  // Location carried over from the previous session or project picker so a new session lands there.
  location?: LocationRef
}

export type SessionRoute = {
  type: "session"
  sessionID: string
  prompt?: PromptInfo
}

export type PluginRoute = {
  type: "plugin"
  id: string
  name: string
  data?: Record<string, unknown>
}

/**
 * A ROKFOSS AI room opened like a session. The transcript stays in the view's memory and is never
 * written to the session store; only the room identity needed to reload it from the gateway is here.
 */
export type RoomsRoute = {
  type: "rooms"
  /** `"0"` is a room that has not been created on the gateway yet. */
  roomID: string
  title: string
  provider: string
  model: string
  access: "owner" | "write" | "read" | null
  projectID?: string
  running?: boolean
  /** Changes each time the list opens a room, so the view remounts. Omitted from identity updates. */
  openToken?: string
}

export type Route = HomeRoute | SessionRoute | PluginRoute | RoomsRoute

export const { use: useRoute, provider: RouteProvider } = createSimpleContext({
  name: "Route",
  init: (props: { initialRoute?: Route }) => {
    const startup = useTuiStartup()
    const [store, setStore] = createStore<Route>(
      props.initialRoute ?? initialRoute(startup.initialRoute) ?? { type: "home" },
    )

    return {
      get data() {
        return store
      },
      navigate(route: Route) {
        setStore(reconcile(route))
      },
    }
  },
})

function initialRoute(value: unknown): Route | undefined {
  if (!value || typeof value !== "object" || !("type" in value)) return
  if (value.type === "home") return { type: "home" }
  if (value.type === "session" && "sessionID" in value && typeof value.sessionID === "string") {
    return { type: "session", sessionID: value.sessionID }
  }
  if (
    value.type === "plugin" &&
    "id" in value &&
    typeof value.id === "string" &&
    "name" in value &&
    typeof value.name === "string"
  ) {
    const data =
      "data" in value && typeof value.data === "object" && value.data !== null && !Array.isArray(value.data)
        ? (value.data as Record<string, unknown>)
        : undefined
    if (data) return { type: "plugin", id: value.id, name: value.name, data }
    return { type: "plugin", id: value.id, name: value.name }
  }
  if (value.type === "rooms" && "roomID" in value && typeof value.roomID === "string" && value.roomID !== "") {
    const access =
      "access" in value && (value.access === "owner" || value.access === "write" || value.access === "read")
        ? value.access
        : null
    const projectID = "projectID" in value && typeof value.projectID === "string" ? value.projectID : undefined
    return {
      type: "rooms",
      roomID: value.roomID,
      title: "title" in value && typeof value.title === "string" ? value.title : "",
      provider: "provider" in value && typeof value.provider === "string" ? value.provider : "",
      model: "model" in value && typeof value.model === "string" ? value.model : "",
      access,
      ...(projectID ? { projectID } : {}),
      ...("running" in value && value.running === true ? { running: true } : {}),
    }
  }
}

export function useRouteData<T extends Route["type"]>(type: T) {
  const route = useRoute()
  return route.data as Extract<Route, { type: typeof type }>
}
