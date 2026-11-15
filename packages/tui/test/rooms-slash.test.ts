import { describe, expect, test } from "bun:test"
import { roomSlashCommands, roomSlashDirect, ROOM_SLASH_LIMIT, type SlashShape } from "../src/component/rooms-slash"

const command = (
  name: string,
  slash: string,
  options: { aliases?: string[]; arguments?: boolean } = {},
): SlashShape => ({
  name,
  title: name,
  slash: { name: slash, ...(options.aliases ? { aliases: options.aliases } : {}), ...options },
})

const commands: SlashShape[] = [
  command("models", "models"),
  command("agents", "agents"),
  command("credentials", "credentials", { aliases: ["rai"] }),
  command("cd", "cd", { arguments: true }),
  command("clear", "clear"),
  command("open", "open", { aliases: ["projects", "project"] }),
  command("settings", "settings"),
  command("themes", "themes"),
  command("help", "help"),
  command("usage", "usage"),
  command("status", "status"),
  command("debug", "debug"),
]

describe("room slash candidates", () => {
  test("prefix matches the command name", () => {
    expect(roomSlashCommands(commands, "/mod").map((item) => item.slash!.name)).toEqual(["models"])
  })

  test("prefix matches an alias", () => {
    expect(roomSlashCommands(commands, "/pro").map((item) => item.slash!.name)).toEqual(["open"])
    expect(roomSlashCommands(commands, "/rai").map((item) => item.slash!.name)).toEqual(["credentials"])
  })

  test("ignores case", () => {
    expect(roomSlashCommands(commands, "/MODE").map((item) => item.slash!.name)).toEqual(["models"])
    expect(roomSlashCommands(commands, "/RAI").map((item) => item.slash!.name)).toEqual(["credentials"])
  })

  test("a bare slash offers the list, capped", () => {
    const all = roomSlashCommands(commands, "/")
    expect(all.length).toBe(ROOM_SLASH_LIMIT)
    expect(all.some((item) => item.slash!.name === "clear")).toBe(false)
  })

  test("session-only commands are never offered", () => {
    expect(roomSlashCommands(commands, "/cl")).toEqual([])
    expect(roomSlashCommands(commands, "/c")).not.toContainEqual(expect.objectContaining({ name: "cd" }))
  })

  test("a space closes the list", () => {
    expect(roomSlashCommands(commands, "/models now")).toEqual([])
    expect(roomSlashCommands(commands, "hello")).toEqual([])
  })
})

describe("room slash direct execution", () => {
  test("runs a plain command with no input", () => {
    const result = roomSlashDirect(commands, "/models")
    expect(result?.command.slash?.name).toBe("models")
    expect(result?.input).toBe("")
  })

  test("passes arguments to a command that takes them", () => {
    // `cd` is session-only, so it must be refused even with arguments.
    expect(roomSlashDirect(commands, "/cd /tmp")).toBeUndefined()

    const withArguments = [...commands, command("setmodel", "setmodel", { arguments: true })]
    const result = roomSlashDirect(withArguments, "/setmodel xai/grok-4.7")
    expect(result?.command.slash?.name).toBe("setmodel")
    expect(result?.input).toBe("xai/grok-4.7")
  })

  test("refuses arguments on a command that declares none", () => {
    expect(roomSlashDirect(commands, "/models now")).toBeUndefined()
  })

  test("resolves aliases", () => {
    expect(roomSlashDirect(commands, "/rai")?.command.slash?.name).toBe("credentials")
    expect(roomSlashDirect(commands, "/project")?.command.slash?.name).toBe("open")
  })

  test("ignores unknown names and plain text", () => {
    expect(roomSlashDirect(commands, "/nope")).toBeUndefined()
    expect(roomSlashDirect(commands, "hello")).toBeUndefined()
    expect(roomSlashDirect(commands, "/")).toBeUndefined()
  })
})
