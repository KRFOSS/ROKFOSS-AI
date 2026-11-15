# ROKFOSS OpenCode

This is a fork of [opencode](https://github.com/sst/opencode) with two additions:

- a **Korean interface for the TUI** (the terminal app), and
- the **ROKFOSS AI provider** (`rai`), so the console's own gateway can be used instead of a
  third-party subscription.

Everything else tracks upstream `dev`.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/KRFOSS/opencode/dev/install.sh | bash
```

The installer detects the platform, downloads the matching release asset, verifies it against
`SHA256SUMS`, and installs to `~/.opencode/bin`. Reopen the shell (or `exec $SHELL`) so `opencode`
is on `PATH`.

The script itself is developed on `dev`, so the `raw.githubusercontent.com` URL above is always the
current installer. Each release also carries a snapshot of it:
`https://github.com/KRFOSS/opencode/releases/latest/download/install.sh`.

```sh
# a specific release
curl -fsSL https://raw.githubusercontent.com/KRFOSS/opencode/dev/install.sh | bash -s -- --version v2.3.0-krfoss.1

# somewhere else on disk, without touching shell config
curl -fsSL https://raw.githubusercontent.com/KRFOSS/opencode/dev/install.sh | bash -s -- --dir ~/bin --no-modify-path
```

| Target | Asset |
| :--- | :--- |
| Linux x64 / arm64 | `opencode-linux-<arch>.tar.gz` (`-musl`, `-baseline` variants included) |
| macOS x64 / arm64 | `opencode-darwin-<arch>.zip` |
| Windows x64 / arm64 | `opencode-windows-<arch>.zip` |

<yellow>macOS and Windows builds are not signed or notarized.</yellow> The installer gives the macOS
binary an ad-hoc signature (`codesign --force --sign -`) and clears the quarantine flag; Windows may
show a SmartScreen warning because there is no code-signing certificate behind this fork.

## Korean interface

`/settings` → **Appearance** → **Language** → `한국어`, or set it in the terminal app's own
configuration file, `~/.config/opencode/cli.json`:

```json
{ "language": "ko" }
```

<yellow>It belongs in `cli.json`, not `opencode.json`.</yellow> The terminal app reads its settings (theme,
keybinds, tabs, language) from `cli.json`; `opencode.json` is the server-side configuration used for
models and providers, and a `language` key there has no effect. `/settings` writes `cli.json` for you.

No restart is needed. The dictionary lives in `packages/tui/src/i18n/ko.ts`; anything missing falls
back to English, so an upstream string that lands without a translation still renders.

## ROKFOSS AI provider

1. `/connect` → **ROKFOSS AI** → paste a `rai-…` key.
2. `/credentials` (aliases `/rai`) → pick a subscription or toggle high-speed output.

Web search uses that same key. Once RAI is connected, **ROKFOSS 검색** is registered as a search provider (it does not replace the model integration) and becomes the default unless another provider was already chosen. It calls `POST /tools/web_search` on the gateway; no Exa/Tavily key is required.

The model list comes from the gateway's `GET /models`; `rai.efforts` becomes model variants and is shown
as the gateway reports it. The gateway downgrades and then drops a step its upstream refuses, so the
client no longer sends probe requests of its own. High-speed output (`service_tier: "priority"`) is
sent for `codex` and `xai` models only — the gateway ignores it elsewhere.

The key never leaves the gateway: requests go to `https://project.krfoss.org` only. A `baseURL` in a
project's `opencode.json` is ignored, because merging that file would otherwise let a repository
redirect the key; only the user-level configuration, the system configuration and `RAI_BASE_URL` are
honoured.

Settings live under `providers.rai.settings`:

```json
{
  "providers": {
    "rai": {
      "settings": {
        "credential": "3"
      }
    }
  }
}
```

## Releases

`.github/workflows/release-fork.yml` builds every target, archives them, and attaches the archives,
`SHA256SUMS` and `install.sh` to a release. Run it from **Actions → release-fork → Run workflow**
(inputs: `targets` — `all` or a comma separated list, `tag`, `draft`).

Upstream's `.github/workflows/release.yml` is left untouched: it needs R2 credentials, signing
identities and self-hosted runners this fork does not have. The fork workflow deliberately lives in
its own file so an upstream release change never collides with it.

## Merging upstream

The fork keeps its changes in as few places as possible:

| Area | Where |
| :--- | :--- |
| Korean strings | `packages/tui/src/i18n/` (new directory) |
| Translated call sites | one `t("…")` per string plus one import per file |
| Language setting | one entry in `packages/tui/src/component/dialog-config.tsx` |
| Provider | `packages/ai/src/providers/rai.ts`, `packages/core/src/plugin/provider/rai.ts`, `packages/schema/src/rai.ts`, `packages/tui/src/component/dialog-rai.tsx` |
| Web search | `packages/core/src/plugin/websearch/rai.ts` (registered in `websearch/index.ts`, not via `WebSearchProvider.register`) |

`bun packages/tui/script/i18n-coverage.ts` reports strings that use `t()` without a translation and
unwrapped English candidates, which is the worklist after an upstream merge.

## Known issues

- Binaries from `v2.3.0-krfoss.1` report `v0.0.0-dev-1` from `opencode --version`, because that build
  did not pass `OPENCODE_VERSION`. The workflow now decides the tag in a `plan` job and stamps it
  into the build, and its smoke test fails if the binary reports anything else; the next release run
  picks that up.

## Fixed after v2.3.0-krfoss.2 (in `dev`, needs one more release run)

- **The provider did not load from a packaged binary.** Core resolves a provider package through the
  `builtins` map in `packages/core/src/provider.ts`, because the CLI is one bundled file and
  `import("@opencode/ai/providers/rai")` has nothing to resolve at runtime. The `rai` entry was
  missing, so a checkout worked (node_modules) and an installed binary failed with
  `Cannot initialize rai/<model>: Cannot find package '@opencode/ai'`. A test now asserts the entry
  exists, and a locally built binary was checked to load the provider with no `node_modules` nearby.
- **An installed fork was told to update to its own base version.** The update check asked upstream's
  service, which answers the plain `2.3.0`; semver sorts that above every `2.3.0-krfoss.<n>`, and
  accepting the update would have replaced the fork with an upstream build. A fork build now reads
  the newest tag from this repository's releases and downloads this fork's installer.
- **The gateway was buried in the provider list.** The model picker and `/connect` now rank ROKFOSS AI
  first; everything after it keeps upstream's order.
