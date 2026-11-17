import type { JsonValue } from "@opencode/client"
import type { RaiTurns } from "@opencode/schema/rai-turns"
import { createEffect, on, onCleanup } from "solid-js"
import { useClient } from "../context/client"
import { useData } from "../context/data"

const turnsID = "opencode.rai.turns"
/** How often an open session bound to a room catches up with what the web wrote there. */
const syncEveryMs = 2_000

/**
 * While a session bound to a room is open, the room's new messages from the web show up in it as user and assistant
 * messages, and an answer the room is making streams in live. Each call returns at once: following a running answer
 * happens in the plugin. The relay keeps out this session's own turns, so nothing it recorded comes back, and an
 * unbound session's call does nothing.
 */
export function useRoomSync(sessionID: () => string | undefined) {
  const client = useClient()
  const data = useData()
  createEffect(
    on(sessionID, (id) => {
      if (!id) return
      let stopped = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const call = async <T>(method: string) => {
        const directory = data.session.get(id)?.location.directory ?? data.location.default().directory
        const result = await client.api.rpc.call({
          rpcID: turnsID,
          method,
          input: { sessionID: id } as JsonValue,
          location: { directory },
        })
        return result.output as T
      }
      const tick = async () => {
        if (stopped) return
        try {
          await call<RaiTurns.Synced>("sync")
        } catch {
          // Catching up is best effort; the next tick tries again.
        }
        if (!stopped) timer = setTimeout(() => void tick(), syncEveryMs)
      }
      void tick()
      onCleanup(() => {
        stopped = true
        if (timer) clearTimeout(timer)
      })
    }),
  )
}
