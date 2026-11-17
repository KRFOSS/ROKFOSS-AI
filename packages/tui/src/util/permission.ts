import { Locale } from "./locale"
import { canonicalToolName, finiteNumber, webSearchProviderLabel } from "./tool-display"
import { t } from "../i18n"

type Dict = Record<string, unknown>

export type PermissionPresentation = {
  icon: string
  title: string
  lines: string[]
  diff?: string
  patch?: string
  file?: string
}

export type PermissionPresentationInput = {
  action: string
  resources: ReadonlyArray<unknown>
  metadata?: unknown
  input?: unknown
  toolMetadata?: unknown
}

export function permissionPresentation(
  source: PermissionPresentationInput,
  formatPath: (value: string) => string = (value) => value,
): PermissionPresentation {
  const action = canonicalToolName(source.action)
  const input = normalizeInput(action, source.input)
  const metadata = { ...dict(source.toolMetadata), ...dict(source.metadata) }
  const resources = source.resources.filter((item): item is string => typeof item === "string")

  if (action === "edit") {
    const file = text(input.path) || resources[0] || ""
    const first = dict(Array.isArray(metadata.files) ? metadata.files[0] : undefined)
    const diff = text(first.patch) || text(first.diff) || text(metadata.diff) || undefined
    return {
      icon: "→",
      title: t("Edit {{path}}", { path: formatPath(file) }),
      lines: [],
      diff,
      patch: diff ? undefined : text(input.patchText) || undefined,
      file,
    }
  }

  if (action === "read" || action === "list") {
    const value = text(input.path) || resources[0] || ""
    const title = action === "read" ? "Read" : "List"
    return {
      icon: "→",
      title: `${title} ${formatPath(value)}`,
      lines: value ? [t("Path: {{path}}", { path: formatPath(value) })] : [],
    }
  }

  if (action === "glob" || action === "grep") {
    const pattern = text(input.pattern) || resources[0] || ""
    const title = action === "glob" ? "Glob" : "Grep"
    return {
      icon: "✱",
      title: `${title} "${pattern}"`,
      lines: pattern ? [t("Pattern: {{pattern}}", { pattern })] : [],
    }
  }

  if (action === "shell") {
    const command = text(input.command)
    return {
      icon: "#",
      title: t("Shell command"),
      lines: command ? [`$ ${command}`] : resources.map((item) => `- ${item}`),
    }
  }

  if (action === "subagent") {
    const agent = text(input.agent) || "general"
    const description = text(input.description)
    return {
      icon: "#",
      title: t("{{agent}} Subagent", { agent: Locale.titlecase(agent) }),
      lines: description ? [`◉ ${description}`] : [],
    }
  }

  if (action === "webfetch") {
    const url = text(input.url) || text(metadata.url)
    return {
      icon: "%",
      title: `WebFetch ${url}`,
      lines: url ? [`URL: ${url}`] : [],
    }
  }

  if (action === "websearch") {
    const query = text(input.query) || text(metadata.query)
    const title = webSearchProviderLabel(metadata.provider)
    return {
      icon: "◈",
      title: query ? `${title} "${query}"` : title,
      lines: query ? [t("Query: {{query}}", { query })] : [],
    }
  }

  if (action === "lsp") {
    const file = text(input.path)
    const operation = text(input.operation) || "request"
    const line = finiteNumber(input.line)
    const character = finiteNumber(input.character)
    const position = line !== undefined && character !== undefined ? `${line}:${character}` : undefined
    return {
      icon: "→",
      title: `LSP ${operation}${file ? ` ${formatPath(file)}${position ? `:${position}` : ""}` : ""}`,
      lines: [
        ...(input.operation ? [t("Operation: {{operation}}", { operation })] : []),
        ...(file ? [t("Path: {{path}}", { path: formatPath(file) })] : []),
        ...(position ? [t("Position: {{position}}", { position })] : []),
      ],
    }
  }

  if (action === "external_directory") {
    const raw = text(metadata.parentDir) || text(metadata.filepath) || resources[0] || ""
    const directory = wildcardDirectory(raw)
    return {
      icon: "←",
      title: t("Access external directory {{path}}", { path: formatPath(directory) }),
      lines: resources.map((item) => `- ${item}`),
    }
  }

  if (action === "rai_tool") return raiToolPresentation(resources, metadata)

  if (action === "doom_loop") {
    return {
      icon: "⟳",
      title: t("Continue after repeated failures"),
      lines: [t("This keeps the session running despite repeated failures.")],
    }
  }

  return {
    icon: "⚙",
    title: t("Call tool {{tool}}", { tool: source.action }),
    lines: [t("Tool: {{tool}}", { tool: source.action })],
  }
}

/**
 * A RAI room tool call the server wants approved (rai-tools.ts): the server's one-line title, what the server checked
 * (details), a preview of what will be sent, and — labelled apart — the purpose the model wrote, so text the model
 * wrote cannot pass for something the server confirmed.
 */
export function raiToolPresentation(resources: ReadonlyArray<string>, metadata: Dict): PermissionPresentation {
  const tool = text(metadata.tool) || resources[0] || "rai_tool"
  const title = text(metadata.title).trim()
  const purpose = text(metadata.purpose).trim()
  const details = Array.isArray(metadata.details)
    ? metadata.details.flatMap((line) => (typeof line === "string" && line.trim() !== "" ? [line.trim()] : []))
    : []
  const preview = text(metadata.preview).trim()
  return {
    icon: "⚙",
    title: title ? t("RAI room: {{title}}", { title }) : t("Call tool {{tool}}", { tool }),
    lines: [
      t("Tool: {{tool}}", { tool }),
      ...details.slice(0, 20),
      ...(preview ? [t("Preview:"), ...preview.split(/\r?\n/).slice(0, 30)] : []),
      ...(purpose ? [t("Purpose given by the model:"), ...purpose.split(/\r?\n/).slice(0, 10)] : []),
    ],
  }
}

function wildcardDirectory(value: string) {
  const wildcard = value.indexOf("*")
  if (wildcard === -1) return value
  const prefix = value.slice(0, wildcard)
  if (/^[\\/]+$/.test(prefix) || /^[A-Za-z]:[\\/]$/.test(prefix)) return prefix
  return prefix.replace(/[\\/]+$/, "")
}

export function permissionAlwaysLines(input: { action: string; save?: ReadonlyArray<string> }): string[] {
  const save = input.save ?? []
  if (save.length === 1 && save[0] === "*") {
    return [t("This will always allow {{action}} for this project.", { action: input.action })]
  }
  return [
    t("This will always allow the following patterns for this project."),
    ...save.map((item) => `- ${item}`),
  ]
}

export function permissionOptionLabel(option: "once" | "always" | "reject" | "confirm" | "cancel") {
  if (option === "once") return t("Allow once")
  if (option === "always") return t("Always allow")
  if (option === "reject") return t("Reject")
  if (option === "confirm") return t("Confirm")
  return t("Cancel")
}

function normalizeInput(action: string, value: unknown): Dict {
  const input = dict(value)
  const path = text(input.path) || text(input.filePath) || text(input.filepath)
  const agent = text(input.agent) || text(input.subagent_type)
  return {
    ...input,
    ...(["read", "edit", "list", "lsp"].includes(action) && path ? { path } : {}),
    ...(action === "subagent" && agent ? { agent } : {}),
  }
}

function dict(value: unknown): Dict {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as Dict
}

function text(value: unknown) {
  return typeof value === "string" ? value : ""
}
