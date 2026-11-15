import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpClientRequest } from "effect/http"
import { ai } from "../../src/effect.js"
import { RAI } from "../../src/providers.js"
import { LLMClient } from "../../src/route.js"
import { compileRequest } from "../../src/route/client.js"
import { it } from "../lib/effect.js"
import { dynamicResponse, json, type HandlerInput } from "../lib/http.js"
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

/** Sends one prompt against a scripted gateway and reports how many times it was called and the failure. */
const failing = (
  model: Model,
  respond: (input: HandlerInput) => ReturnType<HandlerInput["respond"]>,
  prompt = "Hello",
) =>
  Effect.gen(function* () {
    const calls: Array<string> = []
    const error = yield* LLMClient.generate(ai.request({ model, prompt })).pipe(
      Effect.provide(
        dynamicResponse((input) =>
          Effect.sync(() => {
            calls.push(input.text)
            return respond(input)
          }),
        ),
      ),
      Effect.flip,
    )
    return { calls, error }
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

  it.effect("honors a custom baseURL on the gateway and forwards the subscription credential", () =>
    Effect.gen(function* () {
      const configured = RAI.configure({
        apiKey: "fixture",
        // A deployment path on the gateway itself: spec 5.9 rejects any other host before the key is sent.
        baseURL: "https://project.krfoss.org/rai/v1",
        credential: "owner-42",
        headers: { "x-rai-tenant": "tenant-1" },
      }).responses("rai-test-model")
      const call = yield* observed(configured)

      expect(call.url).toBe("https://project.krfoss.org/rai/v1/responses")
      expect(call.headers.get("authorization")).toBe("Bearer fixture")
      expect(call.headers.get("x-rai-credential")).toBe("owner-42")
      expect(call.headers.get("x-rai-tenant")).toBe("tenant-1")
    }),
  )

  it.effect("omits the credential header when the owner id is blank", () =>
    Effect.gen(function* () {
      const call = yield* observed(
        RAI.configure({ apiKey: "fixture", baseURL: "https://project.krfoss.org/rai/v1", credential: "  " }).responses(
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
          baseURL: "https://project.krfoss.org/rai/v1",
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
          baseURL: "https://project.krfoss.org/settings/v1",
          credential: "owner-7",
        }),
      )

      expect(call.url).toBe("https://project.krfoss.org/settings/v1/responses")
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

  // Spec 5.8: a request is served statelessly, and `withOpenAIOptions` merges the caller's options over its defaults,
  // so a caller could otherwise turn storage on and break reasonning replay for the next turn.
  it.effect("keeps store false in the body it sends, whichever option the caller uses", () =>
    Effect.gen(function* () {
      const settings = yield* observed(RAI.model("rai-test-model", { apiKey: "fixture", store: true }))
      expect(JSON.parse(settings.body).store).toBe(false)
      // The include default survives the override.
      expect(JSON.parse(settings.body).include).toEqual(["reasoning.encrypted_content"])

      const configured = yield* observed(
        RAI.configure({ apiKey: "fixture", providerOptions: { store: true } }).responses("rai-test-model"),
      )
      expect(JSON.parse(configured.body).store).toBe(false)

      // A settings `body` overlays the compiled body inside the transport, so it needs the same pin.
      const overlaid = yield* observed(RAI.model("rai-test-model", { apiKey: "fixture", body: { store: true } }))
      expect(JSON.parse(overlaid.body).store).toBe(false)
    }),
  )

  // Spec 5.9: a shared-subscription limit is a final answer, so it must not cost a second request.
  it.effect("does not retry a shared-subscription limit", () =>
    Effect.gen(function* () {
      const { calls, error } = yield* failing(model, (input) =>
        json(
          input,
          { error: { code: "share_limited", message: "Shared subscription limit reached" } },
          { status: 429, headers: { "retry-after": "0" } },
        ),
      )

      expect(calls).toHaveLength(1)
      expect(error.isRetryable).toBe(false)
      expect(error.message).toContain("Shared subscription limit reached")
    }),
  )

  // The same code can arrive as a stream event, where no retry is possible but the caller's own policy must not retry.
  it.effect("treats share_limited inside the stream as final", () =>
    Effect.gen(function* () {
      const { error } = yield* failing(model, (input) =>
        input.respond(
          sseEvents({ type: "error", code: "share_limited", message: "Shared subscription limit reached" }),
          { headers: { "content-type": "text/event-stream" } },
        ),
      )

      expect(error.reason._tag).toBe("QuotaExceeded")
      expect(error.isRetryable).toBe(false)
    }),
  )

  it.effect("retries a throttle at most three times", () =>
    Effect.gen(function* () {
      const { calls, error } = yield* failing(model, (input) =>
        json(
          input,
          { error: { code: "upstream_rate_limited", message: "Slow down" } },
          { status: 429, headers: { "retry-after": "0" } },
        ),
      )

      // One attempt plus the three retries the specification allows.
      expect(calls).toHaveLength(4)
      expect(error.reason._tag).toBe("RateLimit")
      // The allowance is spent, so an outer policy cannot pay for the same waits again.
      expect(error.isRetryable).toBe(false)
    }),
  )

  it.effect("does not retry a deterministic rejection", () =>
    Effect.gen(function* () {
      const { calls, error } = yield* failing(model, (input) =>
        json(input, { error: { code: "invalid_api_key", message: "Incorrect API key" } }, { status: 401 }),
      )

      expect(calls).toHaveLength(1)
      expect(error.reason._tag).toBe("Authentication")
      expect(error.isRetryable).toBe(false)
    }),
  )

  // Spec 5.9 (security): the key rides on every request, so only the gateway itself may be addressed.
  test("safeBaseURL accepts only the gateway over https", () => {
    expect(RAI.safeBaseURL(undefined)).toBeUndefined()
    expect(RAI.safeBaseURL("")).toBeUndefined()
    expect(RAI.safeBaseURL("   ")).toBeUndefined()

    expect(RAI.safeBaseURL("https://project.krfoss.org/api/rai/v1")).toBe("https://project.krfoss.org/api/rai/v1")
    // The trailing slash is normalized away so the endpoint never becomes `//responses`.
    expect(RAI.safeBaseURL("https://project.krfoss.org/api/rai/v1///")).toBe("https://project.krfoss.org/api/rai/v1")

    // Plain http would put the key on the wire in the clear.
    expect(RAI.safeBaseURL("http://project.krfoss.org/api/rai/v1")).toBeUndefined()
    expect(RAI.safeBaseURL("ftp://project.krfoss.org/api/rai/v1")).toBeUndefined()
    // Another host, a look-alike name, and a different port on the same name are all refused.
    expect(RAI.safeBaseURL("https://gateway.example/rai/v1")).toBeUndefined()
    expect(RAI.safeBaseURL("https://project.krfoss.org.evil.example/rai/v1")).toBeUndefined()
    expect(RAI.safeBaseURL("https://project.krfoss.org:8443/api/rai/v1")).toBeUndefined()
    expect(RAI.safeBaseURL("project.krfoss.org/api/rai/v1")).toBeUndefined()
  })

  it.effect("falls back to the gateway endpoint when the configured baseURL is refused", () =>
    Effect.gen(function* () {
      const call = yield* observed(
        RAI.model("rai-test-model", { apiKey: "fixture", baseURL: "https://gateway.example/rai/v1" }),
      )

      expect(call.url).toBe("https://project.krfoss.org/api/rai/v1/responses")
    }),
  )
})
