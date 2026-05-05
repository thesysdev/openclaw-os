"use client";

import { AgentsView } from "@/components/agents/AgentsView";
import { AppDetail, type AppContinueConversationHandler } from "@/components/apps/AppDetail";
import { AppsView } from "@/components/apps/AppsView";
import { ArtifactDetail } from "@/components/artifacts/ArtifactDetail";
import { ArtifactsView } from "@/components/artifacts/ArtifactsView";
import { AgentTopBar } from "@/components/chat/AgentTopBar";
import { EmptyAgentHero } from "@/components/chat/EmptyAgentHero";
import { EmptyChatWelcome } from "@/components/chat/EmptyChatWelcome";
import { TopBar } from "@/components/chat/TopBar";
import { CommandPalette } from "@/components/CommandPalette";
import { CronsView } from "@/components/crons/CronsView";
import { CronTrayHost } from "@/components/crons/CronTrayHost";
import { HomeView } from "@/components/home/HomeView";
import { AppSidebar } from "@/components/layout/AppSidebar";
import { ClawThreadContainer } from "@/components/layout/ClawThreadContainer";
import { DetailTopBar } from "@/components/layout/DetailTopBar";
import { MobileShell } from "@/components/layout/MobileShell";
import { IconButton } from "@/components/layout/sidebar/IconButton";
import { CategoryTile, TextTile } from "@/components/layout/sidebar/Tile";
import { MobileAgentsView } from "@/components/mobile/MobileAgentsView";
import { MobileAgentTopBar } from "@/components/mobile/MobileAgentTopBar";
import { MobileAppDetail } from "@/components/mobile/MobileAppDetail";
import { MobileAppsView } from "@/components/mobile/MobileAppsView";
import { MobileArtifactDetail } from "@/components/mobile/MobileArtifactDetail";
import { MobileArtifactsView } from "@/components/mobile/MobileArtifactsView";
import { MobileCronsView } from "@/components/mobile/MobileCronsView";
import { MobileHomeView } from "@/components/mobile/MobileHomeView";
import { MobileNotificationInboxDrawer } from "@/components/mobile/MobileNotificationInboxDrawer";
import { MobileSettingsDialog } from "@/components/mobile/MobileSettingsDialog";
import { MobileWorkspaceDrawer } from "@/components/mobile/MobileWorkspaceDrawer";
import { AssistantMessage } from "@/components/rendering/AssistantMessage";
import { UserMessage } from "@/components/rendering/UserMessage";
import { SessionComposer } from "@/components/session/SessionComposer";
import { UploadPreviewPanel } from "@/components/session/SessionPreviewPanels";
import {
  SessionWorkspaceDrawer,
  SessionWorkspacePane,
} from "@/components/session/SessionWorkspacePane";
import { SettingsDialog } from "@/components/settings/SettingsDialog";
import { loadPinnedAppIds, savePinnedAppIds } from "@/lib/app-pins";
import { openClawAdapter } from "@/lib/chat/openClawAdapter";
import { serializeAssistantTimelineContent } from "@/lib/chat/timeline";
import {
  resolveChatSessionKey,
  sessionRouteIdFromSessionKey,
  useGateway,
} from "@/lib/chat/useGateway";
import { isTabHidden, playCompletionChime } from "@/lib/chime";
import type { CommandContext, CommandMessageSnapshot } from "@/lib/commands";
import { DEFAULT_STARTERS } from "@/lib/conversation-starters";
import type { CronJobRecord, CronRunEntry, CronStatusRecord } from "@/lib/cron";
import type { CompactSessionResult } from "@/lib/engines/openclaw/OpenClawEngine";
import type {
  AppRecord,
  AppStore,
  AppSummary,
  ArtifactRecord,
  ArtifactStore,
  ArtifactSummary,
  GatewayCommand,
  UploadStore,
} from "@/lib/engines/types";
import { ConnectionState } from "@/lib/gateway/types";
import { navigate, useHashRoute } from "@/lib/hooks/useHashRoute";
import { useIsMobile } from "@/lib/hooks/useIsMobile";
import { qualifyModel } from "@/lib/models";
import type { NotificationRecord } from "@/lib/notifications";
import { apply as applyPreferences, getPreferences } from "@/lib/preferences";
import { extractAgentIdFromKey } from "@/lib/session-keys";
import {
  EMPTY_THREAD_WORKSPACE,
  deriveThreadWorkspaceFromMessages,
  fileToThreadUpload,
  sessionAppPreviewId,
  sessionArtifactPreviewId,
  sessionUploadPreviewId,
  uploadMetaToThreadUpload,
  type ThreadUpload,
  type ThreadWorkspaceState,
} from "@/lib/session-workspace";
import { buildAppSiblings, buildArtifactSiblings, makeAgentNameResolver } from "@/lib/siblings";
import { getSettings, type Settings } from "@/lib/storage";
import { UploadsProvider, type UploadsSeed } from "@/lib/uploads-context";
import type { ClawThread } from "@/types/claw-thread";
import type { ClawThreadListItem, ModelChoice, SessionRow } from "@/types/gateway-responses";
import type { Message, Thread } from "@openuidev/react-headless";
import {
  ChatProvider,
  useActiveArtifact,
  useArtifactStore,
  useThread,
  useThreadList,
} from "@openuidev/react-headless";
import { ArtifactPanel, Shell, ThemeProvider } from "@openuidev/react-ui";
import {
  ArrowLeft,
  BellRing,
  Database,
  FileText,
  LayoutGrid,
  PanelRightOpen,
  Plus,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// Same default used by FullScreen — swap for a custom Claw logo later.
const LOGO_URL = "https://www.openui.com/favicon.svg";
const ENABLE_THREAD_REPLY_NOTIFICATIONS = false;

function formatTokens(n: number): string {
  if (n >= 1000) return `${(Math.round(n / 100) / 10).toFixed(1)}k`;
  return String(n);
}

function toThreadRow(r: ClawThreadListItem): Thread {
  return {
    id: r.id,
    title: r.title,
    createdAt: r.createdAt,
    clawKind: r.clawKind,
    clawAgentId: r.clawAgentId,
  } as Thread;
}

type NotificationToastNotice = {
  id: string;
  notification: NotificationRecord;
};

function NotificationToastViewport({
  toasts,
  onDismiss,
  onOpen,
}: {
  toasts: NotificationToastNotice[];
  onDismiss: (toastId: string) => void;
  onOpen: (notification: NotificationRecord, toastId: string) => void;
}) {
  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed right-ml top-ml z-[80] flex w-[min(92vw,380px)] flex-col gap-m">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className="pointer-events-auto overflow-hidden rounded-2xl border border-border-default/80 bg-background shadow-float"
        >
          <div className="flex items-start gap-m px-ml py-m transition-colors hover:bg-sunk-light">
            <div className="mt-3xs flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl bg-info-background text-text-info-primary">
              <BellRing className="h-ml w-ml" />
            </div>
            <button
              type="button"
              className="min-w-0 flex-1 text-left"
              onClick={() => onOpen(toast.notification, toast.id)}
            >
              <div className="flex items-center gap-s">
                <p className="truncate text-sm font-bold text-text-neutral-primary">
                  {toast.notification.title}
                </p>
                {toast.notification.unread ? (
                  <span className="inline-flex h-s w-s shrink-0 rounded-full bg-text-info-primary" />
                ) : null}
              </div>
              <p className="mt-2xs max-h-[4.5rem] overflow-hidden text-sm text-text-neutral-secondary">
                {toast.notification.message}
              </p>
            </button>
            <button
              type="button"
              className="rounded-xl p-2xs text-text-neutral-tertiary transition-colors hover:bg-sunk-light hover:text-text-neutral-primary"
              onClick={() => onDismiss(toast.id)}
            >
              <X className="h-ml w-ml" />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

// Returns a callback that walks the browser history one step (so back from a
// chat opened via Refine returns to the app/artifact you came from). Falls
// back to `defaultNav` when there is no prior in-app entry.
function smartBack(defaultNav: () => void): () => void {
  return () => {
    if (typeof window !== "undefined" && window.history.length > 1) {
      window.history.back();
      return;
    }
    defaultNav();
  };
}

function ThreadArea({
  sessionMeta,
  availableModels,
  gatewayDefaultModelId,
  agentModelById,
  defaultAgentId,
  patchSession,
  resetSession,
  compactSession,
  onSessionChanged,
  loadThread,
  knownAgentIds,
  appList,
  artifactList,
  apps,
  artifacts,
  uploads,
  pinnedAppIds,
  onTogglePinned,
  workspaceByThread,
  onUpdateThreadWorkspace,
  onMarkUploadsSent,
  onRemoveUpload,
  onRefreshDurables,
  onRefreshSummaries,
  pendingPreviewOpen,
  onConsumePendingPreview,
  onAppContinueConversation,
  workspacePaneCollapsed,
  onToggleWorkspacePaneCollapsed,
  gatewayCommands,
  createSession,
  deleteSession,
  renameSession,
}: {
  sessionMeta: Map<string, SessionRow>;
  availableModels: ModelChoice[];
  gatewayDefaultModelId: string | null;
  agentModelById: Map<string, string>;
  defaultAgentId: string | null;
  patchSession: (key: string, patch: Record<string, unknown>) => Promise<boolean>;
  resetSession: (sessionKey: string) => Promise<boolean>;
  compactSession: (sessionKey: string) => Promise<CompactSessionResult>;
  onSessionChanged: (listener: (sessionKey: string) => void) => () => void;
  loadThread: (threadId: string) => Promise<Message[]>;
  knownAgentIds: React.RefObject<Set<string>>;
  appList: AppSummary[];
  artifactList: ArtifactSummary[];
  apps: AppStore | undefined;
  artifacts: ArtifactStore | undefined;
  uploads: UploadStore | undefined;
  pinnedAppIds: Set<string>;
  onTogglePinned: (appId: string) => void;
  workspaceByThread: Record<string, ThreadWorkspaceState>;
  onUpdateThreadWorkspace: (
    threadId: string,
    updater: (current: ThreadWorkspaceState) => ThreadWorkspaceState,
  ) => void;
  onMarkUploadsSent: (threadId: string, uploadIds: string[]) => void;
  onRemoveUpload: (threadId: string, uploadId: string) => void;
  onRefreshDurables: () => Promise<void> | void;
  onRefreshSummaries: () => void;
  pendingPreviewOpen: { threadId: string; previewId: string } | null;
  onConsumePendingPreview: () => void;
  onRefineApp: (record: AppRecord) => void | Promise<void>;
  onRefineArtifact: (record: ArtifactRecord) => void | Promise<void>;
  onAppContinueConversation: AppContinueConversationHandler;
  workspacePaneCollapsed: boolean;
  onToggleWorkspacePaneCollapsed: (collapsed: boolean) => void;
  gatewayCommands: GatewayCommand[];
  createSession: (agentId: string) => Promise<string | null>;
  deleteSession: (threadId: string) => Promise<boolean>;
  renameSession: (threadId: string, label: string) => Promise<boolean>;
}) {
  const { threads: allThreadsRaw, selectedThreadId } = useThreadList();
  const isRunning = useThread((state) => state.isRunning);
  const threadMessages = useThread((state) => state.messages);
  const setThreadMessages = useThread((state) => state.setMessages);
  const artifactStore = useArtifactStore();

  const { activeArtifactId } = useActiveArtifact();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Close the fullscreen artifact preview on Escape.
  useEffect(() => {
    if (!activeArtifactId) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") artifactStore.getState().closeArtifact(activeArtifactId);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeArtifactId, artifactStore]);
  const previousRunningRef = useRef(false);
  const isMobile = useIsMobile();
  const [commandToast, setCommandToast] = useState<{
    message: string;
    kind: "info" | "success" | "error";
  } | null>(null);
  // Locally-known uploads — seeded the moment `uploads.put` resolves so the
  // `UserMessage` thumbnail renders immediately, without waiting for the next
  // `uploads.list` refresh to include the new id.
  const [uploadSeeds, setUploadSeeds] = useState<UploadsSeed[]>([]);

  useEffect(() => {
    if (!commandToast) return;
    const timer = setTimeout(() => setCommandToast(null), 3000);
    return () => clearTimeout(timer);
  }, [commandToast]);
  const autoPreviewStateRef = useRef<{
    threadId: string;
    baselineAppIds: Set<string>;
    baselineArtifactIds: Set<string>;
    openedAppIds: Set<string>;
    openedArtifactIds: Set<string>;
  } | null>(null);
  const [mobileWorkspaceOpen, setMobileWorkspaceOpen] = useState(false);

  const sessionKey = useMemo(() => {
    if (!selectedThreadId) return null;
    return resolveChatSessionKey(selectedThreadId, knownAgentIds.current);
  }, [selectedThreadId, knownAgentIds]);

  const meta = sessionKey ? sessionMeta.get(sessionKey) : undefined;
  const workspace =
    (selectedThreadId ? workspaceByThread[selectedThreadId] : undefined) ?? EMPTY_THREAD_WORKSPACE;

  /**
   * Agent id for the current thread. Used for cross-session lookups (e.g. the
   * uploads aggregation below) but NOT for apps/artifacts — those are scoped
   * per-session.
   *
   * Resolution order:
   *  1. Parse `agent:<id>:<slot>:openclaw-os` directly from the route key
   *     — works pre-fetch (URL is the source of truth, no race vs. threads
   *     loading).
   *  2. Bare agent id stored on the synthetic main-thread item (`a.id`).
   *  3. Lookup in the threads list (for any unusual id shape).
   */
  const activeAgentId = useMemo(() => {
    if (!selectedThreadId) return null;
    const fromKey = extractAgentIdFromKey(selectedThreadId);
    if (fromKey) return fromKey;
    if (knownAgentIds.current?.has(selectedThreadId)) return selectedThreadId;
    const t = (allThreadsRaw as unknown as ClawThread[]).find((x) => x.id === selectedThreadId);
    return t?.clawAgentId ?? t?.id ?? null;
  }, [allThreadsRaw, knownAgentIds, selectedThreadId]);

  /** Display name for the agent owning the current thread (the `clawKind:
   *  "main"` thread's title). Used by the empty-chat welcome screen. */
  const activeAgentName = useMemo(() => {
    if (!activeAgentId) return undefined;
    const main = (allThreadsRaw as unknown as ClawThread[]).find(
      (t) => (t.clawAgentId ?? t.id) === activeAgentId && t.clawKind === "main",
    );
    return main?.title;
  }, [allThreadsRaw, activeAgentId]);

  const sessionApps = useMemo(
    () => (sessionKey ? appList.filter((app) => app.sessionKey === sessionKey) : []),
    [appList, sessionKey],
  );

  const sessionArtifacts = useMemo(
    () =>
      sessionKey ? artifactList.filter((artifact) => artifact.source.sessionId === sessionKey) : [],
    [artifactList, sessionKey],
  );

  const paneUploads = workspace.uploads;
  const paneLinkedApp = workspace.linkedApp;
  const paneLinkedArtifact = workspace.linkedArtifact;

  // The refined `linkedApp` may live in a different session than the current
  // thread (e.g. refining from /apps/<id> can land on the agent's main thread
  // if the app's origin session no longer exists). Without this, the app
  // isn't in `sessionApps` → no <ArtifactPanel> registers for it → the
  // auto-opened side pane portal target stays empty. Append the linkedApp
  // record (looked up from the global appList) when it's not already there.
  const paneApps = useMemo(() => {
    if (!paneLinkedApp) return sessionApps;
    if (sessionApps.some((a) => a.id === paneLinkedApp.appId)) return sessionApps;
    const found = appList.find((a) => a.id === paneLinkedApp.appId);
    return found ? [...sessionApps, found] : sessionApps;
  }, [sessionApps, paneLinkedApp, appList]);
  // Same merge for linkedArtifact — needed when the artifact's origin session
  // differs from the active thread.
  const paneArtifacts = useMemo(() => {
    if (!paneLinkedArtifact) return sessionArtifacts;
    if (sessionArtifacts.some((a) => a.id === paneLinkedArtifact.artifactId))
      return sessionArtifacts;
    const found = artifactList.find((a) => a.id === paneLinkedArtifact.artifactId);
    return found ? [...sessionArtifacts, found] : sessionArtifacts;
  }, [sessionArtifacts, paneLinkedArtifact, artifactList]);

  useEffect(() => {
    const wasRunning = previousRunningRef.current;

    if (!wasRunning && isRunning && selectedThreadId) {
      autoPreviewStateRef.current = {
        threadId: selectedThreadId,
        baselineAppIds: new Set(sessionApps.map((app) => app.id)),
        baselineArtifactIds: new Set(sessionArtifacts.map((artifact) => artifact.id)),
        openedAppIds: new Set(),
        openedArtifactIds: new Set(),
      };
    }

    if (wasRunning && !isRunning) {
      onRefreshSummaries();
      // Soft chime when the assistant finishes while the user is on another
      // tab/window. Pref-gated; checking inside the callback (not at mount)
      // means toggling the pref takes effect on the very next completion.
      if (getPreferences().notificationSound && isTabHidden()) {
        playCompletionChime();
      }
    }

    previousRunningRef.current = isRunning;
  }, [isRunning, onRefreshSummaries, selectedThreadId, sessionApps, sessionArtifacts]);

  useEffect(() => {
    if (autoPreviewStateRef.current && autoPreviewStateRef.current.threadId !== selectedThreadId) {
      autoPreviewStateRef.current = null;
    }
  }, [selectedThreadId]);

  useEffect(() => {
    if (!selectedThreadId || !isRunning) return;

    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const refreshLoop = async () => {
      try {
        await onRefreshDurables();
      } catch (error) {
        console.warn("[claw] durable refresh failed:", error);
      }
      if (cancelled) return;
      timeoutId = setTimeout(() => {
        void refreshLoop();
      }, 1500);
    };

    timeoutId = setTimeout(() => {
      void refreshLoop();
    }, 1200);

    return () => {
      cancelled = true;
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [isRunning, onRefreshDurables, selectedThreadId]);

  useEffect(() => {
    if (!selectedThreadId) return;

    const tracker = autoPreviewStateRef.current;
    if (!tracker || tracker.threadId !== selectedThreadId) return;

    const nextArtifact = sessionArtifacts.find(
      (artifact) =>
        !tracker.baselineArtifactIds.has(artifact.id) &&
        !tracker.openedArtifactIds.has(artifact.id),
    );

    if (nextArtifact) {
      tracker.openedArtifactIds.add(nextArtifact.id);
      artifactStore.getState().openArtifact(sessionArtifactPreviewId(nextArtifact.id));
      return;
    }

    const nextApp = sessionApps.find(
      (app) => !tracker.baselineAppIds.has(app.id) && !tracker.openedAppIds.has(app.id),
    );

    if (nextApp && tracker.openedArtifactIds.size === 0) {
      tracker.openedAppIds.add(nextApp.id);
      artifactStore.getState().openArtifact(sessionAppPreviewId(nextApp.id));
    }
  }, [artifactStore, selectedThreadId, sessionApps, sessionArtifacts]);

  useEffect(() => {
    if (
      pendingPreviewOpen &&
      selectedThreadId &&
      pendingPreviewOpen.threadId === selectedThreadId
    ) {
      // On mobile during a chat, the artifact overlay is suppressed (chat owns
      // the screen during refine), so opening the artifact would be a no-op
      // render but still mutate store state. Skip the auto-open and just
      // consume the pending request — the chip in the composer is the
      // mobile-side indicator that refine context is attached.
      if (!isMobile) {
        artifactStore.getState().openArtifact(pendingPreviewOpen.previewId);
      }
      onConsumePendingPreview();
    }
  }, [artifactStore, isMobile, onConsumePendingPreview, pendingPreviewOpen, selectedThreadId]);

  const addFiles = useCallback(
    async (files: File[]) => {
      if (!selectedThreadId || files.length === 0) return;

      const nextUploads = await Promise.all(files.map((file) => fileToThreadUpload(file)));
      onUpdateThreadWorkspace(selectedThreadId, (current) => ({
        ...current,
        uploads: [...current.uploads, ...nextUploads],
      }));

      // Persist bytes to the plugin's UploadStore so previews survive reload
      // after OpenClaw's 2-minute media TTL expires. Use the resolved session
      // key (not the raw threadId) so agent-main threads scope correctly.
      if (uploads && sessionKey) {
        const threadId = selectedThreadId;
        const scopedSessionKey = sessionKey;
        await Promise.all(
          nextUploads.map(async (upload) => {
            if (!upload.attachment?.content) return;
            const meta = await uploads.putUpload({
              sessionKey: scopedSessionKey,
              name: upload.name,
              mimeType: upload.mimeType,
              content: upload.attachment.content,
              size: upload.size,
            });
            if (!meta) return;
            // Seed provider with the remote meta + a locally-synthesized data
            // URL so `InlineUploadChip` gets both `kind` and `dataUrl` on its
            // first render, rather than falling back to the generic chip while
            // `uploads.list` catches up.
            const previewDataUrl = upload.attachment?.content
              ? `data:${upload.mimeType};base64,${upload.attachment.content}`
              : undefined;
            setUploadSeeds((prev) => {
              const next = prev.filter((entry) => entry.meta.id !== meta.id);
              next.push(previewDataUrl ? { meta, previewDataUrl } : { meta });
              return next;
            });
            onUpdateThreadWorkspace(threadId, (current) => ({
              ...current,
              uploads: current.uploads.map((candidate) =>
                candidate.id === upload.id ? { ...candidate, remoteId: meta.id } : candidate,
              ),
            }));
          }),
        );
      }
    },
    [onUpdateThreadWorkspace, selectedThreadId, sessionKey, uploads],
  );

  const handleFilesSelected = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []);
      event.target.value = "";
      await addFiles(files);
    },
    [addFiles],
  );

  const openFilePicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const downloadBlob = useCallback((filename: string, mimeType: string, content: string | Blob) => {
    const blob = content instanceof Blob ? content : new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }, []);

  const buildCommandContext = useCallback((): CommandContext => {
    const messages = threadMessages.map((message: Message) => {
      const contentRaw = (message as { content?: unknown }).content;
      const content =
        typeof contentRaw === "string"
          ? contentRaw
          : Array.isArray(contentRaw)
            ? contentRaw
                .map((part) =>
                  part && typeof part === "object" && "text" in part
                    ? String((part as { text?: unknown }).text ?? "")
                    : "",
                )
                .join("")
            : "";
      return {
        id: message.id,
        role:
          message.role === "user"
            ? "user"
            : message.role === "assistant"
              ? "assistant"
              : "activity",
        content,
      } as CommandMessageSnapshot;
    });

    return {
      threadId: selectedThreadId ?? null,
      threadTitle: meta?.derivedTitle ?? meta?.displayName ?? meta?.label ?? undefined,
      messages,
      apps,
      artifacts,
      uploads,
      toast: (message, kind = "info") => setCommandToast({ message, kind }),
      downloadBlob,
    };
  }, [apps, artifacts, downloadBlob, meta, selectedThreadId, threadMessages, uploads]);

  // Gateway commands that map 1:1 to a dedicated RPC. Dispatching these
  // through `chat.send` doesn't trigger the gateway's command handler for the
  // webchat channel — the slash text just reaches the LLM — so we call the
  // RPC directly instead.
  // Refresh the current thread when the gateway reports an out-of-band
  // transcript change — subagent completions, external sessions.send, or
  // anything that lands after our run listener has been torn down. Debounce
  // briefly so a burst of events (e.g. several subagent steps) collapses.
  // While an active stream is driving the store, skip the reload entirely —
  // the stream is authoritative and a `setMessages` mid-run wipes the
  // optimistic user bubble + streaming assistant message, producing a flicker
  // until the next event arrives. A trailing sessions.changed after
  // RUN_FINISHED still fires the reload to reshape the stream into per-message
  // cards.
  const isRunningRef = useRef(isRunning);
  useEffect(() => {
    isRunningRef.current = isRunning;
  }, [isRunning]);
  useEffect(() => {
    if (!selectedThreadId) return;
    let pending: ReturnType<typeof setTimeout> | null = null;
    const handler = (changedKey: string) => {
      if (!selectedThreadId) return;
      const scopedKey = resolveChatSessionKey(selectedThreadId, knownAgentIds.current);
      if (changedKey !== scopedKey) return;
      if (pending) clearTimeout(pending);
      pending = setTimeout(() => {
        pending = null;
        if (isRunningRef.current) return;
        void loadThread(selectedThreadId)
          .then((messages) => setThreadMessages(messages))
          .catch((err) => console.warn("[claw] session-changed reload failed:", err));
      }, 400);
    };
    const unsubscribe = onSessionChanged(handler);
    return () => {
      if (pending) clearTimeout(pending);
      unsubscribe();
    };
  }, [selectedThreadId, onSessionChanged, loadThread, setThreadMessages, knownAgentIds]);

  const dispatchGatewayCommand = useCallback(
    async (name: string, _args: string): Promise<boolean> => {
      if (!sessionKey) return false;
      if (name === "reset" || name === "new") {
        const ok = await resetSession(sessionKey);
        setCommandToast({
          message: ok ? "Thread reset" : "Reset failed",
          kind: ok ? "success" : "error",
        });
        if (ok) setThreadMessages([]);
        return true;
      }
      if (name === "compact") {
        // The RPC awaits the full compaction (~1s), so show a pending toast
        // up front so the user knows something is happening. Replace with
        // the enriched result on resolve.
        setCommandToast({ message: "Compacting context…", kind: "info" });
        const result = await compactSession(sessionKey);
        if (!result.ok) {
          setCommandToast({ message: "Compaction failed", kind: "error" });
        } else if (!result.compacted) {
          setCommandToast({
            message: result.reason ? `Nothing to compact (${result.reason})` : "Nothing to compact",
            kind: "info",
          });
        } else {
          const before = result.tokensBefore;
          const after = result.tokensAfter;
          const detail =
            before != null && after != null
              ? ` (${formatTokens(before)} → ${formatTokens(after)} tokens)`
              : "";
          setCommandToast({
            message: `Context compacted${detail}`,
            kind: "success",
          });
        }
        return true;
      }
      return false;
    },
    [compactSession, resetSession, sessionKey, setThreadMessages],
  );

  return (
    <UploadsProvider store={uploads} sessionKey={sessionKey} seeds={uploadSeeds}>
      <div className="flex h-full min-w-0 flex-1 overflow-hidden bg-background dark:bg-sunk">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleFilesSelected}
        />

        <ClawThreadContainer className="openclaw-os-thread-container min-w-0 flex-1">
          {/* `Shell.MobileHeader` was previously rendered here. It stacked
              on top of `AgentTopBar` on mobile and its buttons routed to
              react-headless / Shell's own sidebar, neither of which we
              use — the hamburger went nowhere useful and its "+" called
              `switchToNewThread` instead of our `createSession` flow.
              Dropped so AgentTopBar is the sole chat header on mobile. */}
          {(() => {
            // Derive the top-bar data from the current thread list. Scoped
            // into an IIFE so we don't leak locals elsewhere.
            const allThreads = allThreadsRaw as unknown as ClawThread[];
            const currentThread = allThreads.find((t) => t.id === selectedThreadId);
            // Fresh-session race: createSession resolves and we navigate to
            // the new thread id before `loadThreads` has pushed it into the
            // thread list. Rather than render a blank header (which the user
            // reads as "broken"), render a minimal placeholder bar with a
            // back affordance so the chat surface still has a chrome.
            if (!currentThread) {
              return (
                <TopBar
                  leading={
                    <button
                      type="button"
                      onClick={() => navigate({ view: isMobile ? "agents" : "home" })}
                      className="flex h-8 w-8 items-center justify-center rounded-m text-text-neutral-secondary hover:bg-foreground"
                      aria-label="Back"
                    >
                      <ArrowLeft size={16} />
                    </button>
                  }
                >
                  <span className="font-heading text-md font-medium text-text-neutral-primary">
                    New chat
                  </span>
                </TopBar>
              );
            }
            const currentAgentId = currentThread.clawAgentId ?? currentThread.id;
            // Map of agentId → main thread title (or first thread title as fallback).
            const agentNameMap = new Map<string, string>();
            for (const t of allThreads) {
              const aid = t.clawAgentId ?? t.id;
              if (!agentNameMap.has(aid)) agentNameMap.set(aid, aid);
              if (t.clawKind === "main") agentNameMap.set(aid, t.title);
            }
            const allAgents = [...agentNameMap.entries()].map(([id, name]) => ({
              id,
              name,
            }));
            const sessions = allThreads.filter((t) => (t.clawAgentId ?? t.id) === currentAgentId);
            const onNewSession = async () => {
              const newId = await createSession(currentAgentId);
              if (newId) navigate({ view: "chat", sessionId: newId });
            };
            if (isMobile) {
              return (
                <MobileAgentTopBar
                  agent={{
                    id: currentAgentId,
                    name: agentNameMap.get(currentAgentId) ?? currentAgentId,
                  }}
                  allAgents={allAgents}
                  activeSession={{
                    id: currentThread.id,
                    title: currentThread.title,
                  }}
                  sessions={sessions}
                  onBack={smartBack(() => navigate({ view: "agents" }))}
                  onSwitchAgent={(a) => {
                    const target =
                      allThreads.find(
                        (t) => (t.clawAgentId ?? t.id) === a.id && t.clawKind === "main",
                      ) ?? allThreads.find((t) => (t.clawAgentId ?? t.id) === a.id);
                    if (target) navigate({ view: "chat", sessionId: target.id });
                  }}
                  onSelectSession={(threadId) => navigate({ view: "chat", sessionId: threadId })}
                  onNewSession={onNewSession}
                  onOpenWorkspace={() => setMobileWorkspaceOpen(true)}
                  onDeleteSession={async () => {
                    await deleteSession(currentThread.id);
                    navigate({ view: "agents" });
                  }}
                  onDeleteAgent={async () => {
                    const main =
                      allThreads.find(
                        (t) => (t.clawAgentId ?? t.id) === currentAgentId && t.clawKind === "main",
                      ) ?? allThreads.find((t) => (t.clawAgentId ?? t.id) === currentAgentId);
                    const target = main?.id;
                    if (target) {
                      await deleteSession(target);
                      navigate({ view: "agents" });
                    }
                  }}
                />
              );
            }
            return (
              <AgentTopBar
                agent={{
                  id: currentAgentId,
                  name: agentNameMap.get(currentAgentId) ?? currentAgentId,
                }}
                allAgents={allAgents}
                activeSession={{
                  id: currentThread.id,
                  title: currentThread.title,
                }}
                sessions={sessions}
                onBack={() => navigate({ view: "home" })}
                onSwitchAgent={(a) => {
                  // Open the agent's main thread if present, else any thread.
                  const target =
                    allThreads.find(
                      (t) => (t.clawAgentId ?? t.id) === a.id && t.clawKind === "main",
                    ) ?? allThreads.find((t) => (t.clawAgentId ?? t.id) === a.id);
                  if (target) navigate({ view: "chat", sessionId: target.id });
                }}
                onSelectSession={(threadId) => navigate({ view: "chat", sessionId: threadId })}
                onNewSession={onNewSession}
                onRenameSession={async (next) => {
                  await renameSession(currentThread.id, next);
                }}
                onDeleteSession={async () => {
                  await deleteSession(currentThread.id);
                  navigate({ view: "agents" });
                }}
                // Renaming the agent = renaming its main thread (the one
                // whose title bubbles up as the agent name in the sidebar).
                onRenameAgent={async (next) => {
                  const main =
                    allThreads.find(
                      (t) => (t.clawAgentId ?? t.id) === currentAgentId && t.clawKind === "main",
                    ) ?? allThreads.find((t) => (t.clawAgentId ?? t.id) === currentAgentId);
                  if (main) await renameSession(main.id, next);
                }}
                onDeleteAgent={async () => {
                  const main =
                    allThreads.find(
                      (t) => (t.clawAgentId ?? t.id) === currentAgentId && t.clawKind === "main",
                    ) ?? allThreads.find((t) => (t.clawAgentId ?? t.id) === currentAgentId);
                  const target = main?.id;
                  if (target) {
                    await deleteSession(target);
                    navigate({ view: "agents" });
                  }
                }}
                // On mobile, the workspace pane is a drawer instead of the
                // permanent right-rail. Surface a toggle in the chat header
                // since the desktop expand-rail doesn't exist here.
                onOpenWorkspace={isMobile ? () => setMobileWorkspaceOpen(true) : undefined}
              />
            );
          })()}
          {workspace.linkedApp || workspace.linkedArtifact ? (
            <div className="sticky top-0 z-20 flex items-center gap-xs border-b border-border-default/40 bg-info-background px-ml py-2xs text-sm dark:border-border-default/16">
              <span className="font-medium text-text-info-primary">
                {workspace.linkedApp ? "App" : "Artifact"}:
              </span>
              <span className="truncate text-text-info-primary">
                {workspace.linkedApp?.title ?? workspace.linkedArtifact?.title}
              </span>
            </div>
          ) : null}
          {(() => {
            const composerEl = (
              <SessionComposer
                uploads={workspace.uploads}
                linkedApp={workspace.linkedApp}
                linkedArtifact={workspace.linkedArtifact}
                onPickFiles={openFilePicker}
                onAddFiles={addFiles}
                onRemoveUpload={(uploadId) => {
                  if (!selectedThreadId) return;
                  onRemoveUpload(selectedThreadId, uploadId);
                  artifactStore.getState().closeArtifact(sessionUploadPreviewId(uploadId));
                }}
                onUploadsSent={(uploadIds) => {
                  if (!selectedThreadId) return;
                  onMarkUploadsSent(selectedThreadId, uploadIds);
                }}
                commandContext={buildCommandContext}
                gatewayCommands={gatewayCommands}
                onDispatchGatewayCommand={dispatchGatewayCommand}
                models={availableModels}
                gatewayDefaultModelId={gatewayDefaultModelId}
                agentDefaultModelId={(() => {
                  // Per-agent override wins over the workspace default. When no
                  // thread is selected (home/welcome composer) fall back to the
                  // configured default agent so a single-agent setup still
                  // surfaces its model as `Default (X)`.
                  const targetAgentId = activeAgentId ?? defaultAgentId;
                  return targetAgentId ? (agentModelById.get(targetAgentId) ?? null) : null;
                })()}
                currentModel={meta?.model ? qualifyModel(meta.model, meta.modelProvider ?? "") : ""}
                currentEffort={meta?.thinkingLevel ?? ""}
                effortDefault={meta?.thinkingDefault ?? null}
                effortOptions={meta?.thinkingOptions ?? null}
                onModelChange={
                  sessionKey
                    ? (value) => {
                        void patchSession(sessionKey, { model: value || null });
                      }
                    : undefined
                }
                onEffortChange={
                  sessionKey
                    ? (value) => {
                        void patchSession(sessionKey, { thinkingLevel: value || null });
                      }
                    : undefined
                }
                {...(() => {
                  // Map openclaw's SessionRow fields onto the ring's
                  // (used, limit) pair. See git blame for the discussion
                  // about totalTokens vs inputTokens vs contextTokens.
                  const totalFresh = meta?.totalTokensFresh !== false;
                  const used = totalFresh
                    ? (meta?.totalTokens ?? meta?.inputTokens)
                    : meta?.inputTokens;
                  return {
                    contextTokens: used ?? undefined,
                    contextLimit: meta?.contextTokens ?? undefined,
                  };
                })()}
              />
            );
            const isEmpty = !isRunning && threadMessages.length === 0;
            if (isEmpty) {
              return (
                <div className="min-h-0 flex-1 overflow-y-auto">
                  <EmptyAgentHero agentName={activeAgentName} composer={composerEl} />
                </div>
              );
            }
            return (
              <>
                <Shell.ScrollArea>
                  <EmptyChatWelcome agentName={activeAgentName} />
                  {}
                  <Shell.Messages
                    assistantMessage={AssistantMessage}
                    userMessage={UserMessage as any}
                    loader={<Shell.MessageLoading />}
                  />
                </Shell.ScrollArea>
                {composerEl}
              </>
            );
          })()}
          {commandToast && (
            <div className="pointer-events-none absolute left-1/2 top-4 z-40 -translate-x-1/2 transform">
              <div
                className={`pointer-events-auto rounded-xl border px-ml py-s text-xs font-medium shadow-lg ${
                  commandToast.kind === "error"
                    ? "border-border-danger bg-danger-background text-text-danger-primary"
                    : commandToast.kind === "success"
                      ? "border-border-success bg-success-background text-text-success-primary"
                      : "border-border-default bg-background text-text-neutral-secondary"
                }`}
              >
                {commandToast.message}
              </div>
            </div>
          )}
        </ClawThreadContainer>

        {(() => {
          // Register one <ArtifactPanel> per known app/artifact/upload.
          // Each panel portals into the <ArtifactPortalTarget> mounted by
          // ClawThreadContainer's right pane. The panels themselves render
          // no DOM until activated, so iterating the FULL `appList`/
          // `artifactList` (not session-filtered `paneApps`/`paneArtifacts`)
          // is essentially free and guarantees that any cross-session
          // refine target has a panel ready to portal — without this,
          // auto-opening a linkedApp from the agent's main thread would
          // activate an id with no registered panel and the side pane
          // would render empty.
          const threadsAll = allThreadsRaw as unknown as ClawThread[];
          const agentNameFor = makeAgentNameResolver(threadsAll);
          const handleClose = () => {
            if (activeArtifactId) artifactStore.getState().closeArtifact(activeArtifactId);
          };
          const appSiblings = buildAppSiblings(appList, agentNameFor);
          const artifactSiblings = buildArtifactSiblings(artifactList, agentNameFor);
          return (
            <>
              {appList.map((app) => (
                <ArtifactPanel
                  key={`${app.id}:${app.updatedAt}`}
                  artifactId={sessionAppPreviewId(app.id)}
                  title={app.title}
                  header={false}
                >
                  {apps ? (
                    <AppDetail
                      appId={app.id}
                      apps={apps}
                      updatedAt={app.updatedAt}
                      mode="panel"
                      isPinned={pinnedAppIds.has(app.id)}
                      onTogglePinned={onTogglePinned}
                      // In-chat panel: omit onRefine so the Refine action
                      // hides — the user is already in the refine session
                      // (composer is primed and `linkedApp` is set).
                      onContinueConversation={onAppContinueConversation}
                      onDeleted={onRefreshSummaries}
                      onClose={handleClose}
                      siblings={appSiblings}
                      onSwitch={(nextAppId) =>
                        artifactStore.getState().openArtifact(sessionAppPreviewId(nextAppId))
                      }
                    />
                  ) : null}
                </ArtifactPanel>
              ))}

              {artifactList.map((artifact) => (
                <ArtifactPanel
                  key={`${artifact.id}:${artifact.updatedAt}`}
                  artifactId={sessionArtifactPreviewId(artifact.id)}
                  title={artifact.title}
                  header={false}
                >
                  {artifacts ? (
                    <ArtifactDetail
                      artifactId={artifact.id}
                      artifacts={artifacts}
                      updatedAt={artifact.updatedAt}
                      mode="panel"
                      onDeleted={onRefreshSummaries}
                      onClose={handleClose}
                      // In-chat panel: omit onRefine — see comment on
                      // <AppDetail> above.
                      siblings={artifactSiblings}
                      onSwitch={(nextArtId) =>
                        artifactStore.getState().openArtifact(sessionArtifactPreviewId(nextArtId))
                      }
                    />
                  ) : null}
                </ArtifactPanel>
              ))}

              {paneUploads.map((upload) => (
                <ArtifactPanel
                  key={upload.id}
                  artifactId={sessionUploadPreviewId(upload.id)}
                  title={upload.name}
                  header={false}
                >
                  <div className="flex h-full flex-col">
                    <DetailTopBar title={upload.name} onClose={handleClose} />
                    <div className="min-h-0 flex-1 overflow-auto bg-sunk-light dark:bg-sunk-deep">
                      <UploadPreviewPanel upload={upload} uploadStore={uploads} />
                    </div>
                  </div>
                </ArtifactPanel>
              ))}
            </>
          );
        })()}

        {isMobile ? (
          <MobileWorkspaceDrawer
            open={mobileWorkspaceOpen}
            onClose={() => setMobileWorkspaceOpen(false)}
            apps={paneApps}
            artifacts={paneArtifacts}
            uploads={paneUploads}
            linkedApp={paneLinkedApp}
            pinnedAppIds={pinnedAppIds}
            activePreviewId={activeArtifactId}
            onOpenApp={(appId) => {
              // On mobile, route to /apps/<id> instead of toggling the
              // artifact store — the chat-route overlay is suppressed so the
              // store-based open would render nothing.
              setMobileWorkspaceOpen(false);
              navigate({ view: "app", appId });
            }}
            onOpenArtifact={(artifactId) => {
              setMobileWorkspaceOpen(false);
              navigate({ view: "artifact", artifactId });
            }}
            onOpenUpload={(uploadId) => {
              artifactStore.getState().openArtifact(sessionUploadPreviewId(uploadId));
              setMobileWorkspaceOpen(false);
            }}
            onTogglePinned={onTogglePinned}
            onPickFiles={() => {
              setMobileWorkspaceOpen(false);
              openFilePicker();
            }}
          />
        ) : (
          <SessionWorkspaceDrawer
            open={mobileWorkspaceOpen}
            onClose={() => setMobileWorkspaceOpen(false)}
            apps={paneApps}
            artifacts={paneArtifacts}
            uploads={paneUploads}
            linkedApp={paneLinkedApp}
            pinnedAppIds={pinnedAppIds}
            activePreviewId={activeArtifactId}
            onOpenApp={(appId) => {
              artifactStore.getState().openArtifact(sessionAppPreviewId(appId));
              setMobileWorkspaceOpen(false);
            }}
            onOpenArtifact={(artifactId) => {
              artifactStore.getState().openArtifact(sessionArtifactPreviewId(artifactId));
              setMobileWorkspaceOpen(false);
            }}
            onOpenUpload={(uploadId) => {
              artifactStore.getState().openArtifact(sessionUploadPreviewId(uploadId));
              setMobileWorkspaceOpen(false);
            }}
            onTogglePinned={onTogglePinned}
            onPickFiles={() => {
              setMobileWorkspaceOpen(false);
              openFilePicker();
            }}
          />
        )}

        {/* When an artifact panel is open, force the workspace rail into its
            collapsed icon-strip variant so users keep the per-thread context
            tiles within reach without the full pane competing for the right
            edge that the artifact slide-in claims. */}
        {activeArtifactId || workspacePaneCollapsed ? (
          <aside className="hidden h-full w-12 shrink-0 flex-col items-center overflow-y-auto border-l border-border-default/50 bg-transparent dark:border-border-default/16 lg:flex">
            <div className="flex min-h-[48px] w-full items-center justify-center border-b border-border-default px-2xs dark:border-border-default/16">
              <IconButton
                icon={PanelRightOpen}
                variant="tertiary"
                size="md"
                title="Expand thread workspace"
                aria-label="Expand thread workspace"
                onClick={() => onToggleWorkspacePaneCollapsed(false)}
              />
            </div>

            {/* Apps */}
            <div className="flex w-full flex-col items-center gap-2xs py-m">
              <CategoryTile icon={LayoutGrid} category="apps" subtle />
              {paneApps.map((app) => {
                const isActive = activeArtifactId === sessionAppPreviewId(app.id);
                return (
                  <button
                    key={app.id}
                    type="button"
                    title={app.title}
                    onClick={() =>
                      artifactStore.getState().openArtifact(sessionAppPreviewId(app.id))
                    }
                    className="rounded-m p-2xs transition-colors hover:bg-sunk-light dark:hover:bg-highlight-subtle"
                  >
                    <TextTile
                      label={app.title}
                      category={isActive ? "apps" : null}
                      active={isActive}
                    />
                  </button>
                );
              })}
            </div>

            <div className="h-px w-full bg-border-default/50 dark:bg-border-default/16" />

            {/* Artifacts */}
            <div className="flex w-full flex-col items-center gap-2xs py-m">
              <CategoryTile icon={FileText} category="artifacts" subtle />
              {paneArtifacts.map((art) => {
                const isActive = activeArtifactId === sessionArtifactPreviewId(art.id);
                return (
                  <button
                    key={art.id}
                    type="button"
                    title={art.title}
                    onClick={() =>
                      artifactStore.getState().openArtifact(sessionArtifactPreviewId(art.id))
                    }
                    className="rounded-m p-2xs transition-colors hover:bg-sunk-light dark:hover:bg-highlight-subtle"
                  >
                    <TextTile
                      label={art.title}
                      category={isActive ? "artifacts" : null}
                      active={isActive}
                    />
                  </button>
                );
              })}
            </div>

            <div className="h-px w-full bg-border-default/50 dark:bg-border-default/16" />

            {/* Context */}
            <div className="flex w-full flex-col items-center gap-2xs py-m">
              <CategoryTile icon={Database} category="home" subtle />
              {paneLinkedApp
                ? (() => {
                    const isActive = activeArtifactId === sessionAppPreviewId(paneLinkedApp.appId);
                    return (
                      <button
                        type="button"
                        title={paneLinkedApp.title}
                        onClick={() =>
                          artifactStore
                            .getState()
                            .openArtifact(sessionAppPreviewId(paneLinkedApp.appId))
                        }
                        className="rounded-m p-2xs transition-colors hover:bg-sunk-light dark:hover:bg-highlight-subtle"
                      >
                        <TextTile
                          label={paneLinkedApp.title}
                          category={isActive ? "apps" : null}
                          active={isActive}
                        />
                      </button>
                    );
                  })()
                : null}
              {paneUploads.map((upload) => {
                const isActive = activeArtifactId === sessionUploadPreviewId(upload.id);
                return (
                  <button
                    key={upload.id}
                    type="button"
                    title={upload.name}
                    onClick={() =>
                      artifactStore.getState().openArtifact(sessionUploadPreviewId(upload.id))
                    }
                    className="rounded-m p-2xs transition-colors hover:bg-sunk-light dark:hover:bg-highlight-subtle"
                  >
                    <TextTile
                      label={upload.name}
                      category={isActive ? "home" : null}
                      active={isActive}
                    />
                  </button>
                );
              })}
              <IconButton
                icon={Plus}
                variant="tertiary"
                size="md"
                title="Add context"
                onClick={openFilePicker}
              />
            </div>
          </aside>
        ) : (
          <SessionWorkspacePane
            apps={paneApps}
            artifacts={paneArtifacts}
            uploads={paneUploads}
            linkedApp={paneLinkedApp}
            pinnedAppIds={pinnedAppIds}
            activePreviewId={activeArtifactId}
            onCollapse={() => onToggleWorkspacePaneCollapsed(true)}
            onOpenApp={(appId) => artifactStore.getState().openArtifact(sessionAppPreviewId(appId))}
            onOpenArtifact={(artifactId) =>
              artifactStore.getState().openArtifact(sessionArtifactPreviewId(artifactId))
            }
            onOpenUpload={(uploadId) =>
              artifactStore.getState().openArtifact(sessionUploadPreviewId(uploadId))
            }
            onTogglePinned={onTogglePinned}
            onPickFiles={openFilePicker}
          />
        )}
      </div>
    </UploadsProvider>
  );
}

interface ChatAppInnerProps {
  connectionState: ConnectionState;
  onSettingsClick: () => void;
  onSettingsSave: (settings: Settings) => void;
  createSession: (agentId: string) => Promise<string | null>;
  renameSession: (threadId: string, label: string) => Promise<boolean>;
  deleteSession: (threadId: string) => Promise<boolean>;
  resetSession: (sessionKey: string) => Promise<boolean>;
  compactSession: (sessionKey: string) => Promise<CompactSessionResult>;
  onSessionChanged: (listener: (sessionKey: string) => void) => () => void;
  loadThread: (threadId: string) => Promise<Message[]>;
  sessionMeta: Map<string, SessionRow>;
  availableModels: ModelChoice[];
  gatewayDefaultModelId: string | null;
  agentModelById: Map<string, string>;
  defaultAgentId: string | null;
  patchSession: (key: string, patch: Record<string, unknown>) => Promise<boolean>;
  knownAgentIds: React.RefObject<Set<string>>;
  artifacts: ArtifactStore | undefined;
  apps: AppStore | undefined;
  uploads: UploadStore | undefined;
  appList: AppSummary[];
  artifactList: ArtifactSummary[];
  pinnedAppIds: Set<string>;
  onTogglePinned: (appId: string) => void;
  workspaceByThread: Record<string, ThreadWorkspaceState>;
  onUpdateThreadWorkspace: (
    threadId: string,
    updater: (current: ThreadWorkspaceState) => ThreadWorkspaceState,
  ) => void;
  onMarkUploadsSent: (threadId: string, uploadIds: string[]) => void;
  onRemoveUpload: (threadId: string, uploadId: string) => void;
  pendingPreviewOpen: { threadId: string; previewId: string } | null;
  onSetPendingPreviewOpen: (value: { threadId: string; previewId: string }) => void;
  onConsumePendingPreview: () => void;
  onDeleteApp: (appId: string) => Promise<void>;
  onRefreshApps: () => void;
  onRefreshArtifacts: () => void;
  notifications: NotificationRecord[];
  onMarkNotificationsRead: (ids?: string[]) => Promise<boolean>;
  onRefreshNotifications: () => Promise<NotificationRecord[]>;
  onUpsertNotification: (
    notification: Omit<NotificationRecord, "id" | "createdAt" | "updatedAt" | "unread" | "readAt">,
  ) => Promise<boolean>;
  cronJobs: CronJobRecord[];
  cronRuns: CronRunEntry[];
  cronStatus: CronStatusRecord | null;
  onRefreshCronData: () => Promise<{
    jobs: CronJobRecord[];
    runs: CronRunEntry[];
    status: CronStatusRecord | null;
  }>;
  onUpdateCronJob: (id: string, patch: Record<string, unknown>) => Promise<boolean>;
  onRunCronJob: (id: string, mode?: "force" | "due") => Promise<boolean>;
  onRemoveCronJob: (id: string) => Promise<boolean>;
  gatewayCommands: GatewayCommand[];
  themeMode: "light" | "dark";
  onToggleThemeMode: () => void;
  requestThreadListRefresh: (fn: () => void) => void;
}

function ChatAppInner({
  connectionState,
  onSettingsClick,
  createSession,
  renameSession,
  deleteSession,
  resetSession,
  compactSession,
  onSessionChanged,
  loadThread,
  sessionMeta,
  availableModels,
  defaultAgentId,
  gatewayDefaultModelId,
  agentModelById,
  patchSession,
  knownAgentIds,
  artifacts,
  apps,
  uploads,
  appList,
  artifactList,
  pinnedAppIds,
  onTogglePinned,
  workspaceByThread,
  onUpdateThreadWorkspace,
  onMarkUploadsSent,
  onRemoveUpload,
  pendingPreviewOpen,
  onSetPendingPreviewOpen,
  onConsumePendingPreview,
  onDeleteApp,
  onRefreshApps,
  onRefreshArtifacts,
  notifications,
  onMarkNotificationsRead,
  onRefreshNotifications,
  onUpsertNotification,
  cronJobs,
  cronRuns,
  onRefreshCronData,
  onUpdateCronJob,
  onRunCronJob,
  onRemoveCronJob,
  gatewayCommands,
  themeMode,
  onToggleThemeMode,
  requestThreadListRefresh,
}: ChatAppInnerProps) {
  // Extra (non-destructured-above) props that flow through ChatAppInner.
  // Using `arguments` would be noisy; re-grab via a local re-assignment.
  const route = useHashRoute() ?? { view: "home" as const };
  const isMobile = useIsMobile();
  const { threads, selectedThreadId, selectThread, loadThreads } = useThreadList();
  const selectedThreadIsRunning = useThread((state) => state.isRunning);
  const dispatchChatProcessMessage = useThread((state) => state.processMessage);

  const [mobileNotificationInboxOpen, setMobileNotificationInboxOpen] = useState(false);
  const [workspacePaneCollapsed, setWorkspacePaneCollapsed] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [cronTrayJobId, setCronTrayJobId] = useState<string | null>(null);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
  const [toastNotices, setToastNotices] = useState<NotificationToastNotice[]>([]);
  const notificationIdsRef = useRef<Set<string>>(new Set());
  // Anchor "what counts as new" to page-load time, not to the first render.
  // The first render lands before `engine.listNotifications()` resolves, so a
  // primer-set-based check would treat the entire async-loaded list as new
  // on every reload and pop a toast for each one. Anything with `createdAt`
  // earlier than this timestamp is a pre-existing notification, not a new
  // one to surface.
  const notificationLoadTimeRef = useRef<number>(Date.now());
  const unreadNotificationCount = useMemo(
    () => notifications.filter((notification) => notification.unread).length,
    [notifications],
  );
  const backgroundRunTrackersRef = useRef(
    new Map<
      string,
      {
        threadId: string;
        sessionKey: string;
        title: string;
        agentId: string;
        baselineUpdatedAt: number;
        baselineNotificationIds: Set<string>;
        leftThread: boolean;
      }
    >(),
  );

  const collectThreadNotificationIds = useCallback(
    (threadId: string, sessionKey: string) =>
      new Set(
        notifications
          .filter((notification) => {
            if (!notification.unread) return false;
            if (notification.target.view === "chat" && notification.target.sessionId === threadId) {
              return true;
            }
            return notification.source?.sessionKey === sessionKey;
          })
          .map((notification) => notification.id),
      ),
    [notifications],
  );
  const activeAppUpdatedAt = useMemo(
    () =>
      route.view === "app" ? appList.find((app) => app.id === route.appId)?.updatedAt : undefined,
    [appList, route],
  );
  const activeArtifactUpdatedAt = useMemo(
    () =>
      route.view === "artifact"
        ? artifactList.find((artifact) => artifact.id === route.artifactId)?.updatedAt
        : undefined,
    [artifactList, route],
  );
  const hiddenRefinementThreadIds = useMemo(() => {
    const hidden = new Set<string>();

    Object.entries(workspaceByThread).forEach(([threadId, workspace]) => {
      const sourceSessionKey =
        workspace.linkedApp?.sessionKey ?? workspace.linkedArtifact?.sessionKey;
      if (!sourceSessionKey) return;

      const sourceThreadId = sessionRouteIdFromSessionKey(sourceSessionKey, knownAgentIds.current);

      if (threadId !== sourceThreadId) {
        hidden.add(threadId);
      }
    });

    return hidden;
  }, [knownAgentIds, workspaceByThread]);

  // Sent uploads hydrate via engine.uploads.listUploads once the engine is ready.
  // Backfill here in case ChatProvider loaded the thread before the engine connected.
  useEffect(() => {
    if (!uploads || !selectedThreadId) return;
    const threadId = selectedThreadId;
    const resolvedKey = resolveChatSessionKey(threadId, knownAgentIds.current);
    let cancelled = false;
    void uploads.listUploads(resolvedKey).then((metas) => {
      if (cancelled) return;
      onUpdateThreadWorkspace(threadId, (current) => {
        const existingPending = current.uploads.filter((upload) => upload.status === "pending");
        const remoteUploads = metas.map(uploadMetaToThreadUpload);
        return {
          uploads: [...remoteUploads, ...existingPending],
          linkedApp: current.linkedApp,
          linkedArtifact: current.linkedArtifact,
        };
      });
    });
    return () => {
      cancelled = true;
    };
  }, [uploads, selectedThreadId, knownAgentIds, onUpdateThreadWorkspace]);

  const notificationMatchesRoute = useCallback(
    (notification: NotificationRecord) => {
      switch (notification.target.view) {
        case "chat":
          return route.view === "chat" && route.sessionId === notification.target.sessionId;
        case "app":
          return route.view === "app" && route.appId === notification.target.appId;
        case "artifact":
          return route.view === "artifact" && route.artifactId === notification.target.artifactId;
        default:
          return false;
      }
    },
    [route],
  );

  useEffect(() => {
    if (!ENABLE_THREAD_REPLY_NOTIFICATIONS) return;
    if (!selectedThreadId || !selectedThreadIsRunning) return;

    const sessionKey = resolveChatSessionKey(selectedThreadId, knownAgentIds.current);
    const trackers = backgroundRunTrackersRef.current;
    if (trackers.has(sessionKey)) return;

    const currentThread = threads.find((thread) => thread.id === selectedThreadId) as
      | ClawThread
      | undefined;
    trackers.set(sessionKey, {
      threadId: selectedThreadId,
      sessionKey,
      title: currentThread?.title ?? "Conversation",
      agentId: currentThread?.clawAgentId ?? selectedThreadId,
      baselineUpdatedAt: sessionMeta.get(sessionKey)?.updatedAt ?? 0,
      baselineNotificationIds: collectThreadNotificationIds(selectedThreadId, sessionKey),
      leftThread: !(route.view === "chat" && route.sessionId === selectedThreadId),
    });
  }, [
    collectThreadNotificationIds,
    knownAgentIds,
    route,
    selectedThreadId,
    selectedThreadIsRunning,
    sessionMeta,
    threads,
  ]);

  useEffect(() => {
    if (!ENABLE_THREAD_REPLY_NOTIFICATIONS) return;
    const trackers = backgroundRunTrackersRef.current;
    trackers.forEach((tracker) => {
      tracker.leftThread = !(route.view === "chat" && route.sessionId === tracker.threadId);
    });
  }, [route]);

  useEffect(() => {
    if (!ENABLE_THREAD_REPLY_NOTIFICATIONS) return;

    const trackers = backgroundRunTrackersRef.current;
    const completedTrackers = Array.from(trackers.entries()).filter(
      ([sessionKey, tracker]) =>
        (sessionMeta.get(sessionKey)?.updatedAt ?? 0) > tracker.baselineUpdatedAt,
    );

    if (completedTrackers.length === 0) return;

    const finalizeCompletedRuns = async () => {
      for (const [sessionKey, tracker] of completedTrackers) {
        trackers.delete(sessionKey);

        if (!tracker.leftThread) {
          continue;
        }

        const threadNotificationIds = collectThreadNotificationIds(tracker.threadId, sessionKey);
        const alreadyHasSpecificNotification = Array.from(threadNotificationIds).some(
          (id) => !tracker.baselineNotificationIds.has(id),
        );

        if (alreadyHasSpecificNotification) {
          continue;
        }

        const updatedAt = sessionMeta.get(sessionKey)?.updatedAt ?? Date.now();
        await onUpsertNotification({
          dedupeKey: `thread-reply:${tracker.threadId}:${updatedAt}`,
          kind: "thread_reply",
          title: tracker.title,
          message: "A background reply finished while you were away.",
          target: { view: "chat", sessionId: tracker.threadId },
          source: {
            agentId: tracker.agentId,
            sessionKey,
          },
        });
      }
    };

    void finalizeCompletedRuns();
  }, [collectThreadNotificationIds, onUpsertNotification, sessionMeta]);

  // Sync hash route → selected thread
  useEffect(() => {
    if (route.view === "chat" && route.sessionId !== selectedThreadId) {
      selectThread(route.sessionId);
    }
  }, [route, selectedThreadId, selectThread]);

  // Re-fetch history once the engine is actually connected.
  // The first selectThread fires before the engine exists (child effects
  // run before the parent's useGateway effect), so loadThread returns [].
  // When connectionState transitions to CONNECTED the engine is ready —
  // re-select the same thread to load real messages.
  const prevConnected = useRef(false);
  useEffect(() => {
    const justConnected = connectionState === ConnectionState.CONNECTED && !prevConnected.current;
    prevConnected.current = connectionState === ConnectionState.CONNECTED;
    if (justConnected && route.view === "chat" && route.sessionId === selectedThreadId) {
      selectThread(route.sessionId);
    }
  }, [connectionState, route, selectedThreadId, selectThread]);

  useEffect(() => {
    if (connectionState === ConnectionState.CONNECTED) {
      loadThreads();
    }
  }, [connectionState, loadThreads]);

  useEffect(() => {
    requestThreadListRefresh(() => loadThreads());
  }, [requestThreadListRefresh, loadThreads]);

  /**
   * Resolve where a refine click should land:
   *   1. originating session (sessionKey → routed thread id)
   *   2. agent's `clawKind === "main"` thread, if the originating one is gone
   *   3. fresh session under the agent, as a last resort
   * Returns `null` only if we have no agent to attach to either.
   */
  const resolveRefineThreadId = useCallback(
    async (sessionKey: string | undefined, agentId: string | undefined) => {
      if (sessionKey) {
        const candidate = sessionRouteIdFromSessionKey(sessionKey, knownAgentIds.current);
        const exists = (threads as unknown as ClawThread[]).some((t) => t.id === candidate);
        if (exists) return candidate;
      }
      if (agentId) {
        const main = (threads as unknown as ClawThread[]).find(
          (t) => (t.clawAgentId ?? t.id) === agentId && t.clawKind === "main",
        );
        if (main) return main.id;
        return await createSession(agentId);
      }
      return null;
    },
    [createSession, knownAgentIds, threads],
  );

  /**
   * Drop the user back into the chat thread that produced an app/artifact and
   * prefill the composer with a refine instruction. Replaces the old iframe
   * iframe RefineTray flow — same gateway, same store, no embed mode.
   *
   * Composer prefill is delivered via a window event the SessionComposer
   * listens for in a useEffect. We dispatch on the next animation frame so
   * the composer has had a chance to mount when navigating from a route
   * that doesn't render it (e.g. /apps/<id> → /chat/<threadId>).
   */
  const refineInChat = useCallback(
    async (
      target: { kind: "app"; record: AppRecord } | { kind: "artifact"; record: ArtifactRecord },
    ) => {
      const sessionKey =
        target.kind === "app" ? target.record.sessionKey : target.record.source?.sessionId;
      const agentId = target.kind === "app" ? target.record.agentId : target.record.source?.agentId;
      const nextThreadId = await resolveRefineThreadId(sessionKey, agentId);
      if (!nextThreadId) return;

      if (target.kind === "app") {
        // Link the app to the thread so the "Refining ..." chip shows up,
        // and queue the app's artifact preview to auto-open. With the split-
        // pane Shell.ThreadContainer, the chat stays visible on the left
        // while the app pins on the right — so opening the preview no longer
        // hides the composer. Clear `linkedArtifact` so a previous artifact
        // refine doesn't leak both contexts into the next user message.
        onUpdateThreadWorkspace(nextThreadId, (current) => ({
          ...current,
          linkedArtifact: null,
          linkedApp: {
            appId: target.record.id,
            title: target.record.title,
            agentId: target.record.agentId,
            sessionKey: target.record.sessionKey,
          },
        }));
        onSetPendingPreviewOpen({
          threadId: nextThreadId,
          previewId: sessionAppPreviewId(target.record.id),
        });
      } else {
        // Same parity as `linkedApp`: stamp `linkedArtifact` so the chip shows
        // and the model gets context, then auto-open the artifact preview on
        // desktop (mobile suppresses the overlay during chat — see effect at
        // ~line 467).
        const artifactSessionKey = target.record.source?.sessionId ?? "";
        const artifactAgentId = target.record.source?.agentId ?? "";
        // Clear `linkedApp` so a previous app refine doesn't leak both
        // contexts into the next user message.
        onUpdateThreadWorkspace(nextThreadId, (current) => ({
          ...current,
          linkedApp: null,
          linkedArtifact: {
            artifactId: target.record.id,
            title: target.record.title,
            agentId: artifactAgentId,
            sessionKey: artifactSessionKey,
          },
        }));
        onSetPendingPreviewOpen({
          threadId: nextThreadId,
          previewId: sessionArtifactPreviewId(target.record.id),
        });
      }

      loadThreads();
      selectThread(nextThreadId);
      navigate({ view: "chat", sessionId: nextThreadId });
    },
    [
      loadThreads,
      onSetPendingPreviewOpen,
      onUpdateThreadWorkspace,
      resolveRefineThreadId,
      selectThread,
    ],
  );

  const handleRefineApp = useCallback(
    (record: AppRecord) => refineInChat({ kind: "app", record }),
    [refineInChat],
  );
  const handleRefineArtifact = useCallback(
    (record: ArtifactRecord) => refineInChat({ kind: "artifact", record }),
    [refineInChat],
  );

  /**
   * `ContinueConversation` from inside a standalone app view mirrors the
   * Refine flow: select the app's origin chat thread, pin the app as that
   * thread's `linkedApp` workspace context, open the app preview pane on
   * the right, navigate the URL to the chat view, and finally post the user
   * message via the chat store's `processMessage`. If the app doesn't carry
   * a known sessionKey, fall back to the currently selected thread rather
   * than silently dropping the user's click.
   */
  const handleAppContinueConversation = useCallback(
    async (payload: { message: { role: "user"; content: string }; appRecord: AppRecord }) => {
      const { appRecord, message } = payload;
      const nextThreadId = appRecord.sessionKey
        ? sessionRouteIdFromSessionKey(appRecord.sessionKey, knownAgentIds.current)
        : await createSession(appRecord.agentId);
      if (!nextThreadId) return;

      onUpdateThreadWorkspace(nextThreadId, (current) => ({
        ...current,
        linkedApp: {
          appId: appRecord.id,
          title: appRecord.title,
          agentId: appRecord.agentId,
          sessionKey: appRecord.sessionKey,
        },
      }));
      onSetPendingPreviewOpen({
        threadId: nextThreadId,
        previewId: sessionAppPreviewId(appRecord.id),
      });
      loadThreads();

      // Always navigate to the chat view. The user may already have
      // `selectedThreadId === nextThreadId` while viewing the app surface at
      // `#/apps/<id>` — in that case skipping `navigate` would leave them
      // stuck on the app route even though we've just posted a message.
      selectThread(nextThreadId);
      navigate({ view: "chat", sessionId: nextThreadId });

      // Zustand's set is synchronous, so processMessage sees the new
      // selectedThreadId on the very next call.
      dispatchChatProcessMessage(message);
    },
    [
      createSession,
      dispatchChatProcessMessage,
      knownAgentIds,
      loadThreads,
      onSetPendingPreviewOpen,
      onUpdateThreadWorkspace,
      selectThread,
    ],
  );

  const openNotification = useCallback(
    async (notification: NotificationRecord) => {
      // Backwards-compat: legacy cron notifications were stored with
      // `target: { view: "chat", sessionId: <synthetic-cron-run-key> }` which
      // routed to a non-existent thread (blank page). Detect via
      // `source.cronId` and redirect to the crons view.
      const isLegacyCronTarget =
        notification.target.view === "chat" &&
        typeof notification.source?.cronId === "string" &&
        notification.target.sessionId.includes(":cron:");

      if (isLegacyCronTarget && notification.source?.cronId) {
        setCronTrayJobId(notification.source.cronId);
      } else {
        switch (notification.target.view) {
          case "chat":
            navigate({ view: "chat", sessionId: notification.target.sessionId });
            break;
          case "app":
            navigate({ view: "app", appId: notification.target.appId });
            break;
          case "artifact":
            navigate({ view: "artifact", artifactId: notification.target.artifactId });
            break;
          case "crons":
            if (notification.target.jobId) {
              setCronTrayJobId(notification.target.jobId);
            } else {
              navigate({ view: "crons" });
            }
            break;
          default:
            navigate({ view: "home" });
            break;
        }
      }

      if (notification.unread) {
        await onMarkNotificationsRead([notification.id]);
      }
    },
    [onMarkNotificationsRead],
  );

  useEffect(() => {
    const nextIds = new Set(notifications.map((notification) => notification.id));
    const loadTime = notificationLoadTimeRef.current;
    const newUnreadNotifications = notifications.filter((notification) => {
      if (!notification.unread) return false;
      if (notificationIdsRef.current.has(notification.id)) return false;
      if (notificationMatchesRoute(notification)) return false;
      // Only toast notifications whose underlying event happened during this
      // page session. Prefer `metadata.runAtMs` (the actual cron run time)
      // over the server-set `createdAt`, which can drift on every upsert and
      // make hours-old runs look brand-new on reload.
      const runAtMs =
        typeof notification.metadata?.["runAtMs"] === "number"
          ? notification.metadata["runAtMs"]
          : null;
      const eventTime = runAtMs ?? Date.parse(notification.createdAt);
      if (Number.isFinite(eventTime) && eventTime < loadTime) return false;
      return true;
    });

    if (newUnreadNotifications.length > 0) {
      setToastNotices((current) => {
        const existingNotificationIds = new Set(current.map((toast) => toast.notification.id));
        const additions = newUnreadNotifications
          .filter((notification) => !existingNotificationIds.has(notification.id))
          .map((notification) => ({
            id: `toast:${notification.id}`,
            notification,
          }));

        return [...current, ...additions].slice(-4);
      });
    }

    notificationIdsRef.current = nextIds;
  }, [notificationMatchesRoute, notifications]);

  useEffect(() => {
    if (toastNotices.length === 0) return;

    const timers = toastNotices.map((toast) =>
      window.setTimeout(() => {
        setToastNotices((current) => current.filter((candidate) => candidate.id !== toast.id));
      }, 5000),
    );

    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [toastNotices]);

  useEffect(() => {
    const ids = notifications
      .filter((notification) => {
        if (!notification.unread) return false;
        return notificationMatchesRoute(notification);
      })
      .map((notification) => notification.id);

    if (ids.length === 0) return;

    const timeoutId = window.setTimeout(() => {
      void onMarkNotificationsRead(ids);
    }, 1500);

    return () => window.clearTimeout(timeoutId);
  }, [notificationMatchesRoute, notifications, onMarkNotificationsRead]);

  // Home composer — same SessionComposer used in chat. To make the
  // composer's `processMessage` (read from `useThread`) land in the
  // default agent's main session, we make sure that thread is selected
  // whenever home is the active route. SessionComposer's submit then
  // dispatches there directly via the global ChatProvider store.
  const homeMainThreadId = useMemo(() => {
    const allHere = threads as unknown as ClawThread[];
    if (allHere.length === 0) return null;
    // Preferred: the configured default agent's main thread.
    if (defaultAgentId) {
      const main = allHere.find(
        (t) => (t.clawAgentId ?? t.id) === defaultAgentId && t.clawKind === "main",
      );
      if (main) return main.id;
    }
    // Fallbacks (offline / no defaultAgentId yet): any main thread,
    // else the first available thread, so the home composer always
    // has a target session for uploads + processMessage.
    return allHere.find((t) => t.clawKind === "main")?.id ?? allHere[0]?.id ?? null;
  }, [threads, defaultAgentId]);

  useEffect(() => {
    if (route.view !== "home") return;
    if (!homeMainThreadId) return;
    if (selectedThreadId === homeMainThreadId) return;
    selectThread(homeMainThreadId);
  }, [route.view, homeMainThreadId, selectedThreadId, selectThread]);

  // Once the home composer kicks off a submission, jump to the main
  // session's chat so the user sees their message + the agent's response
  // stream in. SessionComposer's submit flips the global `isRunning`
  // flag, so we react to that — no need to wrap the composer's onSubmit.
  useEffect(() => {
    if (route.view !== "home") return;
    if (!homeMainThreadId) return;
    if (!selectedThreadIsRunning) return;
    navigate({ view: "chat", sessionId: homeMainThreadId });
  }, [route.view, homeMainThreadId, selectedThreadIsRunning]);

  // File-attach plumbing for the home composer. Mirrors the per-thread
  // pipeline in ThreadArea but pinned to `homeMainThreadId` instead of
  // `selectedThreadId`. The hidden <input type="file"> is rendered as a
  // sibling of the composer (see the JSX returned by `homeComposerEl`).
  const homeFileInputRef = useRef<HTMLInputElement | null>(null);
  const homeAddFiles = useCallback(
    async (files: File[]) => {
      if (!homeMainThreadId || files.length === 0) return;
      const sessionKey = resolveChatSessionKey(homeMainThreadId, knownAgentIds.current);
      const nextUploads = await Promise.all(files.map((file) => fileToThreadUpload(file)));
      onUpdateThreadWorkspace(homeMainThreadId, (current) => ({
        ...current,
        uploads: [...current.uploads, ...nextUploads],
      }));
      if (uploads && sessionKey) {
        await Promise.all(
          nextUploads.map(async (upload) => {
            if (!upload.attachment?.content) return;
            const meta = await uploads.putUpload({
              sessionKey,
              name: upload.name,
              mimeType: upload.mimeType,
              content: upload.attachment.content,
              size: upload.size,
            });
            if (!meta) return;
            onUpdateThreadWorkspace(homeMainThreadId, (current) => ({
              ...current,
              uploads: current.uploads.map((c) =>
                c.id === upload.id ? { ...c, remoteId: meta.id } : c,
              ),
            }));
          }),
        );
      }
    },
    [homeMainThreadId, knownAgentIds, onUpdateThreadWorkspace, uploads],
  );
  const homeOpenFilePicker = useCallback(() => {
    homeFileInputRef.current?.click();
  }, []);
  const handleHomeFilesSelected = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []);
      event.target.value = "";
      await homeAddFiles(files);
    },
    [homeAddFiles],
  );

  const homeComposerEl = useMemo(() => {
    const workspace = homeMainThreadId
      ? (workspaceByThread[homeMainThreadId] ?? EMPTY_THREAD_WORKSPACE)
      : EMPTY_THREAD_WORKSPACE;
    const sessionKey = homeMainThreadId
      ? resolveChatSessionKey(homeMainThreadId, knownAgentIds.current)
      : "";
    const meta = sessionKey ? sessionMeta.get(sessionKey) : undefined;
    return (
      <>
        <input
          ref={homeFileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleHomeFilesSelected}
        />
        <SessionComposer
          uploads={workspace.uploads}
          linkedApp={workspace.linkedApp}
          linkedArtifact={workspace.linkedArtifact}
          onPickFiles={homeOpenFilePicker}
          onAddFiles={homeAddFiles}
          onRemoveUpload={(uploadId) => {
            if (homeMainThreadId) onRemoveUpload(homeMainThreadId, uploadId);
          }}
          onUploadsSent={(uploadIds) => {
            if (homeMainThreadId) onMarkUploadsSent(homeMainThreadId, uploadIds);
          }}
          commandContext={() => ({
            threadId: homeMainThreadId,
            messages: [],
            toast: () => {},
            downloadBlob: () => {},
          })}
          gatewayCommands={[]}
          onDispatchGatewayCommand={async () => false}
          models={availableModels}
          gatewayDefaultModelId={gatewayDefaultModelId}
          agentDefaultModelId={(() => {
            const targetAgentId = defaultAgentId;
            return targetAgentId ? (agentModelById.get(targetAgentId) ?? null) : null;
          })()}
          currentModel={meta?.model ? qualifyModel(meta.model, meta.modelProvider ?? "") : ""}
          currentEffort={meta?.thinkingLevel ?? ""}
          effortDefault={meta?.thinkingDefault ?? null}
          effortOptions={meta?.thinkingOptions ?? null}
          onModelChange={
            sessionKey
              ? (value) => {
                  void patchSession(sessionKey, { model: value || null });
                }
              : undefined
          }
          onEffortChange={
            sessionKey
              ? (value) => {
                  void patchSession(sessionKey, { thinkingLevel: value || null });
                }
              : undefined
          }
          // Skip the rotating placeholder + TAB-to-fill UX on mobile — the
          // overlay assumes a hardware keyboard and the TAB tag has no
          // affordance on touch.
          rotatingPlaceholders={isMobile ? undefined : DEFAULT_STARTERS.map((s) => s.displayText)}
          rotatingPlaceholderFillWith={isMobile ? undefined : DEFAULT_STARTERS.map((s) => s.prompt)}
        />
      </>
    );
  }, [
    homeMainThreadId,
    workspaceByThread,
    knownAgentIds,
    sessionMeta,
    availableModels,
    gatewayDefaultModelId,
    defaultAgentId,
    agentModelById,
    patchSession,
    onRemoveUpload,
    onMarkUploadsSent,
    homeOpenFilePicker,
    homeAddFiles,
    handleHomeFilesSelected,
    isMobile,
  ]);

  let mainContent: React.ReactNode;
  if (route.view === "home") {
    const homeProps = {
      threads,
      apps: appList,
      artifacts: artifactList,
      notifications,
      cronJobs,
      cronRuns,
      onNavigate: (view: "agents" | "apps" | "artifacts" | "crons") => navigate({ view }),
      onOpenThread: (threadId: string) => navigate({ view: "chat", sessionId: threadId }),
      onOpenApp: (appId: string) => navigate({ view: "app", appId }),
      onOpenArtifact: (artifactId: string) => navigate({ view: "artifact", artifactId }),
      onOpenNotif: async (notifId: string) => {
        const target = notifications.find((n) => n.id === notifId);
        if (target) await openNotification(target);
      },
      onMarkNotifRead: (notifId: string) => {
        void onMarkNotificationsRead([notifId]);
      },
      onMarkAllNotifsRead: async () => {
        await onMarkNotificationsRead();
      },
      onOpenCron: (jobId: string) => setCronTrayJobId(jobId),
      composer: homeComposerEl,
    };
    mainContent = (
      <div className="flex h-full min-w-0 flex-1 overflow-hidden">
        {isMobile ? <MobileHomeView {...homeProps} /> : <HomeView {...homeProps} />}
      </div>
    );
  } else if (route.view === "agents") {
    const onOpenThread = (threadId: string) => navigate({ view: "chat", sessionId: threadId });
    mainContent = (
      <Shell.ThreadContainer>
        {isMobile ? (
          <MobileAgentsView threads={threads} onOpenThread={onOpenThread} />
        ) : (
          <AgentsView threads={threads} onOpenThread={onOpenThread} />
        )}
      </Shell.ThreadContainer>
    );
  } else if (route.view === "apps") {
    const onOpenApp = (appId: string) => navigate({ view: "app", appId });
    mainContent = (
      <Shell.ThreadContainer>
        {isMobile ? (
          <MobileAppsView
            apps={appList}
            pinnedAppIds={pinnedAppIds}
            onOpenApp={onOpenApp}
            onDeleteApp={async (appId) => {
              await onDeleteApp(appId);
              onRefreshApps();
            }}
            onRefineApp={(app) => {
              const id = app.sessionKey
                ? sessionRouteIdFromSessionKey(app.sessionKey, knownAgentIds.current)
                : null;
              if (id) navigate({ view: "chat", sessionId: id });
            }}
          />
        ) : (
          <AppsView apps={appList} pinnedAppIds={pinnedAppIds} onOpenApp={onOpenApp} />
        )}
      </Shell.ThreadContainer>
    );
  } else if (route.view === "artifacts" && artifacts) {
    const onOpenArtifact = (artifactId: string) => navigate({ view: "artifact", artifactId });
    mainContent = (
      <Shell.ThreadContainer>
        {isMobile ? (
          <MobileArtifactsView
            artifacts={artifacts}
            onOpenArtifact={onOpenArtifact}
            connectionState={connectionState}
            onDeleteArtifact={async (artifactId) => {
              await artifacts.deleteArtifact(artifactId);
              onRefreshArtifacts();
            }}
            onRefineArtifact={(artifact) => {
              const id = artifact.source?.sessionId
                ? sessionRouteIdFromSessionKey(artifact.source.sessionId, knownAgentIds.current)
                : null;
              if (id) navigate({ view: "chat", sessionId: id });
            }}
          />
        ) : (
          <ArtifactsView
            artifacts={artifacts}
            onOpenArtifact={onOpenArtifact}
            connectionState={connectionState}
          />
        )}
      </Shell.ThreadContainer>
    );
  } else if (route.view === "crons") {
    const cronsProps = {
      cronJobs,
      runs: cronRuns,
      threads,
      initialSelectedId: route.selectedId,
      onOpenThread: (threadId: string) => navigate({ view: "chat", sessionId: threadId }),
      onUpdateCronJob,
      onRunCronJob,
      onRemoveCronJob,
      onRefreshCronData,
    };
    mainContent = (
      <Shell.ThreadContainer>
        {isMobile ? <MobileCronsView {...cronsProps} /> : <CronsView {...cronsProps} />}
      </Shell.ThreadContainer>
    );
  } else if ((route.view === "artifact" && artifacts) || (route.view === "app" && apps)) {
    // Full-screen modal view for standalone app/artifact URLs — mirrors the
    // in-chat preview modal so the UX is identical whether the user lands
    // here via sidebar nav, home page, or an in-thread workspace tile.
    const routeThreads = threads as unknown as ClawThread[];
    const agentNameFor = makeAgentNameResolver(routeThreads);
    const appSiblings = buildAppSiblings(appList, agentNameFor);
    const artifactSiblings = buildArtifactSiblings(artifactList, agentNameFor);
    if (isMobile && route.view === "app" && apps) {
      mainContent = (
        <MobileAppDetail
          appId={route.appId}
          apps={apps}
          updatedAt={activeAppUpdatedAt}
          onContinueConversation={handleAppContinueConversation}
          onRefine={handleRefineApp}
          onDeleted={onRefreshApps}
          onClose={smartBack(() => navigate({ view: "apps" }))}
          siblings={appSiblings}
          onSwitch={(nextAppId) => navigate({ view: "app", appId: nextAppId })}
        />
      );
    } else if (isMobile && route.view === "artifact" && artifacts) {
      mainContent = (
        <MobileArtifactDetail
          artifactId={route.artifactId}
          artifacts={artifacts}
          updatedAt={activeArtifactUpdatedAt}
          onRefine={handleRefineArtifact}
          onDeleted={onRefreshArtifacts}
          onClose={smartBack(() => navigate({ view: "artifacts" }))}
          siblings={artifactSiblings}
          onSwitch={(nextArtId) => navigate({ view: "artifact", artifactId: nextArtId })}
        />
      );
    } else {
      mainContent = (
        <div className="relative flex h-full min-w-0 flex-1 bg-background dark:bg-sunk">
          <div className="flex min-w-0 flex-1 flex-col">
            {route.view === "app" && apps ? (
              <AppDetail
                appId={route.appId}
                apps={apps}
                updatedAt={activeAppUpdatedAt}
                mode="panel"
                isPinned={pinnedAppIds.has(route.appId)}
                onTogglePinned={onTogglePinned}
                onRefine={handleRefineApp}
                onContinueConversation={handleAppContinueConversation}
                onDeleted={() => {
                  onRefreshApps();
                  navigate({ view: "home" });
                }}
                onClose={() => navigate({ view: "home" })}
                siblings={appSiblings}
                onSwitch={(nextAppId) => navigate({ view: "app", appId: nextAppId })}
              />
            ) : null}
            {route.view === "artifact" && artifacts ? (
              <ArtifactDetail
                artifactId={route.artifactId}
                artifacts={artifacts}
                updatedAt={activeArtifactUpdatedAt}
                mode="panel"
                onDeleted={() => {
                  onRefreshArtifacts();
                  navigate({ view: "home" });
                }}
                onClose={() => navigate({ view: "home" })}
                onRefine={handleRefineArtifact}
                siblings={artifactSiblings}
                onSwitch={(nextArtId) => navigate({ view: "artifact", artifactId: nextArtId })}
              />
            ) : null}
          </div>
        </div>
      );
    }
  } else {
    mainContent = (
      <ThreadArea
        sessionMeta={sessionMeta}
        availableModels={availableModels}
        gatewayDefaultModelId={gatewayDefaultModelId}
        agentModelById={agentModelById}
        defaultAgentId={defaultAgentId}
        patchSession={patchSession}
        createSession={createSession}
        deleteSession={deleteSession}
        renameSession={renameSession}
        resetSession={resetSession}
        compactSession={compactSession}
        onSessionChanged={onSessionChanged}
        loadThread={loadThread}
        knownAgentIds={knownAgentIds}
        appList={appList}
        artifactList={artifactList}
        apps={apps}
        artifacts={artifacts}
        uploads={uploads}
        pinnedAppIds={pinnedAppIds}
        onTogglePinned={onTogglePinned}
        workspaceByThread={workspaceByThread}
        onUpdateThreadWorkspace={onUpdateThreadWorkspace}
        onMarkUploadsSent={onMarkUploadsSent}
        onRemoveUpload={onRemoveUpload}
        onRefreshDurables={() => {
          onRefreshApps();
          onRefreshArtifacts();
        }}
        onRefreshSummaries={() => {
          onRefreshApps();
          onRefreshArtifacts();
          void onRefreshNotifications();
          void onRefreshCronData();
        }}
        pendingPreviewOpen={pendingPreviewOpen}
        onConsumePendingPreview={onConsumePendingPreview}
        onRefineApp={handleRefineApp}
        onRefineArtifact={handleRefineArtifact}
        onAppContinueConversation={handleAppContinueConversation}
        workspacePaneCollapsed={workspacePaneCollapsed}
        onToggleWorkspacePaneCollapsed={setWorkspacePaneCollapsed}
        gatewayCommands={gatewayCommands}
      />
    );
  }

  if (isMobile) {
    return (
      <Shell.Container agentName="Claw" logoUrl={LOGO_URL}>
        <MobileShell
          route={route}
          unreadNotificationCount={unreadNotificationCount}
          connectionState={connectionState}
          onOpenSearch={() => setPaletteOpen(true)}
          onOpenNotifications={() => setMobileNotificationInboxOpen(true)}
          onOpenSettings={onSettingsClick}
          themeMode={themeMode}
          onToggleThemeMode={onToggleThemeMode}
          chromeless={
            route.view === "chat" ||
            route.view === "app" ||
            route.view === "artifact" ||
            (route.view === "crons" && Boolean(route.selectedId))
          }
        >
          {mainContent}
        </MobileShell>
        <MobileNotificationInboxDrawer
          open={mobileNotificationInboxOpen}
          onClose={() => setMobileNotificationInboxOpen(false)}
          notifications={notifications}
          onMarkAllRead={async () => {
            await onMarkNotificationsRead();
          }}
          onOpenNotification={async (notification) => {
            setMobileNotificationInboxOpen(false);
            await openNotification(notification);
          }}
        />
        <NotificationToastViewport
          toasts={toastNotices}
          onDismiss={(toastId) => {
            setToastNotices((current) => current.filter((toast) => toast.id !== toastId));
          }}
          onOpen={(notification, toastId) => {
            setToastNotices((current) => current.filter((toast) => toast.id !== toastId));
            void openNotification(notification);
          }}
        />
        <CommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          threads={threads as unknown as ClawThreadListItem[]}
          apps={appList}
          artifacts={artifactList}
          onTarget={(target) => {
            if (target.kind === "thread") {
              navigate({ view: "chat", sessionId: target.threadId });
            } else if (target.kind === "app") {
              navigate({ view: "app", appId: target.appId });
            } else if (target.kind === "artifact") {
              navigate({ view: "artifact", artifactId: target.artifactId });
            } else if (target.kind === "command") {
              if (route.view !== "chat") navigate({ view: "home" });
              const evt = new CustomEvent("openclaw-os:prime-composer", {
                detail: { text: `/${target.command.name} ` },
              });
              window.dispatchEvent(evt);
            }
          }}
        />
        {cronTrayJobId ? (
          <CronTrayHost
            jobId={cronTrayJobId}
            cronJobs={cronJobs}
            runs={cronRuns}
            threads={threads}
            isMobile
            onClose={() => setCronTrayJobId(null)}
            onOpenThread={(threadId) => {
              setCronTrayJobId(null);
              navigate({ view: "chat", sessionId: threadId });
            }}
            onUpdateCronJob={onUpdateCronJob}
            onRunCronJob={onRunCronJob}
            onRemoveCronJob={onRemoveCronJob}
            onRefreshCronData={onRefreshCronData}
          />
        ) : null}
      </Shell.Container>
    );
  }

  return (
    <Shell.Container agentName="Claw" logoUrl={LOGO_URL}>
      <RouteSidebarSync collapse={route.view === "app" || route.view === "artifact"} />
      <AppSidebar
        connectionState={connectionState}
        onSettingsClick={onSettingsClick}
        createSession={createSession}
        renameSession={renameSession}
        deleteSession={deleteSession}
        apps={appList}
        artifacts={artifactList}
        unreadNotificationCount={unreadNotificationCount}
        hiddenThreadIds={hiddenRefinementThreadIds}
        pinnedAppIds={pinnedAppIds}
        onOpenCommandPalette={() => setPaletteOpen(true)}
        themeMode={themeMode}
        onToggleThemeMode={onToggleThemeMode}
      />
      {mainContent}
      <NotificationToastViewport
        toasts={toastNotices}
        onDismiss={(toastId) => {
          setToastNotices((current) => current.filter((toast) => toast.id !== toastId));
        }}
        onOpen={(notification, toastId) => {
          setToastNotices((current) => current.filter((toast) => toast.id !== toastId));
          void openNotification(notification);
        }}
      />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        threads={threads as unknown as ClawThreadListItem[]}
        apps={appList}
        artifacts={artifactList}
        onTarget={(target) => {
          if (target.kind === "thread") {
            navigate({ view: "chat", sessionId: target.threadId });
          } else if (target.kind === "app") {
            navigate({ view: "app", appId: target.appId });
          } else if (target.kind === "artifact") {
            navigate({ view: "artifact", artifactId: target.artifactId });
          } else if (target.kind === "command") {
            // Focus the composer and prime it with the command. If user isn't
            // in a chat, drop them into the home route first so the composer
            // is visible.
            if (route.view !== "chat") navigate({ view: "home" });
            const evt = new CustomEvent("openclaw-os:prime-composer", {
              detail: { text: `/${target.command.name} ` },
            });
            window.dispatchEvent(evt);
          }
        }}
      />
      {cronTrayJobId ? (
        <CronTrayHost
          jobId={cronTrayJobId}
          cronJobs={cronJobs}
          runs={cronRuns}
          threads={threads}
          isMobile={false}
          onClose={() => setCronTrayJobId(null)}
          onOpenThread={(threadId) => {
            setCronTrayJobId(null);
            navigate({ view: "chat", sessionId: threadId });
          }}
          onUpdateCronJob={onUpdateCronJob}
          onRunCronJob={onRunCronJob}
          onRemoveCronJob={onRemoveCronJob}
          onRefreshCronData={onRefreshCronData}
        />
      ) : null}
    </Shell.Container>
  );
}

const THEME_STORAGE_KEY = "claw:theme";

export default function ChatApp() {
  const isMobile = useIsMobile();
  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => {
    applyPreferences();
  }, []);
  const [appList, setAppList] = useState<AppSummary[]>([]);
  const [artifactList, setArtifactList] = useState<ArtifactSummary[]>([]);
  const [pinnedAppIds, setPinnedAppIds] = useState<Set<string>>(new Set());

  // Single source of truth for color scheme. Drives:
  //  1. the Tailwind chrome via `.dark` on <html>
  //  2. the openui ThemeProvider's `mode` prop (CSS vars)
  //  3. localStorage so the choice survives reload
  // Anything else that wants to read/write theme should consume these props,
  // not mutate <html> or localStorage directly.
  const [themeMode, setThemeMode] = useState<"light" | "dark">(() => {
    if (typeof window === "undefined") return "light";
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "dark" || stored === "light") return stored;
    return document.documentElement.classList.contains("dark") ? "dark" : "light";
  });
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.classList.toggle("dark", themeMode === "dark");
    if (typeof window !== "undefined") {
      window.localStorage.setItem(THEME_STORAGE_KEY, themeMode);
    }
  }, [themeMode]);
  const toggleThemeMode = useCallback(() => {
    setThemeMode((prev) => (prev === "dark" ? "light" : "dark"));
  }, []);
  const [workspaceByThread, setWorkspaceByThread] = useState<Record<string, ThreadWorkspaceState>>(
    {},
  );
  const [pendingPreviewOpen, setPendingPreviewOpen] = useState<{
    threadId: string;
    previewId: string;
  } | null>(null);

  const {
    connectionState,
    pairingDeviceId,
    settings,
    processMessage,
    fetchThreadList,
    loadThread,
    createSession,
    deleteSession,
    renameSession,
    reconnect,
    sessionMeta,
    availableModels,
    gatewayDefaultModelId,
    agentModelById,
    defaultAgentId,
    patchSession,
    resetSession,
    compactSession,
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
    requestThreadListRefresh,
  } = useGateway({ onAuthFailed: () => setSettingsOpen(true) });

  const refreshAppList = useCallback(async () => {
    if (!apps) return;
    const list = await apps.listApps();
    const hydrated = await Promise.all(
      list.map(async (app) => {
        if (app.sessionKey) return app;
        const full = await apps.getApp(app.id);
        return {
          ...app,
          sessionKey: full?.sessionKey ?? "",
        };
      }),
    );
    setAppList(hydrated);
  }, [apps]);

  const refreshArtifactList = useCallback(async () => {
    if (!artifacts) return;
    const list = await artifacts.listArtifacts();
    setArtifactList(list);
  }, [artifacts]);

  useEffect(() => {
    if (connectionState === ConnectionState.CONNECTED) {
      // Apps/artifacts plugin refs can be truthy before the WebSocket finishes
      // handshaking, so listing on plugin-available alone returns [] on a cold
      // first connect (visible on mobile, where there's no second sidebar
      // copy of this effect to bail us out). Gate on CONNECTED so the list
      // calls run against a ready engine — same pattern as notifications and
      // cron below.
      if (apps) void refreshAppList();
      if (artifacts) void refreshArtifactList();
      void refreshNotifications();
      void refreshCronData();
    }
  }, [
    connectionState,
    apps,
    artifacts,
    refreshAppList,
    refreshArtifactList,
    refreshCronData,
    refreshNotifications,
  ]);

  const handleDeleteApp = useCallback(
    async (appId: string) => {
      await apps?.deleteApp(appId);
      void refreshAppList();
    },
    [apps, refreshAppList],
  );

  // Auto-open settings on first visit (no gateway URL configured)
  useEffect(() => {
    if (!getSettings()?.gatewayUrl) setSettingsOpen(true);
  }, []);

  useEffect(() => {
    setPinnedAppIds(new Set(loadPinnedAppIds()));
  }, []);

  const adaptedFetchThreadList = useCallback(async (): Promise<{
    threads: Thread[];
  }> => {
    const rows = await fetchThreadList();
    return {
      threads: rows.map(toThreadRow),
    };
  }, [fetchThreadList]);

  // Stable ref so adaptedLoadThread's async listUploads picks up the latest
  // engine store even when the engine connects after ChatProvider mounts.
  const uploadsRef = useRef(uploads);
  useEffect(() => {
    uploadsRef.current = uploads;
  }, [uploads]);

  const adaptedLoadThread = useCallback(
    async (threadId: string): Promise<Message[]> => {
      const msgs = await loadThread(threadId);
      const historyWorkspace = deriveThreadWorkspaceFromMessages(msgs);

      // Hydrate sent uploads from the plugin (server-authoritative). Resolve
      // the sessionKey first — the raw threadId may be an agent id that
      // resolveChatSessionKey expands to `agent:<id>:main:openclaw-os`.
      let remoteUploads: ThreadUpload[] = [];
      const uploadsStore = uploadsRef.current;
      if (uploadsStore) {
        const scopedSessionKey = resolveChatSessionKey(threadId, knownAgentIds.current);
        try {
          const metas = await uploadsStore.listUploads(scopedSessionKey);
          remoteUploads = metas.map(uploadMetaToThreadUpload);
        } catch (error) {
          console.warn("[claw] uploads.list failed:", error);
        }
      }

      setWorkspaceByThread((current) => {
        const existingPending = (current[threadId]?.uploads ?? []).filter(
          (upload) => upload.status === "pending",
        );
        // Preserve link state that was just written by the Refine flow —
        // history-derived link info is `null` for refines (the link isn't in
        // the message stream yet), so blindly overwriting would drop the chip.
        const existingLinkedApp = current[threadId]?.linkedApp ?? null;
        const existingLinkedArtifact = current[threadId]?.linkedArtifact ?? null;
        return {
          ...current,
          [threadId]: {
            uploads: [...remoteUploads, ...existingPending],
            linkedApp: existingLinkedApp ?? historyWorkspace.linkedApp,
            linkedArtifact: existingLinkedArtifact ?? historyWorkspace.linkedArtifact,
          },
        };
      });

      const result: Message[] = [];
      for (const m of msgs) {
        if (m.role === "assistant") {
          result.push({
            id: m.id,
            role: "assistant" as const,
            content: serializeAssistantTimelineContent({
              text: m.content ?? undefined,
              timeline:
                m.timeline ??
                (m.reasoning
                  ? [
                      {
                        type: "reasoning" as const,
                        text: m.reasoning,
                      },
                    ]
                  : []),
            }),
            ...(m.toolCalls?.length ? { toolCalls: m.toolCalls } : {}),
          });
        } else if (m.role === "activity") {
          result.push({
            id: m.id,
            role: "activity" as const,
            activityType: m.activityType,
            content: m.content,
          });
        } else {
          result.push({ id: m.id, role: m.role, content: m.content });
        }
      }
      return result as Message[];
    },
    [loadThread],
  );

  const togglePinnedApp = useCallback((appId: string) => {
    setPinnedAppIds((current) => {
      const next = new Set(current);
      if (next.has(appId)) next.delete(appId);
      else next.add(appId);
      savePinnedAppIds(next);
      return next;
    });
  }, []);

  const updateThreadWorkspace = useCallback(
    (threadId: string, updater: (current: ThreadWorkspaceState) => ThreadWorkspaceState) => {
      setWorkspaceByThread((current) => ({
        ...current,
        [threadId]: updater(current[threadId] ?? EMPTY_THREAD_WORKSPACE),
      }));
    },
    [],
  );

  const markUploadsSent = useCallback(
    (threadId: string, uploadIds: string[]) => {
      updateThreadWorkspace(threadId, (current) => ({
        ...current,
        uploads: current.uploads.map((upload) =>
          uploadIds.includes(upload.id) ? { ...upload, status: "sent" } : upload,
        ),
      }));
    },
    [updateThreadWorkspace],
  );

  const removeUpload = useCallback(
    (threadId: string, uploadId: string) => {
      // Look up remoteId from current state BEFORE we remove the entry. Reading
      // it inside the state updater is racy — React may batch the updater run
      // after the outer function returns, so the fire-and-forget delete below
      // would read `undefined` and skip the server-side cleanup.
      const target = workspaceByThread[threadId]?.uploads.find((upload) => upload.id === uploadId);
      const removedRemoteId = target?.remoteId;
      updateThreadWorkspace(threadId, (current) => ({
        ...current,
        uploads: current.uploads.filter((upload) => upload.id !== uploadId),
      }));
      if (uploads && removedRemoteId) {
        void uploads.deleteUpload(removedRemoteId).catch((error) => {
          console.warn("[claw] uploads.delete failed:", error);
        });
      }
    },
    [updateThreadWorkspace, uploads, workspaceByThread],
  );

  return (
    <ThemeProvider mode={themeMode}>
      <ChatProvider
        fetchThreadList={adaptedFetchThreadList as any}
        loadThread={adaptedLoadThread}
        processMessage={processMessage as any}
        streamProtocol={openClawAdapter()}
      >
        <ChatAppInner
          connectionState={connectionState}
          onSettingsClick={() => setSettingsOpen(true)}
          onSettingsSave={(newSettings) => {
            reconnect(newSettings);
            setSettingsOpen(false);
          }}
          createSession={createSession}
          renameSession={renameSession}
          deleteSession={deleteSession}
          resetSession={resetSession}
          compactSession={compactSession}
          onSessionChanged={onSessionChanged}
          requestThreadListRefresh={requestThreadListRefresh}
          loadThread={adaptedLoadThread}
          sessionMeta={sessionMeta}
          availableModels={availableModels}
          gatewayDefaultModelId={gatewayDefaultModelId}
          agentModelById={agentModelById}
          defaultAgentId={defaultAgentId}
          patchSession={patchSession}
          knownAgentIds={knownAgentIds}
          artifacts={artifacts}
          apps={apps}
          uploads={uploads}
          appList={appList}
          artifactList={artifactList}
          pinnedAppIds={pinnedAppIds}
          onTogglePinned={togglePinnedApp}
          workspaceByThread={workspaceByThread}
          onUpdateThreadWorkspace={updateThreadWorkspace}
          onMarkUploadsSent={markUploadsSent}
          onRemoveUpload={removeUpload}
          pendingPreviewOpen={pendingPreviewOpen}
          onSetPendingPreviewOpen={setPendingPreviewOpen}
          onConsumePendingPreview={() => setPendingPreviewOpen(null)}
          onDeleteApp={handleDeleteApp}
          onRefreshApps={refreshAppList}
          onRefreshArtifacts={refreshArtifactList}
          notifications={notifications}
          onMarkNotificationsRead={markNotificationsRead}
          onRefreshNotifications={refreshNotifications}
          onUpsertNotification={upsertNotification}
          cronJobs={cronJobs}
          cronRuns={cronRuns}
          cronStatus={cronStatus}
          onRefreshCronData={refreshCronData}
          onUpdateCronJob={updateCronJob}
          onRunCronJob={runCronJob}
          onRemoveCronJob={removeCronJob}
          gatewayCommands={gatewayCommands}
          themeMode={themeMode}
          onToggleThemeMode={toggleThemeMode}
        />

        {isMobile ? (
          <MobileSettingsDialog
            open={settingsOpen}
            currentSettings={settings}
            connectionState={connectionState}
            onClose={() => setSettingsOpen(false)}
            onSave={(newSettings) => {
              // Don't close here — the dialog watches `connectionState` and
              // closes itself on CONNECTED, or stays open with an inline
              // error on UNREACHABLE / AUTH_FAILED.
              reconnect(newSettings);
            }}
          />
        ) : (
          <SettingsDialog
            open={settingsOpen}
            currentSettings={settings}
            connectionState={connectionState}
            onClose={() => setSettingsOpen(false)}
            onSave={(newSettings) => {
              reconnect(newSettings);
            }}
          />
        )}

        {connectionState === ConnectionState.PAIRING && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay backdrop-blur-sm">
            <div className="bg-background rounded-xl shadow-float p-xl max-w-md w-full mx-ml text-center">
              <div className="w-10 h-10 mx-auto mb-ml rounded-full bg-alert-background flex items-center justify-center">
                <svg
                  className="w-l h-l text-text-alert-primary"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={2}
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z"
                  />
                </svg>
              </div>
              <h2 className="text-lg font-bold text-text-neutral-primary mb-s">
                Device Pairing Required
              </h2>
              <p className="text-sm text-text-neutral-tertiary mb-ml">
                This device needs to be approved on your server before it can connect.
              </p>
              <div className="relative group">
                <code className="block px-m py-s pr-10 bg-sunk-light rounded-s text-xs font-code text-text-neutral-secondary break-all select-all text-left">
                  openclaw devices approve {pairingDeviceId}
                </code>
                <button
                  type="button"
                  className="absolute top-xs right-xs p-2xs rounded-s hover:bg-sunk text-text-neutral-tertiary hover:text-text-neutral-secondary transition-colors"
                  onClick={() => {
                    navigator.clipboard.writeText(`openclaw devices approve ${pairingDeviceId}`);
                  }}
                  title="Copy to clipboard"
                >
                  <svg
                    className="w-3.5 h-3.5"
                    fill="none"
                    viewBox="0 0 24 24"
                    strokeWidth={2}
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M15.666 3.888A2.25 2.25 0 0 0 13.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 0 1-.75.75H9.75a.75.75 0 0 1-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 0 1-2.25 2.25H6.75A2.25 2.25 0 0 1 4.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 0 1 1.927-.184"
                    />
                  </svg>
                </button>
              </div>
              <p className="text-xs text-text-neutral-tertiary mt-ml">
                Retrying automatically&hellip;
              </p>
            </div>
          </div>
        )}
      </ChatProvider>
    </ThemeProvider>
  );
}

// Auto-collapse the main left sidebar when the user lands on a fullscreen
// app/artifact view. Lives inside <Shell.Container> so it can call into the
// shell store. Renders nothing.
function RouteSidebarSync({ collapse }: { collapse: boolean }) {
  const setIsSidebarOpen = Shell.useShellStore((s) => s.setIsSidebarOpen);
  useEffect(() => {
    if (collapse) setIsSidebarOpen(false);
  }, [collapse, setIsSidebarOpen]);
  return null;
}
