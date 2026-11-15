import { createEffect, type ParentProps } from "solid-js"
import { useConfig } from "../config"
import { setLanguage } from "./index"

/**
 * Keeps the module-level language in step with the configured one.
 *
 * It sits inside `ConfigProvider` and reads the config store rather than taking a prop, so a
 * language change from `/settings` (or a hand edit of the config file, which the config watcher
 * reloads) switches the interface without a restart.
 */
export function I18nProvider(props: ParentProps) {
  const config = useConfig()

  createEffect(() => setLanguage(config.data.language))

  return props.children
}
