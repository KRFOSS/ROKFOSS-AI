import { createSignal } from "solid-js"
import type { Route } from "../context/route"

/**
 * Room tabs share the session tab strip, so their ids are namespaced: a room id is not a session id and
 * must never reach the session API. `roomIDOfTab` is the inverse of `roomTabID`.
 */
export const ROOM_TAB_PREFIX = "rai:"

export function roomTabID(roomID: string): string {
  return ROOM_TAB_PREFIX + roomID
}

export function isRoomTab(tabID: string): boolean {
  return tabID.startsWith(ROOM_TAB_PREFIX)
}

export function roomIDOfTab(tabID: string): string | undefined {
  if (!isRoomTab(tabID)) return undefined
  return tabID.slice(ROOM_TAB_PREFIX.length)
}

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

/**
 * Room a session is recording into. Kept client-side so the prompt footer can show it without asking the gateway on
 * every frame; the value itself comes from the turns RPC and never contains message text.
 */
const [bound, setBound] = createSignal<ReadonlyMap<string, string>>(new Map())

export function boundRoomTitle(sessionID: string | undefined): string | undefined {
  if (!sessionID) return undefined
  return bound().get(sessionID)
}

export function setBoundRoom(sessionID: string, title: string | undefined) {
  setBound((current) => {
    const next = new Map(current)
    if (title === undefined) next.delete(sessionID)
    else next.set(sessionID, title)
    return next
  })
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
