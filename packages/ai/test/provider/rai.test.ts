import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpClientRequest } from "effect/http"
import { ai } from "../../src/effect.js"
import { RAI } from "../../src/providers.js"
import { LLMClient } from "../../src/route.js"
import { compileRequest } from "../../src/route/client.js"
import { it } from "../lib/effect.js"
import { dynamicResponse } from "../lib/http.js"
import { sseEvents } from "../lib/sse.js"

const model = RAI.model("rai-test-model", { apiKey: "fixture" })

type Model = ReturnType<typeof RAI.model>

/** Sends one prompt through the fake transport and reports what the gateway would have received. */
const observed = (model: Model, prompt = "Hello") =>
  Effect.gen(function* () {
    const calls: Array<{ readonly url: string; readonly headers: Headers; readonly body: string }> = []
    yield* LLMClient.generate(ai.request({ model, prompt })).pipe(
      Effect.provide(
        dynamicResponse((input) =>
          Effect.gen(function* () {
            const web = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
            calls.push({ url: web.url, headers: web.headers, body: input.text })
            return input.respond(sseEvents({ type: "response.completed", response: { id: "resp_1" } }), {
              headers: { "content-type": "text/event-stream" },
            })
          }),
        ),
      ),
    )
    const call = calls.at(-1)
    if (!call) throw new Error("the gateway received no request")
    return call
  })

describe("RAI gateway", () => {
  test("exposes its own Responses route", async () => {
    const entrypoint = await import("@opencode/ai/providers/rai")

    expect(RAI.id).toBe("rai")
    expect(entrypoint.model).toBeFunction()
    expect(RAI.route).toMatchObject({
      id: "rai-responses",
      provider: "rai",
      providerMetadataKey: "rai",
      protocol: "openai-responses",
    })
    expect(RAI.route.endpoint).toMatchObject({
      baseURL: "https://project.krfoss.org/api/rai/v1",
      path: "/responses",
    })
  })

  it.effect("posts to the default Responses endpoint with bearer auth", () =>
    Effect.gen(function* () {
      const call = yield* observed(model)

      expect(call.url).toBe("https://project.krfoss.org/api/rai/v1/responses")
      expect(call.headers.get("authorization")).toBe("Bearer fixture")
      expect(call.headers.get("x-rai-credential")).toBeNull()
      expect(JSON.parse(call.body)).toMatchObject({ model: "rai-test-model", store: false, stream: true })
    }),
  )

  // The gateway rejects every other user agent with an HTML 403, so the header is part of the contract.
  it.effect("identifies itself with a ROKFOSS user agent", () =>
    Effect.gen(function* () {
      const call = yield* observed(model)

      expect(call.headers.get("user-agent")).toContain("ROKFOSS")
    }),
  )

  it.effect("keeps a caller-supplied user agent", () =>
    Effect.gen(function* () {
      const call = yield* observed(
        RAI.configure({ apiKey: "fixture", headers: { "User-Agent": "custom-agent/1" } }).responses("rai-test-model"),
      )

      expect(call.headers.get("user-agent")).toBe("custom-agent/1")
    }),
  )

  it.effect("honors a custom baseURL and forwards the subscription credential", () =>
    Effect.gen(function* () {
      const configured = RAI.configure({
        apiKey: "fixture",
        baseURL: "https://gateway.example/rai/v1",
        credential: "owner-42",
        headers: { "x-rai-tenant": "tenant-1" },
      }).responses("rai-test-model")
      const call = yield* observed(configured)

      expect(call.url).toBe("https://gateway.example/rai/v1/responses")
      expect(call.headers.get("authorization")).toBe("Bearer fixture")
      expect(call.headers.get("x-rai-credential")).toBe("owner-42")
      expect(call.headers.get("x-rai-tenant")).toBe("tenant-1")
    }),
  )

  it.effect("omits the credential header when the owner id is blank", () =>
    Effect.gen(function* () {
      const call = yield* observed(
        RAI.configure({ apiKey: "fixture", baseURL: "https://gateway.example/rai/v1", credential: "  " }).responses(
          "rai-test-model",
        ),
      )

      expect(call.headers.get("x-rai-credential")).toBeNull()
    }),
  )

  it.effect("lets an explicit credential header win over the setting", () =>
    Effect.gen(function* () {
      const call = yield* observed(
        RAI.configure({
          apiKey: "fixture",
          baseURL: "https://gateway.example/rai/v1",
          credential: "owner-42",
          headers: { "x-rai-credential": "header-owner" },
        }).responses("rai-test-model"),
      )

      expect(call.headers.get("x-rai-credential")).toBe("header-owner")
    }),
  )

  it.effect("takes connection settings from the settings facade", () =>
    Effect.gen(function* () {
      const call = yield* observed(
        RAI.model("rai-test-model", {
          apiKey: "fixture",
          baseURL: "https://settings.example/rai/v1",
          credential: "owner-7",
        }),
      )

      expect(call.url).toBe("https://settings.example/rai/v1/responses")
      expect(call.headers.get("x-rai-credential")).toBe("owner-7")
    }),
  )

  it.effect("defaults to a stateless Responses request", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(ai.request({ model, prompt: "Hello" }))

      expect(prepared.route).toBe("rai-responses")
      expect(prepared.protocol).toBe("openai-responses")
      expect(prepared.model.route.providerMetadataKey).toBe("rai")
      expect(prepared.body.store).toBe(false)
    }),
  )

  it.effect("asks for encrypted reasoning on every request so a stateless follow-up can replay it", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(ai.request({ model, prompt: "Hello" }))

      // Without this the gateway returns reasoning items with no encrypted content, which a later
      // stateless turn cannot replay.
      expect(prepared.body.include).toEqual(["reasoning.encrypted_content"])
    }),
  )

  it.effect("forwards high-speed output as the gateway's service tier", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        ai.request({ model: RAI.model("rai-test-model", { apiKey: "fixture", serviceTier: "priority" }), prompt: "Hello" }),
      )

      // The gateway accepts only `priority`, and the request stays stateless.
      expect(prepared.body.service_tier).toBe("priority")
      expect(prepared.body.store).toBe(false)
    }),
  )

  it.effect("omits the service tier unless the caller asks for it", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(ai.request({ model, prompt: "Hello" }))

      expect(prepared.body.service_tier).toBeUndefined()
    }),
  )

  it.effect("lets an explicit include replace the default one", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        ai.request({
          model: RAI.configure({
            apiKey: "fixture",
            providerOptions: { include: ["message.output_text.logprobs"] },
          }).responses("rai-test-model"),
          prompt: "Hello",
        }),
      )

      expect(prepared.body.include).toEqual(["message.output_text.logprobs"])
    }),
  )
})
