# @openuidev/openclaw-os-plugin

> The [OpenClaw](https://github.com/openclaw/openclaw) plugin behind [OpenClaw OS](../../README.md). Bundles the workspace UI ([`@openuidev/claw-client`](../claw-client)) and serves it from the gateway at `http://<gateway>/plugins/openclawos` — no separate Next.js process, no tunnel, no settings dialog on first load.

Requires `openclaw >= 2026.4.12`.

## What it does

The plugin is a single OpenClaw extension that performs four roles:

1. **Serves the workspace UI.** Registers an HTTP route at `/plugins/openclawos` (via `api.registerHttpRoute`). The route serves the prebuilt static export of the workspace (Next.js `output: "export"`) bundled into the plugin's `static/` directory. Browser tabs load the UI from the gateway origin and connect back over the same-origin WebSocket — no CORS, no allowed-origins config, no tunnel.

2. **Augments agent prompts for OpenClaw OS sessions.** Registers a `before_prompt_build` hook. For each agent run originating from the workspace it prepends a small OpenUI Lang system prompt — roughly 100–200 tokens, just enough to point the model at the available skills. Detection uses the session-key suffix `:openclaw-os`, so runs from other clients (CLI, scripts, third-party apps) are unaffected.

3. **Provides persistent UI primitives.** Lightweight stores for **apps**, **artifacts**, **notifications**, and **uploads** give agents addressable, persistent surfaces the workspace renders and updates across turns. See `app-store.ts`, `artifact-store.ts`, `notification-store.ts`, `upload-store.ts`.

4. **Registers the `openclaw os` CLI command group.** Via `api.registerCli`. The `os url` subcommand prints a token-authenticated workspace URL built from the gateway-validated config — same auth pattern as `openclaw dashboard`. Clipboard and browser-open are left to the calling shell so the plugin stays free of `child_process` (which would trip openclaw's install security scan).

## Skills, not a bloated system prompt

The system prompt the plugin injects is intentionally thin. It does not contain the full OpenUI Lang reference, the component library, or the app-authoring guide.

Instead, the plugin ships two **skills** at `skills/`:

| Skill | Purpose |
| :--- | :--- |
| [`openui-inline-ui`](./skills/openui-inline-ui/SKILL.md) | One-shot UI inside a chat reply — charts, tables, forms, follow-ups, multi-section reports. Static (no `$state`, no `Query`). |
| [`openui-app`](./skills/openui-app/SKILL.md) | Durable apps the user reopens — dashboards, trackers, command centers. Full reactive surface: `$state`, `Query`, `Mutation`, scheduled refresh, persistent SQLite. |

The initial prompt only carries each skill's name and one-line description. The LLM loads a skill's full body on demand, when it actually needs to render UI or build an app — so the base context stays small and turns that don't touch UI generation pay no token tax.

## Install

For end users, install OpenClaw OS via the installer script from the [root README](../../README.md#quick-start):

```sh
curl -fsSL https://openui.com/openclaw-os/install.sh | bash
```

### From a local clone

```sh
# Build the workspace static export and copy it into ./static/
pnpm bundle-ui

# Build the plugin's own dist/ (esbuild bundle)
pnpm build

# Clear local node_modules. pnpm's escaping symlinks trip openclaw's
# install scanner, and the bundled dist/ has no runtime deps to install.
rm -rf node_modules

# Install + reload
openclaw plugins install ./packages/claw-plugin --force
openclaw gateway restart
```

If `~/.openclaw/openclaw.json` has a non-empty `plugins.allow` list, add `openclaw-os-plugin` to it. With an empty `plugins.allow` (allow-all) no action is needed; without pinning when an allow list is set, the gateway lazy-reloads the plugin on every tool lookup and `app_create` fails intermittently.

Open the workspace at `http://localhost:18789/plugins/openclawos`. Paste the gateway URL (`ws://localhost:18789`) and the auth token from `~/.openclaw/openclaw.json` into the Settings dialog on first load.

### Skipping the settings dialog

To skip the dialog and get a pre-authenticated URL (token in the fragment, mirrors `openclaw dashboard`), use the CLI subcommand the plugin registers:

```sh
openclaw os url        # prints the setup URL with auth to stdout
```

This reads the gateway-validated config directly, so it survives `--dev` / `--profile` flags and is the recommended path for installers and onboarding scripts.

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
│   ├── index.ts                # entrypoint: hook + tools + RPC + HTTP route + CLI
│   ├── app-store.ts            # app primitive store
│   ├── artifact-store.ts       # artifact primitive store (SQLite-backed)
│   ├── lint-openui.ts          # validation for emitted OpenUI Lang
│   ├── notification-store.ts   # notification store
│   ├── upload-store.ts         # upload store
│   └── generated/              # generated prompt assets (do not edit by hand)
├── skills/
│   ├── openui-app/SKILL.md          # durable apps skill (loaded on demand)
│   └── openui-inline-ui/SKILL.md    # inline UI skill (loaded on demand)
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
- The `static/` directory is treated as opaque content. The HTTP handler serves whatever is in there with sensible MIME types and a path-traversal guard. `pnpm bundle-ui` is the only thing that should write to it.
- For end-user setup story, architecture rationale, and what's still TODO, see [`docs/openclaw-os-bundling.md`](../../docs/openclaw-os-bundling.md).

## License

[MIT](../../LICENSE)
