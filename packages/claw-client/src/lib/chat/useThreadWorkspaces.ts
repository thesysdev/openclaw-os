"use client";

import type { UploadStore } from "@/lib/engines/types";
import { EMPTY_THREAD_WORKSPACE, type ThreadWorkspaceState } from "@/lib/session-workspace";
import { useCallback, useState, type Dispatch, type SetStateAction } from "react";

export interface PendingPreviewOpen {
  threadId: string;
  previewId: string;
}

export interface ThreadWorkspaces {
  workspaceByThread: Record<string, ThreadWorkspaceState>;
  /** Exposed for `useChatProviderAdapters` to seed history-derived state. */
  setWorkspaceByThread: Dispatch<SetStateAction<Record<string, ThreadWorkspaceState>>>;
  updateThreadWorkspace: (
    threadId: string,
    updater: (current: ThreadWorkspaceState) => ThreadWorkspaceState,
  ) => void;
  markUploadsSent: (threadId: string, uploadIds: string[]) => void;
  removeUpload: (threadId: string, uploadId: string) => void;
  pendingPreviewOpen: PendingPreviewOpen | null;
  setPendingPreviewOpen: (value: PendingPreviewOpen) => void;
  consumePendingPreview: () => void;
}

/**
 * Per-thread workspace state (uploads, linkedApp, linkedArtifact) plus the
 * `pendingPreviewOpen` queue that the Refine flow uses to ask the chat
 * surface to auto-open an artifact panel after navigation.
 *
 * `removeUpload` reads the entry's `remoteId` BEFORE patching state so the
 * fire-and-forget `uploads.deleteUpload` doesn't race with the React batch
 * and read `undefined`.
 */
export function useThreadWorkspaces(uploads: UploadStore | undefined): ThreadWorkspaces {
  const [workspaceByThread, setWorkspaceByThread] = useState<Record<string, ThreadWorkspaceState>>(
    {},
  );
  const [pendingPreviewOpen, setPendingPreviewOpenState] = useState<PendingPreviewOpen | null>(
    null,
  );

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

  const setPendingPreviewOpen = useCallback((value: PendingPreviewOpen) => {
    setPendingPreviewOpenState(value);
  }, []);

  const consumePendingPreview = useCallback(() => {
    setPendingPreviewOpenState(null);
  }, []);

  return {
    workspaceByThread,
    setWorkspaceByThread,
    updateThreadWorkspace,
    markUploadsSent,
    removeUpload,
    pendingPreviewOpen,
    setPendingPreviewOpen,
    consumePendingPreview,
  };
}
