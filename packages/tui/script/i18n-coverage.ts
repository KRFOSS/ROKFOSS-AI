/**
 * Reports how much of the TUI's interface copy a language dictionary actually covers.
 *
 * Run it after merging an upstream release:
 *
 *   bun packages/tui/script/i18n-coverage.ts
 *   bun packages/tui/script/i18n-coverage.ts --language ko --details
 *
 * Two things are reported, and they need different reactions:
 *
 *   - "missing keys" are strings already wrapped in `t("...")` that the dictionary does not know.
 *     These show in English at runtime, so they are the backlog to translate first.
 *   - "unwrapped candidates" are English literals in shared dialog/select/toast renderers and in
 *     component props. They are informational: many are data (model names, paths) or reach the
 *     screen through a renderer that already translates, so treat the list as a worklist, not a bug
 *     list.
 *
 * The scanning is heuristic on purpose -- it has no parser dependency, so it keeps working across
 * upstream refactors, and a false negative only means a string we would have shown in English.
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const sourceRoot = join(import.meta.dir, "..", "src")

const args = process.argv.slice(2)
const language = args.find((value) => value.startsWith("--language="))?.slice("--language=".length) ?? "ko"
const details = args.includes("--details")
const strict = args.includes("--strict")

const dictionary: Readonly<Record<string, string>> = (await import(`../src/i18n/${language}.ts`)).dict

function files(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) return files(path)
    return path.endsWith(".ts") || path.endsWith(".tsx") ? [path] : []
  })
}

const sourceFiles = files(sourceRoot).filter((path) => !path.includes(`${join("src", "i18n")}`))

/** `t("...")` call sites: every one of them should resolve through the dictionary. */
const wrapped = /(?:^|[^\w$.])t\(\s*"((?:[^"\\]|\\.){1,200})"/g

/** English literals handed to a shared renderer, used as a rough backlog for coverage work. */
const candidates = /(?:(?:title|label|placeholder|description|category|group|message)\??:\s*|(?:title|label|placeholder|description|category|message)=)"((?:[^"\\]|\\.){2,120})"/g

const missing = new Map<string, Set<string>>()
const unwrapped = new Map<string, Set<string>>()

for (const file of sourceFiles) {
  const source = readFileSync(file, "utf8")
  const name = relative(sourceRoot, file)

  for (const match of source.matchAll(wrapped)) {
    const value = match[1]
    if (!/[A-Za-z]/.test(value)) continue
    if (Object.hasOwn(dictionary, value)) continue
    if (!missing.has(value)) missing.set(value, new Set())
    missing.get(value)!.add(name)
  }

  for (const match of source.matchAll(candidates)) {
    const value = match[1]
    if (Object.hasOwn(dictionary, value)) continue
    if (!/^[A-Za-z]/.test(value)) continue
    if (!unwrapped.has(value)) unwrapped.set(value, new Set())
    unwrapped.get(value)!.add(name)
  }
}

function report(title: string, entries: Map<string, Set<string>>, hint: string) {
  console.log(`\n${title}: ${entries.size}`)
  if (entries.size === 0) return
  console.log(hint)
  const limit = details ? entries.size : 25
  const sorted = [...entries.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  for (const [value, places] of sorted.slice(0, limit)) {
    const where = details ? `  (${[...places].slice(0, 2).join(", ")})` : ""
    console.log(`  - ${JSON.stringify(value)}${where}`)
  }
  if (sorted.length > limit) console.log(`  ... ${sorted.length - limit} more (use --details)`)
}

console.log(`i18n coverage for "${language}": ${Object.keys(dictionary).length} entries, ${sourceFiles.length} files scanned`)
report(
  "missing keys",
  missing,
  "Strings already using t() with no dictionary entry; they render in English. Add them to src/i18n/<language>.ts.",
)
report(
  "unwrapped candidates",
  unwrapped,
  "English literals reaching the shared dialog/select/toast renderers or plain props. Informational: UI copy worth wrapping, data values not.",
)

const missingTotal = missing.size
if (strict && missingTotal > 0) {
  console.error(`\n${missingTotal} wrapped string(s) have no "${language}" translation.`)
  process.exit(1)
}
