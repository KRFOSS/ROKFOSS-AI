import type { Permission } from "@opencode/schema/permission"

/**
 * Permission actions of the built-in tools that touch this computer: running commands, reading, searching and
 * writing local files, leaving the project directory, and the ways around those (a subagent runs in its own session
 * and a schedule runs later, neither under this session's rules).
 * Write and patch register under `edit` (which also covers worktree removal); they are listed too in case a tool
 * registers under its own name. Codemode tools are named `<namespace>_<tool>`.
 * Web search, web fetch, todos, questions and skills stay on.
 */
export const LOCAL_TOOL_ACTIONS = [
  "shell",
  "read",
  "edit",
  "write",
  "patch",
  "glob",
  "grep",
  "external_directory",
  "subagent",
  "opencode_worktree_create",
  "opencode_schedule_create",
] as const

/**
 * Leads the block of deny rules the toggle appends. No tool asks for this action, so the rule itself changes nothing;
 * it only marks where the toggle's own rules start, so turning local tools back on removes those and keeps every
 * rule the user had, even an identical deny.
 */
export const LOCAL_TOOLS_MARKER = "opencode_local_tools_off"

type Rule = Permission.Rule

const deny = (action: string): Rule => ({ action, resource: "*", effect: "deny" })

/** Whether the session's own rules currently carry the toggle's block. */
export function localToolsDisabled(rules: ReadonlyArray<Rule> | undefined) {
  return (rules ?? []).some((rule) => rule.action === LOCAL_TOOLS_MARKER)
}

/**
 * Appends the marker and a wildcard deny for every local action. Session rules are evaluated after the agent's and
 * the last match wins, so these hide the tools from the model and refuse any call that still names them.
 */
export function disableLocalTools(rules: ReadonlyArray<Rule> | undefined): Rule[] {
  const current = [...(rules ?? [])]
  if (localToolsDisabled(current)) return current
  return [...current, deny(LOCAL_TOOLS_MARKER), ...LOCAL_TOOL_ACTIONS.map(deny)]
}

/**
 * Removes the marker and the run of the toggle's deny rules right after it, each action at most once. Anything else,
 * including rules added after the block, is kept in order.
 */
export function enableLocalTools(rules: ReadonlyArray<Rule> | undefined): Rule[] {
  const current = [...(rules ?? [])]
  const removed = new Set<number>()
  current.forEach((rule, index) => {
    if (rule.action !== LOCAL_TOOLS_MARKER) return
    removed.add(index)
    const pending = new Set<string>(LOCAL_TOOL_ACTIONS)
    for (let next = index + 1; next < current.length; next++) {
      const candidate = current[next]!
      if (candidate.resource !== "*" || candidate.effect !== "deny" || !pending.has(candidate.action)) break
      pending.delete(candidate.action)
      removed.add(next)
    }
  })
  return current.filter((_, index) => !removed.has(index))
}

/** The session's next rules and whether local tools end up off. */
export function toggleLocalTools(rules: ReadonlyArray<Rule> | undefined) {
  const disabled = !localToolsDisabled(rules)
  return { disabled, permissions: disabled ? disableLocalTools(rules) : enableLocalTools(rules) }
}
