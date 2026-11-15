import type { ConnectionInfo } from "@opencode/client"
import { define } from "@opencode/plugin/effect/plugin"
import { Document } from "@opencode/schema/config"
import { Rai } from "@opencode/schema/rai"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { Duration, Effect, FiberSet, Option, Schema, Schedule, Semaphore, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import path from "node:path"
import { Config } from "../../config.js"
import { ConfigDiscovery } from "../../config/discovery.js"
import { ConfigIntegration } from "../../config/integration.js"
import { Integration } from "../../integration.js"
import { IntegrationConnection } from "../../integration/connection.js"
import { Model } from "../../model.js"
import { Provider } from "../../provider.js"
import type { PluginInternal } from "../internal.js"
import { configuredSettings, foldSettings } from "./configured.js"
import { activeCredential } from "./credential-settings.js"
import { ProviderRefresh } from "./refresh.js"

const providerID = Provider.ID.make("rai")
const integrationID = Integration.ID.make("rai")
const packageName = "@opencode/ai/providers/rai"
const defaultBaseURL = "https://project.krfoss.org/api/rai/v1"
/** The gateway host a project config may name; every other host may only come from user scope (spec 9.1). */
const gatewayHost = "project.krfoss.org"
const credentialHeader = "X-RAI-Credential"
// The gateway answers `403` with an HTML page to every other user agent, so this must contain `ROKFOSS`.
export const userAgent = "ROKFOSS-CLI/v0.1 (opencode-rai)"
// The gateway's model list is small; a remote host that never answers must not hold the refresh.
const requestTimeout = Duration.seconds(15)
// The gateway's catalogue changes rarely; a background refresh keeps a new model from waiting for a restart.
const interval = Duration.minutes(30)
// Responses accepts reasoning without server-side storage only when the encrypted content comes back.
const reasoningInclude = ["reasoning.encrypted_content"]
// The subscription choice and the high-speed switch are the user's, not the config file's, once they pick one.
const preferencesKey = "rai-preferences"
/** Upstreams that accept high-speed output; the gateway forwards the tier to these only (spec 3.4). */
const tieredProviders = new Set(["codex", "xai"])
/** `rai-` plus 43 base64url characters is the only key shape the gateway issues (spec 2). */
const keyPattern = /^rai-[A-Za-z0-9_-]{43}$/

/** One `GET /models` entry. `rai` carries the reasoning steps the gateway offers for that model. */
const ModelEntry = Schema.Struct({
  id: Schema.String,
  rai: Schema.optional(
    Schema.Struct({
      provider: Schema.optional(Schema.String),
      efforts: Schema.optional(Schema.Array(Schema.String)),
      default_effort: Schema.optional(Schema.String),
    }),
  ),
})
const ModelList = Schema.Struct({ data: Schema.Array(ModelEntry) })
/** One `GET /credentials` entry; the gateway spells the owner id with a snake-case key. */
const CredentialEntry = Schema.Struct({
  owner_id: Schema.Int,
  label: Schema.String,
  providers: Schema.optional(Schema.Array(Schema.String)),
})
const CredentialList = Schema.Struct({ data: Schema.Array(CredentialEntry) })
/** Gateway errors answer `{ error: { message, code } }`, sometimes with the message at the top level. */
const ErrorBody = Schema.Struct({
  message: Schema.optional(Schema.String),
  code: Schema.optional(Schema.String),
  error: Schema.optional(
    Schema.Union([
      Schema.String,
      Schema.Struct({ message: Schema.optional(Schema.String), code: Schema.optional(Schema.String) }),
    ]),
  ),
})
const decodeError = Schema.decodeUnknownOption(Schema.fromJsonString(ErrorBody))
const Preferences = Schema.Struct({ ownerID: Schema.NullOr(Schema.Int), fast: Schema.Boolean })
const decodePreferences = Schema.decodeUnknownOption(Preferences)

export type RaiModel = typeof ModelEntry.Type
export type RaiPreferences = typeof Preferences.Type

type Discovered = {
  readonly baseURL?: string
  readonly models?: readonly RaiModel[]
  readonly connection?: ConnectionInfo
  readonly connected?: boolean
}

/** The `credential` setting names a subscription (owner id); "0" and blanks mean the account's own quota. */
export function subscription(value: unknown) {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed === "" || trimmed === "0" ? undefined : trimmed
}

/** A config-file owner id as the number the dialog uses; 0 is the account's own quota. */
function numericOwner(value: string | undefined) {
  if (value === undefined) return undefined
  const id = Number(value)
  return Number.isFinite(id) && id > 0 ? Math.trunc(id) : undefined
}

/** Whether the value is the `rai-…` key the gateway issues: `rai-` plus 43 base64url characters (spec 2). */
export function keyShape(key: string) {
  return keyPattern.test(key)
}

/**
 * Shown when a stored key cannot be a gateway key. Core stores a pasted key before a plugin can inspect it, so this is
 * the earliest point the plugin can refuse one; it never repeats the key itself.
 */
export const keyShapeMessage = "키 모양이 올바르지 않습니다. RAI 앱에서 새 키(rai- + 43자)를 만들어 다시 연결하세요."

/** The action each gateway `code` implies; the server's Korean `message` already says what happened (spec 4). */
export function guidance(code: string | undefined) {
  switch (code) {
    case "expired_api_key":
      return "RAI 앱에서 새 키를 만들어 다시 연결하세요"
    case "credential_not_allowed":
    case "credential_unavailable":
    case "share_not_allowed":
      return "구독을 다시 고르세요"
    case "share_limited":
      return "공유 한도가 끝났습니다. 내 구독으로 바꾸거나 잠시 뒤 다시 시도하세요"
    case "scope_missing":
      return "AI 앱 설정에서 이 키의 권한을 켜 주세요"
    // `ai_locked` is answered with guidance the server already words, so nothing is appended to it.
    default:
      return undefined
  }
}

/** The gateway's message followed by what the code implies, so one line tells the user what to do (spec 4). */
export function describe(code: string | undefined, message: string) {
  const next = guidance(code)
  return next === undefined ? message : `${message} — ${next}`
}

/** An `https:` API root without a trailing slash, or why the value cannot be one. */
export type BaseURL = { readonly url?: string; readonly reason?: "invalid" | "http" | "port" | "host" }

/**
 * An `https:` API root, rebuilt from its parsed parts so a query, fragment or userinfo never reaches a request path.
 * `http:` is refused everywhere: the key must never travel in clear text (spec 9.1).
 */
export function parseBaseURL(value: unknown): BaseURL {
  if (typeof value !== "string") return {}
  const trimmed = value.trim()
  if (trimmed === "") return {}
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return { reason: "invalid" }
  }
  if (url.protocol !== "https:") return { reason: "http" }
  // The AI package accepts the gateway on its default port only, so a port here would fall back there anyway.
  const host = url.hostname.replace(/\.+$/, "").toLowerCase()
  if (host === gatewayHost && url.port !== "") return { reason: "port" }
  return { url: `${url.origin}${url.pathname}`.replace(/\/+$/, "") }
}

/**
 * A project config may only name the gateway host: it merges from the opened folder, so any other host there would
 * send the saved key to whoever wrote the repository (spec 9.1). The comparison folds case and a root dot.
 */
export function gatewayBaseURL(value: unknown): BaseURL {
  const parsed = parseBaseURL(value)
  if (parsed.url === undefined) return parsed
  const host = new URL(parsed.url).hostname.replace(/\.+$/, "").toLowerCase()
  return host === gatewayHost ? parsed : { reason: "host" }
}

/** The origin of a refused setting: a warning names the host without the path or credentials a URL may carry. */
function originOf(value: string) {
  try {
    return new URL(value.trim()).origin
  } catch {
    return undefined
  }
}

/** The advertised steps of one entry, trimmed, without blanks. */
function advertisedEfforts(entry: RaiModel | undefined) {
  return (entry?.rai?.efforts ?? []).map((effort) => effort.trim()).filter((effort) => effort !== "")
}

/**
 * The gateway's inventory as provider models. `rai.efforts` becomes the variants exactly as listed: the gateway drops a
 * step its own upstream refuses, so the CLI neither probes nor hides one (spec 3.1, 9.2).
 *
 * `options.fast` turns on high-speed output, and only for the providers whose upstream accepts it (spec 3.4).
 */
export function toModels(
  endpoint: string,
  entries: readonly RaiModel[],
  options: { readonly fast?: boolean } = {},
): Model.Info[] {
  return entries.map((entry) => {
    const id = Model.ID.make(entry.id)
    const efforts = advertisedEfforts(entry)
    const upstream = entry.rai?.provider?.trim().toLowerCase()
    const fallback = entry.rai?.default_effort?.trim()
    return Model.Info.make({
      ...Model.Info.default(providerID, id),
      id,
      modelID: id,
      providerID,
      name: entry.id,
      ...(entry.rai?.provider ? { family: Model.Family.make(entry.rai.provider) } : {}),
      package: packageName,
      settings: {
        baseURL: endpoint,
        provider: "rai",
        // High-speed output is a `service_tier` the protocol forwards as-is; the gateway accepts only `priority` and
        // passes it to codex and xai upstreams, leaving the rest at their default tier (spec 3.4).
        ...(options.fast && upstream !== undefined && tieredProviders.has(upstream) ? { serviceTier: "priority" } : {}),
        // Requests start at the effort the gateway calls default; a chosen variant replaces it.
        ...(fallback && efforts.includes(fallback) ? { reasoningEffort: fallback } : {}),
      },
      variants: efforts.map((effort) => ({
        id: Model.VariantID.make(effort),
        settings: { reasoningEffort: effort, reasoningSummary: "auto", include: reasoningInclude },
      })),
    })
  })
}

/**
 * Documents a project cannot write: the global config directory, the system directory, and the
 * `OPENCODE_CONFIG_CONTENT` document, which has no path. An integration document is remote, not the user's own.
 */
function userScoped(entry: Document, roots: readonly string[]) {
  if (entry instanceof ConfigIntegration.Document) return false
  if (entry instanceof ConfigIntegration.WellKnownDocument) return false
  const file = entry.path
  return file === undefined || roots.some((root) => FSUtil.contains(root, file))
}

export const RaiPlugin = define({
  id: "opencode.provider.rai",
  effect: Effect.fn(function* (ctx) {
    const http = yield* HttpClient.HttpClient
    // Captured so an RPC handler (which may not require services) can still publish through the provider transform.
    const providerService = yield* Provider.Service
    // Read here and refreshed on `config.updated`: the provider transform below is synchronous.
    const settings = { current: yield* configuredSettings(providerID) }
    // A stored choice outlives a restart, so the dialog only writes to storage; the config file stays the fallback.
    const preferences = {
      current: Option.getOrUndefined(decodePreferences(yield* ctx.storage.get(preferencesKey))) ?? {
        ownerID: null as number | null,
        fast: false,
      },
    }
    const credentials = { current: [] as Rai.Credential[], error: null as string | null }
    /** The hash of what the provider list currently reflects, so an unchanged refresh publishes nothing. */
    let published = ""
    /** The endpoint every request uses; only user-scoped settings may change it (spec 9.1). */
    const endpoint = { current: defaultBaseURL }
    /** Scopes whose base URL setting was refused, so a warning is logged once instead of on every refresh. */
    const warned = new Set<string>()

    /** The subscription the config file names, if the dialog has not picked one. */
    const configuredOwner = () => subscription(settings.current?.credential)
    /** The numeric subscription the dialog uses; 0 is the account's own quota. */
    const ownerID = () => preferences.current.ownerID ?? numericOwner(configuredOwner())
    /** The header value for the subscription in play; `undefined` keeps the request on the account's own quota. */
    const ownerHeader = () => {
      if (preferences.current.ownerID !== null)
        return preferences.current.ownerID === 0 ? undefined : String(preferences.current.ownerID)
      return configuredOwner()
    }

    /**
     * `providers.rai.settings` folded from user-scoped documents only. A project `opencode.json` merges into the same
     * settings, so folding every layer here would let a repository redirect the saved key (spec 9.1).
     */
    const userSettings = Effect.fn("RaiPlugin.userSettings")(function* () {
      const service = yield* Effect.serviceOption(Config.Service)
      if (Option.isNone(service)) return undefined
      // Optional too: the RPC handlers provide only the provider service, and a missing Global just leaves the
      // environment document trusted.
      const global = yield* Effect.serviceOption(Global.Service)
      const roots = Option.isNone(global)
        ? []
        : [path.resolve(global.value.config), path.resolve(ConfigDiscovery.systemDirectory())]
      const entries = (yield* service.value.entries()).filter(
        (entry): entry is Document => entry.type === "document" && userScoped(entry, roots),
      )
      // Not the provider's current settings: those already hold every layer, including the project's.
      return foldSettings(entries, providerID, undefined)
    })

    /** Warns once per scope about a refused setting, naming the origin instead of the whole URL. */
    const warn = (scope: string, result: BaseURL, value: unknown) => {
      if (result.reason === undefined || warned.has(scope) || typeof value !== "string") return Effect.void
      warned.add(scope)
      return Effect.logWarning("ignored a RAI base URL setting", {
        scope,
        reason: result.reason,
        origin: originOf(value),
      })
    }

    /**
     * The endpoint in effect. `RAI_BASE_URL` and a global config may name any `https:` host, a project config only the
     * gateway host, and anything refused falls back to the default with one warning (spec 9.1).
     */
    const resolveEndpoint = Effect.fn("RaiPlugin.endpoint")(function* (configured: Provider.Settings | undefined) {
      const user = yield* userSettings()
      const environment = parseBaseURL(process.env.RAI_BASE_URL)
      const global = parseBaseURL(user?.baseURL)
      const shared = gatewayBaseURL(configured?.baseURL)
      const next = environment.url ?? global.url ?? shared.url ?? defaultBaseURL
      yield* warn("environment", environment, process.env.RAI_BASE_URL)
      yield* warn("global", global, user?.baseURL)
      // A layer that repeats the global value is not a second rejection.
      yield* warn("project", shared, configured?.baseURL === user?.baseURL ? undefined : configured?.baseURL)
      endpoint.current = next
      return next
    })

    // Resolve once before the first publish, so a configured endpoint is in place even before discovery.
    endpoint.current = yield* resolveEndpoint(settings.current)

    yield* ctx.integration.transform((editor) => {
      editor.update(integrationID, (integration) => {
        integration.name = "ROKFOSS AI"
      })
      // Only an API key: the first stage has no browser or OAuth sign-in.
      editor.method.update({ integrationID, method: { type: "key", label: "ROKFOSS AI API 키" } })
    })

    // One `GET /models` connects, validates the saved key and lists what it may use. A rejected key is reported on
    // the connection, so `/connect` shows the gateway's own message next to the account.
    const discovered: { current: Discovered } = { current: {} }
    const lock = Semaphore.makeUnsafe(1)
    const load = Effect.fn("RaiPlugin.load")(function* () {
      const { connection, credential } = yield* activeCredential(ctx, "rai")
      settings.current = yield* configuredSettings(providerID)
      const current = yield* resolveEndpoint(settings.current)
      const key = credential?.type === "key" ? credential.key : undefined
      const report = (status: IntegrationConnection.Status | undefined) =>
        connection ? ctx.integration.connection.status({ integrationID: "rai", connection, status }) : Effect.void
      if (!key) {
        yield* report(undefined)
        credentials.current = []
        credentials.error = null
        return { connection, baseURL: current, connected: false } satisfies Discovered
      }
      // Core stores a pasted key before a plugin sees it, so this is the earliest refusal: a key that cannot be one of
      // ours never leaves the process, and `/connect` says why (spec 2, 9.4).
      if (!keyShape(key)) {
        yield* report({ status: "needs_auth", message: keyShapeMessage })
        credentials.current = []
        credentials.error = keyShapeMessage
        return { connection, baseURL: current, connected: false } satisfies Discovered
      }
      const auth = { key, credential: ownerHeader() }
      const listed = yield* listModels(http, current, auth).pipe(
        Effect.map((entries) => ({ entries })),
        Effect.catch((error) => Effect.succeed({ error })),
      )
      // The subscription list is a convenience: a failure here must not hide models the key can still use.
      const shared = yield* listCredentials(http, current, auth).pipe(
        Effect.map((entries) => ({ entries })),
        Effect.catch((error) => Effect.succeed({ error })),
      )
      credentials.error = "error" in shared ? shared.error.message : null
      credentials.current =
        "error" in shared
          ? []
          : shared.entries.map((entry) => ({
              ownerID: entry.owner_id,
              label: entry.label,
              providers: entry.providers ?? [],
            }))
      if ("error" in listed) {
        yield* report({ status: "needs_auth", message: listed.error.message })
        // Keep the last inventory for the same account through a transient outage; never another account's.
        const previous = discovered.current
        const same = IntegrationConnection.key(previous.connection) === IntegrationConnection.key(connection)
        return {
          connection,
          baseURL: current,
          connected: true,
          models: same ? previous.models : undefined,
        } satisfies Discovered
      }
      yield* report(undefined)
      return { connection, baseURL: current, connected: true, models: listed.entries } satisfies Discovered
    })

    // The loop keeps the inventory current on a timer, and a connection change refreshes at once.
    const refresh = Effect.fn("RaiPlugin.refresh")(function* () {
      const next = yield* lock.withPermit(load())
      const hash = JSON.stringify([
        next.baseURL,
        next.models,
        IntegrationConnection.key(next.connection),
        ownerID() ?? 0,
        preferences.current.fast,
      ])
      if (hash === published) return
      published = hash
      discovered.current = next
      yield* ctx.provider.reload()
    })

    yield* refresh().pipe(Effect.repeat(Schedule.spaced(interval)), Effect.forkScoped)
    // Event handlers start a refresh without waiting on it, so a slow gateway doesn't hold up the next event.
    const background = yield* FiberSet.make()
    yield* ProviderRefresh.onSwitch("rai", FiberSet.run(background, refresh()))

    /** What a dialog renders; every RPC method answers this so one reply is enough. */
    const snapshot = Effect.fn("RaiPlugin.snapshot")(function* () {
      const loaded = discovered.current
      return {
        connected: loaded.connected === true,
        ownerID: preferences.current.ownerID,
        fast: preferences.current.fast,
        credentials: credentials.current,
        error: credentials.error,
      } satisfies Rai.Settings
    })

    /** Stores one preference and republishes the provider, so the next request already uses it. */
    const save = Effect.fn("RaiPlugin.save")(function* (next: RaiPreferences) {
      preferences.current = next
      yield* ctx.storage.set(preferencesKey, next)
      yield* refresh()
    })

    yield* ctx.rpc
      .register(Rai.Definition, {
        state: () => snapshot().pipe(Effect.provideService(Provider.Service, providerService)),
        refresh: () =>
          refresh().pipe(
            Effect.andThen(snapshot()),
            Effect.provideService(Provider.Service, providerService),
          ),
        select: (input) =>
          save({ ...preferences.current, ownerID: input.ownerID }).pipe(
            Effect.andThen(snapshot()),
            Effect.provideService(Provider.Service, providerService),
          ),
        setFast: (input) =>
          save({ ...preferences.current, fast: input.enabled }).pipe(
            Effect.andThen(snapshot()),
            Effect.provideService(Provider.Service, providerService),
          ),
      })
      .pipe(Effect.orDie)

    yield* ctx.provider.transform((providers) => {
      const loaded = discovered.current
      const resolved = loaded.baseURL ?? endpoint.current
      const credential = ownerHeader()
      providers.update(providerID, (provider) => {
        provider.name = "ROKFOSS AI"
        provider.package = packageName
        // Availability follows the connection, as it does for every other integration provider.
        provider.integrationID = integrationID
        provider.settings = Provider.mergeOverlay(provider.settings, { baseURL: resolved, provider: "rai" })
        // A subscription rides on every request of this provider; "0" and blanks mean the account's own quota.
        const next = { ...provider.headers }
        for (const name of Object.keys(next))
          if (name.toLowerCase() === credentialHeader.toLowerCase()) delete next[name]
        if (credential) next[credentialHeader] = credential
        provider.headers = Object.keys(next).length > 0 ? next : undefined
      })
      const item = providers.get(providerID)
      if (!item || !loaded.models || !loaded.baseURL) return
      providers.add({
        info: item.provider,
        models: toModels(loaded.baseURL, loaded.models, { fast: preferences.current.fast }),
        sourceConnection: loaded.connection,
      })
    })

    // A changed base URL or subscription changes both the discovery request and the headers of later requests.
    yield* ctx.event.subscribe({ types: ["config.updated"] }).pipe(
      Stream.runForEach(() =>
        Effect.gen(function* () {
          const next = yield* configuredSettings(providerID)
          const previous = endpoint.current
          const resolved = yield* resolveEndpoint(next)
          if (
            resolved === previous &&
            subscription(next?.credential) === subscription(settings.current?.credential)
          )
            return
          settings.current = next
          yield* refresh()
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
}) satisfies PluginInternal.InternalPlugin

/** `GET {baseURL}/models`: the saved key is accepted only when the gateway lists models for it. */
function listModels(
  http: HttpClient.HttpClient,
  endpoint: string,
  auth: { readonly key: string; readonly credential?: string },
) {
  return http
    .execute(
      HttpClientRequest.get(`${endpoint}/models`).pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.bearerToken(auth.key),
        HttpClientRequest.setHeaders(headers(auth.credential)),
      ),
    )
    .pipe(
      Effect.timeout(requestTimeout),
      Effect.mapError((cause) =>
        cause instanceof Error && cause.message
          ? new Error(cause.message)
          : new Error("Could not reach the ROKFOSS AI gateway"),
      ),
      Effect.flatMap((response) => {
        if (response.status < 200 || response.status >= 300) return failure(response)
        return HttpClientResponse.schemaBodyJson(ModelList)(response).pipe(
          Effect.mapError(() => new Error("The ROKFOSS AI gateway returned an invalid model list")),
          Effect.map((body) => body.data),
        )
      }),
    )
}

/** `GET {baseURL}/credentials`: the subscriptions the saved key may spend from, own quota first. */
function listCredentials(
  http: HttpClient.HttpClient,
  endpoint: string,
  auth: { readonly key: string; readonly credential?: string },
) {
  return http
    .execute(
      HttpClientRequest.get(`${endpoint}/credentials`).pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.bearerToken(auth.key),
        HttpClientRequest.setHeaders(headers(auth.credential)),
      ),
    )
    .pipe(
      Effect.timeout(requestTimeout),
      Effect.mapError((cause) =>
        cause instanceof Error && cause.message
          ? new Error(cause.message)
          : new Error("Could not reach the ROKFOSS AI gateway"),
      ),
      Effect.flatMap((response) => {
        if (response.status < 200 || response.status >= 300) return failure(response)
        return HttpClientResponse.schemaBodyJson(CredentialList)(response).pipe(
          Effect.mapError(() => new Error("The ROKFOSS AI gateway returned an invalid subscription list")),
          Effect.map((body) => body.data),
        )
      }),
    )
}

/** Every gateway request carries the user agent the CDN requires and, when one is chosen, the subscription. */
function headers(credential: string | undefined) {
  return {
    "User-Agent": userAgent,
    ...(credential ? { [credentialHeader]: credential } : {}),
  }
}

/** Fails with the gateway's own `message` and the action its `code` implies, so the user sees why (spec 4). */
function failure(response: HttpClientResponse.HttpClientResponse) {
  return Effect.gen(function* () {
    const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
    const decoded = Option.getOrUndefined(decodeError(body))
    const error = decoded?.error
    const code = decoded?.code ?? (typeof error === "object" ? error?.code : undefined)
    const message =
      decoded?.message?.trim() ||
      (typeof error === "string" ? error.trim() : error?.message?.trim()) ||
      `ROKFOSS AI request failed (${response.status})`
    return yield* Effect.fail(new Error(describe(code, message)))
  })
}
