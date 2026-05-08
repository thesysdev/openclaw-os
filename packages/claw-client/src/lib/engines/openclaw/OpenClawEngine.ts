import type { MergedMessage } from "@/lib/chat/history-merger";
import { mergeHistoryMessages } from "@/lib/chat/history-merger";
import { createOpenClawAGUIMapper } from "@/lib/chat/openclaw-agui-mapper";
import type { CronJobRecord, CronRunEntry, CronStatusRecord } from "@/lib/cron";
import { getOrCreateDeviceIdentity } from "@/lib/gateway/device-identity";
import { GatewaySocket } from "@/lib/gateway/socket";
import type {
  AgentEvent,
  ChatEvent,
  ChatHistoryMessage,
  EventFrame,
  HelloOk,
} from "@/lib/gateway/types";
import { ConnectionState } from "@/lib/gateway/types";
import { normalizeSessionPatch } from "@/lib/models";
import type { NotificationRecord } from "@/lib/notifications";
import { encodeExtra, encodeMain, extractAgentIdFromKey, hasClawSuffix } from "@/lib/session-keys";
import type { Settings } from "@/lib/storage";
import {
  clearAuthCredentials,
  clearDeviceToken,
  getSettings,
  saveDeviceToken,
} from "@/lib/storage";
import { resolveSessionTitle } from "@/lib/thread-titles";
import type {
  AgentsListResult,
  ClawThreadListItem,
  ConfigGetResult,
  ModelChoice,
  ModelsListResult,
  NotificationsListResult,
  SessionGetResult,
  SessionRow,
  SessionsListResult,
} from "@/types/gateway-responses";
import { EventType } from "@openuidev/react-headless";
import type {
  AgentInfo,
  AppRecord,
  AppStore,
  AppSummary,
  ArtifactRecord,
  ArtifactStore,
  ArtifactSummary,
  ConversationStore,
  Engine,
  EngineCapabilities,
  GatewayCommand,
  GatewayCommandRaw,
  ModelInfo,
  OpenClawEngineConfig,
  SessionInfo,
  StoredMessage,
  UploadMeta,
  UploadRecord,
  UploadStore,
} from "../types";

const log = (...args: unknown[]) => console.info("[claw:openclaw-engine]", ...args);
const warn = (...args: unknown[]) => console.warn("[claw:openclaw-engine]", ...args);

const FULL_VERBOSE_LEVEL = "full";

interface CompactSessionResponse {
  ok?: boolean;
  compacted?: boolean;
  reason?: string;
  result?: {
    tokensBefore?: number;
    tokensAfter?: number;
  };
}

export interface CompactSessionResult {
  ok: boolean;
  compacted: boolean;
  tokensBefore: number | null;
  tokensAfter: number | null;
  reason: string | null;
}

function sessionRowTitle(
  row: Pick<SessionRow, "label" | "displayName" | "derivedTitle" | "key">,
): string {
  return resolveSessionTitle({
    label: row.label,
    displayName: row.displayName,
    derivedTitle: row.derivedTitle,
    fallbackId: row.key,
  });
}

export function agentMainSessionKey(agentId: string): string {
  return encodeMain(agentId);
}

export function resolveChatSessionKey(threadId: string, agentIds: Set<string>): string {
  if (agentIds.has(threadId)) return agentMainSessionKey(threadId);
  return threadId;
}

/** Convert merged history into StoredMessage[] for UI hydration. */
function mergedToStored(merged: MergedMessage[]): StoredMessage[] {
  const result: StoredMessage[] = [];

  for (const m of merged) {
    if (m.role === "user") {
      result.push({ id: m.id, role: "user", content: m.content ?? "" });
      continue;
    }
    if (m.role === "assistant") {
      result.push({
        id: m.id,
        role: "assistant",
        content: m.content,
        ...(m.timeline?.length ? { timeline: m.timeline } : {}),
        ...(m.toolCalls?.length ? { toolCalls: m.toolCalls } : {}),
      });
      continue;
    }
    if (m.role === "activity") {
      result.push(m);
    }
  }

  return result;
}

interface RunListener {
  onAgentEvent: (event: AgentEvent) => void;
  onChatEvent: (event: ChatEvent) => void;
  onClose: () => void;
}

export interface OpenClawEngineEvents {
  onConnectionStateChange: (state: ConnectionState) => void;
  onPairingRequired: (deviceId: string | null) => void;
  onAuthFailed: () => void;
  onSettingsChanged: (settings: Settings) => void;
  onSessionMetaChanged: (meta: Map<string, SessionRow>) => void;
  onModelsChanged: (models: ModelChoice[]) => void;
  /** Fired when `config.get` resolves on connect. Carries the workspace
   *  default model (`cfg.agents.defaults.model.primary`), any per-agent
   *  overrides (`cfg.agents.list[].model.primary`), and the default agent
   *  id (first entry in `cfg.agents.list`, falling back to "main"). Model
   *  refs are qualified `provider/model`. Used so the picker can show
   *  "Default (X)" pre-thread (where no `activeAgentId` exists yet) by
   *  resolving against `defaultAgentId`. */
  onModelDefaultsChanged: (defaults: {
    workspaceDefault: string | null;
    byAgent: Map<string, string>;
    defaultAgentId: string | null;
  }) => void;
  onKnownAgentIdsChanged: (ids: Set<string>) => void;
  /**
   * Fired when the gateway broadcasts `sessions.changed` for a session we
   * subscribe to (new transcript messages, resets, subagent completions).
   * The UI uses this to re-pull `chat.history` for the currently-viewed thread
   * even after the active run listener has been torn down.
   */
  onSessionChanged: (sessionKey: string) => void;
  /**
   * Fired when the gateway broadcasts `event cron` (a job started, completed,
   * was added, or removed). The UI uses this to refresh cron rows + post-run
   * notifications immediately, instead of waiting for the next 30 s poll.
   */
  onCronChanged: () => void;
}

export class OpenClawEngine implements Engine {
  readonly id: string;

  readonly capabilities: EngineCapabilities = {
    loadSession: true,
    listSessions: true,
    deleteSessions: true,
    multiAgent: true,
    sessionConfig: true,
    artifacts: true,
    apps: true,
    uploads: true,
  };

  private socket: GatewaySocket | null = null;
  /** Active runs keyed by sessionKey. Allows concurrent runs across threads
   * without cross-contaminating their event streams. */
  private runListeners = new Map<string, RunListener>();
  private knownAgentIds = new Set<string>();
  /** Resolves the first time `agents.list` has populated `knownAgentIds`.
   *  `resolveChatSessionKey` returns different keys depending on whether the
   *  threadId is recognized as an agent id, so any RPC that uses it must wait
   *  for hydration — otherwise a cold-start `chat.history("main")` lands on
   *  the bare `"main"` key while the post-hydration call uses the encoded
   *  `agent:main:main:openclaw-os`, splitting reads across two transcripts. */
  private _agentIdsHydrated = false;
  private _agentIdsHydratedPromise: Promise<void>;
  private _resolveAgentIdsHydrated!: () => void;
  private notificationMethodState: "unknown" | "supported" | "unsupported" = "unknown";

  private _connectionState: ConnectionState = ConnectionState.DISCONNECTED;
  private _settings: Settings | null;
  private _sessionMeta = new Map<string, SessionRow>();
  private _availableModels: ModelChoice[] = [];
  private events: OpenClawEngineEvents;

  private _isReady = false;
  private _readyDeferred: {
    promise: Promise<void>;
    resolve: () => void;
    reject: (e: Error) => void;
  } | null = null;

  /** Resolves immediately if hello-ok already fired, otherwise waits. */
  private get _engineReady(): Promise<void> {
    if (this._isReady) return Promise.resolve();
    if (!this._readyDeferred) {
      let resolve!: () => void, reject!: (e: Error) => void;
      const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      this._readyDeferred = { promise, resolve, reject };
    }
    return this._readyDeferred.promise;
  }

  constructor(config: OpenClawEngineConfig, events: OpenClawEngineEvents) {
    this.id = config.id;
    this._settings = config.gatewayUrl
      ? { gatewayUrl: config.gatewayUrl, token: config.token, deviceToken: config.deviceToken }
      : getSettings();
    this.events = events;
    this._agentIdsHydratedPromise = new Promise<void>((resolve) => {
      this._resolveAgentIdsHydrated = resolve;
    });
  }

  // ── Engine interface: stores ───────────────────────────────────────────────

  readonly conversations: ConversationStore = {
    listSessions: (agentId) => this._listSessions(agentId),
    getSession: (sessionId) => this._getSession(sessionId),
    createSession: (agentId, title) => this._createSessionRecord(agentId, title),
    deleteSession: (sessionId) => this._deleteSessionRecord(sessionId),
    renameSession: (sessionId, title) => this._renameSessionRecord(sessionId, title),
    loadHistory: (sessionId) => this._loadHistory(sessionId),
    getSessionConfig: (sessionId) => this._getSessionConfig(sessionId),
    setSessionConfig: (sessionId, key, value) => this._setSessionConfig(sessionId, key, value),
  };

  readonly artifacts: ArtifactStore = {
    listArtifacts: async (kind?: string): Promise<ArtifactSummary[]> => {
      try {
        const result = await this._request<{ artifacts: ArtifactSummary[] }>(
          "openclawos.artifacts.list",
          {
            kind,
          },
        );
        return result?.artifacts ?? [];
      } catch (error) {
        warn("artifacts.list failed:", error);
        return [];
      }
    },

    getArtifact: async (artifactId: string): Promise<ArtifactRecord | null> => {
      try {
        const result = await this._request<{ artifact: ArtifactRecord | null }>(
          "openclawos.artifacts.get",
          {
            id: artifactId,
          },
        );
        return result?.artifact ?? null;
      } catch (error) {
        warn("artifacts.get failed:", error);
        return null;
      }
    },

    deleteArtifact: async (artifactId: string): Promise<void> => {
      await this._request("openclawos.artifacts.delete", { id: artifactId });
    },
  };

  readonly apps: AppStore = {
    listApps: async (): Promise<AppSummary[]> => {
      try {
        const result = await this._request<{ apps: AppSummary[] }>("openclawos.apps.list", {});
        return result?.apps ?? [];
      } catch (error) {
        warn("apps.list failed:", error);
        return [];
      }
    },

    getApp: async (appId: string): Promise<AppRecord | null> => {
      try {
        const result = await this._request<{ app: AppRecord | null }>("openclawos.apps.get", {
          id: appId,
        });
        return result?.app ?? null;
      } catch (error) {
        warn("apps.get failed:", error);
        return null;
      }
    },

    deleteApp: async (appId: string): Promise<void> => {
      await this._request("openclawos.apps.delete", { id: appId });
    },

    invokeTool: async (
      tool: string,
      args: Record<string, unknown>,
      sessionKey?: string,
    ): Promise<unknown> => {
      const result = await this._request<{ result: unknown }>("openclawos.tools.invoke", {
        tool_name: tool,
        tool_args: args,
        ...(sessionKey ? { sessionKey } : {}),
      });
      return result?.result ?? null;
    },
  };

  readonly uploads: UploadStore = {
    putUpload: async (params): Promise<UploadMeta | null> => {
      try {
        const result = await this._request<{ upload: UploadMeta }>(
          "openclawos.uploads.put",
          params,
        );
        return result?.upload ?? null;
      } catch (error) {
        warn("uploads.put failed:", error);
        return null;
      }
    },

    listUploads: async (sessionKey?: string): Promise<UploadMeta[]> => {
      try {
        const result = await this._request<{ uploads: UploadMeta[] }>(
          "openclawos.uploads.list",
          sessionKey ? { sessionKey } : {},
        );
        return result?.uploads ?? [];
      } catch (error) {
        warn("uploads.list failed:", error);
        return [];
      }
    },

    getUpload: async (id: string): Promise<UploadRecord | null> => {
      try {
        const result = await this._request<{ upload: UploadRecord | null }>(
          "openclawos.uploads.get",
          { id },
        );
        return result?.upload ?? null;
      } catch (error) {
        warn("uploads.get failed:", error);
        return null;
      }
    },

    deleteUpload: async (id: string): Promise<void> => {
      try {
        await this._request("openclawos.uploads.delete", { id });
      } catch (error) {
        warn("uploads.delete failed:", error);
      }
    },
  };

  // Skills feature removed — see SkillsStore type in engines/types.ts (commented out).
  // readonly skills: SkillsStore = {
  //   status: async (agentId?: string): Promise<SkillStatusEntry[]> => {
  //     try {
  //       const params = agentId ? { agentId } : {};
  //       const result = await this._request<{ skills: SkillStatusEntry[] }>("skills.status", params);
  //       return result?.skills ?? [];
  //     } catch (error) {
  //       warn("skills.status failed:", error);
  //       return [];
  //     }
  //   },
  //
  //   setEnabled: async (skillKey: string, enabled: boolean): Promise<boolean> => {
  //     try {
  //       await this._request("skills.update", { skillKey, enabled });
  //       return true;
  //     } catch (error) {
  //       warn("skills.update failed:", error);
  //       return false;
  //     }
  //   },
  // };

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    this.notificationMethodState = "unknown";
    this.socket = this._createSocket(this._settings);
    if (this._settings?.gatewayUrl) this.socket.start();
  }

  async disconnect(): Promise<void> {
    this._isReady = false;
    this._readyDeferred?.reject(new Error("disconnected"));
    this._readyDeferred = null;
    this.socket?.stop();
    this.socket = null;
  }

  reconnect(newSettings: Settings): void {
    this._isReady = false;
    this._readyDeferred?.reject(new Error("reconnecting"));
    this._readyDeferred = null;
    this.notificationMethodState = "unknown";
    this._settings = newSettings;
    this.events.onSettingsChanged(newSettings);
    this.socket?.stop();
    this.socket = this._createSocket(newSettings);
    this.socket.start();
  }

  // ── Engine interface: orchestration ──────────────────────────────────────

  async listAgents(): Promise<AgentInfo[]> {
    try {
      const result = await this._request<AgentsListResult>("agents.list");
      return (result?.agents ?? []).map((a) => ({
        id: a.id,
        name: a.identity?.name ?? a.id,
      }));
    } catch (e) {
      warn("agents.list failed:", e);
      return [];
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    return this._availableModels.map((m) => ({
      id: m.id,
      name: m.name ?? m.id,
      provider: m.provider ?? "unknown",
      contextWindow: m.contextWindow,
      capabilities: m.reasoning ? { thinking: m.reasoning } : undefined,
    }));
  }

  async sendMessage(
    sessionId: string,
    messages: unknown[],
    abortController: AbortController,
  ): Promise<Response> {
    const lastMsg = messages[messages.length - 1] as {
      role?: string;
      content?: unknown;
    };
    const raw = lastMsg?.content;
    const messageText =
      typeof raw === "string"
        ? raw
        : Array.isArray(raw)
          ? raw
              .filter((c: unknown) => (c as { type?: string } | null)?.type === "text")
              .map((c: unknown) => (c as { text?: string } | null)?.text ?? "")
              .join("")
          : "";
    const attachments = Array.isArray((lastMsg as { attachments?: unknown[] } | null)?.attachments)
      ? ((lastMsg as { attachments?: unknown[] }).attachments ?? [])
          .map((item) => {
            if (!item || typeof item !== "object") return null;
            const candidate = item as Record<string, unknown>;
            const mimeType = typeof candidate["mimeType"] === "string" ? candidate["mimeType"] : "";
            const fileName = typeof candidate["fileName"] === "string" ? candidate["fileName"] : "";
            const content = typeof candidate["content"] === "string" ? candidate["content"] : "";

            if (!mimeType || !fileName || !content) return null;
            return {
              ...(typeof candidate["type"] === "string" ? { type: candidate["type"] } : {}),
              mimeType,
              fileName,
              content,
            };
          })
          .filter(
            (
              item,
            ): item is { type?: string; mimeType: string; fileName: string; content: string } =>
              item !== null,
          )
      : [];

    const sessionKey = resolveChatSessionKey(sessionId, this.knownAgentIds);
    log(`sendMessage  sessionId=${sessionId}  sessionKey=${sessionKey}`);

    await this.patchSession(sessionKey, { verboseLevel: FULL_VERBOSE_LEVEL });

    const encoder = new TextEncoder();
    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        ctrl = c;
      },
    });

    const write = (event: Record<string, unknown>) => {
      try {
        ctrl.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      } catch {
        /* closed */
      }
    };
    const closeStream = () => {
      if (this.runListeners.get(sessionKey) === listener) {
        this.runListeners.delete(sessionKey);
      }
      try {
        ctrl.close();
      } catch {
        /* already closed */
      }
    };

    // If a previous run for the same sessionKey is still tracked (shouldn't
    // happen normally since the server aborts prior runs), close it cleanly.
    const existing = this.runListeners.get(sessionKey);
    if (existing) {
      try {
        existing.onClose();
      } catch {
        /* ignore */
      }
    }

    const mapper = createOpenClawAGUIMapper(write);
    const listener: RunListener = {
      onAgentEvent: mapper.onAgentEvent,
      onChatEvent: (evt: ChatEvent) => {
        mapper.onChatEvent(evt);
        if (evt.state === "final") {
          this._refreshSessionMeta(sessionKey);
        }
        if (evt.state === "final" || evt.state === "aborted" || evt.state === "error") {
          closeStream();
        }
      },
      onClose: closeStream,
    };
    this.runListeners.set(sessionKey, listener);

    // The AbortController signal fires both on the user clicking Stop AND on
    // ChatProvider.selectThread() when the user navigates to another thread
    // (see react-headless dist/index.mjs:858,871 — cancelMessage is invoked
    // unconditionally on thread switch). Auto-firing `chat.abort` here would
    // therefore kill in-flight runs on every navigation, which (a) loses the
    // partial response server-side and (b) causes the gateway to persist the
    // partial as a `model: "gateway-injected"` message that re-renders as a
    // duplicate "Gateway"-tagged bubble (history-merger.ts treats that model
    // tag as a slash-command reply). We only close the local stream; the
    // backend run continues server-side, completes normally, and lands in
    // chat.history on the next reload — matching the openclaw web client's
    // `deliver: false` fire-and-forget semantics. Explicit Stop is available
    // via `engine.abort(sessionId)` for callers that want it.
    abortController.signal.addEventListener("abort", () => {
      closeStream();
    });

    try {
      await this.socket?.request("chat.send", {
        sessionKey,
        message: messageText,
        ...(attachments.length > 0 ? { attachments } : {}),
        idempotencyKey: crypto.randomUUID(),
        // Decouple the run lifecycle from this client's subscription. The
        // openclaw web client (ui/src/ui/controllers/chat.ts:410) does the
        // same — it lets the gateway treat the run as internal so any future
        // client disconnect doesn't cancel it.
        deliver: false,
      });
    } catch (err) {
      this.runListeners.delete(sessionKey);
      write({
        type: EventType.RUN_ERROR,
        message: err instanceof Error ? err.message : "Failed to send",
      });
      closeStream();
    }

    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "application/octet-stream" },
    });
  }

  async abort(sessionId: string): Promise<void> {
    const sessionKey = resolveChatSessionKey(sessionId, this.knownAgentIds);
    await this.socket?.request("chat.abort", { sessionKey }).catch(() => {});
  }

  // ── Engine-internal helpers used by useGateway ────────────────────────────

  async fetchThreadList(): Promise<ClawThreadListItem[]> {
    let agents: NonNullable<AgentsListResult["agents"]> = [];
    try {
      const result = await this._request<AgentsListResult>("agents.list");
      agents = result?.agents ?? [];
      log(`agents.list → ${agents.length} agent(s)`);
    } catch (e) {
      warn("agents.list failed:", e);
    }

    if (!agents.length) {
      this._setKnownAgentIds(new Set(["main"]));
      return [
        {
          id: "main",
          title: "Agent",
          createdAt: Date.now(),
          clawKind: "main",
          clawAgentId: "main",
        },
      ];
    }

    this._setKnownAgentIds(new Set(agents.map((a) => a.id)));

    const items: ClawThreadListItem[] = [];
    const metaUpdates = new Map<string, SessionRow>();

    for (const a of agents) {
      const mainKey = agentMainSessionKey(a.id);
      items.push({
        id: a.id,
        title: [a.identity?.emoji, a.identity?.name].filter(Boolean).join(" ") || a.id,
        createdAt: Date.now(),
        clawKind: "main",
        clawAgentId: a.id,
      });

      try {
        const result = await this._request<SessionsListResult>("sessions.list", {
          agentId: a.id,
          limit: 50,
        });
        const seen = new Set<string>();
        for (const row of result?.sessions ?? []) {
          metaUpdates.set(row.key, row);
          if (!hasClawSuffix(row.key) || row.key === mainKey || seen.has(row.key)) continue;
          seen.add(row.key);
          items.push({
            id: row.key,
            title: sessionRowTitle(row),
            createdAt: row.updatedAt ?? Date.now(),
            clawKind: "extra",
            clawAgentId: a.id,
          });
        }
      } catch (e) {
        warn(`sessions.list failed for ${a.id}:`, e);
      }
    }

    if (metaUpdates.size > 0) {
      for (const [k, v] of metaUpdates) this._sessionMeta.set(k, v);
      this.events.onSessionMetaChanged(new Map(this._sessionMeta));
    }

    return items;
  }

  async patchSession(sessionKey: string, patch: Record<string, unknown>): Promise<boolean> {
    log("patchSession", sessionKey, patch);
    try {
      await this._request("sessions.patch", { key: sessionKey, ...patch });
      const localPatch = normalizeSessionPatch(patch);
      this._sessionMeta.set(sessionKey, {
        ...this._sessionMeta.get(sessionKey),
        key: sessionKey,
        ...localPatch,
      } as SessionRow);
      this.events.onSessionMetaChanged(new Map(this._sessionMeta));
      // A `model` change re-derives `thinkingDefault` / `thinkingOptions` on
      // the gateway side. Pull the fresh row so the composer's effort dropdown
      // reflects the new model immediately, instead of waiting for the next
      // chat run's `state:"final"` refresh.
      if ("model" in patch) {
        this._refreshSessionMeta(sessionKey);
      }
      return true;
    } catch (e) {
      warn("sessions.patch failed:", e);
      return false;
    }
  }

  async listNotifications(): Promise<NotificationRecord[]> {
    if (this.notificationMethodState === "unsupported") {
      return [];
    }

    try {
      const result = await this._request<NotificationsListResult>("openclawos.notifications.list");
      this.notificationMethodState = "supported";
      return result?.notifications ?? [];
    } catch (e) {
      if (this.isUnknownMethodError(e, "openclawos.notifications.list")) {
        this.notificationMethodState = "unsupported";
        warn("notifications.list unavailable on the current gateway runtime");
        return [];
      }
      warn("notifications.list failed:", e);
      return [];
    }
  }

  async markNotificationsRead(ids?: string[]): Promise<boolean> {
    if (this.notificationMethodState === "unsupported") {
      return false;
    }

    try {
      await this._request("openclawos.notifications.read", {
        ...(ids && ids.length > 0 ? { ids } : {}),
      });
      this.notificationMethodState = "supported";
      return true;
    } catch (e) {
      if (this.isUnknownMethodError(e, "openclawos.notifications.read")) {
        this.notificationMethodState = "unsupported";
        warn("notifications.read unavailable on the current gateway runtime");
        return false;
      }
      warn("notifications.read failed:", e);
      return false;
    }
  }

  async upsertNotification(
    notification: Omit<NotificationRecord, "id" | "createdAt" | "updatedAt" | "unread" | "readAt">,
  ): Promise<boolean> {
    if (this.notificationMethodState === "unsupported") {
      return false;
    }

    try {
      await this._request("openclawos.notifications.upsert", notification);
      this.notificationMethodState = "supported";
      return true;
    } catch (e) {
      if (this.isUnknownMethodError(e, "openclawos.notifications.upsert")) {
        this.notificationMethodState = "unsupported";
        warn("notifications.upsert unavailable on the current gateway runtime");
        return false;
      }
      warn("notifications.upsert failed:", e);
      return false;
    }
  }

  async listCronJobs(): Promise<CronJobRecord[]> {
    try {
      const result = await this._request<{ jobs?: CronJobRecord[] }>("cron.list", {
        limit: 20,
        includeDisabled: true,
      });
      return Array.isArray(result?.jobs) ? result.jobs : [];
    } catch (e) {
      warn("cron.list failed:", e);
      return [];
    }
  }

  async listCronRuns(): Promise<CronRunEntry[]> {
    try {
      const result = await this._request<{ entries?: CronRunEntry[] }>("cron.runs", {
        scope: "all",
        limit: 20,
      });
      return Array.isArray(result?.entries) ? result.entries : [];
    } catch (e) {
      warn("cron.runs failed:", e);
      return [];
    }
  }

  async getCronStatus(): Promise<CronStatusRecord | null> {
    try {
      return await this._request<CronStatusRecord>("cron.status", {});
    } catch (e) {
      warn("cron.status failed:", e);
      return null;
    }
  }

  async updateCronJob(id: string, patch: Record<string, unknown>): Promise<boolean> {
    try {
      await this._request("cron.update", { id, patch });
      return true;
    } catch (e) {
      warn("cron.update failed:", e);
      return false;
    }
  }

  /**
   * Triggers an ad-hoc run of a cron job.
   * - "force" (default) runs immediately even if the job is paused (disabled).
   *   This matches what the user means when they hit "Run now" on a paused
   *   row in the UI.
   * - "due" only runs if the schedule says it's currently due — useful for
   *   testing the dispatcher; not surfaced in the UI today.
   */
  async runCronJob(id: string, mode: "force" | "due" = "force"): Promise<boolean> {
    try {
      await this._request("cron.run", { id, mode });
      return true;
    } catch (e) {
      warn("cron.run failed:", e);
      return false;
    }
  }

  async removeCronJob(id: string): Promise<boolean> {
    try {
      await this._request("cron.remove", { id });
      return true;
    } catch (e) {
      warn("cron.remove failed:", e);
      return false;
    }
  }

  // ── Public state accessors ────────────────────────────────────────────────

  get connectionState(): ConnectionState {
    return this._connectionState;
  }
  get settings(): Settings | null {
    return this._settings;
  }
  get sessionMeta(): Map<string, SessionRow> {
    return this._sessionMeta;
  }
  get availableModels(): ModelChoice[] {
    return this._availableModels;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Awaits engine readiness (socket creation + hello-ok handshake) then
   * delegates to socket.request. Use for all data RPCs so they automatically
   * wait even when called before connect() has run (e.g. from child component
   * effects that fire before the parent's useGateway effect).
   */
  private async _request<T>(method: string, params?: unknown): Promise<T> {
    await this._engineReady;
    return this.socket!.request<T>(method, params);
  }

  private _createSocket(settings: Settings | null): GatewaySocket {
    return new GatewaySocket({
      getSettings: () => settings ?? getSettings(),
      getDevice: getOrCreateDeviceIdentity,
      onHelloOk: this._handleHelloOk,
      onAuthFailed: this._handleAuthFailed,
      onPairingRequired: (deviceId: string) => {
        log(`pairing required — device ${deviceId}`);
        this.events.onPairingRequired(deviceId);
        this._setConnectionState(ConnectionState.PAIRING);
      },
      onEvent: this._handleEvent,
      onStateChange: (connecting: boolean) => {
        // Don't downgrade UNREACHABLE → DISCONNECTED on the post-give-up
        // onStateChange(false). UNREACHABLE is the terminal label until the
        // user explicitly retries via reconnect().
        if (this._connectionState === ConnectionState.UNREACHABLE && !connecting) return;
        log(`state → ${connecting ? "CONNECTING" : "DISCONNECTED"}`);
        this._setConnectionState(
          connecting ? ConnectionState.CONNECTING : ConnectionState.DISCONNECTED,
        );
      },
      onUnreachable: () => {
        log("state → UNREACHABLE");
        this._setConnectionState(ConnectionState.UNREACHABLE);
      },
    });
  }

  private _setConnectionState(state: ConnectionState): void {
    this._connectionState = state;
    this.events.onConnectionStateChange(state);
  }

  private _setKnownAgentIds(ids: Set<string>): void {
    this.knownAgentIds = ids;
    this.events.onKnownAgentIdsChanged(ids);
    if (!this._agentIdsHydrated) {
      this._agentIdsHydrated = true;
      this._resolveAgentIdsHydrated();
    }
  }

  private _handleEvent = (frame: EventFrame): void => {
    const payload = frame.payload as Record<string, unknown> | undefined;
    if (!payload) return;
    const sessionKey =
      typeof (payload as { sessionKey?: unknown }).sessionKey === "string"
        ? (payload as { sessionKey: string }).sessionKey
        : null;

    // Broadcasts from `sessions.subscribe` arrive as event:"sessions.changed"
    // with a sessionKey on the payload. Route to the UI-level subscriber so
    // out-of-band transcript changes (subagent completions, external
    // sessions.send, resets) can trigger a chat.history reload.
    if (frame.event === "sessions.changed") {
      if (sessionKey) {
        this.events.onSessionChanged(sessionKey);
      } else {
        warn("sessions.changed frame missing sessionKey:", frame);
      }
      return;
    }

    // Cron broadcasts (`event:"cron"`) carry job-id / phase metadata, but the
    // UI just needs "something changed — refetch". Coalescing the refetch is
    // the consumer's job (cf. useGateway's debounced `refreshCronData`).
    if (frame.event === "cron") {
      this.events.onCronChanged();
      return;
    }

    if (!sessionKey) return;
    const listener = this.runListeners.get(sessionKey);
    if (!listener) return;
    if (frame.event === "agent") {
      listener.onAgentEvent(payload as unknown as AgentEvent);
      if (
        (payload as { stream?: string }).stream === "lifecycle" &&
        (payload as { data?: { phase?: string } }).data?.phase === "error"
      ) {
        listener.onClose();
      }
    } else if (frame.event === "chat") {
      listener.onChatEvent(payload as unknown as ChatEvent);
    }
  };

  /** RPC: subscribe to `sessions.changed` broadcasts for all sessions we can see. */
  async subscribeSessions(): Promise<void> {
    try {
      await this._request("sessions.subscribe", {});
    } catch (error) {
      warn("sessions.subscribe failed:", error);
    }
  }

  /** RPC: reset a session's transcript. Returns true on success.
   *  Gateway schema uses `key`, not `sessionKey`. */
  async resetSession(sessionKey: string): Promise<boolean> {
    try {
      await this._request("sessions.reset", { key: sessionKey });
      return true;
    } catch (error) {
      warn("sessions.reset failed:", error);
      return false;
    }
  }

  /** RPC: run compaction on the session. Returns the rich gateway payload so
   *  the UI can show token-count deltas. `ok: false` means the RPC failed;
   *  `ok: true` + `compacted: false` means the gateway succeeded but had
   *  nothing to compact (below threshold, no transcript, etc.). */
  async compactSession(sessionKey: string): Promise<CompactSessionResult> {
    try {
      const result = await this._request<CompactSessionResponse>("sessions.compact", {
        key: sessionKey,
      });
      return {
        ok: result?.ok ?? true,
        compacted: result?.compacted ?? false,
        tokensBefore: result?.result?.tokensBefore ?? null,
        tokensAfter: result?.result?.tokensAfter ?? null,
        reason: result?.reason ?? null,
      };
    } catch (error) {
      warn("sessions.compact failed:", error);
      return {
        ok: false,
        compacted: false,
        tokensBefore: null,
        tokensAfter: null,
        reason: null,
      };
    }
  }

  /** RPC: fetch slash commands registered on the gateway (native + plugin). */
  async fetchGatewayCommands(agentId = "main"): Promise<GatewayCommand[]> {
    try {
      const result = await this._request<{ commands?: GatewayCommandRaw[] }>("commands.list", {
        agentId,
        scope: "both",
        includeArgs: true,
      });
      const raw = result?.commands ?? [];
      const out: GatewayCommand[] = [];
      for (const c of raw) {
        const aliases = Array.isArray(c.textAliases) ? (c.textAliases as unknown[]) : [];
        const firstAlias = aliases.find((a) => typeof a === "string") as string | undefined;
        const name =
          (typeof c.name === "string" && c.name) ||
          (typeof c.nativeName === "string" && c.nativeName) ||
          firstAlias ||
          "";
        if (!name) continue;
        const argHint = Array.isArray(c.args)
          ? (c.args as Array<{ name?: unknown }>)
              .map((a) => (typeof a?.name === "string" ? a.name : null))
              .filter((v): v is string => !!v)
              .map((v) => `<${v}>`)
              .join(" ")
          : undefined;
        out.push({
          key: name,
          name,
          description: typeof c.description === "string" ? c.description : "",
          ...(argHint ? { argHint } : {}),
        });
      }
      return out;
    } catch (error) {
      warn("commands.list failed:", error);
      return [];
    }
  }

  private _handleHelloOk = (hello: HelloOk): void => {
    if (hello.auth?.deviceToken) {
      log("saving new deviceToken from hello-ok");
      saveDeviceToken(hello.auth.deviceToken);
      if (this._settings) {
        const updated = { ...this._settings, deviceToken: hello.auth.deviceToken };
        this._settings = updated;
        this.events.onSettingsChanged(updated);
      }
    }
    log("connected ✓");
    this.events.onPairingRequired(null);
    this._setConnectionState(ConnectionState.CONNECTED);
    this._isReady = true;
    this._readyDeferred?.resolve();
    void this._refreshModels();
    void this._refreshConfig();
  };

  private _handleAuthFailed = (): void => {
    const current = getSettings();
    if (current?.deviceToken && current?.token) {
      warn("deviceToken rejected — clearing and retrying with raw token");
      clearDeviceToken();
      if (this._settings) {
        const { deviceToken: _dt, ...rest } = this._settings as Settings & { deviceToken?: string };
        this._settings = rest as Settings;
        this.events.onSettingsChanged(this._settings);
      }
    } else {
      warn("all auth credentials failed — prompting user");
      clearAuthCredentials();
      this._setConnectionState(ConnectionState.AUTH_FAILED);
      this._isReady = false;
      this._readyDeferred?.reject(new Error("auth failed"));
      this._readyDeferred = null;
      this.events.onAuthFailed();
    }
  };

  private async _refreshModels(): Promise<void> {
    try {
      const result = await this._request<ModelsListResult>("models.list");
      this._availableModels = result?.models ?? [];
      this.events.onModelsChanged(this._availableModels);
      log(`models.list → ${this._availableModels.length} model(s)`);
    } catch (e) {
      warn("models.list failed:", e);
    }
  }

  /**
   * Fetches the gateway's full config snapshot once on connect to learn the
   * workspace default model and any per-agent overrides. We use `config.get`
   * because `models.list` doesn't expose `defaultId` and `agents.list` doesn't
   * carry `model.primary` per agent in this openclaw build — config is the
   * single source of truth for those refs.
   *
   * The response wraps the config under `resolved` (merged effective view).
   * Per-agent `model` may be a bare string ref OR a `{primary}` object —
   * normalize both shapes.
   */
  private async _refreshConfig(): Promise<void> {
    try {
      const result = await this._request<ConfigGetResult>("config.get");
      const cfg = result?.resolved ?? result?.parsed;
      const workspaceDefault = cfg?.agents?.defaults?.model?.primary?.trim() || null;
      const byAgent = new Map<string, string>();
      const list = cfg?.agents?.list ?? [];
      for (const entry of list) {
        const id = entry?.id?.trim();
        if (!id) continue;
        const rawModel = entry.model;
        const primary =
          typeof rawModel === "string" ? rawModel.trim() : (rawModel?.primary?.trim() ?? "");
        if (primary) byAgent.set(id, primary);
      }
      // Mirror openclaw's `resolveDefaultAgentId`: first configured agent,
      // or the implicit "main" when the list is empty. This is the agent
      // any pre-thread composer would route to, so the picker uses its
      // override as the default before a thread is selected.
      const defaultAgentId = list[0]?.id?.trim() || "main";
      this.events.onModelDefaultsChanged({ workspaceDefault, byAgent, defaultAgentId });
      log(
        `config.get → workspaceDefault=${workspaceDefault ?? "(none)"}, perAgentOverrides=${byAgent.size}, defaultAgentId=${defaultAgentId}`,
      );
    } catch (e) {
      warn("config.get failed:", e);
    }
  }

  private _refreshSessionMeta(sessionKey: string): void {
    // The gateway's `sessions.get` returns only `{ messages }` and `chat.history`
    // returns `{ messages, thinkingLevel, verboseLevel }` — neither carries the
    // full row (no `model`, `thinkingDefault`, `thinkingOptions`). Only
    // `sessions.list` does, so we refetch the agent's session list and pick out
    // our row.
    const agentId = extractAgentIdFromKey(sessionKey);
    if (!agentId) return;
    this._request<SessionsListResult>("sessions.list", { agentId, limit: 50 })
      .then((result) => {
        const row = result?.sessions?.find((r) => r.key === sessionKey);
        if (!row) return;
        this._sessionMeta.set(sessionKey, row);
        this.events.onSessionMetaChanged(new Map(this._sessionMeta));
      })
      .catch((e) => warn("sessions.list (refresh) failed:", e));
  }

  private isUnknownMethodError(error: unknown, method: string): boolean {
    if (!(error instanceof Error)) return false;

    if (error.message.includes(`unknown method: ${method}`)) {
      return true;
    }

    const causeMessage =
      typeof (error as Error & { cause?: unknown }).cause === "object" &&
      (error as Error & { cause?: { message?: string } }).cause &&
      typeof (error as Error & { cause?: { message?: string } }).cause?.message === "string"
        ? (error as Error & { cause?: { message?: string } }).cause?.message
        : null;

    return causeMessage?.includes(`unknown method: ${method}`) ?? false;
  }

  // ── ConversationStore implementation ──────────────────────────────────────

  private async _listSessions(agentId?: string): Promise<SessionInfo[]> {
    try {
      const result = await this._request<SessionsListResult>(
        "sessions.list",
        agentId ? { agentId, limit: 100 } : { limit: 100 },
      );
      return (result?.sessions ?? []).map((row) => ({
        id: row.key,
        agentId: agentId ?? "",
        title: sessionRowTitle(row),
        createdAt: new Date(row.updatedAt ?? Date.now()).toISOString(),
        updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : undefined,
      }));
    } catch (e) {
      warn("sessions.list failed:", e);
      return [];
    }
  }

  private async _getSession(sessionId: string): Promise<SessionInfo | null> {
    const sessionKey = resolveChatSessionKey(sessionId, this.knownAgentIds);
    try {
      const result = await this._request<SessionGetResult>("sessions.get", { key: sessionKey });
      if (!result?.session) return null;
      const row = result.session;
      return {
        id: sessionId,
        agentId: "",
        title: sessionRowTitle(row),
        createdAt: new Date(row.updatedAt ?? Date.now()).toISOString(),
        updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : undefined,
      };
    } catch (e) {
      warn("sessions.get failed:", e);
      return null;
    }
  }

  private async _createSessionRecord(agentId: string, title?: string): Promise<SessionInfo> {
    const key = encodeExtra(agentId);
    log("createSession", agentId, key, title ? `"${title}"` : "");
    try {
      await this._request("sessions.create", {
        agentId,
        key,
        // `label` is the gateway field that backs the session title in
        // `sessions.list`; passing it here means callers who supply a title
        // at create time get a labelled session immediately, with no
        // separate `sessions.patch` round-trip.
        ...(title ? { label: title } : {}),
      });
    } catch (e) {
      warn("sessions.create failed:", e);
    }
    return { id: key, agentId, createdAt: new Date().toISOString() };
  }

  private async _deleteSessionRecord(sessionId: string): Promise<void> {
    const sessionKey = resolveChatSessionKey(sessionId, this.knownAgentIds);
    await this._request("sessions.delete", {
      key: sessionKey,
      deleteTranscript: true,
    });
    // Best-effort cleanup of uploads bound to this session.
    try {
      await this._request("openclawos.uploads.deleteBySession", { sessionKey });
    } catch (error) {
      warn("uploads.deleteBySession failed:", error);
    }
  }

  private async _renameSessionRecord(sessionId: string, title: string): Promise<void> {
    const sessionKey = resolveChatSessionKey(sessionId, this.knownAgentIds);
    await this._request("sessions.patch", { key: sessionKey, label: title });
  }

  private async _loadHistory(sessionId: string): Promise<StoredMessage[]> {
    // Wait for `agents.list` to populate `knownAgentIds` before resolving the
    // session key. Otherwise a cold-start call with `sessionId === "main"`
    // returns the bare `"main"` key (because the agent id isn't in the set
    // yet), which addresses a different transcript on the gateway than the
    // post-hydration encoded form `agent:main:main:openclaw-os`.
    await this._agentIdsHydratedPromise;
    const sessionKey = resolveChatSessionKey(sessionId, this.knownAgentIds);
    log(`loadHistory  sessionId=${sessionId}  sessionKey=${sessionKey}`);
    try {
      const result = await this._request<{
        messages?: ChatHistoryMessage[];
      }>("chat.history", { sessionKey, limit: 200 });
      const raw = result?.messages ?? [];
      log(`chat.history returned ${raw.length} messages`);
      return mergedToStored(mergeHistoryMessages(raw));
    } catch (e) {
      warn("chat.history failed:", e);
      return [];
    }
  }

  private async _getSessionConfig(sessionId: string): Promise<Record<string, string>> {
    const sessionKey = resolveChatSessionKey(sessionId, this.knownAgentIds);
    try {
      const result = await this._request<SessionGetResult>("sessions.get", { key: sessionKey });
      if (!result?.session) return {};
      const { model, thinkingLevel } = result.session;
      const config: Record<string, string> = {};
      if (model) config["model"] = model;
      if (thinkingLevel) config["thinkingLevel"] = thinkingLevel;
      return config;
    } catch (e) {
      warn("sessions.get (config) failed:", e);
      return {};
    }
  }

  private async _setSessionConfig(sessionId: string, key: string, value: string): Promise<void> {
    await this.patchSession(resolveChatSessionKey(sessionId, this.knownAgentIds), { [key]: value });
  }
}
