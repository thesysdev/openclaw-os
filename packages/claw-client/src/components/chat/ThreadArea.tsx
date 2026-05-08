"use client";

import { type AppContinueConversationHandler } from "@/components/apps/AppDetail";
import { EmptyAgentHero } from "@/components/chat/EmptyAgentHero";
import { EmptyChatWelcome } from "@/components/chat/EmptyChatWelcome";
import { ThreadArtifactPanels } from "@/components/chat/ThreadArtifactPanels";
import { ThreadHeader } from "@/components/chat/ThreadHeader";
import { ThreadWorkspaceStrip } from "@/components/chat/ThreadWorkspaceStrip";
import { ClawThreadContainer } from "@/components/layout/ClawThreadContainer";
import { MobileWorkspaceDrawer } from "@/components/mobile/MobileWorkspaceDrawer";
import { AssistantMessage } from "@/components/rendering/AssistantMessage";
import { UserMessage } from "@/components/rendering/UserMessage";
import { SessionComposer } from "@/components/session/SessionComposer";
import {
  SessionWorkspaceDrawer,
  SessionWorkspacePane,
} from "@/components/session/SessionWorkspacePane";
import { resolveChatSessionKey } from "@/lib/chat/useGateway";
import { isTabHidden, playCompletionChime } from "@/lib/chime";
import type { CommandContext, CommandMessageSnapshot } from "@/lib/commands";
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
import { navigate } from "@/lib/hooks/useHashRoute";
import { useIsMobile } from "@/lib/hooks/useIsMobile";
import { qualifyModel } from "@/lib/models";
import { getPreferences } from "@/lib/preferences";
import { extractAgentIdFromKey } from "@/lib/session-keys";
import {
  EMPTY_THREAD_WORKSPACE,
  fileToThreadUpload,
  sessionAppPreviewId,
  sessionArtifactPreviewId,
  sessionUploadPreviewId,
  type ThreadWorkspaceState,
} from "@/lib/session-workspace";
import { UploadsProvider, type UploadsSeed } from "@/lib/uploads-context";
import type { ClawThread } from "@/types/claw-thread";
import type { ModelChoice, SessionRow } from "@/types/gateway-responses";
import {
  useActiveArtifact,
  useArtifactStore,
  useThread,
  useThreadList,
  type Message,
} from "@openuidev/react-headless";
import { Shell } from "@openuidev/react-ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

function formatTokens(n: number): string {
  if (n >= 1000) return `${(Math.round(n / 100) / 10).toFixed(1)}k`;
  return String(n);
}

export interface ThreadAreaProps {
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
  /** User-initiated Stop. Sends `chat.abort` to the gateway. */
  abort: (threadId: string) => Promise<void>;
}

export function ThreadArea({
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
  abort,
}: ThreadAreaProps) {
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

  // Auto-collapse the right Workspace pane to its icon strip whenever an
  // artifact preview opens — the side-pane already claims the right edge so
  // the full Workspace would compete. Users can still expand it back via the
  // strip's chevron; we only force-collapse on the open transition.
  const lastArtifactActiveRef = useRef(false);
  useEffect(() => {
    const isActive = !!activeArtifactId;
    if (isActive && !lastArtifactActiveRef.current) {
      onToggleWorkspacePaneCollapsed(true);
    }
    lastArtifactActiveRef.current = isActive;
  }, [activeArtifactId, onToggleWorkspacePaneCollapsed]);
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

  // Gateway commands that map 1:1 to a dedicated RPC. Dispatching these
  // through `chat.send` doesn't trigger the gateway's command handler for the
  // webchat channel — the slash text just reaches the LLM — so we call the
  // RPC directly instead.
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
          <ThreadHeader
            allThreads={allThreadsRaw as unknown as ClawThread[]}
            selectedThreadId={selectedThreadId}
            isMobile={isMobile}
            createSession={createSession}
            deleteSession={deleteSession}
            renameSession={renameSession}
            onOpenMobileWorkspace={() => setMobileWorkspaceOpen(true)}
          />
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
                onStop={() => {
                  if (!selectedThreadId) return;
                  // Fire-and-forget — local stream is closed by the chat-store's
                  // own `cancelMessage`, this just makes the gateway stop the run
                  // server-side. Errors are non-fatal (the run may already be
                  // finishing); log so we notice if the path is silently failing.
                  void abort(selectedThreadId).catch((err) => {
                    console.warn("[claw] chat.abort failed:", err);
                  });
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

        <ThreadArtifactPanels
          appList={appList}
          artifactList={artifactList}
          paneUploads={paneUploads}
          threads={allThreadsRaw as unknown as ClawThread[]}
          apps={apps}
          artifacts={artifacts}
          uploads={uploads}
          pinnedAppIds={pinnedAppIds}
          onTogglePinned={onTogglePinned}
          onAppContinueConversation={onAppContinueConversation}
          onRefreshSummaries={onRefreshSummaries}
        />

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

        {/* The Workspace pane defaults to its full layout. When an artifact
            preview opens we auto-collapse to a 48px icon strip (effect above);
            from there the user can re-expand via the chevron — even with the
            artifact slide-in claiming the right edge. */}
        {workspacePaneCollapsed ? (
          <ThreadWorkspaceStrip
            paneApps={paneApps}
            paneArtifacts={paneArtifacts}
            paneUploads={paneUploads}
            paneLinkedApp={paneLinkedApp}
            activeArtifactId={activeArtifactId}
            onExpand={() => onToggleWorkspacePaneCollapsed(false)}
          />
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
