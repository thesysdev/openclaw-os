"use client";

import { separateContentAndContext } from "@/lib/content-parser";
import {
  OpenClawEngine,
  resolveChatSessionKey,
  type CompactSessionResult,
} from "@/lib/engines/openclaw/OpenClawEngine";
import type {
  AppStore,
  ArtifactStore,
  GatewayCommand,
  StoredMessage,
  UploadStore,
} from "@/lib/engines/types";
import { ConnectionState } from "@/lib/gateway/types";
import type { Settings } from "@/lib/storage";
import { getSettings, saveSettings } from "@/lib/storage";
import { deriveTitleFromText, isOpaqueSessionTitle } from "@/lib/thread-titles";
import type { ClawThreadListItem, ModelChoice, SessionRow } from "@/types/gateway-responses";
import { EventType } from "@openuidev/react-headless";
import { useCallback, useEffect, useRef, useState } from "react";
import { sessionRouteIdFromSessionKey } from "./session-routing";
import { useCronGateway } from "./useCronGateway";
import { useNotificationsGateway } from "./useNotificationsGateway";

export type { ClawThreadListItem, ModelChoice, SessionRow } from "@/types/gateway-responses";
export { resolveChatSessionKey, sessionRouteIdFromSessionKey };

function extractUserMessageText(content: unknown): string {
  if (typeof content === "string") {
    return separateContentAndContext(content).content ?? "";
  }

  if (!Array.isArray(content)) return "";

  return content
    .flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      const candidate = part as { type?: string; text?: unknown };
      return candidate.type === "text" && typeof candidate.text === "string"
        ? [candidate.text]
        : [];
    })
    .join(" ")
    .trim();
}

function deriveThreadTitleFromMessages(messages: unknown[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const candidate = messages[i];
    if (!candidate || typeof candidate !== "object") continue;

    const messageLike = candidate as { role?: string; content?: unknown };
    if (messageLike.role !== "user") continue;

    const title = deriveTitleFromText(extractUserMessageText(messageLike.content));
    if (title) return title;
  }

  return null;
}

export function useGateway({ onAuthFailed }: { onAuthFailed: () => void }) {
  const threadListRefreshFnRef = useRef<(() => void) | null>(null);
  const requestThreadListRefresh = useCallback((fn: () => void) => {
    threadListRefreshFnRef.current = fn;
  }, []);

  const [connectionState, setConnectionState] = useState<ConnectionState>(
    ConnectionState.DISCONNECTED,
  );
  const [settings, setSettings] = useState<Settings | null>(() => getSettings());
  const [pairingDeviceId, setPairingDeviceId] = useState<string | null>(null);
  const [sessionMeta, setSessionMeta] = useState<Map<string, SessionRow>>(() => new Map());
  const [availableModels, setAvailableModels] = useState<ModelChoice[]>([]);
  const [gatewayDefaultModelId, setGatewayDefaultModelId] = useState<string | null>(null);
  const [agentModelById, setAgentModelById] = useState<Map<string, string>>(() => new Map());
  const [defaultAgentId, setDefaultAgentId] = useState<string | null>(null);
  const [artifacts, setArtifacts] = useState<ArtifactStore | undefined>(undefined);
  const [apps, setApps] = useState<AppStore | undefined>(undefined);
  const [uploads, setUploads] = useState<UploadStore | undefined>(undefined);
  const [gatewayCommands, setGatewayCommands] = useState<GatewayCommand[]>([]);

  const onAuthFailedRef = useRef(onAuthFailed);
  useEffect(() => {
    onAuthFailedRef.current = onAuthFailed;
  }, [onAuthFailed]);

  const knownAgentIds = useRef<Set<string>>(new Set());
  const attemptedAutoTitlesRef = useRef<Map<string, string>>(new Map());
  const engineRef = useRef<OpenClawEngine | null>(null);
  const sessionMetaRef = useRef(sessionMeta);
  // Subscribers for `sessions.changed` broadcasts — populated by consumers
  // via `onSessionChanged(...)` and drained when the gateway fires an event.
  const sessionChangedListenersRef = useRef<Set<(sessionKey: string) => void>>(new Set());
  // Cron-event refresh plumbing. The engine fires `onCronChanged` from
  // `_handleEvent`, which schedules a debounced refetch. We can't reference
  // `refreshCronData` directly inside the engine callback (it isn't defined
  // yet), so a ref is the connector.
  const cronRefreshFnRef = useRef<(() => Promise<unknown>) | null>(null);
  const cronRefreshTimerRef = useRef<number | null>(null);

  // Notifications + cron live in their own sub-hooks. Cron depends on
  // notifications so that cron-run upserts can patch the cached list without
  // a redundant `listNotifications` round-trip.
  const {
    notifications,
    setNotifications,
    refreshNotifications,
    markNotificationsRead,
    upsertNotification,
  } = useNotificationsGateway(engineRef);

  const {
    cronJobs,
    cronRuns,
    cronStatus,
    refreshCronData,
    updateCronJob,
    runCronJob,
    removeCronJob,
  } = useCronGateway(
    engineRef,
    knownAgentIds,
    connectionState,
    refreshNotifications,
    setNotifications,
  );

  // Keep the engine-side cron callback pointing at the latest closure.
  useEffect(() => {
    cronRefreshFnRef.current = refreshCronData;
  }, [refreshCronData]);

  useEffect(() => {
    sessionMetaRef.current = sessionMeta;
  }, [sessionMeta]);

  useEffect(() => {
    const s = getSettings();
    const engine = new OpenClawEngine(
      {
        id: "default",
        name: "Default",
        enabled: true,
        gatewayUrl: s?.gatewayUrl ?? "",
        token: s?.token,
        deviceToken: s?.deviceToken,
      },
      {
        onConnectionStateChange: setConnectionState,
        onPairingRequired: setPairingDeviceId,
        onAuthFailed: () => onAuthFailedRef.current(),
        onSettingsChanged: (updated) => {
          setSettings(updated);
          saveSettings(updated);
        },
        onSessionMetaChanged: setSessionMeta,
        onModelsChanged: setAvailableModels,
        onModelDefaultsChanged: ({ workspaceDefault, byAgent, defaultAgentId: nextDefault }) => {
          setGatewayDefaultModelId(workspaceDefault);
          setAgentModelById(new Map(byAgent));
          setDefaultAgentId(nextDefault);
        },
        onKnownAgentIdsChanged: (ids) => {
          knownAgentIds.current = ids;
        },
        onSessionChanged: (sessionKey) => {
          for (const listener of sessionChangedListenersRef.current) {
            try {
              listener(sessionKey);
            } catch (err) {
              console.warn("[claw] onSessionChanged listener threw:", err);
            }
          }
        },
        // Coalesce bursts: cron events can arrive in pairs (started → completed
        // within milliseconds). A short trailing debounce keeps refetch traffic
        // sane while still feeling instant in the UI.
        onCronChanged: () => {
          if (cronRefreshTimerRef.current !== null) return;
          cronRefreshTimerRef.current = window.setTimeout(() => {
            cronRefreshTimerRef.current = null;
            void cronRefreshFnRef.current?.().catch((err) => {
              console.warn("[claw] cron refresh after event failed:", err);
            });
          }, 150);
        },
      },
    );
    engineRef.current = engine;
    setArtifacts(engine.artifacts);
    setApps(engine.apps);
    setUploads(engine.uploads);
    void engine.connect();
    return () => {
      void engine.disconnect();
    };
    // Only run once on mount
  }, []);

  const reconnect = useCallback((newSettings: Settings) => {
    engineRef.current?.reconnect(newSettings);
  }, []);

  // User-initiated abort. Tells the gateway to stop the in-flight run on
  // `threadId`. The engine's AbortController-listener intentionally does NOT
  // fire `chat.abort` (it'd also fire on every thread switch via
  // `ChatProvider.selectThread`, killing background runs). This callback is
  // the explicit "Stop button" path the composer wires up.
  const abort = useCallback(async (threadId: string): Promise<void> => {
    await engineRef.current?.abort(threadId);
  }, []);

  const processMessage = useCallback(
    async (params: {
      messages: unknown[];
      abortController: AbortController;
      threadId?: string;
    }): Promise<Response> => {
      const { messages, abortController, threadId } = params;

      if (!threadId) {
        return new Response(
          JSON.stringify({
            type: EventType.RUN_ERROR,
            message: "No agent selected. Choose an agent from the sidebar.",
          }) + "\n",
          { status: 200, headers: { "Content-Type": "application/octet-stream" } },
        );
      }

      if (!engineRef.current) {
        return new Response(
          JSON.stringify({ type: EventType.RUN_ERROR, message: "Engine not initialized." }) + "\n",
          { status: 200, headers: { "Content-Type": "application/octet-stream" } },
        );
      }

      if (!knownAgentIds.current.has(threadId)) {
        const sessionKey = resolveChatSessionKey(threadId, knownAgentIds.current);
        const session = sessionMetaRef.current.get(sessionKey);
        const serverTitle = session?.label ?? session?.displayName ?? session?.derivedTitle ?? null;

        if (!serverTitle || isOpaqueSessionTitle(serverTitle, sessionKey)) {
          const derivedTitle = deriveThreadTitleFromMessages(messages);
          if (derivedTitle && attemptedAutoTitlesRef.current.get(sessionKey) !== derivedTitle) {
            // Mark optimistically *before* awaiting so we don't fire two
            // patches in parallel for the same title; clear on failure so a
            // retry isn't permanently blocked.
            attemptedAutoTitlesRef.current.set(sessionKey, derivedTitle);
            engineRef.current
              .patchSession(sessionKey, { label: derivedTitle })
              .then((ok) => {
                if (!ok) {
                  attemptedAutoTitlesRef.current.delete(sessionKey);
                  return;
                }
                // Refresh the sidebar so the new title (and the row itself,
                // if it was missing) shows up without waiting for the next
                // reconnect.
                threadListRefreshFnRef.current?.();
              })
              .catch(() => {
                attemptedAutoTitlesRef.current.delete(sessionKey);
              });
          }
        }
      }

      return engineRef.current.sendMessage(threadId, messages, abortController);
    },
    [],
  );

  const fetchThreadList = useCallback(
    async (): Promise<ClawThreadListItem[]> => engineRef.current?.fetchThreadList() ?? [],
    [],
  );

  const loadThread = useCallback(
    async (threadId: string): Promise<StoredMessage[]> =>
      engineRef.current?.conversations.loadHistory(threadId) ?? [],
    [],
  );

  const createSession = useCallback(async (agentId: string): Promise<string | null> => {
    const session = await engineRef.current?.conversations.createSession(agentId);
    return session?.id ?? null;
  }, []);

  const deleteSession = useCallback(async (threadId: string): Promise<boolean> => {
    // `ConversationStore.deleteSession` returns `Promise<void>` and throws on
    // failure. Map to a boolean here for callers that branch on it.
    const store = engineRef.current?.conversations;
    if (!store) return false;
    try {
      await store.deleteSession(threadId);
      // Drop any auto-title dedup entry for this session so a future session
      // reusing the same key (rare, but the gateway has no global ban) can
      // re-derive its title (B25 — was leaking forever).
      const sessionKey = resolveChatSessionKey(threadId, knownAgentIds.current);
      attemptedAutoTitlesRef.current.delete(sessionKey);
      return true;
    } catch {
      return false;
    }
  }, []);

  const renameSession = useCallback(async (threadId: string, label: string): Promise<boolean> => {
    try {
      await engineRef.current?.conversations.renameSession(threadId, label);
      return true;
    } catch {
      return false;
    }
  }, []);

  const resetSession = useCallback(
    async (sessionKey: string): Promise<boolean> =>
      engineRef.current?.resetSession(sessionKey) ?? false,
    [],
  );

  const compactSession = useCallback(
    async (sessionKey: string): Promise<CompactSessionResult> =>
      engineRef.current?.compactSession(sessionKey) ?? {
        ok: false,
        compacted: false,
        tokensBefore: null,
        tokensAfter: null,
        reason: null,
      },
    [],
  );

  const patchSession = useCallback(
    async (sessionKey: string, patch: Record<string, unknown>): Promise<boolean> =>
      engineRef.current?.patchSession(sessionKey, patch) ?? false,
    [],
  );

  // Pull the gateway's native slash-command catalog + subscribe to
  // `sessions.changed` once per connect. Autocomplete needs the commands;
  // `sessions.changed` lets us know when a transcript mutated out of band
  // (subagent completions, external sessions.send, etc.) so we can re-fetch.
  useEffect(() => {
    if (connectionState !== ConnectionState.CONNECTED) {
      setGatewayCommands([]);
      return;
    }
    let cancelled = false;
    void engineRef.current
      ?.fetchGatewayCommands()
      .then((commands) => {
        if (!cancelled) setGatewayCommands(commands);
      })
      .catch((err) => console.warn("[claw] fetchGatewayCommands failed:", err));
    void engineRef.current?.subscribeSessions();
    return () => {
      cancelled = true;
    };
  }, [connectionState]);

  /** Subscribe to `sessions.changed` events for any session. Returns an
   *  unsubscribe function. Consumers typically filter on sessionKey to react
   *  only when their own thread changes. */
  const onSessionChanged = useCallback((listener: (sessionKey: string) => void) => {
    sessionChangedListenersRef.current.add(listener);
    return () => {
      sessionChangedListenersRef.current.delete(listener);
    };
  }, []);

  return {
    connectionState,
    pairingDeviceId,
    settings,
    processMessage,
    fetchThreadList,
    loadThread,
    createSession,
    deleteSession,
    resetSession,
    compactSession,
    renameSession,
    reconnect,
    abort,
    requestThreadListRefresh,
    sessionMeta,
    availableModels,
    gatewayDefaultModelId,
    agentModelById,
    defaultAgentId,
    patchSession,
    knownAgentIds,
    artifacts,
    apps,
    uploads,
    notifications,
    refreshNotifications,
    markNotificationsRead,
    upsertNotification,
    cronJobs,
    cronRuns,
    cronStatus,
    refreshCronData,
    updateCronJob,
    runCronJob,
    removeCronJob,
    gatewayCommands,
    onSessionChanged,
  };
}
