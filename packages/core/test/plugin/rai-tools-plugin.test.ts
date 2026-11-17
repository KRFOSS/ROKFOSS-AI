import { describe, expect } from "bun:test"
import { Agent } from "@opencode/core/agent"
import { Config } from "@opencode/core/config"
import { Integration } from "@opencode/core/integration"
import { Permission } from "@opencode/core/permission"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { PluginHost } from "@opencode/core/plugin/host"
import { RaiPlugin } from "@opencode/core/plugin/provider/rai"
import { registerRaiTools, unboundMessage } from "@opencode/core/plugin/provider/rai-tools"
import { Tool } from "@opencode/core/tool"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Effect, Exit, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { testEffect } from "../lib/effect"
import { eventually } from "../lib/eventually"
import { makePluginTestLayer } from "./fixture"

const asked: Permission.AssertInput[] = []
const permission = Layer.succeed(
  Permission.Service,
  Permission.Service.of({
    close: Effect.void,
    ask: (input) => Effect.succeed({ id: input.id ?? Permission.ID.create(), effect: "ask" }),
    assert: (input) => Effect.sync(() => void asked.push(input)),
    assertNotDenied: () => Effect.void,
    allows: () => Effect.succeed(false),
    reply: () => Effect.void,
    get: () => Effect.succeed(undefined),
    forSession: () => Effect.succeed([]),
    list: () => Effect.succeed([]),
  }),
)
const it = testEffect(Layer.merge(makePluginTestLayer(permission), Config.testLayer()))

const apiKey = "rai-" + "a".repeat(43)
const bound = Session.ID.make("ses_bound")
const loose = Session.ID.make("ses_loose")

const purge = {
  name: "fastly_purge",
  description: "캐시 비우기",
  parameters: { type: "object", properties: { zone: { type: "string" } }, required: ["zone"] },
  group: "fastly",
  approval: "ask",
}

const fixture = Effect.fn(function* () {
  const calls: Array<{ path: string; body: string }> = []
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie)
      const body = request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : ""
      const path = new URL(web.url).pathname
      calls.push({ path, body })
      return HttpClientResponse.fromWeb(request, answer(path, body))
    }),
  )
  const plugin = yield* Plugin.Service
  const host = yield* PluginHost.make(plugin, "test")
  // The RAI provider plugin registers the integration the key is saved under.
  yield* RaiPlugin.effect(host).pipe(Effect.provideService(HttpClient.HttpClient, http))
  yield* registerRaiTools(host, http, (sessionID) => Effect.succeed(sessionID === bound ? "42" : undefined))
  const integrations = yield* Integration.Service
  yield* integrations.connection.key({ integrationID: Integration.ID.make("rai"), key: apiKey, label: "ROKFOSS AI" })
  const tools = yield* Tool.Service
  const hooks = yield* PluginHooks.Service
  return { calls, tools, hooks }
})

function answer(path: string, body: string) {
  if (path.endsWith("/models")) return Response.json({ object: "list", data: [] })
  if (path.endsWith("/credentials")) return Response.json({ data: [] })
  if (path.endsWith("/tools")) return Response.json({ object: "list", data: [purge] })
  if (path.endsWith("/rooms/42/tools/call")) {
    if (!JSON.parse(body).approval_token)
      return Response.json({
        object: "rai.tool_approval",
        approval_token: "tok",
        tool: "fastly_purge",
        title: "캐시 비우기",
        purpose: "example.com 캐시를 모두 비웁니다",
        expires_in: 600,
      })
    const result = { object: "rai.tool_result", content: [{ type: "text", text: "비웠습니다" }], is_error: false }
    return new Response(`: ping\n\ndata: ${JSON.stringify(result)}\n\n`, {
      headers: { "content-type": "text/event-stream" },
    })
  }
  return new Response("", { status: 404 })
}

const context = (sessionID: Session.ID): Tool.Context => ({
  sessionID,
  agent: Agent.ID.make("build"),
  messageID: SessionMessage.ID.make("msg_1"),
  id: Tool.CallID.make("call_1"),
  progress: () => Effect.void,
})

const contextEvent = (sessionID: Session.ID, tools: PluginHooks.Domains["session"]["context"]["tools"]) => ({
  sessionID,
  agent: Agent.ID.make("build"),
  model: Model.Ref.make({ providerID: Provider.ID.make("rai"), id: Model.ID.make("m") }),
  system: [],
  messages: [],
  options: {},
  tools,
})

describe("RAI room tools plugin", () => {
  it.effect("registers the list, hides it from unbound sessions, and asks before an approved call", () =>
    Effect.gen(function* () {
      asked.length = 0
      const test = yield* fixture()
      const listed = yield* eventually(test.tools.list(), (items) => items.some((item) => item.id === "rai_fastly_purge"))
      const tool = listed.find((item) => item.id === "rai_fastly_purge")!
      expect(tool.description).toBe("[RAI 대화방] 캐시 비우기")
      expect(tool.options?.codemode).toBe(false)

      const definitions = { rai_fastly_purge: { description: tool.description, input: {} }, read: { description: "r", input: {} } }
      const hidden = yield* test.hooks.trigger("session", "context", contextEvent(loose, { ...definitions }))
      expect(Object.keys(hidden.tools)).toEqual(["read"])
      const shown = yield* test.hooks.trigger("session", "context", contextEvent(bound, { ...definitions }))
      expect(Object.keys(shown.tools).sort()).toEqual(["rai_fastly_purge", "read"])
      // Only integrated-system tools here: no box tool to point at, so no note about the box.
      expect(shown.system).toEqual([])
      expect(hidden.system).toEqual([])

      const refused = yield* Effect.exit(tool.execute({ zone: "example.com" }, context(loose)))
      expect(Exit.isFailure(refused)).toBe(true)
      if (Exit.isFailure(refused)) expect(JSON.stringify(refused.cause)).toContain(unboundMessage)

      const result = yield* tool.execute({ zone: "example.com" }, context(bound))
      expect(result.content).toEqual([{ type: "text", text: "비웠습니다" }])
      expect(asked).toHaveLength(1)
      expect(asked[0]).toMatchObject({
        sessionID: bound,
        action: "rai_tool",
        resources: ["rai_fastly_purge"],
        metadata: { tool: "rai_fastly_purge", title: "캐시 비우기", purpose: "example.com 캐시를 모두 비웁니다", roomID: "42" },
        source: { type: "tool", messageID: "msg_1", id: "call_1" },
      })
      const sent = test.calls.filter((call) => call.path.endsWith("/tools/call")).map((call) => JSON.parse(call.body))
      expect(sent).toEqual([
        { name: "fastly_purge", arguments: { zone: "example.com" } },
        { name: "fastly_purge", arguments: { zone: "example.com" }, approval_token: "tok" },
      ])
    }),
  )
})
