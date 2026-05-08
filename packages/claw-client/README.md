# @openuidev/claw-client

> The workspace UI for [OpenClaw OS](../../README.md). A Next.js app that connects to an [OpenClaw](https://github.com/openclaw/openclaw) gateway and renders agent responses as live, interactive components using the [OpenUI](https://openui.com) React renderer.

In a normal install the workspace is statically exported and bundled into [`@openuidev/openclaw-os-plugin`](../claw-plugin), then served from your gateway at `http://<gateway>/plugins/openclawos`. This package is the source for that UI — most users will never need to run it directly.

## Features

- **Streaming chat surface** — renders OpenUI Lang components progressively as the LLM emits tokens.
- **Multi-agent sidebar** — every agent the gateway exposes appears as its own thread.
- **Apps, artifacts, notifications** — persistent UI primitives stored by the plugin and surfaced in the workspace.
- **Mobile + desktop** — the same workspace works on a phone, tablet, or laptop.
- **Same-origin auth** — when served from the plugin, the workspace inherits the gateway's auth and connects over the same-origin WebSocket. No CORS, no manual settings dialog.
- **Tailwind 3 + Radix** — styling and primitives.
- **Cloudflare-deployable** — also builds with [`@opennextjs/cloudflare`](https://opennext.js.org/cloudflare), so the same Next.js app can run on Workers + KV when needed.

## Tech stack

| | |
|---|---|
| Framework | Next.js 16 (App Router, React 19) |
| Styling | Tailwind CSS 3 + `@tailwindcss/typography` + Radix UI |
| OpenUI runtime | `@openuidev/react-lang`, `@openuidev/react-ui`, `@openuidev/react-headless` |
| Search | `fuse.js`, `cmdk` |
| Crypto | `@noble/ed25519`, `@noble/hashes` (gateway auth) |
| Optional deploy target | Cloudflare Workers via `@opennextjs/cloudflare` |
| TypeScript | Strict mode, root tsconfig with `noUncheckedIndexedAccess` |

## Local development

You only need this flow if you're working on the workspace UI itself. End users get the bundled UI through the plugin.

From the repo root:

```bash
pnpm install
```

Then in this package:

```bash
pnpm dev      # Next.js dev server on http://localhost:18790
```

You will also need an OpenClaw gateway running with [`@openuidev/openclaw-os-plugin`](../claw-plugin) installed. See the [root README](../../README.md#quick-start) for end-to-end setup.

### Connecting to a gateway

When running standalone (not served from the plugin), the workspace cannot infer auth from the origin:

1. Open http://localhost:18790
2. Open **Settings**
3. Paste your gateway URL (e.g. `ws://localhost:18789` or `wss://your-gateway.example.com/ws`) and auth token from `~/.openclaw/openclaw.json`
4. Pick an agent from the sidebar and start chatting

To get a pre-authenticated URL straight from the gateway, run `openclaw os url` (registered by the plugin).

## Scripts

```bash
pnpm dev          # Next.js dev server (port 18790)
pnpm build        # Next.js production build (static export consumed by the plugin)
pnpm start        # serve the production build (port 18790)
pnpm lint:check   # ESLint
pnpm lint:fix     # ESLint --fix
pnpm format:check # Prettier --check
pnpm format:fix   # Prettier --write
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest run
pnpm ci           # lint + format + typecheck + build
```

## Project layout

```
src/
├── app/              # Next.js App Router pages and route handlers
├── components/       # React components (chat surface, sidebar, settings, artifacts, ...)
├── lib/              # Gateway client, hooks, chat engine, command handlers
└── types/            # Shared TypeScript interfaces (threads, gateway protocol)
```

The gateway protocol types are inlined into `src/lib/gateway/types.ts` because OpenClaw does not export them publicly. There is a comment in the file pointing back to the upstream source. See [`AGENTS.md`](../../AGENTS.md#gateway-protocol-types-browser-clients) for the rationale.

## Deployment

In the standard OpenClaw OS install, this package is built once and bundled into `@openuidev/openclaw-os-plugin/static/` — the gateway serves it directly. No separate deploy is required.

If you want to host the workspace independently (for example on Cloudflare Workers), this package is also configured for [`@opennextjs/cloudflare`](https://opennext.js.org/cloudflare) (see `next.config.ts`, `open-next.config.ts`, `wrangler.jsonc`):

```bash
pnpm exec opennextjs-cloudflare build
pnpm exec opennextjs-cloudflare deploy
```

## Troubleshooting

- **Settings won't save** — the standalone build persists settings to `localStorage`. Make sure third-party storage is enabled in your browser.
- **Gateway connection fails** — verify the URL is reachable and the auth token is valid. `openclaw os url` (from the plugin) prints a known-good URL with the token already attached.
- **Agent responds in plain text** — confirm `@openuidev/openclaw-os-plugin` is installed in the gateway and that the gateway has been restarted since install.

## License

[MIT](../../LICENSE)
