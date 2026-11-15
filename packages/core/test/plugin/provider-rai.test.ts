import { describe, expect, test } from "bun:test"
import { Config } from "@opencode/core/config"
import { Integration } from "@opencode/core/integration"
import { Model } from "@opencode/core/model"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { ProviderPlugins } from "@opencode/core/plugin/provider"
import {
  RaiPlugin,
  describe as describeFailure,
  gatewayBaseURL,
  keyShape,
  keyShapeMessage,
  parseBaseURL,
} from "@opencode/core/plugin/provider/rai"
import { Provider } from "@opencode/core/provider"
import { Rpc } from "@opencode/core/rpc"
import { AbsolutePath } from "@opencode/core/schema"
import { Document, Info } from "@opencode/schema/config"
import { Rai } from "@opencode/schema/rai"
import { Global } from "@opencode/util/global"
import { Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import path from "node:path"
import { testEffect } from "../lib/effect"
import { eventually } from "../lib/eventually"
import { PluginTestLayer } from "./fixture"

const it = testEffect(Layer.merge(PluginTestLayer, Config.testLayer()))
const decode = Schema.decodeUnknownSync(Info)

const providerID = Provider.ID.make("rai")
const integrationID = Integration.ID.make("rai")
const codex = Model.ID.make("codex/gpt-5.1-codex")
const xai = Model.ID.make("xai/grok-4")
const opencode = Model.ID.make("opencode/opencode-go/glm-5")
const groq = Model.ID.make("groq/openai/gpt-oss-120b")
const baseURL = "https://project.krfoss.org/api/rai/v1"

// `rai-` plus 43 base64url characters, which is the only shape the gateway issues.
const apiKey = "rai-" + "a".repeat(43)

// The gateway's `GET /models` answer: the reasoning steps arrive as `rai` metadata, not as catalog entries.
const inventory = {
  object: "list",
  data: [
    // `ultra` is listed here on purpose: the gateway now drops refused steps itself, so it must be offered as listed.
    { id: codex, rai: { provider: "codex", efforts: ["low", "medium", "high", "ultra"], default_effort: "medium" } },
    { id: xai, rai: { provider: "xai", efforts: ["low"] } },
    // Only the first `/` names the provider, so a model id with more of them stays as the gateway spelled it.
    { id: opencode, rai: { provider: "opencode", efforts: ["low"] } },
    { id: groq, rai: { provider: "groq" } },
  ],
}

// The gateway's `GET /credentials` answer: owner 0 is the account's own quota, the rest are shared subscriptions.
const subscriptions = {
  data: [
    { owner_id: 0, label: "내 구독", providers: ["codex", "xai"] },
    { owner_id: 3, label: "팀 공유", providers: ["codex"] },
  ],
}

const configuration = (settings: Record<string, unknown>, file?: string) =>
  new Document({
    type: "document",
    ...(file === undefined ? {} : { path: AbsolutePath.make(file) }),
    info: decode({ providers: { rai: { settings } } }),
  })

/** The path a settings document would have: the global config directory, or a folder a project was opened in. */
const scopePath = Effect.fn(function* (scope: "project" | "user" | undefined) {
  if (scope === "user") return path.join((yield* Global.Service).config, "opencode.json")
  if (scope === "project") return path.join(process.cwd(), "opencode.json")
  return undefined
})

/**
 * Answers by path: the plugin refreshes on startup, on a connection switch and after a settings change, and a shared
 * test layer can add one more, so a positional reply list would drift between tests. The plugin no longer calls
 * `POST /responses`, so any such request fails the test.
 */
const fixture = Effect.fn(function* (
  input: {
    readonly models?: () => Response
    readonly credentials?: () => Response
    readonly settings?: Record<string, unknown>
    readonly scope?: "project" | "user"
    readonly key?: string
  } = {},
) {
  const requests: Request[] = []
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie)
      requests.push(web)
      const target = new URL(web.url).pathname
      const response = target.endsWith("/models")
        ? (input.models?.() ?? Response.json(inventory))
        : target.endsWith("/credentials")
          ? (input.credentials?.() ?? Response.json({ data: [] }))
          : undefined
      if (!response) throw new Error(`Unexpected request: ${request.url}`)
      return HttpClientResponse.fromWeb(request, response)
    }),
  )
  const config = yield* Config.Test
  // Config lands before the plugin starts, so its first read sees the settings a user would have saved.
  if (input.settings)
    yield* config.setEntries([configuration(input.settings, yield* scopePath(input.scope))])
  const plugin = yield* Plugin.Service
  const host = yield* PluginHost.make(plugin, "test")
  yield* RaiPlugin.effect(host).pipe(Effect.provideService(HttpClient.HttpClient, http))
  const integrations = yield* Integration.Service
  const providers = yield* Provider.Service
  const models = yield* Model.Service
  const rpc = (yield* Rpc.Service).client(Rai.Definition)
  const connect = integrations.connection.key({
    integrationID,
    key: input.key ?? apiKey,
    label: "ROKFOSS AI",
  })
  const paths = () => requests.map((item) => new URL(item.url).pathname)
  return { requests, paths, integrations, providers, models, rpc, connect, key: input.key ?? apiKey }
})

/** Waits for the one request the plugin sends for a saved key, so a URL assertion reads a settled state. */
const firstRequest = (test: { requests: Request[] }, suffix: string) =>
  Effect.gen(function* () {
    yield* eventually(
      Effect.sync(() => test.requests.find((item) => new URL(item.url).pathname.endsWith(suffix))),
      (request) => request !== undefined,
    )
    return test.requests.find((item) => new URL(item.url).pathname.endsWith(suffix))
  })

describe("RaiPlugin", () => {
  it.effect("is registered as a built-in provider plugin with a key-only integration", () =>
    Effect.gen(function* () {
      const test = yield* fixture()
      expect(ProviderPlugins.map((item) => item.id)).toContain("opencode.provider.rai")
      expect(yield* test.integrations.get(integrationID)).toMatchObject({
        name: "ROKFOSS AI",
        methods: [{ type: "key", label: "ROKFOSS AI API 키" }],
      })
      // The reasoning-step probe and its re-check are gone; the dialog has nothing to verify any more.
      expect(Object.keys(Rai.Definition.methods).sort()).toEqual(["refresh", "select", "setFast", "state"])
      // Nothing is fetched until a key is saved.
      expect(test.requests).toHaveLength(0)
      expect(yield* test.providers.get(providerID)).toMatchObject({
        name: "ROKFOSS AI",
        package: "@opencode/ai/providers/rai",
        settings: { baseURL, provider: "rai" },
      })
      // Without a connection the provider stays out of the catalog, as every other integration provider does.
      expect(yield* test.providers.available()).not.toContainEqual(expect.objectContaining({ id: providerID }))
      // The dialog still answers, so a client can say what is missing instead of failing.
      expect(yield* test.rpc.state({})).toMatchObject({ connected: false, credentials: [] })
    }),
  )

  it.effect("registers its package so a compiled binary can load it", () =>
    Effect.gen(function* () {
      // The CLI ships as one bundled file, so a provider package resolves at runtime only through this
      // map. Without the entry a checkout works (node_modules) and a release fails with
      // "Cannot find package '@opencode/ai'", which is what happened to v2.3.0-krfoss.2.
      expect(Provider.builtinPackages.has("@opencode/ai/providers/rai")).toBe(true)
    }),
  )

  it.effect("turns the gateway inventory into models with every reasoning step it lists", () =>
    Effect.gen(function* () {
      const test = yield* fixture()
      yield* test.connect
      const resolved = yield* eventually(
        test.models.get(providerID, codex),
        (model) => model !== undefined,
      )
      // Efforts become variants exactly as listed: `ultra` is offered because the gateway advertised it (spec 3.1).
      expect(resolved?.variants.map((variant) => String(variant.id))).toEqual(["low", "medium", "high", "ultra"])
      expect(resolved?.variants[0]?.settings).toEqual({
        reasoningEffort: "low",
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
      })
      // The gateway's default effort is what a request uses until another step is chosen.
      expect(resolved?.settings).toMatchObject({ reasoningEffort: "medium", baseURL, provider: "rai" })
      expect(String(resolved?.family)).toBe("codex")
      expect(resolved?.name).toBe(String(codex))
      // A model with no efforts keeps no variants, which hides the step picker for it.
      const plain = yield* eventually(
        test.models.get(providerID, groq),
        (model) => model !== undefined,
      )
      expect(plain?.variants).toEqual([])
      // A model id with more than one `/` is used as the gateway spelled it.
      expect(String(plain?.id)).toBe(String(groq))

      const request = yield* firstRequest(test, "/models")
      expect(request?.url).toBe(`${baseURL}/models`)
      expect(request?.headers.get("authorization")).toBe(`Bearer ${test.key}`)
      expect(request?.headers.get("x-rai-credential")).toBeNull()
      // A request without this header is answered with an HTML 403, so discovery must carry it too.
      expect(request?.headers.get("user-agent")).toContain("ROKFOSS")
      // Nothing probes a reasoning step: the only requests are the two discovery reads (spec 9.2).
      expect(test.paths().every((item) => item.endsWith("/models") || item.endsWith("/credentials"))).toBe(true)
    }),
  )

  it.effect("sends the configured subscription on discovery and every request", () =>
    Effect.gen(function* () {
      const test = yield* fixture({ settings: { credential: "owner-1" } })
      yield* test.connect
      expect((yield* test.providers.get(providerID))?.headers).toEqual({ "X-RAI-Credential": "owner-1" })
      // The provider headers ride along on every model, which is how the header reaches each request.
      const resolved = yield* eventually(
        test.models.get(providerID, codex),
        (model) => model !== undefined,
      )
      expect(resolved?.headers).toEqual({ "X-RAI-Credential": "owner-1" })
      expect(test.requests[0]?.headers.get("x-rai-credential")).toBe("owner-1")
    }),
  )

  it.effect('drops the "0" subscription instead of sending it', () =>
    Effect.gen(function* () {
      const test = yield* fixture({ settings: { credential: "0" } })
      yield* test.connect
      expect((yield* test.providers.get(providerID))?.headers).toBeUndefined()
      yield* firstRequest(test, "/models")
      expect(test.requests[0]?.headers.get("x-rai-credential")).toBeNull()
    }),
  )

  it.effect("reports the gateway's own message when the saved key is rejected, without listing models", () =>
    Effect.gen(function* () {
      const test = yield* fixture({
        models: () => new Response(JSON.stringify({ message: "invalid api key" }), { status: 401 }),
      })
      yield* test.connect
      const connection = yield* eventually(
        test.integrations.get(integrationID),
        (integration) => integration?.connections[0]?.status !== undefined,
      )
      expect(connection?.connections[0]?.status).toEqual({ status: "needs_auth", message: "invalid api key" })
      expect(yield* test.models.get(providerID, codex)).toBeUndefined()
      expect((yield* test.providers.get(providerID))?.settings).toMatchObject({ baseURL, provider: "rai" })
      // The key itself never leaves the connection: no part of it appears in what the user is shown.
      expect(JSON.stringify(yield* test.integrations.get(integrationID))).not.toContain(apiKey)
    }),
  )

  it.effect("accepts a wrapped error body from the gateway", () =>
    Effect.gen(function* () {
      const test = yield* fixture({
        models: () => new Response(JSON.stringify({ error: { message: "quota exhausted" } }), { status: 403 }),
      })
      yield* test.connect
      const connection = yield* eventually(
        test.integrations.get(integrationID),
        (integration) => integration?.connections[0]?.status !== undefined,
      )
      expect(connection?.connections[0]?.status).toEqual({ status: "needs_auth", message: "quota exhausted" })
    }),
  )

  it.effect("turns the gateway's error code into the action it needs", () =>
    Effect.gen(function* () {
      const test = yield* fixture({
        models: () =>
          new Response(
            JSON.stringify({ error: { message: "API 키가 만료되었습니다", code: "expired_api_key" } }),
            { status: 401 },
          ),
      })
      yield* test.connect
      const connection = yield* eventually(
        test.integrations.get(integrationID),
        (integration) => integration?.connections[0]?.status !== undefined,
      )
      // The server's Korean message stays in front of the guidance the code implies (spec 4).
      expect(connection?.connections[0]?.status).toEqual({
        status: "needs_auth",
        message: "API 키가 만료되었습니다 — RAI 앱에서 새 키를 만들어 다시 연결하세요",
      })
    }),
  )

  it.effect("refuses a key that cannot be one of the gateway's before any request", () =>
    Effect.gen(function* () {
      const test = yield* fixture({ key: "rai-key" })
      yield* test.connect
      const connection = yield* eventually(
        test.integrations.get(integrationID),
        (integration) => integration?.connections[0]?.status !== undefined,
      )
      // Core stores a pasted key before a plugin sees it, so the earliest refusal is here: nothing is sent with it.
      expect(test.requests).toHaveLength(0)
      expect(connection?.connections[0]?.status).toEqual({ status: "needs_auth", message: keyShapeMessage })
      expect(yield* test.models.get(providerID, codex)).toBeUndefined()
      expect((yield* test.rpc.state({})).error).toBe(keyShapeMessage)
      // The malformed key is not echoed back to the user either.
      expect(JSON.stringify(yield* test.rpc.state({}))).not.toContain("rai-key")
    }),
  )

  it.effect("offers the subscriptions the key may spend from", () =>
    Effect.gen(function* () {
      const test = yield* fixture({ credentials: () => Response.json(subscriptions) })
      yield* test.connect
      const state = yield* eventually(
        test.rpc.state({}),
        (value: Rai.Settings) => value.credentials.length === 2,
      )
      expect(state).toMatchObject({
        connected: true,
        ownerID: null,
        fast: false,
        credentials: [
          { ownerID: 0, label: "내 구독", providers: ["codex", "xai"] },
          { ownerID: 3, label: "팀 공유", providers: ["codex"] },
        ],
        error: null,
      })
    }),
  )

  it.effect("picks a subscription without editing the config file", () =>
    Effect.gen(function* () {
      const test = yield* fixture({ credentials: () => Response.json(subscriptions) })
      yield* test.connect
      yield* eventually(
        test.rpc.state({}),
        (value: Rai.Settings) => value.credentials.length === 2,
      )
      const picked = yield* test.rpc.select({ ownerID: 3 })
      expect(picked.ownerID).toBe(3)
      expect((yield* test.providers.get(providerID))?.headers).toEqual({ "X-RAI-Credential": "3" })
      // The next discovery already spends from the picked subscription.
      expect(test.requests.at(-1)?.headers.get("x-rai-credential")).toBe("3")

      // Returning to the account's own quota drops the header entirely instead of sending an empty one.
      yield* test.rpc.select({ ownerID: null })
      expect((yield* test.providers.get(providerID))?.headers).toBeUndefined()
    }),
  )

  it.effect("turns high-speed output on for the providers whose upstream accepts it", () =>
    Effect.gen(function* () {
      const test = yield* fixture()
      yield* test.connect
      yield* eventually(
        test.models.get(providerID, codex),
        (model) => model !== undefined,
      )
      // A fast switch republishes the models; the gateway is only read again for the inventory.
      const state = yield* test.rpc.setFast({ enabled: true })
      expect(state.fast).toBe(true)
      const resolved = yield* eventually(
        test.models.get(providerID, codex),
        (model) => model !== undefined && model.settings?.serviceTier === "priority",
      )
      expect(resolved?.settings).toMatchObject({ serviceTier: "priority", baseURL, provider: "rai" })
      // xai accepts the tier as well, even for a model without reasoning steps.
      expect((yield* test.models.get(providerID, xai))?.settings).toMatchObject({ serviceTier: "priority" })
      // opencode and groq never get it: the gateway does not pass the tier to those upstreams (spec 3.4).
      expect((yield* test.models.get(providerID, opencode))?.settings?.serviceTier).toBeUndefined()
      expect((yield* test.models.get(providerID, groq))?.settings?.serviceTier).toBeUndefined()
      expect((yield* test.rpc.setFast({ enabled: false })).fast).toBe(false)
      expect((yield* test.models.get(providerID, codex))?.settings?.serviceTier).toBeUndefined()
    }),
  )

  it.effect("ignores a base URL a project config sets", () =>
    Effect.gen(function* () {
      // Opening a repository must not move the saved key: its `opencode.json` merges into the same settings (spec 9.1).
      const test = yield* fixture({
        settings: { baseURL: "https://collect.example/rai/v1" },
        scope: "project",
      })
      yield* test.connect
      const request = yield* firstRequest(test, "/models")
      expect(request?.url).toBe(`${baseURL}/models`)
      expect((yield* test.providers.get(providerID))?.settings).toMatchObject({ baseURL })
      // The key is never sent to the host the project named.
      expect(test.requests.some((item) => item.url.includes("collect.example"))).toBe(false)
    }),
  )

  it.effect("accepts the gateway host from a project config", () =>
    Effect.gen(function* () {
      const test = yield* fixture({
        settings: { baseURL: "https://project.krfoss.org/api/rai/v2/" },
        scope: "project",
      })
      yield* test.connect
      const request = yield* firstRequest(test, "/models")
      // The gateway host is the one place a project may point at, and the trailing slash is dropped.
      expect(request?.url).toBe("https://project.krfoss.org/api/rai/v2/models")
    }),
  )

  it.effect("refuses a plain-http base URL from any layer", () =>
    Effect.gen(function* () {
      const test = yield* fixture({
        settings: { baseURL: "http://project.krfoss.org/api/rai/v1" },
        scope: "user",
      })
      yield* test.connect
      const request = yield* firstRequest(test, "/models")
      // The key must never travel in clear text, so `http:` falls back to the default endpoint (spec 9.1).
      expect(request?.url).toBe(`${baseURL}/models`)
    }),
  )

  it.effect("honors another host from the user's global config", () =>
    Effect.gen(function* () {
      const test = yield* fixture({
        settings: { baseURL: "https://gateway.example/rai/v1/" },
        scope: "user",
      })
      yield* test.connect
      const request = yield* firstRequest(test, "/models")
      expect(request?.url).toBe("https://gateway.example/rai/v1/models")
      expect((yield* test.providers.get(providerID))?.settings).toMatchObject({
        baseURL: "https://gateway.example/rai/v1",
      })
    }),
  )

  it.effect("honors RAI_BASE_URL from the environment", () =>
    Effect.gen(function* () {
      const previous = process.env.RAI_BASE_URL
      process.env.RAI_BASE_URL = "https://env.example/rai/v1"
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (previous === undefined) delete process.env.RAI_BASE_URL
          else process.env.RAI_BASE_URL = previous
        }),
      )
      const test = yield* fixture({ settings: { baseURL: "https://global.example/rai/v1" }, scope: "user" })
      yield* test.connect
      const request = yield* firstRequest(test, "/models")
      // The user's own environment wins over their config file.
      expect(request?.url).toBe("https://env.example/rai/v1/models")
    }),
  )
})

describe("base URL resolution", () => {
  test("accepts only https and drops trailing slashes", () => {
    expect(parseBaseURL("https://project.krfoss.org/api/rai/v1/")).toEqual({
      url: "https://project.krfoss.org/api/rai/v1",
    })
    // `http:` would put the key on the wire in clear text (spec 9.1).
    expect(parseBaseURL("http://project.krfoss.org/api/rai/v1")).toEqual({ reason: "http" })
    // The AI package accepts the gateway on its default port only.
    expect(parseBaseURL("https://project.krfoss.org:8443/api/rai/v1")).toEqual({ reason: "port" })
    // A query or fragment is not part of the API root, so it is dropped instead of reaching a request path.
    expect(parseBaseURL("https://gateway.example/rai/v1?x=1")).toEqual({ url: "https://gateway.example/rai/v1" })
    expect(parseBaseURL("not a url")).toEqual({ reason: "invalid" })
    expect(parseBaseURL("  ")).toEqual({})
    expect(parseBaseURL(undefined)).toEqual({})
  })

  test("lets a project config name the gateway host only", () => {
    expect(gatewayBaseURL("https://project.krfoss.org/api/rai/v1")).toEqual({
      url: "https://project.krfoss.org/api/rai/v1",
    })
    // A trailing root dot and upper case are the same host; any other name is not.
    expect(gatewayBaseURL("https://PROJECT.KRFOSS.ORG./api/rai/v1").url).toBe(
      "https://project.krfoss.org./api/rai/v1",
    )
    expect(gatewayBaseURL("https://collect.example/rai/v1")).toEqual({ reason: "host" })
    // A host that merely ends with the gateway name is a different host.
    expect(gatewayBaseURL("https://project.krfoss.org.collect.example/rai/v1")).toEqual({ reason: "host" })
  })

  test("accepts the key shape the gateway issues", () => {
    expect(keyShape(apiKey)).toBe(true)
    // Every base64url character is allowed, and the length is exact.
    expect(keyShape("rai-" + "aZ0-_".repeat(8) + "abc")).toBe(true)
    expect(keyShape("rai-key")).toBe(false)
    expect(keyShape("rai-" + "a".repeat(42))).toBe(false)
    expect(keyShape("rai-" + "a".repeat(44))).toBe(false)
    expect(keyShape("rai-" + "a".repeat(42) + "!")).toBe(false)
    expect(keyShape("sk-" + "a".repeat(43))).toBe(false)
  })
})

describe("gateway guidance", () => {
  test("adds the action each code implies behind the server's message", () => {
    expect(describeFailure("expired_api_key", "만료")).toBe("만료 — RAI 앱에서 새 키를 만들어 다시 연결하세요")
    expect(describeFailure("credential_not_allowed", "권한 없음")).toBe("권한 없음 — 구독을 다시 고르세요")
    expect(describeFailure("credential_unavailable", "공급자 없음")).toBe("공급자 없음 — 구독을 다시 고르세요")
    expect(describeFailure("share_not_allowed", "공유 불가")).toBe("공유 불가 — 구독을 다시 고르세요")
    expect(describeFailure("share_limited", "한도 소진")).toBe(
      "한도 소진 — 공유 한도가 끝났습니다. 내 구독으로 바꾸거나 잠시 뒤 다시 시도하세요",
    )
    expect(describeFailure("scope_missing", "권한 없음")).toBe(
      "권한 없음 — AI 앱 설정에서 이 키의 권한을 켜 주세요",
    )
    // `ai_locked` already carries the server's own guidance, so nothing is appended.
    expect(describeFailure("ai_locked", "AI가 잠겨 있습니다")).toBe("AI가 잠겨 있습니다")
    // An unknown or missing code leaves the gateway's message alone.
    expect(describeFailure("model_tools_unsupported", "도구를 지원하지 않습니다")).toBe(
      "도구를 지원하지 않습니다",
    )
    expect(describeFailure(undefined, "평문")).toBe("평문")
  })
})
