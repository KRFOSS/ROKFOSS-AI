import { describe, expect } from "bun:test"
import { Config } from "@opencode/core/config"
import { Integration } from "@opencode/core/integration"
import { Model } from "@opencode/core/model"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { ProviderPlugins } from "@opencode/core/plugin/provider"
import { RaiPlugin } from "@opencode/core/plugin/provider/rai"
import { Provider } from "@opencode/core/provider"
import { Rpc } from "@opencode/core/rpc"
import { Document, Info } from "@opencode/schema/config"
import { Rai } from "@opencode/schema/rai"
import { Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { testEffect } from "../lib/effect"
import { eventually } from "../lib/eventually"
import { PluginTestLayer } from "./fixture"

const it = testEffect(Layer.merge(PluginTestLayer, Config.testLayer()))
const decode = Schema.decodeUnknownSync(Info)

const providerID = Provider.ID.make("rai")
const integrationID = Integration.ID.make("rai")
const modelID = Model.ID.make("codex/gpt-5.1-codex")
const plainID = Model.ID.make("codex/gpt-5.1-codex-mini")
const baseURL = "https://project.krfoss.org/api/rai/v1"

// The gateway's `GET /models` answer: the reasoning steps arrive as `rai` metadata, not as catalog entries.
const inventory = {
  object: "list",
  data: [
    {
      id: modelID,
      rai: { provider: "codex", efforts: ["low", "medium", "high"], default_effort: "medium" },
    },
    { id: plainID },
  ],
}

/** The same model, with the step the gateway advertises but its upstream refuses. */
const ultraInventory = {
  object: "list",
  data: [{ id: modelID, rai: { provider: "codex", efforts: ["low", "ultra"], default_effort: "low" } }],
}

// The gateway's `GET /credentials` answer: owner 0 is the account's own quota, the rest are shared subscriptions.
const subscriptions = {
  data: [
    { owner_id: 0, label: "내 구독", providers: ["codex", "xai"] },
    { owner_id: 3, label: "팀 공유", providers: ["codex"] },
  ],
}

const configuration = (settings: Record<string, unknown>) =>
  new Document({ type: "document", info: decode({ providers: { rai: { settings } } }) })

/**
 * Answers by path instead of by order: the plugin refreshes on startup, on a connection switch and after a settings
 * change, and a shared test layer can add one more, so a positional reply list would drift between tests.
 */
const fixture = Effect.fn(function* (
  input: {
    readonly models?: () => Response
    readonly credentials?: () => Response
    readonly probe?: () => Response
    readonly settings?: Record<string, unknown>
  } = {},
) {
  const requests: Request[] = []
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie)
      requests.push(web)
      const path = new URL(web.url).pathname
      const response = path.endsWith("/models")
        ? (input.models?.() ?? Response.json(inventory))
        : path.endsWith("/credentials")
          ? (input.credentials?.() ?? Response.json({ data: [] }))
          : path.endsWith("/responses")
            ? (input.probe?.() ?? Response.json({ id: "resp_1" }))
            : undefined
      if (!response) throw new Error(`Unexpected request: ${request.url}`)
      return HttpClientResponse.fromWeb(request, response)
    }),
  )
  const config = yield* Config.Test
  // Config lands before the plugin starts, so its first read sees the settings a user would have saved.
  if (input.settings) yield* config.setEntries([configuration(input.settings)])
  const plugin = yield* Plugin.Service
  const host = yield* PluginHost.make(plugin, "test")
  yield* RaiPlugin.effect(host).pipe(Effect.provideService(HttpClient.HttpClient, http))
  const integrations = yield* Integration.Service
  const providers = yield* Provider.Service
  const models = yield* Model.Service
  const rpc = (yield* Rpc.Service).client(Rai.Definition)
  const connect = integrations.connection.key({ integrationID, key: "rai-key", label: "ROKFOSS AI" })
  const probes = () => requests.filter((item) => new URL(item.url).pathname.endsWith("/responses"))
  return { requests, integrations, providers, models, rpc, connect, probes }
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

  it.effect("turns the gateway inventory into models with the marketed reasoning steps", () =>
    Effect.gen(function* () {
      const test = yield* fixture()
      yield* test.connect
      const resolved = yield* eventually(
        test.models.get(providerID, modelID),
        (model) => model !== undefined,
      )
      // Efforts become variants, so the step picker offers only what the gateway supports for this model.
      expect(resolved?.variants.map((variant) => String(variant.id))).toEqual(["low", "medium", "high"])
      expect(resolved?.variants[0]?.settings).toEqual({
        reasoningEffort: "low",
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
      })
      // The gateway's default effort is what a request uses until another step is chosen.
      expect(resolved?.settings).toMatchObject({ reasoningEffort: "medium", baseURL, provider: "rai" })
      expect(String(resolved?.family)).toBe("codex")
      expect(resolved?.name).toBe(String(modelID))
      // A model without efforts keeps no variants, which hides the step picker for it.
      const plain = yield* eventually(
        test.models.get(providerID, plainID),
        (model) => model !== undefined,
      )
      expect(plain?.variants).toEqual([])
      expect(plain?.settings).toEqual({ baseURL, provider: "rai" })

      const request = test.requests.find((item) => new URL(item.url).pathname.endsWith("/models"))
      expect(request?.url).toBe(`${baseURL}/models`)
      expect(request?.headers.get("authorization")).toBe("Bearer rai-key")
      expect(request?.headers.get("x-rai-credential")).toBeNull()
      // A request without this header is answered with an HTML 403, so discovery must carry it too.
      expect(request?.headers.get("user-agent")).toContain("ROKFOSS")
    }),
  )

  it.effect("sends the configured subscription on discovery and every request", () =>
    Effect.gen(function* () {
      const test = yield* fixture({ settings: { credential: "owner-1" } })
      yield* test.connect
      expect((yield* test.providers.get(providerID))?.headers).toEqual({ "X-RAI-Credential": "owner-1" })
      // The provider headers ride along on every model, which is how the header reaches each request.
      const resolved = yield* eventually(
        test.models.get(providerID, modelID),
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
      yield* eventually(
        test.models.get(providerID, modelID),
        (model) => model !== undefined,
      )
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
      expect(yield* test.models.get(providerID, modelID)).toBeUndefined()
      expect((yield* test.providers.get(providerID))?.settings).toMatchObject({ baseURL, provider: "rai" })
      // The key itself never leaves the connection: no part of it appears in what the user is shown.
      expect(JSON.stringify(yield* test.integrations.get(integrationID))).not.toContain("rai-key")
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
      // Nothing advertises a probed step here, so there is nothing to report about them.
      expect(state.efforts).toEqual([])
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

  it.effect("turns high-speed output on for every model of the provider", () =>
    Effect.gen(function* () {
      const test = yield* fixture()
      yield* test.connect
      yield* eventually(
        test.models.get(providerID, modelID),
        (model) => model !== undefined,
      )
      // A fast switch republishes the models; the gateway is only read again for the inventory.
      const state = yield* test.rpc.setFast({ enabled: true })
      expect(state.fast).toBe(true)
      const resolved = yield* eventually(
        test.models.get(providerID, modelID),
        (model) => model !== undefined && model.settings?.serviceTier === "priority",
      )
      expect(resolved?.settings).toMatchObject({ serviceTier: "priority", baseURL, provider: "rai" })
      // A model without reasoning steps gets it too; the tier is a property of the request, not the step.
      const plain = yield* test.models.get(providerID, plainID)
      expect(plain?.settings).toMatchObject({ serviceTier: "priority" })
      expect((yield* test.rpc.setFast({ enabled: false })).fast).toBe(false)
    }),
  )

  it.effect("hides an advertised step the gateway's upstream refuses", () =>
    Effect.gen(function* () {
      // The gateway lists `ultra` but answers `400` for it, which is what every codex model did live.
      const test = yield* fixture({
        models: () => Response.json(ultraInventory),
        probe: () => new Response("", { status: 400 }),
      })
      yield* test.connect
      // The step is hidden while it is unknown, so wait for what the probe learned before reading the catalogue.
      const state = yield* eventually(
        test.rpc.state({}),
        (value: Rai.Settings) => value.efforts.length === 1,
      )
      const resolved = yield* eventually(
        test.models.get(providerID, modelID),
        (model) => model !== undefined,
      )
      expect(resolved?.variants.map((variant) => String(variant.id))).toEqual(["low"])
      // The probe asks for the step with a one-word prompt and the stateless request shape.
      const probe = test.probes().at(-1)
      expect(probe).toBeDefined()
      const body = JSON.parse(yield* Effect.promise(() => probe!.text()))
      expect(body).toMatchObject({
        model: String(modelID),
        reasoning: { effort: "ultra" },
        store: false,
        stream: false,
      })
      // The answer is remembered, so the dialog can say what was learned.
      expect(state.efforts).toEqual([{ modelID: String(modelID), effort: "ultra", supported: false }])
    }),
  )

  it.effect("offers a probed step once the gateway accepts it", () =>
    Effect.gen(function* () {
      const test = yield* fixture({ models: () => Response.json(ultraInventory) })
      yield* test.connect
      const resolved = yield* eventually(
        test.models.get(providerID, modelID),
        (model) => model !== undefined && model.variants.length === 2,
      )
      expect(resolved?.variants.map((variant) => String(variant.id))).toEqual(["low", "ultra"])
      const state = yield* test.rpc.state({})
      expect(state.efforts).toEqual([{ modelID: String(modelID), effort: "ultra", supported: true }])
    }),
  )

  it.effect("re-checks a refused step after the gateway starts accepting it", () =>
    Effect.gen(function* () {
      // A gateway upgrade can make a step it used to refuse work; the dialog's re-check must pick that up.
      let accepting = false
      const test = yield* fixture({
        models: () => Response.json(ultraInventory),
        probe: () => (accepting ? Response.json({ id: "resp_1" }) : new Response("", { status: 400 })),
      })
      yield* test.connect
      const refused = yield* eventually(
        test.rpc.state({}),
        (value: Rai.Settings) => value.efforts.length === 1,
      )
      expect(refused.efforts).toEqual([{ modelID: String(modelID), effort: "ultra", supported: false }])

      accepting = true
      // The re-check answers only after it probed, so the dialog can report what this pass found.
      const checked = yield* test.rpc.verify({})
      expect(checked.efforts).toEqual([{ modelID: String(modelID), effort: "ultra", supported: true }])
      const resolved = yield* eventually(
        test.models.get(providerID, modelID),
        (model) => model !== undefined && model.variants.length === 2,
      )
      expect(resolved?.variants.map((variant) => String(variant.id))).toEqual(["low", "ultra"])
    }),
  )
})
