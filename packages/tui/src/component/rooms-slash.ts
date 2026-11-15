/**
 * Slash commands for a ROKFOSS AI room.
 *
 * A room is not a session, so only the commands that work without one are offered here. The
 * session-scoped commands would either act on a session the room does not have or write the room
 * transcript into the session store, which the gateway specification forbids.
 */

export type SlashShape = {
  readonly name: string
  /** Falls back to the slash name when a command carries no title. */
  readonly title?: string
  readonly slash?: {
    readonly name: string
    readonly aliases?: readonly string[]
    readonly arguments?: boolean
  }
  /** Executes the command; absent on a shape used only for listing. */
  readonly run?: (input?: string) => void | false | Promise<void>
}

/** Slash names that need an open session: hiding them keeps a room from acting on the wrong one. */
export const SESSION_ONLY_SLASH: ReadonlySet<string> = new Set([
  // Session lifecycle and its transcript.
  "clear",
  "fork",
  "share",
  "unshare",
  "compact",
  // Working directory and per-session tooling.
  "cd",
  "editor",
  "skills",
  "worktrees",
])

/** Candidates a typed `/` prefix offers, at most a screenful. */
export const ROOM_SLASH_LIMIT = 8

const head = (input: string) => {
  if (!input.startsWith("/")) return undefined
  const rest = input.slice(1)
  // Once the user typed a space they are past the command name: the list closes and `/name args`
  // runs directly instead.
  if (/\s/.test(rest)) return undefined
  return rest
}

const matches = (command: SlashShape, value: string) => {
  const slash = command.slash
  if (!slash) return false
  if (slash.name.toLowerCase().startsWith(value)) return true
  return slash.aliases?.some((alias) => alias.toLowerCase().startsWith(value)) === true
}

/** Every slash name a command answers to, name first. */
const namesOf = (command: SlashShape) => [command.slash!.name, ...(command.slash!.aliases ?? [])]

/** Commands offered while the draft is still the command name, filtered by what was typed. */
export function roomSlashCommands<T extends SlashShape>(commands: readonly T[], input: string): T[] {
  const value = head(input)
  if (value === undefined) return []
  const lower = value.toLowerCase()
  return commands
    .filter((command) => command.slash && !SESSION_ONLY_SLASH.has(command.slash.name))
    .filter((command) => matches(command, lower))
    .slice(0, ROOM_SLASH_LIMIT)
}

/**
 * The command a completed `/name args` line names, if it may run in a room. Arguments are passed
 * only to commands that declare them, so `/models now` is refused rather than run with junk.
 */
export function roomSlashDirect<T extends SlashShape>(
  commands: readonly T[],
  input: string,
): { command: T; input: string } | undefined {
  const trimmed = input.trimStart()
  if (!trimmed.startsWith("/")) return undefined
  const body = trimmed.slice(1)
  if (body.length === 0) return undefined
  const space = body.search(/\s/)
  const name = (space === -1 ? body : body.slice(0, space)).toLowerCase()
  const args = space === -1 ? "" : body.slice(space + 1).trim()
  if (name.length === 0) return undefined

  const command = commands.find(
    (item) =>
      item.slash &&
      !SESSION_ONLY_SLASH.has(item.slash.name) &&
      namesOf(item).some((candidate) => candidate.toLowerCase() === name),
  )
  if (!command) return undefined
  if (!command.slash!.arguments && args.length > 0) return undefined
  return { command, input: command.slash!.arguments ? args : "" }
}
