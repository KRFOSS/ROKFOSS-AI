import { createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useKeyboard, useRenderer } from "@opentui/solid"
import { isDeepEqual } from "remeda"
import { createSimpleContext } from "./helper"
import { useClient } from "./client"
import { locationKey, useData } from "./data"
import { withTimestampedFallback } from "@opencode/util/session-title-fallback"
import { useEvent } from "./event"
import { useRoute } from "./route"
import { useConfig } from "../config"
import { useLocation } from "./location"
import { useStorage } from "./storage"
import { useTuiPaths } from "./runtime"
import { newSessionLocation } from "../config/new-session-location"
import { createSessionRetention } from "@opencode/client/solid"
import { createProgramStatus, type PendingSession } from "./program-status"
import { anchorKey, type AnchorTarget } from "../routes/session/anchors"
import { t } from "../i18n"
import { isRoomTab, nextRoomToken, roomIDOfTab, roomTabID } from "../component/rooms-nav"
import {
  closeSessionTab,
  cycleSessionTab,
  moveSessionTab,
  moveSessionTabHistory,
  NEW_SESSION_TAB_TITLE,
  openSessionTab,
  recordClosedSessionTab,
  recordSessionTabHistory,
  reopenSessionTab,
  type ClosedSessionTab,
  type SessionTab,
  type SessionTabHistory,
} from "./session-tabs-model"

type TabsState = {
  tabs: SessionTab[]
  // Kept empty for rollback compatibility with clients that still read this field.
  unread: Record<string, unknown>
}

type PersistedState = {
  global: TabsState
  cwd: Record<string, TabsState>
}

export type ScrollAnchor = {
  target: AnchorTarget
  screenY: number
}

const empty = (): TabsState => ({ tabs: [], unread: {} })

// Deliberately after connect settles: the visible session's mount syncs win the first slots.
const TAB_PREFETCH_DELAY = 300
const VIEW_RETRY_DELAY = 250
const VIEW_RETRY_MAX_DELAY = 5_000

export const { use: useSessionTabs, provider: SessionTabsProvider } = createSimpleContext({
  name: "SessionTabs",
  init: () => {
    const route = useRoute()
    const client = useClient()
    const data = useData()
    const event = useEvent()
    const config = useConfig().data
    const location = useLocation()
    const paths = useTuiPaths()
    const renderer = useRenderer()
    const storage = useStorage()
    const enabled = () => config.tabs.enabled
    const [focused, setFocused] = createSignal<boolean>()
    // Keyed reconcile keeps tab object identity across reorders, so strip rows move instead of
    // mutating in place, which per-row animations and drag state depend on.
    const [store, updateStore] = storage.store<PersistedState>("tabs", {
      initial: {
        global: empty(),
        cwd: {},
      },
      key: "sessionID",
    })
    const fallback = empty()
    const [promptPulses, setPromptPulses] = createSignal<Record<string, number>>({})
    let history: SessionTabHistory = { entries: [], index: -1 }
    // User-closed tabs eligible for reopening; in-memory like history, deleted sessions pruned.
    const [closedTabs, setClosedTabs] = createSignal<ClosedSessionTab[]>([])
    // Storage mutations apply against the on-disk draft under a file lock, so
    // a registration queued by the route effect can land AFTER a removal that
    // ran while the write was still in flight — resurrecting a tab that was
    // just closed. Removing a tab marks it cancelled so any late-applying
    // registration becomes a no-op; navigating to the session again clears
    // the mark.
    const cancelledTabs = new Set<string>()
    const scrollAnchors = new Map<string, ScrollAnchor>()
    const [expandedGroups, setExpandedGroups] = createStore<Record<string, Record<string, boolean> | undefined>>({})

    const onFocus = () => setFocused(true)
    const onBlur = () => setFocused(false)
    useKeyboard(onFocus)
    renderer.on("focus", onFocus)
    renderer.on("blur", onBlur)
    onCleanup(() => {
      renderer.off("focus", onFocus)
      renderer.off("blur", onBlur)
    })

    function state() {
      if (config.tabs.scope === "cwd") return store.cwd[paths.cwd] ?? fallback
      return store.global
    }

    function update(mutation: (draft: TabsState) => void) {
      const scope = config.tabs.scope
      void updateStore((draft) => mutation(scope === "cwd" ? (draft.cwd[paths.cwd] ??= empty()) : draft.global)).catch(
        // Failed writes lose only tab layout, but silence would hide tabs resetting every launch.
        (error) => console.error("Failed to persist session tabs", error),
      )
    }

    // A room tab id is not a session id: every session API call is guarded so a room tab can never
    // reach the server as if it were a session.
    const root = (sessionID: string) => (isRoomTab(sessionID) ? sessionID : data.session.root(sessionID))
    const title = (sessionID: string, persisted?: string, fallback?: string) => {
      if (isRoomTab(sessionID)) return persisted ?? t("ROKFOSS AI room")
      const session = data.session.get(sessionID)
      return session?.title ?? persisted ?? fallback ?? (session ? withTimestampedFallback(session) : undefined)
    }
    const isUnread = (sessionID: string) => {
      const info = data.session.get(sessionID)
      return info?.time.idle !== undefined && (info.time.viewed === undefined || info.time.idle > info.time.viewed)
    }
    const family = (sessionID: string) => {
      if (isRoomTab(sessionID)) return [sessionID]
      const session = root(sessionID)
      const members = data.session.family(session)
      return members.includes(session) ? members : [session, ...members]
    }
    const normalize = (value: TabsState) => ({
      tabs: value.tabs.reduce<SessionTab[]>((tabs, tab) => {
        if (isRoomTab(tab.sessionID)) return openSessionTab(tabs, tab)
        const sessionID = root(tab.sessionID)
        return openSessionTab(tabs, { sessionID, title: title(sessionID, tab.title) })
      }, []),
      unread: {},
    })
    const current = () => {
      if (route.data.type === "session") return root(route.data.sessionID)
      // `"0"` is a room that does not exist on the gateway yet, so it has no tab to highlight.
      if (route.data.type === "rooms" && route.data.roomID !== "0") return roomTabID(route.data.roomID)
      return undefined
    }
    createSessionRetention({
      session: data.session,
      current: () =>
        route.data.type === "session" && route.data.sessionID !== "dummy" ? route.data.sessionID : undefined,
      keep: () => (enabled() ? state().tabs.filter((tab) => !isRoomTab(tab.sessionID)).map((tab) => tab.sessionID) : []),
      limit: 3,
    })
    const newTab = createMemo((open = false) => {
      if (route.data.type === "home") return true
      if (!open) return false
      const sessionID = current()
      return sessionID !== undefined && !state().tabs.some((tab) => tab.sessionID === sessionID)
    }, false)
    const status = (sessionID: string) => {
      if (isRoomTab(sessionID)) {
        // A room has no session status; only the room currently on screen can be busy, and the
        // transcript itself never reaches the session store.
        const running =
          route.data.type === "rooms" &&
          roomIDOfTab(sessionID) === route.data.roomID &&
          route.data.running === true
        return {
          unread: undefined,
          promptPulse: 0,
          attention: false as const,
          busy: running,
          renaming: false,
        }
      }
      const session = root(sessionID)
      const members = family(session)
      return {
        // Unread reads the root session only: background subagent completions wake the parent,
        // whose own idle transition then carries the signal.
        unread: !isUnread(session)
          ? undefined
          : data.session.get(session)?.outcome === "failed"
            ? ("error" as const)
            : ("activity" as const),
        promptPulse: promptPulses()[session] ?? 0,
        attention: members.some((id) => (data.session.permission.list(id)?.length ?? 0) > 0)
          ? ("permission" as const)
          : members.some((id) => (data.session.form.list(id)?.length ?? 0) > 0)
            ? ("question" as const)
            : (false as const),
        // Parked synthetic context (user shells, plan reminders) stays pending without execution; only work counts as busy.
        busy: members.some(
          (id) =>
            data.session.status(id) === "running" ||
            data.session.pending.list(id).some((item) => item.type !== "synthetic"),
        ),
        renaming: data.session.title.pending(session),
      }
    }

    createProgramStatus({
      renderer,
      sessions: () => {
        const viewed = route.data.type === "session" && route.data.sessionID !== "dummy" ? current() : undefined
        const tabs = enabled() ? state().tabs.filter((tab) => !isRoomTab(tab.sessionID)).map((tab) => tab.sessionID) : []
        return Array.from(new Set(viewed ? [...tabs, viewed] : tabs)).flatMap((sessionID): PendingSession[] => {
          const session = status(sessionID)
          if (session.attention)
            return [
              {
                id: sessionID,
                title: title(sessionID),
                state: "blocked",
                kind: session.attention,
                message: session.attention === "permission" ? "Permission needs input" : "Input needs response",
              },
            ]
          if (session.busy) return [{ id: sessionID, title: title(sessionID), state: "working" }]
          return []
        })
      },
    })

    // Shared storage updates must not re-admit a tab unless this client changes route or scope.
    createEffect(
      on(
        [
          () => {
            if (!enabled()) return undefined
            if (route.data.type === "session") return route.data.sessionID
            // A room that has not reached the gateway yet (`"0"`) has no tab to register.
            if (route.data.type === "rooms" && route.data.roomID !== "0") return roomTabID(route.data.roomID)
            return undefined
          },
          () => config.tabs.scope,
        ],
        ([routed]) => {
          if (!routed || routed === "dummy") return
          const roomID = roomIDOfTab(routed)
          const sessionID = root(routed)
          cancelledTabs.delete(sessionID)
          history = recordSessionTabHistory(history, sessionID)
          if (roomID !== undefined) {
            // Store the room identity needed to reopen it, never a transcript.
            if (route.data.type !== "rooms" || route.data.roomID !== roomID) return
            // Captured here because the store update below runs outside the narrowing above.
            const roomRoute = route.data
            const existing = state().tabs.find((tab) => tab.sessionID === sessionID)
            const room = {
              provider: roomRoute.provider,
              model: roomRoute.model,
              access: roomRoute.access,
              ...(roomRoute.projectID ? { projectID: roomRoute.projectID } : {}),
            }
            update((draft) => {
              if (cancelledTabs.has(sessionID)) return
              const tab = { sessionID, title: roomRoute.title || existing?.title, room }
              const index = draft.tabs.findIndex((item) => item.sessionID === sessionID)
              draft.tabs =
                index === -1
                  ? openSessionTab(draft.tabs, tab)
                  : draft.tabs.map((item) => (item.sessionID === sessionID ? { ...item, ...tab } : item))
            })
            return
          }
          if (state().tabs.some((tab) => tab.sessionID === sessionID)) return
          const fallback = newTab() ? NEW_SESSION_TAB_TITLE : undefined
          update((draft) => {
            if (cancelledTabs.has(sessionID)) return
            const tab = {
              sessionID,
              title: title(sessionID, draft.tabs.find((tab) => tab.sessionID === sessionID)?.title, fallback),
            }
            draft.tabs = openSessionTab(draft.tabs, tab)
          })
        },
      ),
    )

    // Viewed state is server-global, so acknowledgement runs even with tabs disabled: other
    // clients rely on this client reporting what its user has seen.
    const acknowledged = new Map<string, number>()
    const [viewRetry, setViewRetry] = createSignal(0)
    let viewRetryTimer: ReturnType<typeof setTimeout> | undefined
    let viewRetryAttempt = 0
    onCleanup(() => clearTimeout(viewRetryTimer))
    createEffect(() => {
      viewRetry()
      if (focused() !== true) return
      if (route.data.type !== "session" || route.data.sessionID === "dummy") return
      const sessionID = root(route.data.sessionID)
      const idle = data.session.get(sessionID)?.time.idle
      if (idle === undefined || !isUnread(sessionID) || acknowledged.get(sessionID) === idle) return
      // Record before the request so event-driven re-runs don't re-post the same watermark.
      acknowledged.set(sessionID, idle)
      void client.api.session.view({ sessionID, idle }).then(
        () => {
          clearTimeout(viewRetryTimer)
          viewRetryTimer = undefined
          viewRetryAttempt = 0
        },
        () => {
          if (acknowledged.get(sessionID) !== idle) return
          acknowledged.delete(sessionID)
          if (viewRetryTimer) return
          const delay = Math.min(VIEW_RETRY_DELAY * 2 ** viewRetryAttempt, VIEW_RETRY_MAX_DELAY)
          viewRetryAttempt++
          viewRetryTimer = setTimeout(() => {
            viewRetryTimer = undefined
            setViewRetry((value) => value + 1)
          }, delay)
        },
      )
    })

    createEffect(() => {
      if (!enabled()) return
      const next = normalize(state())
      if (isDeepEqual(next, state())) return
      update((draft) => {
        const next = normalize(draft)
        draft.tabs = next.tabs
        draft.unread = next.unread
      })
    })

    // Load lightweight session and location metadata concurrently so persisted tabs can resolve
    // their project and branch labels. Delay the heavier per-tab data so the visible session keeps
    // the first connection slots and switches still render from a warm cache.
    const openTabSessions = createMemo(() =>
      state()
        // A room tab is not a session, so prefetching it would ask the server for a session that
        // does not exist.
        .tabs.filter((tab) => !isRoomTab(tab.sessionID))
        .map((tab) => tab.sessionID)
        .sort()
        .join("\n"),
    )
    createEffect(() => {
      if (!enabled()) return
      if (client.connection.status() !== "connected") return
      const signature = openTabSessions()
      if (signature === "") return
      const sessionIDs = signature.split("\n")
      let stale = false
      void (async () => {
        await Promise.allSettled(sessionIDs.map((sessionID) => data.session.sync(sessionID, { children: true })))
        if (stale) return
        const locations = new Map(
          sessionIDs
            .map((sessionID) => data.session.get(sessionID)?.location)
            .filter((location) => location !== undefined)
            .map((location) => [locationKey(location), location]),
        )
        await Promise.allSettled(
          Array.from(locations.values(), (location) =>
            Promise.all([data.location.syncInfo(location), data.location.vcs.sync(location)]),
          ),
        )
      })()
      const timer = setTimeout(async () => {
        const sessions = state()
          .tabs.map((tab) => tab.sessionID)
          .filter((sessionID) => sessionID !== current())
        for (const sessionID of sessions) {
          if (stale) return
          await Promise.allSettled([
            data.session.message.sync(sessionID),
            data.session.pending.sync(sessionID),
            data.session.permission.sync(sessionID),
            data.session.form.sync(sessionID),
          ])
        }
      }, TAB_PREFETCH_DELAY)
      onCleanup(() => {
        stale = true
        clearTimeout(timer)
      })
    })

    onCleanup(
      event.on("session.moved", (evt) => {
        if (!enabled() || !state().tabs.some((tab) => tab.sessionID === root(evt.data.sessionID))) return
        void Promise.allSettled([data.location.syncInfo(evt.data.location), data.location.vcs.sync(evt.data.location)])
      }),
    )
    onCleanup(
      event.on("session.inbox.enqueued", (evt) => {
        if (!enabled() || evt.data.item.type !== "user") return
        const sessionID = root(evt.data.sessionID)
        if (current() === sessionID || !state().tabs.some((tab) => tab.sessionID === sessionID)) return
        setPromptPulses((pulses) => ({ ...pulses, [sessionID]: (pulses[sessionID] ?? 0) + 1 }))
      }),
    )
    onCleanup(
      event.on("session.deleted", (evt) => {
        const target = root(evt.data.sessionID)
        setClosedTabs((entries) => entries.filter((entry) => entry.tab.sessionID !== target))
        remove(evt.data.sessionID, enabled())
      }),
    )

    /**
     * Opens a tab's own screen. A room tab reopens the gateway room with the identity stored on the
     * tab, so selecting it never asks the session API about a session that does not exist. Returns
     * whether the tab was a room, so callers can fall back to a session navigation.
     */
    function navigateTab(tab: SessionTab) {
      const roomID = roomIDOfTab(tab.sessionID)
      if (roomID === undefined) return false
      route.navigate({
        type: "rooms",
        roomID,
        title: tab.title ?? "",
        provider: tab.room?.provider ?? "",
        model: tab.room?.model ?? "",
        access: tab.room?.access ?? null,
        ...(tab.room?.projectID ? { projectID: tab.room.projectID } : {}),
        openToken: nextRoomToken(),
      })
      return true
    }

    function remove(sessionID: string, navigate: boolean) {
      const target = root(sessionID)
      cancelledTabs.add(target)
      family(target).forEach((id) => {
        scrollAnchors.delete(id)
        setExpandedGroups(id, undefined)
      })
      const closed = closeSessionTab(state().tabs, target)
      const selected = navigate && current() === target
      if (closed.tabs === state().tabs && !selected) return
      const previous = selected
        ? moveSessionTabHistory(recordSessionTabHistory(history, target), closed.tabs, target, -1)
        : { history, sessionID: undefined }
      const next = previous.sessionID ?? closed.next
      // Resolved before the tab is dropped, because a room tab carries the identity used to reopen it.
      const nextTab = next === undefined ? undefined : state().tabs.find((tab) => tab.sessionID === next)
      history = previous.history
      update((draft) => {
        draft.tabs = closeSessionTab(draft.tabs, target).tabs
      })
      setPromptPulses((pulses) => {
        if (pulses[target] === undefined) return pulses
        const next = { ...pulses }
        delete next[target]
        return next
      })
      if (!selected) return
      if (nextTab && navigateTab(nextTab)) return
      route.navigate(next ? { type: "session", sessionID: next } : { type: "home" })
    }

    return {
      enabled,
      tabs() {
        return state().tabs
      },
      recentlyClosed() {
        return closedTabs()
          .filter((entry) => !state().tabs.some((tab) => tab.sessionID === entry.tab.sessionID))
          .toReversed()
          .map((entry) => ({
            ...entry.tab,
            title: isRoomTab(entry.tab.sessionID)
              ? entry.tab.title
              : (data.session.get(entry.tab.sessionID)?.title ?? entry.tab.title),
          }))
      },
      newTab() {
        return newTab()
      },
      current,
      status,
      scrollAnchor(sessionID: string) {
        const target = root(sessionID)
        if (!state().tabs.some((tab) => tab.sessionID === target)) return
        return scrollAnchors.get(sessionID)
      },
      setScrollAnchor(sessionID: string, anchor: ScrollAnchor | undefined) {
        const target = root(sessionID)
        if (anchor === undefined || !state().tabs.some((tab) => tab.sessionID === target)) {
          scrollAnchors.delete(sessionID)
          return
        }
        const current = scrollAnchors.get(sessionID)
        if (current && anchorKey(current.target) === anchorKey(anchor.target) && current.screenY === anchor.screenY)
          return
        scrollAnchors.set(sessionID, anchor)
      },
      groupExpanded(sessionID: string, groupID: string) {
        return expandedGroups[sessionID]?.[groupID]
      },
      setGroupExpanded(sessionID: string, groupID: string, expanded: boolean) {
        setExpandedGroups(sessionID, (current) => ({ ...current, [groupID]: expanded }))
      },
      select(sessionID: string) {
        if (!enabled()) return
        const tab = state().tabs.find((item) => item.sessionID === sessionID)
        if (tab && navigateTab(tab)) return
        route.navigate({ type: "session", sessionID: root(sessionID) })
      },
      open(sessionID: string) {
        if (!enabled()) return
        const session = root(sessionID)
        if (state().tabs.some((tab) => tab.sessionID === session)) return
        cancelledTabs.delete(session)
        update((draft) => {
          draft.tabs = openSessionTab(draft.tabs, { sessionID: session, title: title(session) })
        })
      },
      add() {
        if (!enabled()) return
        const sessionID = current()
        const currentLocation =
          (sessionID && !isRoomTab(sessionID) ? data.session.get(sessionID)?.location : undefined) ?? location.ref
        route.navigate({
          type: "home",
          location: newSessionLocation(
            config.session.new_location,
            data.location.default().directory,
            currentLocation,
            location.error?.location,
          ),
        })
      },
      close(sessionID?: string) {
        if (!enabled()) return
        const target = sessionID ? root(sessionID) : current()
        if (!target) {
          const previous = moveSessionTabHistory(history, state().tabs, undefined, -1)
          history = previous.history
          const session = previous.sessionID ?? state().tabs.at(-1)?.sessionID
          const tab = session === undefined ? undefined : state().tabs.find((item) => item.sessionID === session)
          if (route.data.type === "home" && tab && !navigateTab(tab)) route.navigate({ type: "session", sessionID: tab.sessionID })
          return
        }
        const index = state().tabs.findIndex((tab) => tab.sessionID === target)
        const tab = state().tabs[index]
        if (tab) setClosedTabs((entries) => recordClosedSessionTab(entries, tab, index))
        remove(target, true)
      },
      reopen(sessionID?: string) {
        if (!enabled()) return
        const result = reopenSessionTab(closedTabs(), state().tabs, sessionID)
        setClosedTabs(result.stack)
        const tabs = result.tabs
        if (!tabs || !result.sessionID) return
        cancelledTabs.delete(result.sessionID)
        update((draft) => {
          draft.tabs = tabs
        })
        const reopened = tabs.find((tab) => tab.sessionID === result.sessionID)
        if (reopened && navigateTab(reopened)) return
        route.navigate({ type: "session", sessionID: result.sessionID })
      },
      move(sessionID: string, index: number) {
        if (!enabled()) return
        const session = root(sessionID)
        if (moveSessionTab(state().tabs, session, index) === state().tabs) return
        update((draft) => {
          draft.tabs = moveSessionTab(draft.tabs, session, index)
        })
      },
      cycle(direction: 1 | -1) {
        if (!enabled()) return
        const tab = cycleSessionTab(state().tabs, current(), direction)
        if (tab) navigateTab(tab)
      },
      cycleUnread(direction: 1 | -1) {
        if (!enabled()) return
        const tab = cycleSessionTab(state().tabs, current(), direction, (tab) =>
          Boolean(status(tab.sessionID).unread || status(tab.sessionID).attention),
        )
        if (tab) navigateTab(tab)
      },
      selectIndex(index: number) {
        if (!enabled()) return
        const tab = state().tabs[index]
        if (tab) navigateTab(tab)
      },
    }
  },
})
