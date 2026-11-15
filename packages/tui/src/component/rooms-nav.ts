import type { Route } from "../context/route"

/** Where `/rooms` was opened from, so leaving a room restores that screen and the list dialog. */
let back: Route = { type: "home" }

export function rememberRoomsReturn(route: Route) {
  if (route.type === "rooms") return
  if (route.type === "home") {
    back = route.location ? { type: "home", location: route.location } : { type: "home" }
    return
  }
  if (route.type === "session") {
    back = { type: "session", sessionID: route.sessionID }
    return
  }
  back = route.data
    ? { type: "plugin", id: route.id, name: route.name, data: route.data }
    : { type: "plugin", id: route.id, name: route.name }
}

export function roomsReturn(): Route {
  return back
}

let opened = 0

/** Distinct each time the list opens a room, so the full-screen view remounts. */
export function nextRoomToken() {
  opened += 1
  return String(opened)
}

export function accessOf(value: string | null | undefined): "owner" | "write" | "read" | null {
  if (value === "owner" || value === "write" || value === "read") return value
  return null
}
