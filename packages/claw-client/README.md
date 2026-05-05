# @openuidev/claw-client

> Next.js web client that connects to an [OpenClaw](https://github.com/openclaw/openclaw) gateway and renders agent responses as live, interactive UI using the [OpenUI](https://openui.com) React renderer.

This is the browser side of [OpenClaw OS](../../README.md). The other half is the server-side [`@openuidev/openclaw-os-plugin`](../claw-plugin), which injects the OpenUI Lang system prompt into agent runs.

<!-- Add screenshot / gif here:
<div align="center">
  <img src="./public/screenshot.png" alt="Claw client chat surface" width="100%" />
</div>
-->

## Features

- **Streaming chat surface** — renders OpenUI Lang components progressively as the LLM emits tokens.
- **Multi-agent sidebar** — every agent the gateway exposes appears as its own thread.
- **Artifacts, apps, notifications** — persistent UI primitives stored by the plugin and surfaced in the client.
- **Settings dialog** — paste your gateway URL and auth token; everything is stored locally in the browser.
- **Tailwind 3 + Radix** — styling and primitives.
- **Cloudflare-deployable** — built with [`@opennextjs/cloudflare`](https://opennext.js.org/cloudflare) so the same Next.js app can run on Workers + KV.

## Tech stack

| | |
|---|---|
| Framework | Next.js 16 (App Router, React 19) |
| Styling | Tailwind CSS 3 + `@tailwindcss/typography` + Radix UI |
| OpenUI runtime | `@openuidev/react-lang`, `@openuidev/react-ui`, `@openuidev/react-headless` |
| Search | `fuse.js`, `cmdk` |
| Crypto | `@noble/ed25519`, `@noble/hashes` (for gateway auth) |
| Deploy target | Cloudflare Workers via `@opennextjs/cloudflare` |
| TypeScript | Strict mode, root tsconfig with `noUncheckedIndexedAccess` |

## Local development

From the repo root:

```bash
pnpm install
```

Then in this package:

```bash
pnpm dev      # Next.js dev server on http://localhost:18790
```

You will also need an OpenClaw gateway running with [`@openuidev/openclaw-os-plugin`](../claw-plugin) installed. See the [root README](../../README.md#quick-start) for the end-to-end setup.

### Connecting to a gateway

1. Open http://localhost:18790
2. Open **Settings**
3. Paste your gateway URL (e.g. `wss://your-gateway.example.com/ws`) and auth token
4. Pick an agent from the sidebar and start chatting

You can read your local gateway URL and token with:

```bash
node ../../scripts/connection-info.mjs
```

It reads from `~/.openclaw/openclaw.json`.

## Scripts

```bash
pnpm dev          # Next.js dev server (port 18790)
pnpm build        # Next.js production build
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

This package is configured for Cloudflare Workers via [`@opennextjs/cloudflare`](https://opennext.js.org/cloudflare) (see `next.config.ts`, `open-next.config.ts`, `wrangler.jsonc`). Deployment scripts are intentionally not wired into the workspace yet — they will be added in a follow-up. For now, run them directly when needed:

```bash
pnpm exec opennextjs-cloudflare build
pnpm exec opennextjs-cloudflare deploy
```

## Troubleshooting

- **Settings won't save** — the client persists settings to `localStorage`. Make sure third-party storage is enabled in your browser.
- **Gateway connection fails** — verify the URL is reachable and the auth token is valid using `node scripts/connection-info.mjs` from the repo root.
- **Agent responds in plain text** — confirm `@openuidev/openclaw-os-plugin` is installed in the gateway and that the gateway has been restarted since install.

## License

[MIT](../../LICENSE)
