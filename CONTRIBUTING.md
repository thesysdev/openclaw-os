# Contributing to OpenClaw OS

Thank you for considering contributing to OpenClaw OS! This document covers how to set up the repo, what we expect from contributions, and the workflow for opening a pull request.

## Code of Conduct

By participating in this project, you agree to abide by our [Code of Conduct](./CODE_OF_CONDUCT.md).

## Repository layout

```
openclaw-os/
├── packages/
│   ├── claw-client/   # Next.js generative UI web client
│   └── claw-plugin/   # OpenClaw server-side plugin
├── scripts/           # Local helpers (connection info, tunnel setup)
└── .github/           # CI workflows + issue / PR templates
```

See [`AGENTS.md`](./AGENTS.md) for protocol details, gateway internals, and the agent / session / thread mental model.

## Prerequisites

- [Node.js](https://nodejs.org/) **20+** (run `nvm use` to pick up the version pinned in `.nvmrc`)
- [pnpm](https://pnpm.io/) **9.15+**
- A running [OpenClaw](https://github.com/openclaw/openclaw) gateway for end-to-end testing

## Local setup

```bash
git clone https://github.com/thesysdev/openclaw-os.git
cd openclaw-os
pnpm install
```

That's it — the install runs in the workspace root and links both packages.

### Run the client locally

```bash
cd packages/claw-client
pnpm dev   # http://localhost:18790
```

### Install the plugin into a local gateway

```bash
openclaw plugins install -l ./packages/claw-plugin
openclaw restart
```

The plugin is loaded as raw TypeScript via [jiti](https://github.com/unjs/jiti) — no build step. See [`packages/claw-plugin/README.md`](./packages/claw-plugin/README.md) for remote install instructions.

## Development workflow

1. Fork the repository.
2. Create a feature branch: `git checkout -b feature/your-thing`.
3. Make your changes.
4. Run the full check before pushing:
   ```bash
   pnpm ci
   ```
   This runs lint, format check, typecheck, and build for every package. It is the same set of checks GitHub Actions runs on your PR.
5. Update docs (root README or per-package README) when you change user-facing behaviour.
6. Open a pull request against `main` using the PR template.

## Code style

We use **ESLint** (flat config, v9) and **Prettier**. Both are wired up at the workspace root and run per-package.

```bash
pnpm format:fix      # auto-format every package
pnpm lint:fix        # auto-fix what ESLint can fix
pnpm typecheck       # strict TypeScript across the workspace
```

Notes:

- Strict TypeScript is enabled at the root: `noUncheckedIndexedAccess`, `noImplicitReturns`, `noPropertyAccessFromIndexSignature`, `noFallthroughCasesInSwitch`, `noImplicitOverride`. New code should satisfy these without `// @ts-ignore`.
- `console.log` is a lint error. Use `console.warn` / `console.error` / `console.info` (or a proper logger).
- Unused imports are a lint error. Prefix intentionally-unused vars with `_`.
- Prettier is the source of truth for formatting — no bikeshedding.

## Commit messages

Keep the subject short, imperative, and scoped to the package when relevant:

```
feat(claw-client): stream artifact updates incrementally
fix(claw-plugin): tolerate missing senderId in session keys
chore(deps): bump @openuidev/react-ui to 0.12.0
```

## Bug reports & feature requests

Please use the [issue templates](.github/ISSUE_TEMPLATE/). For bugs, include:

- A clear description and reproduction steps
- Versions of the client, plugin, and OpenClaw gateway
- Relevant gateway logs and browser console output

## Security issues

Please **do not** report security vulnerabilities through public GitHub issues. See [`SECURITY.md`](./SECURITY.md) for the disclosure process.

## Questions?

Open a [discussion](https://github.com/thesysdev/openclaw-os/discussions) or join us on [Discord](https://discord.com/invite/Pbv5PsqUSv).
