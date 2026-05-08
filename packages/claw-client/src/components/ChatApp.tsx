"use client";

import { AppOverlays } from "@/components/chat/AppOverlays";
import { ChatAppProvider, type ChatAppContextValue } from "@/components/chat/ChatAppContext";
import { HomeComposer } from "@/components/chat/HomeComposer";
import { MainContent, type Route } from "@/components/chat/MainContent";
import { ThreadArea } from "@/components/chat/ThreadArea";
import { AppSidebar } from "@/components/layout/AppSidebar";
import { MobileShell } from "@/components/layout/MobileShell";
import { MobileNotificationInboxDrawer } from "@/components/mobile/MobileNotificationInboxDrawer";
import { MobileSettingsDialog } from "@/components/mobile/MobileSettingsDialog";
import { SettingsDialog } from "@/components/settings/SettingsDialog";
import { openClawAdapter } from "@/lib/chat/openClawAdapter";
import { useChatProviderAdapters } from "@/lib/chat/useChatProviderAdapters";
import {
  resolveChatSessionKey,
  sessionRouteIdFromSessionKey,
  useGateway,
} from "@/lib/chat/useGateway";
import { useNotificationToasts } from "@/lib/chat/useNotificationToasts";
import { usePinnedApps } from "@/lib/chat/usePinnedApps";
import { useThreadWorkspaces } from "@/lib/chat/useThreadWorkspaces";
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
import type { NotificationRecord } from "@/lib/notifications";
import { apply as applyPreferences } from "@/lib/preferences";
import {
  sessionAppPreviewId,
  sessionArtifactPreviewId,
  uploadMetaToThreadUpload,
  type ThreadWorkspaceState,
} from "@/lib/session-workspace";
import { getSettings } from "@/lib/storage";
import type { ClawThread } from "@/types/claw-thread";
import type { ModelChoice, SessionRow } from "@/types/gateway-responses";
import {
  ChatProvider,
  useArtifactStore,
  useThread,
  useThreadList,
  type Message,
} from "@openuidev/react-headless";
import { Shell, ThemeProvider } from "@openuidev/react-ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const LOGO_URL = "https://www.openui.com/favicon.svg";
const ENABLE_THREAD_REPLY_NOTIFICATIONS = false;
const THEME_STORAGE_KEY = "claw:theme";

interface ChatAppInnerProps {
  // Connection / config
  connectionState: ConnectionState;
  onSettingsClick: () => void;
  // Sessions
  createSession: (agentId: string) => Promise<string | null>;
  renameSession: (threadId: string, label: string) => Promise<boolean>;
  deleteSession: (threadId: string) => Promise<boolean>;
  resetSession: (sessionKey: string) => Promise<boolean>;
  compactSession: (sessionKey: string) => Promise<CompactSessionResult>;
  onSessionChanged: (listener: (sessionKey: string) => void) => () => void;
  loadThread: (threadId: string) => Promise<Message[]>;
  requestThreadListRefresh: (fn: () => void) => void;
  gatewayCommands: GatewayCommand[];
  /** User-initiated Stop. Sends `chat.abort` to the gateway. */
  abort: (threadId: string) => Promise<void>;
  // Models
  sessionMeta: Map<string, SessionRow>;
  availableModels: ModelChoice[];
  gatewayDefaultModelId: string | null;
  agentModelById: Map<string, string>;
  defaultAgentId: string | null;
  patchSession: (key: string, patch: Record<string, unknown>) => Promise<boolean>;
  knownAgentIds: React.RefObject<Set<string>>;
  // Engine stores
  artifacts: ArtifactStore | undefined;
  apps: AppStore | undefined;
  uploads: UploadStore | undefined;
  // Lists
  appList: AppSummary[];
  artifactList: ArtifactSummary[];
  // Pin + workspace state
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
  // Apps + artifacts handlers
  onDeleteApp: (appId: string) => Promise<void>;
  onRefreshApps: () => void;
  onRefreshArtifacts: () => void;
  // Notifications
  notifications: NotificationRecord[];
  onMarkNotificationsRead: (ids?: string[]) => Promise<boolean>;
  onRefreshNotifications: () => Promise<NotificationRecord[]>;
  onUpsertNotification: (
    notification: Omit<NotificationRecord, "id" | "createdAt" | "updatedAt" | "unread" | "readAt">,
  ) => Promise<boolean>;
  // Cron
  cronJobs: CronJobRecord[];
  cronRuns: CronRunEntry[];
  onRefreshCronData: () => Promise<{
    jobs: CronJobRecord[];
    runs: CronRunEntry[];
    status: CronStatusRecord | null;
  }>;
  onUpdateCronJob: (id: string, patch: Record<string, unknown>) => Promise<boolean>;
  onRunCronJob: (id: string, mode?: "force" | "due") => Promise<boolean>;
  onRemoveCronJob: (id: string) => Promise<boolean>;
  // Theme
  themeMode: "light" | "dark";
  onToggleThemeMode: () => void;
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
  requestThreadListRefresh,
  gatewayCommands,
  abort,
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
  themeMode,
  onToggleThemeMode,
}: ChatAppInnerProps) {
  // Without the memo, `?? { view: "home" }` allocates a fresh object every
  // render and busts the dep array of every hook below that lists `route`.
  const rawRoute = useHashRoute();
  const route = useMemo<Route>(() => rawRoute ?? { view: "home" as const }, [rawRoute]);
  const isMobile = useIsMobile();
  const { threads, selectedThreadId, selectThread, loadThreads } = useThreadList();
  const innerArtifactStore = useArtifactStore();
  const selectedThreadIsRunning = useThread((state) => state.isRunning);
  const dispatchChatProcessMessage = useThread((state) => state.processMessage);

  const [mobileNotificationInboxOpen, setMobileNotificationInboxOpen] = useState(false);
  const [workspacePaneCollapsed, setWorkspacePaneCollapsed] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [cronTrayJobId, setCronTrayJobId] = useState<string | null>(null);

  // Stable callbacks for the streaming refresh loops in `ThreadArea`. Inline
  // arrows would bust the loop's dep array on every parent re-render — and
  // since the cleanup runs before the 1200ms-delayed first tick fires, the
  // durable-summary polling would never actually fire during streaming.
  const refreshDurables = useCallback(() => {
    onRefreshApps();
    onRefreshArtifacts();
  }, [onRefreshApps, onRefreshArtifacts]);
  const refreshSummaries = useCallback(() => {
    onRefreshApps();
    onRefreshArtifacts();
    void onRefreshNotifications();
    void onRefreshCronData();
  }, [onRefreshApps, onRefreshArtifacts, onRefreshNotifications, onRefreshCronData]);

  // Close any in-thread artifact preview when navigating to a sidebar view that
  // doesn't render an `ArtifactPortalTarget`. Without this, `Shell.ThreadContainer`
  // still sees `isArtifactActive` and keeps the chat-side column at 420px,
  // leaving a blank ~2/3 of the screen on /crons, /agents, etc.
  useEffect(() => {
    const viewKeepsArtifact =
      route.view === "chat" || route.view === "app" || route.view === "artifact";
    if (viewKeepsArtifact) return;
    const id = innerArtifactStore.getState().activeArtifactId;
    if (id) innerArtifactStore.getState().closeArtifact(id);
  }, [route.view, innerArtifactStore]);

  // Cmd+K / Ctrl+K toggles the command palette.
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

  const {
    toasts: toastNotices,
    dismiss: dismissToast,
    unreadCount: unreadNotificationCount,
  } = useNotificationToasts(notifications, route, onMarkNotificationsRead);

  // Background-run notifications. Currently disabled at the flag, kept here
  // so the wiring is preserved if/when re-enabled.
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

  // `hiddenThreadIds` hides any thread whose only context is a refine-link to
  // some OTHER session — those threads are mid-refine scaffolding the user
  // shouldn't see in the sidebar list until they actually contain messages.
  const hiddenRefinementThreadIds = useMemo(() => {
    const hidden = new Set<string>();
    Object.entries(workspaceByThread).forEach(([threadId, workspace]) => {
      const sourceSessionKey =
        workspace.linkedApp?.sessionKey ?? workspace.linkedArtifact?.sessionKey;
      if (!sourceSessionKey) return;
      const sourceThreadId = sessionRouteIdFromSessionKey(sourceSessionKey, knownAgentIds.current);
      if (threadId !== sourceThreadId) hidden.add(threadId);
    });
    return hidden;
  }, [knownAgentIds, workspaceByThread]);

  // Sent uploads hydrate via engine.uploads.listUploads once the engine is ready.
  // Backfill in case ChatProvider loaded the thread before the engine connected.
  useEffect(() => {
    if (!uploads || !selectedThreadId) return;
    const threadId = selectedThreadId;
    const resolvedKey = resolveChatSessionKey(threadId, knownAgentIds.current);
    let cancelled = false;
    void uploads.listUploads(resolvedKey).then((metas) => {
      if (cancelled) return;
      onUpdateThreadWorkspace(threadId, (current) => {
        const remoteIds = new Set(metas.map((m) => m.id));
        // Drop any local pending entries whose `remoteId` is already covered
        // by `metas` — otherwise we'd carry both the local copy and the
        // server's "sent" copy of the same physical upload, and the workspace
        // Context tray would render two tiles + two preview panels for one
        // file.
        const existingPending = current.uploads.filter(
          (upload) =>
            upload.status === "pending" && !(upload.remoteId && remoteIds.has(upload.remoteId)),
        );
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
    backgroundRunTrackersRef.current.forEach((tracker) => {
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
    const finalize = async () => {
      for (const [sessionKey, tracker] of completedTrackers) {
        trackers.delete(sessionKey);
        if (!tracker.leftThread) continue;
        const threadNotificationIds = collectThreadNotificationIds(tracker.threadId, sessionKey);
        const alreadyHasSpecificNotification = Array.from(threadNotificationIds).some(
          (id) => !tracker.baselineNotificationIds.has(id),
        );
        if (alreadyHasSpecificNotification) continue;
        const updatedAt = sessionMeta.get(sessionKey)?.updatedAt ?? Date.now();
        await onUpsertNotification({
          dedupeKey: `thread-reply:${tracker.threadId}:${updatedAt}`,
          kind: "thread_reply",
          title: tracker.title,
          message: "A background reply finished while you were away.",
          target: { view: "chat", sessionId: tracker.threadId },
          source: { agentId: tracker.agentId, sessionKey },
        });
      }
    };
    void finalize();
  }, [collectThreadNotificationIds, onUpsertNotification, sessionMeta]);

  // Sync hash route → selected thread.
  useEffect(() => {
    if (route.view === "chat" && route.sessionId !== selectedThreadId) {
      selectThread(route.sessionId);
    }
  }, [route, selectedThreadId, selectThread]);

  // Re-fetch history once the engine is actually connected. The first
  // selectThread fires before the engine exists (child effects run before
  // the parent's useGateway effect), so loadThread returns []. When
  // connectionState transitions to CONNECTED the engine is ready —
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
    if (connectionState === ConnectionState.CONNECTED) loadThreads();
  }, [connectionState, loadThreads]);

  useEffect(() => {
    requestThreadListRefresh(() => loadThreads());
  }, [requestThreadListRefresh, loadThreads]);

  /**
   * Resolve where a refine click should land:
   *   1. originating session (sessionKey → routed thread id)
   *   2. agent's `clawKind === "main"` thread, if the originating one is gone
   *   3. fresh session under the agent, as a last resort
   */
  const resolveRefineThreadId = useCallback(
    async (sessionKey: string | undefined, agentId: string | undefined) => {
      if (sessionKey) return sessionRouteIdFromSessionKey(sessionKey, knownAgentIds.current);
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
        // and queue the app's artifact preview to auto-open. Clear
        // `linkedArtifact` so a previous artifact refine doesn't leak both
        // contexts into the next user message.
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
        const artifactSessionKey = target.record.source?.sessionId ?? "";
        const artifactAgentId = target.record.source?.agentId ?? "";
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
   * `ContinueConversation` from a standalone app view: select the app's
   * origin chat thread, pin the app as that thread's `linkedApp` workspace
   * context, open the app preview, navigate to the chat view, then post the
   * user message via the chat store's `processMessage`. Falls back to
   * `createSession(agentId)` if the app doesn't carry a known sessionKey.
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
      // The user may already be on `#/apps/<id>` with this thread selected —
      // skipping `navigate` would leave them stuck on the app route after
      // posting. Always navigate.
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
      // routed to a non-existent thread. Detect via `source.cronId` and
      // redirect to the crons view.
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
            if (notification.target.jobId) setCronTrayJobId(notification.target.jobId);
            else navigate({ view: "crons" });
            break;
          default:
            navigate({ view: "home" });
            break;
        }
      }
      if (notification.unread) await onMarkNotificationsRead([notification.id]);
    },
    [onMarkNotificationsRead],
  );

  const contextValue: ChatAppContextValue = useMemo(
    () => ({
      threads: threads as unknown as ClawThread[],
      appList,
      artifactList,
      notifications,
      cronJobs,
      cronRuns,
      apps,
      artifacts,
      pinnedAppIds,
      knownAgentIds,
      connectionState,
      openNotification,
      setCronTrayJobId,
      onMarkNotificationsRead,
      onTogglePinned,
      onDeleteApp,
      onRefreshApps,
      onRefreshArtifacts,
      onRefineApp: handleRefineApp,
      onRefineArtifact: handleRefineArtifact,
      onAppContinueConversation: handleAppContinueConversation,
      onUpdateCronJob,
      onRunCronJob,
      onRemoveCronJob,
      onRefreshCronData,
    }),
    [
      threads,
      appList,
      artifactList,
      notifications,
      cronJobs,
      cronRuns,
      apps,
      artifacts,
      pinnedAppIds,
      knownAgentIds,
      connectionState,
      openNotification,
      onMarkNotificationsRead,
      onTogglePinned,
      onDeleteApp,
      onRefreshApps,
      onRefreshArtifacts,
      handleRefineApp,
      handleRefineArtifact,
      handleAppContinueConversation,
      onUpdateCronJob,
      onRunCronJob,
      onRemoveCronJob,
      onRefreshCronData,
    ],
  );

  const homeComposer = (
    <HomeComposer
      threads={threads as unknown as ClawThread[]}
      defaultAgentId={defaultAgentId}
      knownAgentIds={knownAgentIds}
      selectedThreadId={selectedThreadId}
      selectThread={selectThread}
      uploads={uploads}
      workspaceByThread={workspaceByThread}
      onUpdateThreadWorkspace={onUpdateThreadWorkspace}
      onRemoveUpload={onRemoveUpload}
      onMarkUploadsSent={onMarkUploadsSent}
      sessionMeta={sessionMeta}
      availableModels={availableModels}
      gatewayDefaultModelId={gatewayDefaultModelId}
      agentModelById={agentModelById}
      patchSession={patchSession}
    />
  );

  const threadArea = (
    <ThreadArea
      sessionMeta={sessionMeta}
      availableModels={availableModels}
      gatewayDefaultModelId={gatewayDefaultModelId}
      agentModelById={agentModelById}
      defaultAgentId={defaultAgentId}
      patchSession={patchSession}
      abort={abort}
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
      onRefreshDurables={refreshDurables}
      onRefreshSummaries={refreshSummaries}
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

  const overlays = (
    <AppOverlays
      toasts={toastNotices}
      onDismissToast={dismissToast}
      paletteOpen={paletteOpen}
      onClosePalette={() => setPaletteOpen(false)}
      cronTrayJobId={cronTrayJobId}
      isCurrentRouteChat={route.view === "chat"}
      isMobile={isMobile}
    />
  );

  if (isMobile) {
    return (
      <ChatAppProvider value={contextValue}>
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
            <MainContent route={route} homeComposer={homeComposer} threadArea={threadArea} />
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
          {overlays}
        </Shell.Container>
      </ChatAppProvider>
    );
  }

  return (
    <ChatAppProvider value={contextValue}>
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
        <MainContent route={route} homeComposer={homeComposer} threadArea={threadArea} />
        {overlays}
      </Shell.Container>
    </ChatAppProvider>
  );
}

export default function ChatApp() {
  const isMobile = useIsMobile();
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    applyPreferences();
  }, []);

  const [appList, setAppList] = useState<AppSummary[]>([]);
  const [artifactList, setArtifactList] = useState<ArtifactSummary[]>([]);

  // Single source of truth for color scheme. Drives:
  //  1. the Tailwind chrome via `.dark` on <html>
  //  2. the openui ThemeProvider's `mode` prop (CSS vars)
  //  3. localStorage so the choice survives reload
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
    abort,
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
    refreshCronData,
    updateCronJob,
    runCronJob,
    removeCronJob,
    gatewayCommands,
    onSessionChanged,
    requestThreadListRefresh,
  } = useGateway({ onAuthFailed: () => setSettingsOpen(true) });

  const { pinnedAppIds, togglePinnedApp } = usePinnedApps();
  const {
    workspaceByThread,
    setWorkspaceByThread,
    updateThreadWorkspace,
    markUploadsSent,
    removeUpload,
    pendingPreviewOpen,
    setPendingPreviewOpen,
    consumePendingPreview,
  } = useThreadWorkspaces(uploads);

  // `sessionKey` is stable per app; cache it so the streaming refresh loop
  // doesn't re-issue `apps.getApp(...)` for every summary that lacks the
  // field on every tick.
  const appSessionKeyCacheRef = useRef<Map<string, string>>(new Map());
  const refreshAppList = useCallback(async () => {
    if (!apps) return;
    const list = await apps.listApps();
    const cache = appSessionKeyCacheRef.current;
    const hydrated = await Promise.all(
      list.map(async (app) => {
        if (app.sessionKey) {
          cache.set(app.id, app.sessionKey);
          return app;
        }
        const cached = cache.get(app.id);
        if (cached) return { ...app, sessionKey: cached };
        const full = await apps.getApp(app.id);
        const key = full?.sessionKey ?? "";
        if (key) cache.set(app.id, key);
        return { ...app, sessionKey: key };
      }),
    );
    setAppList(hydrated);
  }, [apps]);

  const refreshArtifactList = useCallback(async () => {
    if (!artifacts) return;
    setArtifactList(await artifacts.listArtifacts());
  }, [artifacts]);

  // Apps/artifacts plugin refs can be truthy before the WebSocket finishes
  // handshaking, so listing on plugin-available alone returns [] on a cold
  // first connect. Gate on CONNECTED so the list calls run against a ready
  // engine — same pattern as notifications below. Cron is already refreshed
  // by `useGateway`'s visibility-change effect on mount-after-CONNECTED.
  useEffect(() => {
    if (connectionState !== ConnectionState.CONNECTED) return;
    if (apps) void refreshAppList();
    if (artifacts) void refreshArtifactList();
    void refreshNotifications();
  }, [connectionState, apps, artifacts, refreshAppList, refreshArtifactList, refreshNotifications]);

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

  const { adaptedFetchThreadList, adaptedLoadThread } = useChatProviderAdapters({
    fetchThreadList,
    loadThread,
    knownAgentIds,
    uploads,
    setWorkspaceByThread,
  });

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
          createSession={createSession}
          renameSession={renameSession}
          deleteSession={deleteSession}
          resetSession={resetSession}
          compactSession={compactSession}
          onSessionChanged={onSessionChanged}
          requestThreadListRefresh={requestThreadListRefresh}
          abort={abort}
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
          onConsumePendingPreview={consumePendingPreview}
          onDeleteApp={handleDeleteApp}
          onRefreshApps={refreshAppList}
          onRefreshArtifacts={refreshArtifactList}
          notifications={notifications}
          onMarkNotificationsRead={markNotificationsRead}
          onRefreshNotifications={refreshNotifications}
          onUpsertNotification={upsertNotification}
          cronJobs={cronJobs}
          cronRuns={cronRuns}
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
