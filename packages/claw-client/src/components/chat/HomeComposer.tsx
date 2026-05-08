"use client";

import { SessionComposer } from "@/components/session/SessionComposer";
import { resolveChatSessionKey } from "@/lib/chat/useGateway";
import { DEFAULT_STARTERS } from "@/lib/conversation-starters";
import type { UploadStore } from "@/lib/engines/types";
import { navigate } from "@/lib/hooks/useHashRoute";
import { useIsMobile } from "@/lib/hooks/useIsMobile";
import { qualifyModel } from "@/lib/models";
import {
  EMPTY_THREAD_WORKSPACE,
  fileToThreadUpload,
  type ThreadWorkspaceState,
} from "@/lib/session-workspace";
import type { ClawThread } from "@/types/claw-thread";
import type { ModelChoice, SessionRow } from "@/types/gateway-responses";
import { useThread } from "@openuidev/react-headless";
import { useCallback, useEffect, useMemo, useRef } from "react";

interface Props {
  threads: ClawThread[];
  defaultAgentId: string | null;
  knownAgentIds: React.RefObject<Set<string>>;
  selectedThreadId: string | null;
  selectThread: (id: string) => void;
  uploads: UploadStore | undefined;
  workspaceByThread: Record<string, ThreadWorkspaceState>;
  onUpdateThreadWorkspace: (
    threadId: string,
    updater: (current: ThreadWorkspaceState) => ThreadWorkspaceState,
  ) => void;
  onRemoveUpload: (threadId: string, uploadId: string) => void;
  onMarkUploadsSent: (threadId: string, uploadIds: string[]) => void;
  sessionMeta: Map<string, SessionRow>;
  availableModels: ModelChoice[];
  gatewayDefaultModelId: string | null;
  agentModelById: Map<string, string>;
  patchSession: (key: string, patch: Record<string, unknown>) => Promise<boolean>;
}

/**
 * Home-page composer. Shares `SessionComposer` with the in-thread surface
 * but is pinned to the default agent's main thread so submissions land
 * somewhere even before the user picks an agent. As soon as `isRunning`
 * flips we route to that thread's chat view so the stream is visible.
 */
export function HomeComposer({
  threads,
  defaultAgentId,
  knownAgentIds,
  selectedThreadId,
  selectThread,
  uploads,
  workspaceByThread,
  onUpdateThreadWorkspace,
  onRemoveUpload,
  onMarkUploadsSent,
  sessionMeta,
  availableModels,
  gatewayDefaultModelId,
  agentModelById,
  patchSession,
}: Props) {
  const isMobile = useIsMobile();
  const isRunning = useThread((state) => state.isRunning);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Pick the home-bound thread: the configured default agent's main thread,
  // or any main thread, or the first available thread. The composer always
  // needs a target so uploads + processMessage have somewhere to land.
  const mainThreadId = useMemo(() => {
    if (threads.length === 0) return null;
    if (defaultAgentId) {
      const main = threads.find(
        (t) => (t.clawAgentId ?? t.id) === defaultAgentId && t.clawKind === "main",
      );
      if (main) return main.id;
    }
    return threads.find((t) => t.clawKind === "main")?.id ?? threads[0]?.id ?? null;
  }, [threads, defaultAgentId]);

  // Select the home thread so SessionComposer's submit (which reads from the
  // global ChatProvider store) lands in it.
  useEffect(() => {
    if (!mainThreadId) return;
    if (selectedThreadId === mainThreadId) return;
    selectThread(mainThreadId);
  }, [mainThreadId, selectedThreadId, selectThread]);

  // Once the composer kicks off a submission, jump to the chat view so the
  // user sees their message + the streaming response.
  useEffect(() => {
    if (!mainThreadId || !isRunning) return;
    navigate({ view: "chat", sessionId: mainThreadId });
  }, [mainThreadId, isRunning]);

  const addFiles = useCallback(
    async (files: File[]) => {
      if (!mainThreadId || files.length === 0) return;
      const sessionKey = resolveChatSessionKey(mainThreadId, knownAgentIds.current);
      const nextUploads = await Promise.all(files.map((file) => fileToThreadUpload(file)));
      onUpdateThreadWorkspace(mainThreadId, (current) => ({
        ...current,
        uploads: [...current.uploads, ...nextUploads],
      }));
      if (!uploads || !sessionKey) return;
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
          onUpdateThreadWorkspace(mainThreadId, (current) => ({
            ...current,
            uploads: current.uploads.map((c) =>
              c.id === upload.id ? { ...c, remoteId: meta.id } : c,
            ),
          }));
        }),
      );
    },
    [mainThreadId, knownAgentIds, onUpdateThreadWorkspace, uploads],
  );

  const openFilePicker = useCallback(() => fileInputRef.current?.click(), []);

  const handleFilesSelected = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []);
      event.target.value = "";
      await addFiles(files);
    },
    [addFiles],
  );

  const workspace = mainThreadId
    ? (workspaceByThread[mainThreadId] ?? EMPTY_THREAD_WORKSPACE)
    : EMPTY_THREAD_WORKSPACE;
  const sessionKey = mainThreadId ? resolveChatSessionKey(mainThreadId, knownAgentIds.current) : "";
  const meta = sessionKey ? sessionMeta.get(sessionKey) : undefined;

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFilesSelected}
      />
      <SessionComposer
        uploads={workspace.uploads}
        linkedApp={workspace.linkedApp}
        linkedArtifact={workspace.linkedArtifact}
        onPickFiles={openFilePicker}
        onAddFiles={addFiles}
        onRemoveUpload={(uploadId) => {
          if (mainThreadId) onRemoveUpload(mainThreadId, uploadId);
        }}
        onUploadsSent={(uploadIds) => {
          if (mainThreadId) onMarkUploadsSent(mainThreadId, uploadIds);
        }}
        commandContext={() => ({
          threadId: mainThreadId,
          messages: [],
          toast: () => {},
          downloadBlob: () => {},
        })}
        gatewayCommands={[]}
        onDispatchGatewayCommand={async () => false}
        models={availableModels}
        gatewayDefaultModelId={gatewayDefaultModelId}
        agentDefaultModelId={defaultAgentId ? (agentModelById.get(defaultAgentId) ?? null) : null}
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
        // Skip the rotating placeholder + TAB-to-fill UX on mobile — the overlay
        // assumes a hardware keyboard and the TAB tag has no affordance on touch.
        rotatingPlaceholders={isMobile ? undefined : DEFAULT_STARTERS.map((s) => s.displayText)}
        rotatingPlaceholderFillWith={isMobile ? undefined : DEFAULT_STARTERS.map((s) => s.prompt)}
      />
    </>
  );
}
