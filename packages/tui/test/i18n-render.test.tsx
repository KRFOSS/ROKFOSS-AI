import { testRender } from "@opentui/solid"
import { afterEach, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import type { Dialog } from "@opencode/plugin/tui/context"
import { ConfigProvider } from "../src/config"
import { Keymap } from "../src/context/keymap"
import { ThemeProvider } from "../src/context/theme"
import { I18nProvider } from "../src/i18n/provider"
import { setLanguage } from "../src/i18n"
import { createDialogApi } from "../src/plugin/api"
import { DialogProvider, useDialog } from "../src/ui/dialog"
import { Toast, ToastProvider, useToast } from "../src/ui/toast"
import { permissionOptionLabel } from "../src/util/permission"
import { emptyThemeSource, tmpdir } from "./fixture/fixture"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

/**
 * These render the real dialog and toast surfaces rather than calling `t()` directly: the point of
 * translating at the shared renderers is that a component written in plain English comes out in
 * Korean without being touched, so the assertion has to go through a frame.
 */
async function mount(root: string, language: string) {
  const state = path.join(root, "state")
  await mkdir(state, { recursive: true })
  const dialog = Promise.withResolvers<Dialog>()
  const toast = Promise.withResolvers<ReturnType<typeof useToast>>()

  function Fixture() {
    dialog.resolve(createDialogApi(useDialog(), (render) => render()))
    toast.resolve(useToast())
    return null
  }

  const app = await testRender(
    () => (
      <TestTuiContexts directory={root} paths={{ home: root, state, worktree: root }}>
        <ConfigProvider config={createTuiResolvedConfig({ language })}>
          <I18nProvider>
            <Keymap.Provider>
              <ThemeProvider mode="dark" source={emptyThemeSource}>
                <ToastProvider>
                  <DialogProvider>
                    <Fixture />
                    <Toast />
                  </DialogProvider>
                </ToastProvider>
              </ThemeProvider>
            </Keymap.Provider>
          </I18nProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 80, height: 24, kittyKeyboard: true },
  )
  app.renderer.start()
  return { app, dialog: await dialog.promise, toast: await toast.promise }
}

// The active language is module state, so a test that leaves it on Korean would leak into the rest.
afterEach(() => setLanguage("en"))

test("a dialog written in English renders in Korean", async () => {
  await using tmp = await tmpdir()
  const { app, dialog } = await mount(tmp.path, "ko")
  try {
    void dialog.select({
      title: "Settings",
      options: [{ title: "New session", value: "new", category: "Session", footer: "off" }],
    })
    await app.waitForFrame((frame) => frame.includes("설정"))
    const frame = app.captureCharFrame()
    expect(frame).toContain("새 세션")
    expect(frame).toContain("끔")
    expect(frame).not.toContain("New session")
  } finally {
    app.renderer.destroy()
  }
})

test("English stays the default when no language is configured", async () => {
  await using tmp = await tmpdir()
  const { app, dialog } = await mount(tmp.path, "en")
  try {
    void dialog.select({ title: "Settings", options: [{ title: "New session", value: "new" }] })
    await app.waitForFrame((frame) => frame.includes("Settings"))
    expect(app.captureCharFrame()).toContain("New session")
  } finally {
    app.renderer.destroy()
  }
})

test("a toast raised by English copy reaches the screen translated", async () => {
  await using tmp = await tmpdir()
  const { app, toast } = await mount(tmp.path, "ko")
  try {
    toast.show({ title: "MCP servers", message: "No MCP servers", variant: "info" })
    await app.waitForFrame((frame) => frame.includes("MCP 서버"))
    expect(app.captureCharFrame()).toContain("MCP 서버")
  } finally {
    app.renderer.destroy()
  }
})

test("permission choices follow the active language", () => {
  setLanguage("ko")
  expect(permissionOptionLabel("once")).toBe("한 번만 허용")
  expect(permissionOptionLabel("reject")).toBe("거부")
  setLanguage("en")
  expect(permissionOptionLabel("once")).toBe("Allow once")
})
