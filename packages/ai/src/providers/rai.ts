import type { ProviderPackage } from "../provider-package.js"
import * as OpenAIResponses from "../protocols/openai-responses.js"
import type { ProviderAuthOption } from "../route/auth-options.js"
import { Route } from "../route/client.js"
import { Endpoint } from "../route/endpoint.js"
import { retrying } from "../route/executor.js"
import { ProviderID, type ModelID, type RequestOptions } from "../schema/index.js"
import { withOpenAIOptions, type OpenAIProviderOptionsInput } from "./openai-options.js"
import { bearerRouteDefaults } from "./settings.js"

/** Provider identity for the ROKFOSS AI gateway. */
export const id = ProviderID.make("rai")
/** Display name of this provider. */
export const displayName = "ROKFOSS AI"

/** Canonical gateway endpoint; `configure({ baseURL })` points a model at another deployment. */
const baseURL = "https://project.krfoss.org/api/rai/v1"
/** The only host a key may travel to: the CDN rule and the API both live under this name (spec 5.9). */
const gatewayHost = "project.krfoss.org"

export type Config = Omit<RequestOptions, "providerOptions"> &
  ProviderAuthOption<"optional"> & {
    readonly baseURL?: string
    /** Subscription owner id forwarded to the gateway as `X-RAI-Credential`. */
    readonly credential?: string
    readonly providerOptions?: OpenAIProviderOptionsInput
  }

export type Settings = ProviderPackage.Settings &
  OpenAIProviderOptionsInput & {
    readonly apiKey?: string | false
    readonly baseURL?: string
    readonly credential?: string
  }

const CREDENTIAL_HEADER = "X-RAI-Credential"

/** Parses without throwing: an unparseable base URL is a rejection, not a crash. */
const parseURL = (value: string) => {
  try {
    return new URL(value)
  } catch {
    return undefined
  }
}

/**
 * Spec 5.9 (security): a key must never leave for a host other than the gateway, so a configured base URL is accepted
 * only when it is `https` on `project.krfoss.org` and names no other port. Anything else is `undefined`, which lets the
 * caller fall back to the canonical endpoint instead of sending credentials somewhere unintended.
 */
export function safeBaseURL(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  if (trimmed === "") return undefined
  const url = parseURL(trimmed)
  if (url === undefined) return undefined
  if (url.protocol !== "https:") return undefined
  if (url.hostname !== gatewayHost) return undefined
  // A non-default port is a different service on the same name, so the key is not sent to it either.
  if (url.port !== "") return undefined
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "")
}

/**
 * Spec 5.8: a request is served statelessly, so no caller option may turn server-side storage on. Applied to the body
 * the route actually serializes, which is the only place a caller cannot reach past.
 */
const statelessBody = <Body>(body: Body): Body =>
  (typeof body === "object" && body !== null && !Array.isArray(body) ? { ...body, store: false } : body) as Body

/**
 * Requests are served statelessly (`store: false`), so the gateway only lets a later turn replay reasoning when the
 * encrypted content came back. Ask for it on every request instead of relying on each caller to remember.
 */
const reasoningInclude = ["reasoning.encrypted_content"]

/** A caller that sets `include` itself still wins, so callers can narrow or widen what comes back. */
const withReasoningInclude = (providerOptions: OpenAIProviderOptionsInput | undefined) =>
  providerOptions?.include === undefined ? { ...providerOptions, include: reasoningInclude } : providerOptions

/**
 * Spec 5.8: the reasoning include stays the default and `store` is pinned off after the merge, because the caller's own
 * `providerOptions` would otherwise be the last word and `withOpenAIOptions` merges them over its defaults.
 */
const withStatelessOptions = (providerOptions: OpenAIProviderOptionsInput | undefined) => ({
  ...withReasoningInclude(providerOptions),
  store: false,
})

/**
 * The gateway sits behind a CDN rule that answers `403` with an HTML page to every other user agent, so this header is
 * not cosmetic: it must contain `ROKFOSS` (case-sensitive) or each request is rejected before it reaches the API.
 */
export const userAgent = "ROKFOSS-CLI/v0.1 (opencode-rai)"

/** Caller headers merge over the credential header, so an explicit `X-RAI-Credential` still wins. */
const resolveHeaders = (given: Readonly<Record<string, string>> | undefined, credential: string | undefined) => {
  const headers: Record<string, string> = { ...given }
  const explicit = Object.keys(headers).some((name) => name.toLowerCase() === CREDENTIAL_HEADER.toLowerCase())
  // A blank owner id is not a credential; sending an empty header makes gateways reject the request.
  if (!explicit && credential?.trim()) headers[CREDENTIAL_HEADER] = credential
  // A caller that names its own user agent keeps it; anything else would turn every request into a 403.
  if (!Object.keys(headers).some((name) => name.toLowerCase() === "user-agent")) headers["User-Agent"] = userAgent
  return headers
}

/**
 * The gateway speaks OpenAI Responses only, so this route reuses that protocol instead of cloning it. It also owns
 * the two deployment rules the gateway imposes: requests are stateless (spec 5.8) and throttles are retried there
 * (spec 5.9).
 */
const transport: typeof OpenAIResponses.httpTransport = {
  ...OpenAIResponses.httpTransport,
  // `http.body` overlays the compiled body inside the transport, so pinning only what `body.from` produced would leave
  // that path open: both are forced here, immediately before the JSON is serialized.
  prepare: (input) =>
    OpenAIResponses.httpTransport.prepare({
      ...input,
      body: statelessBody(input.body),
      request:
        input.request.http?.body === undefined
          ? input.request
          : { ...input.request, http: { ...input.request.http, body: statelessBody(input.request.http.body) } },
    }),
  // Only this route retries: `retrying` wraps the executor for these requests and leaves every other provider alone.
  execute: (prepared, request, runtime, options) =>
    OpenAIResponses.httpTransport.execute(prepared, request, { ...runtime, http: retrying(runtime.http) }, options),
}

export const route = Route.make({
  id: "rai-responses",
  provider: id,
  providerMetadataKey: "rai",
  protocol: OpenAIResponses.protocol,
  endpoint: Endpoint.path("/responses", { baseURL }),
  transport,
})

export const routes = [route]

export const configure = (input: Config = {}) => {
  const { credential, providerOptions, baseURL: requested, http, ...configuration } = input
  // A rejected base URL falls back to the canonical endpoint: the key is only ever sent to the gateway (spec 5.9).
  const endpoint = safeBaseURL(requested) ?? baseURL
  const overlay = http === undefined ? undefined : { ...http, body: statelessBody(http.body) }
  const defaults = bearerRouteDefaults(
    { ...configuration, ...(overlay === undefined ? {} : { http: overlay }), baseURL: endpoint },
    "RAI_API_KEY",
    baseURL,
  )
  const configuredRoute = route.with({ ...defaults, headers: resolveHeaders(defaults.headers, credential) })
  const responses = (modelID: string | ModelID) =>
    configuredRoute
      .with(withOpenAIOptions(modelID, { providerOptions: withStatelessOptions(providerOptions) }))
      .model<OpenAIProviderOptionsInput>({ id: modelID })
  return { id, model: responses, responses, configure }
}

export const provider = configure()

export const responses = provider.responses

const config = ({
  apiKey,
  baseURL,
  body,
  headers,
  credential,
  ...providerOptions
}: Settings = {}): Config => ({
  apiKey,
  baseURL,
  headers: resolveHeaders(headers, credential),
  // A settings `body` is an overlay on the request body, so it is pinned here too (spec 5.8).
  http: body === undefined ? undefined : { body: statelessBody(body) },
  providerOptions,
})

export const model: ProviderPackage.Model<Settings, OpenAIProviderOptionsInput> = (modelID, settings) =>
  configure(config(settings)).responses(modelID)
