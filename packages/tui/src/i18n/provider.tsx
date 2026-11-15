import { createEffect, createMemo, type ParentProps } from "solid-js"
import { createUiI18n, UiI18nContext } from "@opencode/ui/context/i18n-core"
import { useConfig } from "../config"
import { setLanguage } from "./index"
import { uiSource } from "./ui"

/**
 * Keeps the module-level language in step with the configured one, and gives the shared session
 * components (turn rows, tool summaries) the same language.
 *
 * It sits inside `ConfigProvider` and reads the config store rather than taking a prop, so a
 * language change from `/settings` (or a hand edit of the config file, which the config watcher
 * reloads) switches the interface without a restart.
 *
 * The shared context is provided directly instead of through the kobalte-backed provider the desktop
 * app uses: that wrapper is JSX, and this package compiles JSX for the terminal renderer.
 */
export function I18nProvider(props: ParentProps) {
  const config = useConfig()
  const i18n = createMemo(() => createUiI18n(uiSource))

  createEffect(() => setLanguage(config.data.language))

  return <UiI18nContext.Provider value={i18n()}>{props.children}</UiI18nContext.Provider>
}
