import { describe, expect, test } from "bun:test"
import type { Permission } from "@opencode/schema/permission"
import {
  disableLocalTools,
  enableLocalTools,
  LOCAL_TOOL_ACTIONS,
  LOCAL_TOOLS_MARKER,
  localToolsDisabled,
  toggleLocalTools,
} from "../src/util/local-tools"

const rule = (action: string, resource: string, effect: Permission.Effect): Permission.Rule => ({
  action,
  resource,
  effect,
})

// The core's last-match evaluation, kept here so the test does not need the core package.
const wildcard = (value: string, pattern: string) =>
  new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".")}$`,
  ).test(value)
const effect = (action: string, resource: string, rules: ReadonlyArray<Permission.Rule>) =>
  rules.findLast((item) => wildcard(action, item.action) && wildcard(resource, item.resource))?.effect ?? "ask"

const userRules: Permission.Rule[] = [
  rule("shell", "git *", "allow"),
  rule("read", "*.env", "deny"),
  rule("shell", "*", "deny"),
  rule("websearch", "*", "allow"),
]

describe("local tools toggle", () => {
  test("turning off appends the marker and a wildcard deny for every local action", () => {
    const next = disableLocalTools(userRules)
    expect(next.slice(0, userRules.length)).toEqual(userRules)
    expect(next.slice(userRules.length)).toEqual([
      rule(LOCAL_TOOLS_MARKER, "*", "deny"),
      ...LOCAL_TOOL_ACTIONS.map((action) => rule(action, "*", "deny")),
    ])
    expect(localToolsDisabled(next)).toBe(true)
    expect(localToolsDisabled(userRules)).toBe(false)
  })

  test("the appended rules win over the user's allows and leave other tools alone", () => {
    const next = disableLocalTools(userRules)
    expect(effect("shell", "git status", next)).toBe("deny")
    expect(effect("read", "src/index.ts", next)).toBe("deny")
    expect(effect("edit", "src/index.ts", next)).toBe("deny")
    expect(effect("write", "src/index.ts", next)).toBe("deny")
    expect(effect("patch", "src/index.ts", next)).toBe("deny")
    expect(effect("grep", "*", next)).toBe("deny")
    expect(effect("websearch", "anything", next)).toBe("allow")
    expect(effect("webfetch", "https://example.com", next)).toBe("ask")
    expect(effect("todowrite", "*", next)).toBe("ask")
  })

  test("turning off twice does not stack another block", () => {
    const once = disableLocalTools(userRules)
    expect(disableLocalTools(once)).toEqual(once)
  })

  test("turning back on restores exactly the user's rules, including an identical deny", () => {
    expect(enableLocalTools(disableLocalTools(userRules))).toEqual(userRules)
    expect(enableLocalTools(disableLocalTools([]))).toEqual([])
    expect(enableLocalTools(disableLocalTools(undefined))).toEqual([])
  })

  test("rules added while off are kept when turning back on", () => {
    const later = [rule("shell", "*", "deny"), rule("webfetch", "*", "deny")]
    const next = enableLocalTools([...disableLocalTools(userRules), ...later])
    expect(next).toEqual([...userRules, ...later])
  })

  test("turning on without the marker changes nothing", () => {
    expect(enableLocalTools(userRules)).toEqual(userRules)
    expect(enableLocalTools(undefined)).toEqual([])
  })

  test("only the run right after the marker is removed", () => {
    const partial = [
      ...userRules,
      rule(LOCAL_TOOLS_MARKER, "*", "deny"),
      rule("shell", "*", "deny"),
      rule("question", "*", "deny"),
      rule("read", "*", "deny"),
    ]
    expect(enableLocalTools(partial)).toEqual([...userRules, rule("question", "*", "deny"), rule("read", "*", "deny")])
  })

  test("toggle flips between the two states", () => {
    const off = toggleLocalTools(userRules)
    expect(off.disabled).toBe(true)
    expect(off.permissions).toEqual(disableLocalTools(userRules))
    const on = toggleLocalTools(off.permissions)
    expect(on.disabled).toBe(false)
    expect(on.permissions).toEqual(userRules)
  })

  test("does not modify the input array", () => {
    const input = [...userRules]
    disableLocalTools(input)
    enableLocalTools(disableLocalTools(input))
    expect(input).toEqual(userRules)
  })
})
