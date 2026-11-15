import { describe, expect, test } from "bun:test"
import { isRoomTab, roomIDOfTab, roomTabID } from "../src/component/rooms-nav"
import {
  closeSessionTab,
  moveSessionTab,
  openSessionTab,
  recordClosedSessionTab,
  reopenSessionTab,
  type SessionTab,
} from "../src/context/session-tabs-model"

const room = (tab: SessionTab) => {
  expect(tab.room).toEqual({ provider: "xai", model: "grok-4.7", access: "write", projectID: "7" })
  return tab
}

const roomTab: SessionTab = {
  sessionID: roomTabID("42"),
  title: "미러 점검",
  room: { provider: "xai", model: "grok-4.7", access: "write", projectID: "7" },
}

describe("room tab ids", () => {
  test("round trip a room id and stay apart from session ids", () => {
    expect(roomTabID("42")).toBe("rai:42")
    expect(isRoomTab(roomTabID("42"))).toBe(true)
    expect(roomIDOfTab(roomTabID("42"))).toBe("42")

    // A session id the gateway happened to name the same way must stay a session.
    expect(isRoomTab("ses_42")).toBe(false)
    expect(isRoomTab("")).toBe(false)
    expect(roomIDOfTab("ses_42")).toBeUndefined()
  })
})

describe("tab model keeps room identity", () => {
  test("opening an existing room tab keeps its room", () => {
    const tabs = openSessionTab([], roomTab)
    expect(tabs).toHaveLength(1)
    // A title refresh must not drop the identity used to reopen the room.
    const renamed = openSessionTab(tabs, { sessionID: roomTab.sessionID, title: "새 제목" })
    expect(renamed[0]!.title).toBe("새 제목")
    room(renamed[0]!)
  })

  test("opening a tab that already exists is a no-op by identity", () => {
    const tabs = openSessionTab([], roomTab)
    expect(openSessionTab(tabs, roomTab)).toBe(tabs)
  })

  test("moving a room tab keeps the room", () => {
    const tabs = openSessionTab(openSessionTab([], { sessionID: "ses_a" }), roomTab)
    const moved = moveSessionTab(tabs, roomTab.sessionID, 0)
    expect(moved[0]!.sessionID).toBe(roomTab.sessionID)
    room(moved[0]!)
  })

  test("closing a room tab reports the neighbour to open next", () => {
    const tabs = openSessionTab(openSessionTab([], roomTab), { sessionID: "ses_b" })
    const closed = closeSessionTab(tabs, roomTab.sessionID)
    expect(closed.tabs.map((tab) => tab.sessionID)).toEqual(["ses_b"])
    expect(closed.next).toBe("ses_b")
  })

  test("a closed room tab can be recorded and reopened with its room", () => {
    const entry = { tab: roomTab, index: 0 }
    const stack = recordClosedSessionTab([], roomTab, 0)
    expect(stack).toEqual([entry])

    const reopened = reopenSessionTab(stack, [], roomTab.sessionID)
    expect(reopened.sessionID).toBe(roomTab.sessionID)
    room(reopened.tabs![0]!)
  })
})
