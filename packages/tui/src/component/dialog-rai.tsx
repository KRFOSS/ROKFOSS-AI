import { Option, Schema } from "effect"
import { createMemo, createSignal, onMount, Show } from "solid-js"
import { Rai } from "@opencode/schema/rai"
import type { JsonValue } from "@opencode/client"
import { useClient } from "../context/client"
import { useData } from "../context/data"
import { useLocation } from "../context/location"
import { useTheme } from "../context/theme"
import { t } from "../i18n"
import { DIALOG_LIST_INSET } from "../ui/dialog"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useToast } from "../ui/toast"

const rpcID = "opencode.rai"
const decodeSettings = Schema.decodeUnknownOption(Rai.Settings)

export function DialogRai() {
  const client = useClient()
  const data = useData()
  const location = useLocation()
  const theme = useTheme().surface("dialog")
  const toast = useToast()
  const [settings, setSettings] = createSignal<Rai.Settings>()
  const [loading, setLoading] = createSignal(true)
  const [saving, setSaving] = createSignal(false)
  const directory = location.current?.directory ?? data.location.default().directory

  // Every method answers the full snapshot, so one call both changes a setting and refreshes the list.
  async function call(method: "refresh" | "select" | "setFast", input: Record<string, JsonValue> = {}) {
    const result = await client.api.rpc.call({ rpcID, method, input, location: { directory } })
    const next = Option.getOrUndefined(decodeSettings(result.output))
    if (!next) throw new Error(`ROKFOSS AI returned no settings for ${method}`)
    setSettings(next)
    return next
  }

  onMount(() =>
    void call("refresh")
      .catch(toast.error)
      .finally(() => setLoading(false)),
  )

  async function choose(credential: Rai.Credential) {
    if (saving()) return
    setSaving(true)
    await call("select", { ownerID: credential.ownerID })
      .then(() =>
        toast.show({
          variant: "success",
          message: t("Using subscription {{label}}", { label: credential.label }),
        }),
      )
      .catch(toast.error)
      .finally(() => setSaving(false))
  }

  async function toggleFast() {
    const current = settings()
    if (!current || saving()) return
    setSaving(true)
    await call("setFast", { enabled: !current.fast })
      .then((next) =>
        toast.show({
          variant: "success",
          message: next.fast ? t("High-speed output enabled") : t("High-speed output disabled"),
        }),
      )
      .catch(toast.error)
      .finally(() => setSaving(false))
  }

  const options = createMemo<DialogSelectOption<string>[]>(() => {
    const current = settings()
    if (!current?.connected) return []
    return [
      ...current.credentials.map((credential) => ({
        value: `subscription:${credential.ownerID}`,
        title: credential.label,
        category: t("Subscription"),
        footer: credential.providers.join(", "),
        // The checkmark marks the subscription later requests spend from, as the integration dialog does.
        gutter:
          current.ownerID === credential.ownerID
            ? () => <text fg={theme.text.feedback.success.base}>✓</text>
            : undefined,
        onSelect: () => void choose(credential),
      })),
      {
        value: "fast",
        title: t("High-speed output"),
        category: t("Options"),
        /* Only the codex and xai upstreams accept the tier; the gateway leaves every other provider at its own. */
        description: t("Applies to codex and xai models only."),
        footer: current.fast ? t("on") : t("off"),
        onSelect: () => void toggleFast(),
      },
    ]
  })

  const hint = createMemo(() => {
    const current = settings()
    if (current) return current.connected ? t("No subscriptions available") : t("Connect a ROKFOSS AI key first.")
    return loading() ? t("Loading ROKFOSS AI settings…") : t("Could not load ROKFOSS AI settings.")
  })

  return (
    <DialogSelect<string>
      title={t("ROKFOSS AI settings")}
      options={options()}
      renderFilter={options().length > 0}
      emptyView={
        <box paddingLeft={DIALOG_LIST_INSET} paddingRight={DIALOG_LIST_INSET} flexDirection="column">
          <text fg={theme.text.muted} wrapMode="word">
            {hint()}
          </text>
          <Show when={settings()?.connected === false}>
            <text fg={theme.text.muted} wrapMode="word">
              {t("Run /connect and add ROKFOSS AI.")}
            </text>
          </Show>
        </box>
      }
      footer={
        <Show when={settings()?.error}>
          {(message) => (
            <text fg={theme.text.feedback.error.base} wrapMode="word">
              {message()}
            </text>
          )}
        </Show>
      }
    />
  )
}
