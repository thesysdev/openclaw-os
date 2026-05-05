import { mergeStatements } from "@openuidev/lang-core";
import { createReadStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { jsonResult } from "openclaw/plugin-sdk/agent-runtime";
import type {
  GatewayRequestHandlerOptions,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/core";
import { definePluginEntry, emptyPluginConfigSchema } from "openclaw/plugin-sdk/plugin-entry";
import { AppStore } from "./app-store.js";
import { ArtifactStore } from "./artifact-store.js";
import { lintOpenUICode, type LintReport } from "./lint-openui.js";
import { NotificationStore } from "./notification-store.js";
import { UploadStore } from "./upload-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Tiny preamble injected into Claw sessions. Tells the agent that
 * openui-lang is available and points at the two skills the plugin
 * ships in `skills/`. Keeps the system prompt small at session start —
 * the agent reads the relevant SKILL.md on demand via the `read` tool
 * (openclaw auto-lists them via `<available_skills>`).
 */
const CLAW_PREAMBLE = `# Claw client — Generative UI is your default for visual answers

This chat is rendered by the Claw client. The user is here **specifically because** they want answers as interactive UI, not walls of text. Two skills give you the language to do that. **Treat them as required reading whenever a request matches their triggers.**

## Skills you MUST use

### \`openui-chat-renderer\` — inline UI inside an assistant message
Read this skill (\`read\` the file at \`skills/openui-chat-renderer/SKILL.md\` from the Claw plugin) **before responding** whenever ANY of these triggers fire:

- The user asks for a **chart, graph, plot, trend, comparison, dashboard view, table, breakdown, KPI, metrics, summary, or visualization**.
- The user asks you to **compare** two or more things, **show** something, or **render** something.
- The user mentions a **stock ticker, price, market, portfolio, ranking, leaderboard, or any series of numbers**.
- You're about to collect **multi-field input from the user** (destination + dates, name + email + role, filters, settings) → render a **Form** with FormControls + a submit Button. Do NOT respond with a numbered bullet list of questions.
- Your answer would be **longer than ~10 lines**, contain **logs / diffs / JSON / multi-step plans / nested lists** → wrap each chunk in a collapsible **\`Section\` / accordion** so the chat stays scannable. Use accordions to **minify long responses**.
- You want to suggest **next actions / follow-up prompts** → render \`FollowUp\` chips.

When triggered, your response MUST contain an \`\`\`openui-lang fenced block. Plain markdown is the wrong choice for these cases — the user explicitly opted into a UI surface.

### \`openui-creator\` — durable, persistent apps the user opens repeatedly
Read this skill (\`read\` the file at \`skills/openui-creator/SKILL.md\`) **before calling** \`app_create\`, \`app_update\`, \`get_app\`, or \`create_markdown_artifact\`. Trigger it whenever the user asks for something they'll *come back to*:

- "**briefing**", "**dashboard**", "**command center**", "**war room**", "**monitor**", "**tracker**", "**hub**", "**inbox**", "**control panel**", "**review queue**", "**daily digest**", "**health check**", "**status board**" — any persistent surface they'll open repeatedly.
- Anything that needs **live data (Query)**, **mutations / action buttons** that fire back to you, or **stateful controls** that survive across page reloads.
- Killer use cases this is built for: morning briefings (weather + calendar + email triage), social media monitoring (live feed + sentiment + recommended actions), trading desks (position cards + risk analysis + price history), SEO command centers (rankings + content gaps), DevOps boards (PRs + deploys + tickets), founder dashboards (MRR + churn + runway), relationship hubs (contact timelines + drafted replies). When asked for any of these, **build an app, not a chat reply**.

## Refine flow

When the composer text starts with \`Refine app "..." (id: ...)\` or \`Refine artifact "..." (id: ...)\`, the user is iterating on an existing surface. Read the openui-creator skill, then call \`app_update\` (apps) or \`create_markdown_artifact\` (artifacts) with that exact id. Do not create a new one.

## When NOT to use UI

- Conversational chat ("hi", "thanks", "what do you mean by X").
- Single-sentence factual answers where a chart adds no value.
- Tool-call output that's already rendered (e.g. file diffs in a tool result).

## The bottom line

Default to plain text only when a visual would be pure decoration. The moment a request smells like data, comparison, structured input, long output, or a recurring surface — read the relevant skill and render UI. Never explain that you can render UI. Just do it.`;

function sanitizeDbSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function normalizeSqlNamespace(value: unknown): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return sanitizeDbSegment(value.trim());
  }
  return "default";
}

function normalizeSqlParams(value: unknown): unknown[] | Record<string, unknown> {
  if (Array.isArray(value)) {
    return value;
  }
  if (value && typeof value === "object") {
    return value as Record<string, unknown>;
  }
  return [];
}

function stripLeadingSqlComments(sql: string): string {
  return sql.replace(/^\s*(?:(?:--[^\n]*\n)\s*|(?:\/\*[\s\S]*?\*\/)\s*)*/u, "");
}

function assertReadOnlySql(sql: string): void {
  const normalized = stripLeadingSqlComments(sql).trimStart().toLowerCase();
  if (
    normalized.startsWith("select") ||
    normalized.startsWith("with") ||
    normalized.startsWith("pragma") ||
    normalized.startsWith("explain")
  ) {
    return;
  }

  throw new Error(
    "db_query only supports read-only SQL (SELECT / WITH / PRAGMA / EXPLAIN). Use db_execute for writes or schema changes.",
  );
}

function runStatement<T>(statement: any, mode: "all" | "get" | "run", params: unknown): T {
  statement.setAllowBareNamedParameters?.(true);
  const normalized = normalizeSqlParams(params);

  if (Array.isArray(normalized)) {
    return statement[mode](...normalized);
  }

  if (Object.keys(normalized).length === 0) {
    return statement[mode]();
  }

  return statement[mode](normalized);
}

export default definePluginEntry({
  id: "openclaw-os-plugin",
  name: "Claw — OpenUI for OpenClaw",
  description:
    "Injects the OpenUI Lang system prompt for requests originating from the Claw client, enabling Generative UI responses instead of plain markdown.",
  configSchema: emptyPluginConfigSchema,

  register(api) {
    api.logger.info("[openclaw-os-plugin] register() called — plugin loaded OK");

    // ── Static UI route ─────────────────────────────────────────────────────
    // Serves the claw-client static export bundled into ../static/ at install
    // time. Authentication is the user's responsibility: open the URL with
    // #gateway=...&token=... in the fragment (see scripts/open-ui.mjs).
    const STATIC_ROOT = path.resolve(__dirname, "..", "static");
    const ROUTE_PREFIX = "/plugins/openclawos";
    const MIME_TYPES: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".mjs": "application/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".map": "application/json; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".ico": "image/x-icon",
      ".woff": "font/woff",
      ".woff2": "font/woff2",
      ".ttf": "font/ttf",
      ".txt": "text/plain; charset=utf-8",
    };

    const serveFile = (res: ServerResponse, absPath: string): void => {
      const ext = path.extname(absPath).toLowerCase();
      const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
      res.writeHead(200, {
        "Content-Type": contentType,
        "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600",
      });
      createReadStream(absPath)
        .on("error", (err) => {
          api.logger.warn(`[openclaw-ui-plugin] static stream error ${absPath}: ${err}`);
          if (!res.headersSent) {
            res.writeHead(500);
          }
          res.end();
        })
        .pipe(res);
    };

    const tryServe = async (res: ServerResponse, candidate: string): Promise<boolean> => {
      try {
        const stats = await stat(candidate);
        if (stats.isFile()) {
          serveFile(res, candidate);
          return true;
        }
      } catch {
        // Falls through to next candidate.
      }
      return false;
    };

    api.registerHttpRoute({
      path: ROUTE_PREFIX,
      auth: "plugin",
      match: "prefix",
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        const rawUrl = req.url ?? "/";
        const urlPath = rawUrl.split("?")[0]!.split("#")[0]!;
        // Strip the route prefix so /plugins/openclawos/_next/x → /_next/x
        let relPath = urlPath.startsWith(ROUTE_PREFIX)
          ? urlPath.slice(ROUTE_PREFIX.length)
          : urlPath;
        if (relPath === "" || relPath === "/") {
          relPath = "/index.html";
        }

        // Decode + normalize, then guard against path traversal.
        let safeRel: string;
        try {
          safeRel = decodeURIComponent(relPath);
        } catch {
          res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Bad Request");
          return true;
        }
        const absPath = path.join(STATIC_ROOT, safeRel);
        const normalizedRoot = path.resolve(STATIC_ROOT) + path.sep;
        if (!path.resolve(absPath).startsWith(normalizedRoot.slice(0, -1))) {
          res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Forbidden");
          return true;
        }

        // 1) Direct file hit (incl. /index.html, /_next/static/*, /favicon.ico).
        if (await tryServe(res, absPath)) return true;
        // 2) Next.js static export emits clean paths like /setup → setup.html.
        if (await tryServe(res, absPath + ".html")) return true;
        // 3) Directory with index.html (e.g. /setup/ → /setup/index.html).
        if (await tryServe(res, path.join(absPath, "index.html"))) return true;
        // 4) SPA fallback so client-side routing on the loaded app still works.
        if (await tryServe(res, path.join(STATIC_ROOT, "index.html"))) return true;

        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not Found");
        return true;
      },
    });
    api.logger.info(
      `[openclaw-ui-plugin] static UI route at ${ROUTE_PREFIX} (root=${STATIC_ROOT})`,
    );

    // ── Tiny preamble injection ──────────────────────────────────────────────
    // The agent fetches the actual openui-lang prompt body via `read` on the
    // skill files in `skills/openui-chat-renderer/SKILL.md` and
    // `skills/openui-creator/SKILL.md`. Openclaw auto-lists those in the
    // `<available_skills>` block, so this hook only adds the two-line nudge
    // that tells the agent which skill to load when.
    api.on("before_prompt_build", (_event, ctx) => {
      if (!ctx.sessionKey?.endsWith(":openclaw-os")) {
        return;
      }
      return { prependSystemContext: CLAW_PREAMBLE };
    });

    // ── Artifact store — lazy-initialized on first use ──────────────────────
    let store: ArtifactStore | null = null;
    const getStore = (): ArtifactStore => {
      if (!store) {
        const stateDir = api.runtime.state.resolveStateDir();
        api.logger.info(`[openclaw-os-plugin] initialising ArtifactStore at: ${stateDir}`);
        store = new ArtifactStore(stateDir);
      }
      return store;
    };

    // ── App store — lazy-initialized on first use ────────────────────────────
    let appStore: AppStore | null = null;
    const getAppStore = (): AppStore => {
      if (!appStore) {
        const stateDir = api.runtime.state.resolveStateDir();
        appStore = new AppStore(stateDir);
      }
      return appStore;
    };

    // ── Notification store — wrapper-owned inbox ─────────────────────────────
    let notificationStore: NotificationStore | null = null;
    const getNotificationStore = (): NotificationStore => {
      if (!notificationStore) {
        const stateDir = api.runtime.state.resolveStateDir();
        notificationStore = new NotificationStore(stateDir);
      }
      return notificationStore;
    };

    // ── Upload store — durable attachment bytes (OpenClaw's media dir TTLs) ──
    let uploadStore: UploadStore | null = null;
    const getUploadStore = (): UploadStore => {
      if (!uploadStore) {
        const stateDir = api.runtime.state.resolveStateDir();
        uploadStore = new UploadStore(stateDir);
      }
      return uploadStore;
    };

    const resolveDatabasePath = async (namespace: string): Promise<string> => {
      const stateDir = api.runtime.state.resolveStateDir();
      const dbDir = path.join(stateDir, "plugins", "openclaw-os", "db");
      await mkdir(dbDir, { recursive: true });
      return path.join(dbDir, `${namespace}.sqlite`);
    };

    const withDatabase = async <T>(
      namespace: string,
      action: (db: DatabaseSync) => T,
    ): Promise<T> => {
      const dbPath = await resolveDatabasePath(namespace);
      const db = new DatabaseSync(dbPath);

      try {
        db.exec("PRAGMA journal_mode = WAL;");
        db.exec("PRAGMA foreign_keys = ON;");
        return action(db);
      } finally {
        db.close();
      }
    };

    // Tool/RPC payloads are typed as Record<string, unknown> by the SDK
    // (gateway frames carry arbitrary JSON), so reads use bracket access to
    // satisfy `noPropertyAccessFromIndexSignature`. Each field is still
    // narrowed with a `typeof` check before use.
    const invokeDbQueryTool = async (args: Record<string, unknown>): Promise<unknown> => {
      const sql = typeof args["sql"] === "string" ? args["sql"].trim() : "";
      if (!sql) {
        throw new Error("db_query requires a non-empty 'sql' argument");
      }
      assertReadOnlySql(sql);

      const namespace = normalizeSqlNamespace(args["namespace"]);
      const rows = await withDatabase(namespace, (db) => {
        const statement = db.prepare(sql);
        const result = runStatement<unknown[]>(statement, "all", args["params"]);
        return Array.isArray(result) ? result : [];
      });

      return { namespace, rows };
    };

    const invokeDbExecuteTool = async (args: Record<string, unknown>): Promise<unknown> => {
      const sql = typeof args["sql"] === "string" ? args["sql"].trim() : "";
      if (!sql) {
        throw new Error("db_execute requires a non-empty 'sql' argument");
      }

      const namespace = normalizeSqlNamespace(args["namespace"]);
      return withDatabase(namespace, (db) => {
        const normalizedParams = normalizeSqlParams(args["params"]);

        if (
          Array.isArray(normalizedParams)
            ? normalizedParams.length > 0
            : Object.keys(normalizedParams).length > 0
        ) {
          const statement = db.prepare(sql);
          const result = runStatement<{
            changes?: number;
            lastInsertRowid?: number | bigint;
          }>(statement, "run", normalizedParams);

          return {
            namespace,
            changes: Number(result?.changes ?? 0),
            lastInsertRowid:
              result?.lastInsertRowid != null ? Number(result.lastInsertRowid) : null,
          };
        }

        db.exec(sql);
        const meta = db
          .prepare("SELECT changes() AS changes, last_insert_rowid() AS lastInsertRowid")
          .get() as {
          changes?: number;
          lastInsertRowid?: number | bigint;
        } | null;

        return {
          namespace,
          changes: Number(meta?.changes ?? 0),
          lastInsertRowid: meta?.lastInsertRowid != null ? Number(meta.lastInsertRowid) : null,
        };
      });
    };

    // ── Lint helper — surface parser errors back to the LLM so it can self-correct ──
    const buildLintPayload = (report: LintReport): Record<string, unknown> => {
      if (report.ok) return {};
      return {
        validationErrors: report.findings,
        correction: `Your app code has ${report.findings.length} validation issue(s). Read the \`message\` and \`hint\` on each finding, then call \`app_update\` with ONLY the corrected statements — the merge is by statement name, so untouched lines don't need to be resent.`,
      };
    };

    // ── Artifact tools ──────────────────────────────────────────────────────

    api.logger.info("[openclaw-os-plugin] registering tools…");

    api.registerTool((ctx: OpenClawPluginToolContext) => ({
      name: "create_markdown_artifact",
      label: "Create Markdown Artifact",
      description:
        "Create a durable markdown document artifact that the user can view and revisit in the Artifacts panel. Use for reports, summaries, plans, reference material, or any structured text worth preserving.",
      parameters: {
        type: "object" as const,
        properties: {
          title: { type: "string", description: "Short, descriptive title for the artifact" },
          content: { type: "string", description: "Full markdown content of the document" },
        },
        required: ["title", "content"],
      },
      execute: async (_id: string, params: { title: string; content: string }) => {
        const artifact = await getStore().create({
          kind: "markdown",
          title: params.title,
          content: params.content,
          source: {
            agentId: ctx.agentId ?? "unknown",
            sessionKey: ctx.sessionKey ?? "unknown",
          },
        });
        return jsonResult({
          id: artifact.id,
          title: artifact.title,
          createdAt: artifact.createdAt,
        });
      },
    }));

    api.registerTool((_ctx: OpenClawPluginToolContext) => ({
      name: "update_markdown_artifact",
      label: "Update Markdown Artifact",
      description:
        "Update the title and/or content of an existing markdown artifact by its id. Call get_artifact first if you need to read the current content before editing.",
      parameters: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "The artifact id" },
          title: { type: "string", description: "New title (optional — omit to keep current)" },
          content: {
            type: "string",
            description: "New markdown content (optional — omit to keep current)",
          },
        },
        required: ["id"],
      },
      execute: async (_id: string, params: { id: string; title?: string; content?: string }) => {
        const artifact = await getStore().update(params.id, {
          ...(params.title !== undefined ? { title: params.title } : {}),
          ...(params.content !== undefined ? { content: params.content } : {}),
        });
        return jsonResult({ id: artifact.id, updatedAt: artifact.updatedAt });
      },
    }));

    api.registerTool(() => ({
      name: "get_artifact",
      label: "Get Artifact By Id",
      description: "Fetch the full content of an artifact by id.",
      parameters: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "The artifact id" },
        },
        required: ["id"],
      },
      execute: async (_id: string, params: { id: string }) => {
        const artifact = await getStore().get(params.id);
        if (!artifact) return jsonResult({ error: "Artifact not found", id: params.id });
        return jsonResult({
          id: artifact.id,
          kind: artifact.kind,
          title: artifact.title,
          content: artifact.content,
        });
      },
    }));

    api.registerTool(() => ({
      name: "list_artifacts",
      label: "List Artifacts",
      description: "List existing artifacts, optionally filtered by kind.",
      parameters: {
        type: "object" as const,
        properties: {
          kind: {
            type: "string",
            description: "Filter by kind (e.g. 'markdown'). Omit to list all.",
          },
        },
      },
      execute: async (_id: string, params: { kind?: string }) => {
        const items = await getStore().list(
          typeof params.kind === "string" ? params.kind : undefined,
        );
        return jsonResult(
          items.map((a) => ({
            id: a.id,
            kind: a.kind,
            title: a.title,
            createdAt: a.createdAt,
            updatedAt: a.updatedAt,
          })),
        );
      },
    }));

    api.registerTool(() => ({
      name: "db_query",
      label: "Query Persistent App DB",
      description:
        "Run a read-only SQLite query against the persistent session-scoped app database. Returns { rows: [...] }. Use for app state such as todos, saved items, or user preferences.",
      parameters: {
        type: "object" as const,
        properties: {
          sql: {
            type: "string",
            description: "Read-only SQL to execute (SELECT / WITH / PRAGMA / EXPLAIN).",
          },
          params: {
            type: "object" as const,
            additionalProperties: true,
            description:
              "Optional named-parameter object for the SQL statement, e.g. { text: 'Buy milk' } used with $text placeholders.",
          },
          namespace: {
            type: "string",
            description:
              "Optional logical database name within the current session. Defaults to 'default'.",
          },
        },
        required: ["sql"],
      },
      execute: async (_callId: string, params: Record<string, unknown>) =>
        jsonResult(await invokeDbQueryTool(params)),
    }));

    api.registerTool(() => ({
      name: "db_execute",
      label: "Write Persistent App DB",
      description:
        "Run a write or schema SQLite statement against the persistent session-scoped app database. Returns { changes, lastInsertRowid }. Use for CREATE TABLE, INSERT, UPDATE, or DELETE.",
      parameters: {
        type: "object" as const,
        properties: {
          sql: {
            type: "string",
            description: "SQL statement to execute. Use params for dynamic values when possible.",
          },
          params: {
            type: "object" as const,
            additionalProperties: true,
            description:
              "Optional named-parameter object for a single prepared statement, e.g. { text: 'Buy milk' } used with $text placeholders.",
          },
          namespace: {
            type: "string",
            description:
              "Optional logical database name within the current session. Defaults to 'default'.",
          },
        },
        required: ["sql"],
      },
      execute: async (_callId: string, params: Record<string, unknown>) =>
        jsonResult(await invokeDbExecuteTool(params)),
    }));

    // ── App tools — direct storage, no subagent ─────────────────────────────

    api.registerTool((ctx: OpenClawPluginToolContext) => ({
      name: "app_create",
      label: "Create App",
      description:
        "Create a live interactive app. Pass the complete openui-lang code. The app is stored and rendered in the Apps panel. Use when the user asks to build a dashboard, app, or interactive view.",
      parameters: {
        type: "object" as const,
        properties: {
          title: { type: "string", description: "Short display title for the app" },
          code: { type: "string", description: "Complete openui-lang source code for the app" },
        },
        required: ["title", "code"],
      },
      execute: async (_callId: string, params: { title: string; code: string }) => {
        api.logger.info(
          `[openclaw-os-plugin] app_create: title="${params.title}" code=${params.code.length} chars`,
        );
        const lint = lintOpenUICode(params.code);
        if (!lint.ok) {
          api.logger.info(
            `[openclaw-os-plugin] app_create lint: ${lint.findings.length} finding(s) — ${lint.summary.slice(0, 180)}`,
          );
        }
        const app = await getAppStore().create({
          title: params.title,
          content: params.code,
          agentId: ctx.agentId ?? "main",
          sessionKey: ctx.sessionKey ?? "",
        });
        api.logger.info(`[openclaw-os-plugin] app_create → saved app ${app.id}`);
        return jsonResult({
          id: app.id,
          title: app.title,
          ...buildLintPayload(lint),
        });
      },
    }));

    api.registerTool(() => ({
      name: "get_app",
      label: "Get App",
      description:
        "Fetch the current openui-lang code of an app by id. Call this before app_update to see the current state.",
      parameters: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "The app id" },
        },
        required: ["id"],
      },
      execute: async (_callId: string, params: { id: string }) => {
        const app = await getAppStore().get(params.id);
        if (!app) return jsonResult({ error: "App not found", id: params.id });
        return jsonResult({ id: app.id, title: app.title, content: app.content });
      },
    }));

    api.registerTool(() => ({
      name: "app_update",
      label: "Update App",
      description:
        "Apply an incremental edit patch to an existing app. Pass ONLY changed/new openui-lang statements — the runtime merges by statement name. Call get_app first to see the current code.",
      parameters: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "The app id" },
          patch: {
            type: "string",
            description: "openui-lang statements to merge (changed/new only)",
          },
        },
        required: ["id", "patch"],
      },
      execute: async (_callId: string, params: { id: string; patch: string }) => {
        const existing = await getAppStore().get(params.id);
        if (!existing) return jsonResult({ error: "App not found", id: params.id });

        api.logger.info(
          `[openclaw-os-plugin] app_update: id=${params.id} patch=${params.patch.length} chars`,
        );

        const merged = mergeStatements(existing.content, params.patch);
        const lint = lintOpenUICode(merged);
        if (!lint.ok) {
          api.logger.info(
            `[openclaw-os-plugin] app_update lint: ${lint.findings.length} finding(s) — ${lint.summary.slice(0, 180)}`,
          );
        }

        const updated = await getAppStore().update(params.id, { content: merged });
        api.logger.info(`[openclaw-os-plugin] app_update → updated app ${updated.id}`);
        return jsonResult({
          id: updated.id,
          updatedAt: updated.updatedAt,
          ...buildLintPayload(lint),
        });
      },
    }));

    api.logger.info("[openclaw-os-plugin] all tools registered");

    // ── Gateway RPC methods — client reads/writes ───────────────────────────

    // Gateway RPC `params` is `Record<string, unknown>` (arbitrary JSON),
    // so reads use bracket access to satisfy `noPropertyAccessFromIndexSignature`.
    // Each field is still narrowed with a `typeof` check before use.
    //
    // Namespaced under `openclawos.*` because openclaw 2026.5.x ships a built-in
    // `artifacts.list/get/download` that returns *transcript-derived media
    // artifacts* scoped to sessionKey/runId/taskId — a different concept from
    // this plugin's user-saved markdown documents. The core method takes
    // priority over plugin handlers, so the plugin must use a non-colliding
    // name. See: openclaw/docs/gateway/protocol.md ("artifacts.list…").
    api.registerGatewayMethod(
      "openclawos.artifacts.list",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const kind = typeof params["kind"] === "string" ? params["kind"] : undefined;
          const items = await getStore().list(kind);
          respond(true, {
            artifacts: items.map((a) => ({
              id: a.id,
              kind: a.kind,
              title: a.title,
              source: {
                engineId: "openclaw",
                agentId: a.source.agentId,
                sessionId: a.source.sessionKey,
              },
              createdAt: a.createdAt,
              updatedAt: a.updatedAt,
            })),
          });
        } catch (e) {
          respond(false, undefined, {
            message: e instanceof Error ? e.message : "Failed to list artifacts",
            code: "artifacts.list_failed",
          });
        }
      },
    );

    api.registerGatewayMethod(
      "openclawos.artifacts.get",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const id = typeof params["id"] === "string" ? params["id"] : "";
          const artifact = await getStore().get(id);
          respond(true, {
            artifact: artifact
              ? {
                  ...artifact,
                  source: {
                    engineId: "openclaw",
                    agentId: artifact.source.agentId,
                    sessionId: artifact.source.sessionKey,
                  },
                }
              : null,
          });
        } catch (e) {
          respond(false, undefined, {
            message: e instanceof Error ? e.message : "Failed to get artifact",
            code: "artifacts.get_failed",
          });
        }
      },
    );

    api.registerGatewayMethod(
      "openclawos.artifacts.delete",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const id = typeof params["id"] === "string" ? params["id"] : "";
          await getStore().delete(id);
          respond(true, { deleted: id });
        } catch (e) {
          respond(false, undefined, {
            message: e instanceof Error ? e.message : "Failed to delete artifact",
            code: "artifacts.delete_failed",
          });
        }
      },
    );

    // ── App gateway RPC methods ──────────────────────────────────────────────

    api.registerGatewayMethod(
      "openclawos.apps.list",
      async ({ respond }: GatewayRequestHandlerOptions) => {
        try {
          const apps = await getAppStore().list();
          respond(true, {
            apps: apps.map((a) => ({
              id: a.id,
              title: a.title,
              agentId: a.agentId,
              sessionKey: a.sessionKey,
              createdAt: a.createdAt,
              updatedAt: a.updatedAt,
            })),
          });
        } catch (e) {
          respond(false, undefined, {
            message: e instanceof Error ? e.message : "Failed to list apps",
            code: "apps.list_failed",
          });
        }
      },
    );

    api.registerGatewayMethod(
      "openclawos.apps.get",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const id = typeof params["id"] === "string" ? params["id"] : "";
          const app = await getAppStore().get(id);
          respond(true, { app });
        } catch (e) {
          respond(false, undefined, {
            message: e instanceof Error ? e.message : "Failed to get app",
            code: "apps.get_failed",
          });
        }
      },
    );

    api.registerGatewayMethod(
      "openclawos.apps.delete",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const id = typeof params["id"] === "string" ? params["id"] : "";
          await getAppStore().delete(id);
          respond(true, { deleted: id });
        } catch (e) {
          respond(false, undefined, {
            message: e instanceof Error ? e.message : "Failed to delete app",
            code: "apps.delete_failed",
          });
        }
      },
    );

    api.registerGatewayMethod(
      "openclawos.apps.versions",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const id = typeof params["id"] === "string" ? params["id"] : "";
          const app = await getAppStore().get(id);
          if (!app) {
            respond(false, undefined, {
              message: "App not found",
              code: "apps.versions_not_found",
            });
            return;
          }
          respond(true, {
            versions: (app.versions ?? []).map((v, i) => ({
              index: i,
              timestamp: v.timestamp,
              source: v.source,
            })),
          });
        } catch (e) {
          respond(false, undefined, {
            message: e instanceof Error ? e.message : "Failed",
            code: "apps.versions_failed",
          });
        }
      },
    );

    api.registerGatewayMethod(
      "openclawos.apps.restore",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const id = typeof params["id"] === "string" ? params["id"] : "";
          const idx = typeof params["versionIndex"] === "number" ? params["versionIndex"] : -1;
          const app = await getAppStore().restore(id, idx);
          respond(true, { id: app.id, updatedAt: app.updatedAt });
        } catch (e) {
          respond(false, undefined, {
            message: e instanceof Error ? e.message : "Failed",
            code: "apps.restore_failed",
          });
        }
      },
    );

    api.registerGatewayMethod(
      "openclawos.uploads.put",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const sessionKey = typeof params["sessionKey"] === "string" ? params["sessionKey"] : "";
          const name = typeof params["name"] === "string" ? params["name"] : "attachment";
          const mimeType =
            typeof params["mimeType"] === "string" && params["mimeType"].length > 0
              ? params["mimeType"]
              : "application/octet-stream";
          const content = typeof params["content"] === "string" ? params["content"] : "";
          const size = typeof params["size"] === "number" ? params["size"] : undefined;
          if (!content) {
            respond(false, undefined, {
              message: "uploads.put requires base64 content",
              code: "uploads.put_invalid",
            });
            return;
          }
          const meta = await getUploadStore().put({ sessionKey, name, mimeType, content, size });
          respond(true, { upload: meta });
        } catch (e) {
          respond(false, undefined, {
            message: e instanceof Error ? e.message : "Failed to save upload",
            code: "uploads.put_failed",
          });
        }
      },
    );

    api.registerGatewayMethod(
      "openclawos.uploads.list",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const sessionKey =
            typeof params["sessionKey"] === "string" ? params["sessionKey"] : undefined;
          const uploads = await getUploadStore().list(sessionKey);
          respond(true, { uploads });
        } catch (e) {
          respond(false, undefined, {
            message: e instanceof Error ? e.message : "Failed to list uploads",
            code: "uploads.list_failed",
          });
        }
      },
    );

    api.registerGatewayMethod(
      "openclawos.uploads.get",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const id = typeof params["id"] === "string" ? params["id"] : "";
          const upload = await getUploadStore().get(id);
          if (!upload) {
            respond(false, undefined, {
              message: "Upload not found",
              code: "uploads.get_not_found",
            });
            return;
          }
          respond(true, { upload });
        } catch (e) {
          respond(false, undefined, {
            message: e instanceof Error ? e.message : "Failed to get upload",
            code: "uploads.get_failed",
          });
        }
      },
    );

    api.registerGatewayMethod(
      "openclawos.uploads.delete",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const id = typeof params["id"] === "string" ? params["id"] : "";
          await getUploadStore().delete(id);
          respond(true, { deleted: id });
        } catch (e) {
          respond(false, undefined, {
            message: e instanceof Error ? e.message : "Failed to delete upload",
            code: "uploads.delete_failed",
          });
        }
      },
    );

    api.registerGatewayMethod(
      "openclawos.uploads.deleteBySession",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const sessionKey = typeof params["sessionKey"] === "string" ? params["sessionKey"] : "";
          if (!sessionKey) {
            respond(false, undefined, {
              message: "uploads.deleteBySession requires sessionKey",
              code: "uploads.deleteBySession_invalid",
            });
            return;
          }
          const count = await getUploadStore().deleteBySession(sessionKey);
          respond(true, { sessionKey, deleted: count });
        } catch (e) {
          respond(false, undefined, {
            message: e instanceof Error ? e.message : "Failed to delete session uploads",
            code: "uploads.deleteBySession_failed",
          });
        }
      },
    );

    api.registerGatewayMethod(
      "openclawos.notifications.list",
      async ({ respond }: GatewayRequestHandlerOptions) => {
        try {
          const notifications = await getNotificationStore().list();
          respond(true, { notifications });
        } catch (e) {
          respond(false, undefined, {
            message: e instanceof Error ? e.message : "Failed to list notifications",
            code: "notifications.list_failed",
          });
        }
      },
    );

    api.registerGatewayMethod(
      "openclawos.notifications.read",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const ids = Array.isArray(params["ids"])
            ? params["ids"].filter((value: unknown): value is string => typeof value === "string")
            : undefined;
          const updated = await getNotificationStore().markRead(ids);
          respond(true, { updated });
        } catch (e) {
          respond(false, undefined, {
            message: e instanceof Error ? e.message : "Failed to update notifications",
            code: "notifications.read_failed",
          });
        }
      },
    );

    api.registerGatewayMethod(
      "openclawos.notifications.upsert",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const kind = params["kind"];
          const title = params["title"];
          const message = params["message"];
          const target = params["target"];
          if (
            !params ||
            typeof params !== "object" ||
            Array.isArray(params) ||
            typeof kind !== "string" ||
            typeof title !== "string" ||
            typeof message !== "string" ||
            !target ||
            typeof target !== "object" ||
            Array.isArray(target)
          ) {
            respond(false, undefined, {
              message: "Invalid notification payload",
              code: "notifications.upsert_invalid",
            });
            return;
          }

          const dedupeKey = params["dedupeKey"];
          const source = params["source"];
          const metadata = params["metadata"];
          const notification = await getNotificationStore().upsert({
            kind,
            title,
            message,
            target: target as Parameters<NotificationStore["upsert"]>[0]["target"],
            ...(typeof dedupeKey === "string" ? { dedupeKey } : {}),
            ...(source && typeof source === "object" && !Array.isArray(source)
              ? { source: source as Parameters<NotificationStore["upsert"]>[0]["source"] }
              : {}),
            ...(metadata && typeof metadata === "object" && !Array.isArray(metadata)
              ? { metadata: metadata as Record<string, unknown> }
              : {}),
          });
          respond(true, { notification });
        } catch (e) {
          respond(false, undefined, {
            message: e instanceof Error ? e.message : "Failed to upsert notification",
            code: "notifications.upsert_failed",
          });
        }
      },
    );

    // ── tools.invoke — execute tools for rendered apps ──────────────────────
    // Called by the Renderer's toolProvider in AppDetail (Query/Mutation).
    // exec/read are handled directly. Other tools are not yet proxied.

    const invokeExecTool = async (args: Record<string, unknown>): Promise<unknown> => {
      const command = typeof args["command"] === "string" ? args["command"] : "";
      if (!command) throw new Error("exec requires a 'command' argument");
      const timeoutMs = typeof args["timeout_ms"] === "number" ? args["timeout_ms"] : 30_000;
      api.logger.info(`[openclaw-os-plugin] invokeTool(exec): command=${command.slice(0, 120)}`);
      try {
        const result = await api.runtime.system.runCommandWithTimeout(["sh", "-c", command], {
          timeoutMs,
          cwd: api.runtime.state.resolveStateDir(),
        });
        const stdout = (result.stdout ?? "").trim();
        const stderr = (result.stderr ?? "").trim();
        const exitCode = result.code ?? 0;

        // Auto-parse stdout as JSON so apps get clean data objects — but only
        // when the output looks like a JSON object or array. Bare numbers and
        // strings (e.g. `date +%s` → `1777925583`) parse successfully too,
        // which would replace the result with a primitive and break Query
        // bindings like `now.stdout` in openui-lang. Restrict to {…} / […].
        if (exitCode === 0 && stdout && (stdout[0] === "{" || stdout[0] === "[")) {
          try {
            return JSON.parse(stdout);
          } catch {
            // Not valid JSON — fall through to the raw shape below.
          }
        }
        return { stdout, stderr, exitCode };
      } catch (err: unknown) {
        const e = err as { stdout?: string; stderr?: string; status?: number; message?: string };
        return {
          stdout: (e.stdout ?? "").trim(),
          stderr: (e.stderr ?? e.message ?? "").trim(),
          exitCode: e.status ?? 1,
        };
      }
    };

    const invokeReadTool = async (args: Record<string, unknown>): Promise<unknown> => {
      const filePath = typeof args["file_path"] === "string" ? args["file_path"] : "";
      if (!filePath) throw new Error("read requires a 'file_path' argument");
      api.logger.info(`[openclaw-os-plugin] invokeTool(read): path=${filePath}`);
      const { readFile } = await import("node:fs/promises");
      const content = await readFile(filePath, "utf-8");
      return { content };
    };

    const invokeTool = async (
      toolName: string,
      toolArgs: Record<string, unknown>,
      _sessionKey: string,
    ): Promise<unknown> => {
      switch (toolName) {
        case "exec":
        case "bash":
        case "shell":
          return invokeExecTool(toolArgs);
        case "read":
          return invokeReadTool(toolArgs);
        case "db_query":
          return invokeDbQueryTool(toolArgs);
        case "db_execute":
          return invokeDbExecuteTool(toolArgs);
        default:
          throw new Error(
            `Tool "${toolName}" is not available in app runtime. Supported tools: exec, read, db_query, db_execute.`,
          );
      }
    };

    // Namespaced under `openclawos.*` because openclaw 2026.5.x ships a built-in
    // `tools.invoke` (param shape `{ name, args }`, not the legacy
    // `{ tool_name, tool_args }`). Registering the same name from a plugin
    // logs `gateway method already registered: tools.invoke` and destabilises
    // plugin tool runtime resolution — symptom: agent `app_create` fails
    // with "plugin tool runtime missing" while peer tools keep working in
    // the same session. Rendered apps' Query/Mutation calls use this
    // namespaced RPC; the gateway core built-in is left alone.
    api.registerGatewayMethod(
      "openclawos.tools.invoke",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        const toolName = typeof params["tool_name"] === "string" ? params["tool_name"] : "";
        const toolArgs =
          params["tool_args"] != null &&
          typeof params["tool_args"] === "object" &&
          !Array.isArray(params["tool_args"])
            ? (params["tool_args"] as Record<string, unknown>)
            : {};
        const sessionKey = typeof params["sessionKey"] === "string" ? params["sessionKey"] : "";

        if (!toolName) {
          respond(false, undefined, {
            message: "tools.invoke requires a tool name",
            code: "tools.invoke_missing_tool",
          });
          return;
        }

        try {
          api.logger.info(`[openclaw-os-plugin] tools.invoke: tool=${toolName}`);
          const result = await invokeTool(toolName, toolArgs, sessionKey);
          respond(true, { result });
        } catch (e) {
          api.logger.error(
            `[openclaw-os-plugin] tools.invoke failed: tool=${toolName} error=${e instanceof Error ? e.message : String(e)}`,
          );
          respond(false, undefined, {
            message: e instanceof Error ? e.message : "Tool invocation failed",
            code: "tools.invoke_failed",
          });
        }
      },
    );

    api.logger.info("[openclaw-os-plugin] gateway RPC methods registered");
  },
});
