import type { ConnectionInfo } from "@opencode/client"
import { define } from "@opencode/plugin/effect/plugin"
import { Rai } from "@opencode/schema/rai"
import { Duration, Effect, FiberSet, Option, Schema, Schedule, Semaphore, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { Integration } from "../../integration.js"
import { IntegrationConnection } from "../../integration/connection.js"
import { Model } from "../../model.js"
import { Provider } from "../../provider.js"
import type { PluginInternal } from "../internal.js"
import { configuredSettings } from "./configured.js"
import { activeCredential } from "./credential-settings.js"
import { ProviderRefresh } from "./refresh.js"

const providerID = Provider.ID.make("rai")
const integrationID = Integration.ID.make("rai")
const packageName = "@opencode/ai/providers/rai"
const defaultBaseURL = "https://project.krfoss.org/api/rai/v1"
const credentialHeader = "X-RAI-Credential"
// The gateway answers `403` with an HTML page to every other user agent, so this must contain `ROKFOSS`.
const userAgent = "ROKFOSS-CLI/v0.1 (opencode-rai)"
// The gateway's model list is small; a remote host that never answers must not hold the refresh.
const requestTimeout = Duration.seconds(15)
// The gateway's catalogue changes rarely; a background refresh keeps a new model from waiting for a restart.
const interval = Duration.minutes(30)
// Responses accepts reasoning without server-side storage only when the encrypted content comes back.
const reasoningInclude = ["reasoning.encrypted_content"]
// The subscription choice and the high-speed switch are the user's, not the config file's, once they pick one.
const preferencesKey = "rai-preferences"
// What was learned about one subscription's reasoning steps, so a rejected step is asked about only once.
const effortPrefix = "rai-efforts:"
const effortTimeout = Duration.seconds(20)
/**
 * Steps the gateway advertises but the upstream may still refuse. Live, `ultra` answers `400` on every codex model, so a
 * step in this set is offered only after it has answered `200`; everything else in `rai.efforts` is trusted as listed.
 */
const probedEfforts = new Set(["ultra"])
const probeConcurrency = 2

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
/** Gateway errors answer `{ message }`, sometimes wrapped as `{ error: { message } }`. */
const ErrorBody = Schema.Struct({
  message: Schema.optional(Schema.String),
  error: Schema.optional(
    Schema.Union([Schema.String, Schema.Struct({ message: Schema.optional(Schema.String) })]),
  ),
})
const decodeError = Schema.decodeUnknownOption(Schema.fromJsonString(ErrorBody))
const Preferences = Schema.Struct({ ownerID: Schema.NullOr(Schema.Int), fast: Schema.Boolean })
const decodePreferences = Schema.decodeUnknownOption(Preferences)
const EffortCache = Schema.Record(Schema.String, Schema.Boolean)
const decodeEffortCache = Schema.decodeUnknownOption(EffortCache)

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

/** A config-file owner id as the number the cache uses; an opaque value still rides on requests, but shares the own-quota cache. */
function numericOwner(value: string | undefined) {
  if (value === undefined) return undefined
  const id = Number(value)
  return Number.isFinite(id) && id > 0 ? Math.trunc(id) : undefined
}

/** The API root, without a trailing slash. Config overrides the gateway default. */
export function baseURLOf(settings: Provider.Settings | undefined) {
  const value = typeof settings?.baseURL === "string" ? settings.baseURL.trim() : ""
  return (value === "" ? defaultBaseURL : value).replace(/\/+$/, "")
}

/** Whether an advertised step may be offered. `undefined` means "not checked yet", which hides a probed step. */
export type EffortSupport = (modelID: string, effort: string) => boolean | undefined

/** The advertised steps of one entry, trimmed, without blanks. */
function advertisedEfforts(entry: RaiModel | undefined) {
  return (entry?.rai?.efforts ?? []).map((effort) => effort.trim()).filter((effort) => effort !== "")
}

/** The cache key of one step: the model, the steps the gateway listed with it, and the step itself. */
function effortKey(modelID: string, advertised: readonly string[], effort: string) {
  return `${[modelID, ...advertised].join("|")}|${effort}`
}

/**
 * The gateway's inventory as provider models. Reasoning steps become variants, so the step picker offers exactly the
 * efforts this model supports; a model without `efforts` keeps no variants, which hides the picker.
 *
 * `options.effort` filters the steps: a step the gateway's own upstream rejected is dropped, and a probed step stays
 * hidden until it has answered once. `options.fast` turns on high-speed output for every request of the model.
 */
export function toModels(
  endpoint: string,
  entries: readonly RaiModel[],
  options: { readonly fast?: boolean; readonly effort?: EffortSupport } = {},
): Model.Info[] {
  return entries.map((entry) => {
    const id = Model.ID.make(entry.id)
    const advertised = advertisedEfforts(entry)
    const efforts = advertised.filter((effort) => {
      const support = options.effort?.(entry.id, effort)
      if (support === false) return false
      // The gateway lists steps the upstream refuses, so an unproven probed step is not offered.
      return !probedEfforts.has(effort) || support === true
    })
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
        // High-speed output is a `service_tier` the protocol forwards as-is; the gateway accepts only `priority`.
        ...(options.fast ? { serviceTier: "priority" } : {}),
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

export const RaiPlugin = define({
  id: "opencode.provider.rai",
  effect: Effect.fn(function* (ctx) {
    const http = yield* HttpClient.HttpClient
    // Captured so an RPC handler (which may not require services) can still publish through the provider transform.
    const providerService = yield* Provider.Service
    // Captured so a background probe can outlive the refresh that started it without making refresh scoped.
    const scope = yield* Effect.scope
    // Read here and refreshed on `config.updated`: the provider transform below is synchronous.
    const settings = { current: yield* configuredSettings(providerID) }
    // A stored choice outlives a restart, so the dialog only writes to storage; the config file stays the fallback.
    const preferences = {
      current: Option.getOrUndefined(decodePreferences(yield* ctx.storage.get(preferencesKey))) ?? {
        ownerID: null as number | null,
        fast: false,
      },
    }
    /** Learned answers for every subscription used in this process, keyed `owner|model|advertised steps|step`. */
    const learned = new Map<string, boolean>()
    /** Subscriptions whose stored answers were already read into `learned`. */
    const loadedOwners = new Set<number>()
    /** Steps asked about in this process, so an unreachable gateway is not asked again on every refresh. */
    const attempted = new Set<string>()
    const credentials = { current: [] as Rai.Credential[], error: null as string | null }
    /** The hash of what the provider list currently reflects, so an unchanged refresh publishes nothing. */
    let published = ""

    /** The subscription the config file names, if the dialog has not picked one. */
    const configuredOwner = () => subscription(settings.current?.credential)
    /** The numeric subscription the cache and the dialog use; 0 is the account's own quota. */
    const ownerID = () => preferences.current.ownerID ?? numericOwner(configuredOwner())
    /** The header value for the subscription in play; `undefined` keeps the request on the account's own quota. */
    const ownerHeader = () => {
      if (preferences.current.ownerID !== null)
        return preferences.current.ownerID === 0 ? undefined : String(preferences.current.ownerID)
      return configuredOwner()
    }

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
      const endpoint = baseURLOf(settings.current)
      const key = credential?.type === "key" ? credential.key : undefined
      const report = (status: IntegrationConnection.Status | undefined) =>
        connection ? ctx.integration.connection.status({ integrationID: "rai", connection, status }) : Effect.void
      if (!key) {
        yield* report(undefined)
        credentials.current = []
        credentials.error = null
        return { connection, baseURL: endpoint, connected: false } satisfies Discovered
      }
      const auth = { key, credential: ownerHeader() }
      const listed = yield* listModels(http, endpoint, auth).pipe(
        Effect.map((entries) => ({ entries })),
        Effect.catch((error) => Effect.succeed({ error })),
      )
      // The subscription list is a convenience: a failure here must not hide models the key can still use.
      const shared = yield* listCredentials(http, endpoint, auth).pipe(
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
          baseURL: endpoint,
          connected: true,
          models: same ? previous.models : undefined,
        } satisfies Discovered
      }
      yield* report(undefined)
      return { connection, baseURL: endpoint, connected: true, models: listed.entries } satisfies Discovered
    })

    /** Reads the answers stored for one subscription so a restart does not ask the gateway again. */
    const remember = Effect.fn("RaiPlugin.remember")(function* (owner: number) {
      if (loadedOwners.has(owner)) return
      loadedOwners.add(owner)
      const stored = Option.getOrUndefined(decodeEffortCache(yield* ctx.storage.get(effortPrefix + owner)))
      for (const [key, supported] of Object.entries(stored ?? {})) learned.set(`${owner}|${key}`, supported)
    })

    /** Set right after `refresh` exists: `learn` asks for a republish through it, which keeps the two out of a cycle. */
    const republish: { current: () => Effect.Effect<void, never, Provider.Service> } = {
      current: () => Effect.void,
    }

    /** What the provider list was built from, including the learned steps a variant list depends on. */
    const digest = (owner: number) =>
      JSON.stringify(
        [...learned.entries()]
          .filter(([key]) => key.startsWith(`${owner}|`))
          .sort(([left], [right]) => left.localeCompare(right)),
      )

    // The loop keeps the inventory current on a timer, and a connection change refreshes at once.
    const refresh = Effect.fn("RaiPlugin.refresh")(function* () {
      const next = yield* lock.withPermit(load())
      const owner = ownerID() ?? 0
      yield* remember(owner)
      const hash = JSON.stringify([
        next.baseURL,
        next.models,
        IntegrationConnection.key(next.connection),
        owner,
        preferences.current.fast,
        digest(owner),
      ])
      if (hash === published) return
      published = hash
      discovered.current = next
      yield* ctx.provider.reload()
      // Learning what the gateway really runs happens after the catalogue is published, so it never delays startup.
      if (settings.current?.verifyEfforts !== false && next.models?.length && next.baseURL)
        yield* learn(next).pipe(Effect.forkIn(scope))
    })

    /** The steps worth asking about: advertised, probed, and neither answered nor attempted yet. */
    const pending = (owner: number, entries: readonly RaiModel[]) =>
      entries.flatMap((entry) => {
        const advertised = advertisedEfforts(entry)
        const steps = advertised.filter((effort) => probedEfforts.has(effort))
        if (steps.length === 0) return []
        return steps
          .map((effort) => ({ modelID: entry.id, effort, key: `${owner}|${effortKey(entry.id, advertised, effort)}` }))
          .filter((target) => !attempted.has(target.key) && !learned.has(target.key))
      })

    /**
     * Asks the gateway about each pending step once. A `200` proves it and a `400` is the gateway refusing it; any other
     * answer (an outage, a rate limit, a timeout) proves nothing, so this process leaves it for a later run.
     */
    const learn = Effect.fn("RaiPlugin.learn")(function* (next: Discovered, publish = true) {
      const owner = ownerID() ?? 0
      yield* remember(owner)
      const targets = pending(owner, next.models ?? [])
      const endpoint = next.baseURL
      if (targets.length === 0 || !endpoint) return
      const { credential } = yield* activeCredential(ctx, "rai")
      const key = credential?.type === "key" ? credential.key : undefined
      if (!key) return
      for (const target of targets) attempted.add(target.key)
      const results = yield* Effect.forEach(
        targets,
        (target) =>
          probeEffort(http, endpoint, { key, credential: ownerHeader() }, target.modelID, target.effort).pipe(
            Effect.map((supported) => ({ target, supported })),
            Effect.catch(() => Effect.succeed({ target, supported: undefined })),
          ),
        { concurrency: probeConcurrency },
      )
      let learnedAny = false
      for (const result of results) {
        if (result.supported === undefined) continue
        learned.set(result.target.key, result.supported)
        learnedAny = true
      }
      if (!learnedAny) return
      yield* ctx.storage.set(effortPrefix + owner, storedFor(owner, learned))
      // The variants the picker shows changed, so publish the catalogue again.
      if (publish) yield* republish.current()
    })
    republish.current = () => refresh()

    yield* refresh().pipe(Effect.repeat(Schedule.spaced(interval)), Effect.forkScoped)
    // Event handlers start a refresh without waiting on it, so a slow gateway doesn't hold up the next event.
    const background = yield* FiberSet.make()
    yield* ProviderRefresh.onSwitch("rai", FiberSet.run(background, refresh()))

    /** What a dialog renders; every RPC method answers this so one reply is enough. */
    const snapshot = Effect.fn("RaiPlugin.snapshot")(function* () {
      const loaded = discovered.current
      const owner = ownerID() ?? 0
      yield* remember(owner)
      const efforts: Rai.Effort[] = (loaded.models ?? []).flatMap((entry) => {
        const advertised = advertisedEfforts(entry)
        return advertised
          .filter((effort) => probedEfforts.has(effort))
          .filter((effort) => learned.has(`${owner}|${effortKey(entry.id, advertised, effort)}`))
          .map((effort) => ({
            modelID: entry.id,
            effort,
            supported: learned.get(`${owner}|${effortKey(entry.id, advertised, effort)}`) === true,
          }))
      })
      return {
        connected: loaded.connected === true,
        ownerID: preferences.current.ownerID,
        fast: preferences.current.fast,
        credentials: credentials.current,
        efforts,
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
        verify: () =>
          Effect.gen(function* () {
            // Forget every subscription's answers; the next load asks again with whatever the gateway lists now.
            const stored = yield* ctx.storage.scan({ prefix: effortPrefix, limit: 100 })
            yield* Effect.forEach(stored.entries, (entry) => ctx.storage.remove(entry.key), { discard: true })
            learned.clear()
            loadedOwners.clear()
            attempted.clear()
            // Probe before answering, so the dialog can report what this pass actually checked.
            const next = yield* lock.withPermit(load())
            yield* learn(next, false)
            yield* refresh()
            return yield* snapshot()
          }).pipe(Effect.provideService(Provider.Service, providerService)),
      })
      .pipe(Effect.orDie)

    yield* ctx.provider.transform((providers) => {
      const loaded = discovered.current
      const endpoint = loaded.baseURL ?? baseURLOf(settings.current)
      const credential = ownerHeader()
      providers.update(providerID, (provider) => {
        provider.name = "ROKFOSS AI"
        provider.package = packageName
        // Availability follows the connection, as it does for every other integration provider.
        provider.integrationID = integrationID
        provider.settings = Provider.mergeOverlay(provider.settings, { baseURL: endpoint, provider: "rai" })
        // A subscription rides on every request of this provider; "0" and blanks mean the account's own quota.
        const next = { ...provider.headers }
        for (const name of Object.keys(next))
          if (name.toLowerCase() === credentialHeader.toLowerCase()) delete next[name]
        if (credential) next[credentialHeader] = credential
        provider.headers = Object.keys(next).length > 0 ? next : undefined
      })
      const item = providers.get(providerID)
      if (!item || !loaded.models || !loaded.baseURL) return
      const owner = ownerID() ?? 0
      const models = loaded.models
      providers.add({
        info: item.provider,
        models: toModels(loaded.baseURL, models, {
          fast: preferences.current.fast,
          effort: (modelID, effort) => {
            const entry = models.find((candidate) => candidate.id === modelID)
            return learned.get(`${owner}|${effortKey(modelID, advertisedEfforts(entry), effort)}`)
          },
        }),
        sourceConnection: loaded.connection,
      })
    })

    // A changed base URL or subscription changes both the discovery request and the headers of later requests.
    yield* ctx.event.subscribe({ types: ["config.updated"] }).pipe(
      Stream.runForEach(() =>
        Effect.gen(function* () {
          const next = yield* configuredSettings(providerID)
          if (
            baseURLOf(next) === baseURLOf(settings.current) &&
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

/** The learned answers of one subscription, without the owner prefix the in-memory map carries. */
function storedFor(owner: number, learned: ReadonlyMap<string, boolean>) {
  return Object.fromEntries(
    [...learned.entries()]
      .filter(([key]) => key.startsWith(`${owner}|`))
      .map(([key, supported]) => [key.slice(String(owner).length + 1), supported]),
  )
}

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

/**
 * Asks for one reasoning step with a one-word prompt: `200` proves the upstream accepts it, `400` is the gateway
 * refusing it, and anything else (an outage, a rate limit, a timeout) proves nothing.
 */
function probeEffort(
  http: HttpClient.HttpClient,
  endpoint: string,
  auth: { readonly key: string; readonly credential?: string },
  modelID: string,
  effort: string,
) {
  return http
    .execute(
      HttpClientRequest.post(`${endpoint}/responses`).pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.bearerToken(auth.key),
        HttpClientRequest.setHeaders(headers(auth.credential)),
        HttpClientRequest.bodyJsonUnsafe({
          model: modelID,
          input: "hi",
          reasoning: { effort },
          include: reasoningInclude,
          store: false,
          stream: false,
        }),
      ),
    )
    .pipe(
      Effect.timeout(effortTimeout),
      Effect.map((response) => (response.status === 200 ? true : response.status === 400 ? false : undefined)),
    )
}

/** Every gateway request carries the user agent the CDN requires and, when one is chosen, the subscription. */
function headers(credential: string | undefined) {
  return {
    "User-Agent": userAgent,
    ...(credential ? { [credentialHeader]: credential } : {}),
  }
}

/** Fails with the gateway's own `message`, so the user sees why the key was rejected. */
function failure(response: HttpClientResponse.HttpClientResponse) {
  return Effect.gen(function* () {
    const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
    const decoded = Option.getOrUndefined(decodeError(body))
    const error = decoded?.error
    const message =
      decoded?.message?.trim() ||
      (typeof error === "string" ? error.trim() : error?.message?.trim()) ||
      `ROKFOSS AI request failed (${response.status})`
    return yield* Effect.fail(new Error(message))
  })
}
