import { expect, test } from "bun:test"
import { permissionPresentation } from "../../src/util/permission"

test("preserves permission roots and self-contained metadata", () => {
  expect(permissionPresentation({ action: "external_directory", resources: ["/*"] }).title).toBe(
    "Access external directory /",
  )
  expect(permissionPresentation({ action: "external_directory", resources: ["C:/*"] }).title).toBe(
    "Access external directory C:/",
  )
  expect(
    permissionPresentation({ action: "webfetch", resources: [], metadata: { url: "https://example.com" } }),
  ).toMatchObject({
    title: "WebFetch https://example.com",
    lines: ["URL: https://example.com"],
  })
  expect(permissionPresentation({ action: "websearch", resources: [], metadata: { query: "releases" } })).toMatchObject(
    {
      title: 'Web Search "releases"',
      lines: ["Query: releases"],
    },
  )
})

test("shows the RAI room tool approval title and purpose", () => {
  const shown = permissionPresentation({
    action: "rai_tool",
    resources: ["rai_fastly_purge"],
    metadata: { tool: "rai_fastly_purge", title: "Purge the cache", purpose: "Purges every object\nfor example.com" },
  })
  expect(shown.title).toBe("RAI room: Purge the cache")
  expect(shown.lines).toEqual(["Tool: rai_fastly_purge", "Purpose given by the model:", "Purges every object", "for example.com"])
  const checked = permissionPresentation({
    action: "rai_tool",
    resources: ["rai_github_commit"],
    metadata: { tool: "rai_github_commit", title: "Commit", details: ["repo: a/b", 3, ""], preview: "+ line", purpose: "fix" },
  })
  expect(checked.lines).toEqual([
    "Tool: rai_github_commit",
    "repo: a/b",
    "Preview:",
    "+ line",
    "Purpose given by the model:",
    "fix",
  ])
  expect(permissionPresentation({ action: "rai_tool", resources: ["rai_x"] }).title).toBe("Call tool rai_x")
})
