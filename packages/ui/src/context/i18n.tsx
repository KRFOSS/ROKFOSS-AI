import type { ParentProps } from "solid-js"
import { I18nProvider } from "@kobalte/core/i18n"
import { createUiI18n, UiI18nContext, type UiI18nSource } from "./i18n-core"

export * from "./i18n-core"

function UiI18nProvider(props: ParentProps<{ value: UiI18nSource }>) {
  const value = createUiI18n(props.value)

  return (
    <I18nProvider locale={(value.layoutLocale ?? value.locale)()}>
      <UiI18nContext.Provider value={value}>{props.children}</UiI18nContext.Provider>
    </I18nProvider>
  )
}

export { UiI18nProvider as I18nProvider }
