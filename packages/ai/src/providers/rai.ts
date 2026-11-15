import type { ProviderPackage } from "../provider-package.js"
import * as OpenAIResponses from "../protocols/openai-responses.js"
import type { ProviderAuthOption } from "../route/auth-options.js"
import { Route } from "../route/client.js"
import { Endpoint } from "../route/endpoint.js"
import { ProviderID, type ModelID, type RequestOptions } from "../schema/index.js"
import { withOpenAIOptions, type OpenAIProviderOptionsInput } from "./openai-options.js"
import { bearerRouteDefaults } from "./settings.js"

/** Provider identity for the ROKFOSS AI gateway. */
export const id = ProviderID.make("rai")
/** Display name of this provider. */
export const displayName = "ROKFOSS AI"

/** Canonical gateway endpoint; `configure({ baseURL })` points a model at another deployment. */
const baseURL = "https://project.krfoss.org/api/rai/v1"

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

/**
 * Requests are served statelessly (`store: false`), so the gateway only lets a later turn replay reasoning when the
 * encrypted content came back. Ask for it on every request instead of relying on each caller to remember.
 */
const reasoningInclude = ["reasoning.encrypted_content"]

/** A caller that sets `include` itself still wins, so callers can narrow or widen what comes back. */
const withReasoningInclude = (providerOptions: OpenAIProviderOptionsInput | undefined) =>
  providerOptions?.include === undefined ? { ...providerOptions, include: reasoningInclude } : providerOptions

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
 * The gateway speaks OpenAI Responses only, so this route reuses that protocol instead of cloning it.
 * Requests are served statelessly: `withOpenAIOptions` pins `store: false` below.
 */
export const route = Route.make({
  id: "rai-responses",
  provider: id,
  providerMetadataKey: "rai",
  protocol: OpenAIResponses.protocol,
  endpoint: Endpoint.path("/responses", { baseURL }),
  transport: OpenAIResponses.httpTransport,
})

export const routes = [route]

export const configure = (input: Config = {}) => {
  const { credential, providerOptions, ...configuration } = input
  const defaults = bearerRouteDefaults(configuration, "RAI_API_KEY", baseURL)
  const configuredRoute = route.with({ ...defaults, headers: resolveHeaders(defaults.headers, credential) })
  const responses = (modelID: string | ModelID) =>
    configuredRoute
      .with(withOpenAIOptions(modelID, { providerOptions: withReasoningInclude(providerOptions) }))
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
  http: body === undefined ? undefined : { body },
  providerOptions,
})

export const model: ProviderPackage.Model<Settings, OpenAIProviderOptionsInput> = (modelID, settings) =>
  configure(config(settings)).responses(modelID)
