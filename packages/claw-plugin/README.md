# @openuidev/openclaw-os-plugin

> The [OpenClaw](https://github.com/openclaw/openclaw) plugin behind [OpenClaw OS](../../README.md). Bundles the workspace UI ([`@openuidev/claw-client`](../claw-client)) and serves it from the gateway at `http://<gateway>/plugins/openclawos` — no separate Next.js process, no tunnel, no settings dialog on first load.

Requires `openclaw >= 2026.4.12`.

## What it does

The plugin is a single OpenClaw extension that performs four roles:

1. **Serves the workspace UI.** Registers an HTTP route at `/plugins/openclawos` (via `api.registerHttpRoute`). The route serves the prebuilt static export of the workspace (Next.js `output: "export"`) bundled into the plugin's `static/` directory. Browser tabs load the UI from the gateway origin and connect back over the same-origin WebSocket — no CORS, no allowed-origins config, no tunnel.

2. **Augments agent prompts for OpenClaw OS sessions.** A `before_prompt_build` hook prepends the full inline-UI OpenUI Lang spec plus surface-routing guidance; a `before_tool_call` hook blocks `app_create` / `app_update` until the agent has `read` `skills/openui-app/SKILL.md` that session. Both are scoped by the session-key suffix `:openclaw-os`, so other clients (CLI, scripts, third-party apps) are unaffected. See "Two UI surfaces" below.

3. **Provides persistent UI primitives.** Lightweight stores for **apps**, **artifacts**, **notifications**, and **uploads** give agents addressable, persistent surfaces the workspace renders and updates across turns. See `app-store.ts`, `artifact-store.ts`, `notification-store.ts`, `upload-store.ts`.

4. **Registers the `openclaw os` CLI command group.** Via `api.registerCli`. The `os url` subcommand prints a token-authenticated workspace URL built from the gateway-validated config — same auth pattern as `openclaw dashboard`. Clipboard and browser-open are left to the calling shell so the plugin stays free of `child_process` (which would trip openclaw's install security scan).

## Two UI surfaces: one inlined, one loaded on demand (and gated)

The plugin teaches OpenUI Lang in two pieces, split by how often a turn needs each:

- **Inline UI** — one-shot UI in a chat reply (charts, tables, forms, follow-ups; static, no `$state`/`Query`/`Mutation`). Used by almost every visual answer, so the full spec ([`prompts/openui-inline-ui.md`](./prompts/openui-inline-ui.md), a `generate-prompt.ts` artifact — not a skill) is prepended verbatim to every OpenClaw OS system prompt.
- **Durable apps** — reopenable dashboards/trackers/command centers with the full reactive surface (`$state`, `Query`, `Mutation`, scheduled refresh, SQLite). Larger and needed by a minority of turns, so it stays a load-on-demand skill ([`skills/openui-app/SKILL.md`](./skills/openui-app/SKILL.md)). The model tends to call `app_create` without reading it, so a `before_tool_call` hook blocks `app_create` / `app_update` until the agent has `read` it that session (per-session set persisted to `<state-dir>/plugins/openclaw-os/app-skill-read-sessions.json`, so restarts don't force a re-read).

## Install

For end users, install OpenClaw OS via the installer script from the [root README](../../README.md#quick-start):

macOS or Linux:

```bash
curl -fsSL https://openui.com/openclaw-os/install.sh | bash
```

Windows:

```powershell
powershell -c "irm https://openui.com/openclaw-os/install.ps1 | iex"
```

or

```bash
openclaw plugins install @openuidev/openclaw-os-plugin
openclaw gateway restart
openclaw os url
```

### Opening the workspace

The workspace is served from your gateway — most likely `http://localhost:18789/plugins/openclawos`. For the pre-authenticated URL, run `openclaw os url`.

### From a local clone

```sh
# Build the workspace static export and copy it into ./static/
pnpm bundle-ui

# Build the plugin's own dist/ (esbuild bundle)
pnpm build

# Clear local node_modules before installing. pnpm's escaping symlinks trip
# openclaw's install scanner, and the bundled dist/ has no runtime deps.
# macOS or Linux: rm -rf node_modules
# Windows PowerShell: Remove-Item -Recurse -Force node_modules

# Install + reload, then open it
openclaw plugins install ./packages/claw-plugin --force
openclaw gateway restart
openclaw os url
```

If `~/.openclaw/openclaw.json` has a non-empty `plugins.allow` list, add `openclaw-os-plugin` to it. With an empty `plugins.allow` (allow-all) no action is needed; without pinning when an allow list is set, the gateway lazy-reloads the plugin on every tool lookup and `app_create` fails intermittently.

## Scripts

```sh
pnpm bundle-ui      # build claw-client and copy out/ → ./static/
pnpm build          # esbuild bundle src/index.ts → dist/index.js
pnpm lint:check     # ESLint
pnpm lint:fix       # ESLint --fix
pnpm format:check   # Prettier --check
pnpm format:fix     # Prettier --write
pnpm typecheck      # tsc --noEmit
pnpm test           # vitest run
pnpm ci             # lint + format + typecheck
```

## Project layout

```
packages/claw-plugin/
├── src/
│   ├── index.ts                # entrypoint: hooks (prompt + app-skill gate) + tools + RPC + HTTP route + CLI
│   ├── app-store.ts            # app primitive store
│   ├── artifact-store.ts       # artifact primitive store (SQLite-backed)
│   ├── lint-openui.ts          # validation for emitted OpenUI Lang
│   ├── notification-store.ts   # notification store
│   ├── upload-store.ts         # upload store
│   └── generated/              # generated assets — openui-schema.json (do not edit by hand)
├── prompts/
│   └── openui-inline-ui.md     # inline-UI OpenUI Lang spec — inlined into the system prompt (not a skill)
├── skills/
│   └── openui-app/SKILL.md     # durable-apps skill — loaded on demand, gated by app_create/app_update
├── generate-prompt.ts          # regenerates prompts/, skills/openui-app/, and src/generated/ from the OpenUI library
├── static/                     # workspace static export (gitignored, populated by `pnpm bundle-ui`)
├── dist/                       # esbuild output (generated by `pnpm build`)
├── openclaw.plugin.json        # plugin manifest
└── package.json
```

## Notes for plugin developers

- `openclaw` is in `peerDependencies` and `devDependencies`, never `dependencies`. The runtime gateway provides the module.
- Types come from subpath exports: `import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry"` and `from "openclaw/plugin-sdk/core"`. See [`AGENTS.md`](../../AGENTS.md) for the full guidance.
- The plugin ships compiled JS at `dist/index.js`, bundled by esbuild. `package.json` `main` and `openclaw.extensions` both point there. Older "jiti loads `.ts` directly" behavior was removed in openclaw 2026.5.x.
- Plugin RPCs and tools that share names with gateway-core surfaces (`artifacts.*`, `tools.invoke`) are namespaced under `openclawos.*` to avoid collision.
- `app_create` / `app_update` are gated by a `before_tool_call` hook (must `read` `skills/openui-app/SKILL.md` first; state in `<state-dir>/plugins/openclaw-os/app-skill-read-sessions.json`). The inline-UI spec (`prompts/openui-inline-ui.md`) is read at startup by `src/index.ts` and prepended via `before_prompt_build`. Both `:openclaw-os`-only. See "Two UI surfaces" above.
- The `static/` directory is treated as opaque content. The HTTP handler serves whatever is in there with sensible MIME types and a path-traversal guard. `pnpm bundle-ui` is the only thing that should write to it.
- For end-user setup story, architecture rationale, and what's still TODO, see [`docs/openclaw-os-bundling.md`](../../docs/openclaw-os-bundling.md).

## License

[MIT](../../LICENSE)
