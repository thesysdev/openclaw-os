"use client";

import { serializeAssistantTimelineContent } from "@/lib/chat/timeline";
import { resolveChatSessionKey } from "@/lib/chat/useGateway";
import type { StoredMessage, UploadStore } from "@/lib/engines/types";
import {
  deriveThreadWorkspaceFromMessages,
  extractMessageUploadIds,
  uploadMetaToThreadUpload,
  type ThreadUpload,
  type ThreadWorkspaceState,
} from "@/lib/session-workspace";
import type { ClawThreadListItem } from "@/types/gateway-responses";
import type { Message, Thread } from "@openuidev/react-headless";
import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";

function toThreadRow(r: ClawThreadListItem): Thread {
  return {
    id: r.id,
    title: r.title,
    createdAt: r.createdAt,
    clawKind: r.clawKind,
    clawAgentId: r.clawAgentId,
  } as Thread;
}

interface Args {
  fetchThreadList: () => Promise<ClawThreadListItem[]>;
  loadThread: (threadId: string) => Promise<StoredMessage[]>;
  knownAgentIds: RefObject<Set<string>>;
  uploads: UploadStore | undefined;
  setWorkspaceByThread: Dispatch<SetStateAction<Record<string, ThreadWorkspaceState>>>;
}

/**
 * Adapters that reshape the gateway's thread/history payloads into what
 * `<ChatProvider>` expects. The `uploads` store can land after `ChatProvider`
 * has already mounted, so we hold it in a ref and read the latest value at
 * call-time instead of baking it into the closure.
 */
export function useChatProviderAdapters({
  fetchThreadList,
  loadThread,
  knownAgentIds,
  uploads,
  setWorkspaceByThread,
}: Args) {
  const uploadsRef = useRef(uploads);
  useEffect(() => {
    uploadsRef.current = uploads;
  }, [uploads]);

  const adaptedFetchThreadList = useCallback(async (): Promise<{ threads: Thread[] }> => {
    const rows = await fetchThreadList();
    return { threads: rows.map(toThreadRow) };
  }, [fetchThreadList]);

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

        // `listUploads(sessionKey)` only returns uploads stored under the
        // current session key. But messages can reference uploads put under
        // a different sessionKey — e.g. an agent main thread whose
        // `resolveChatSessionKey` once returned `main` and later
        // `agent:<id>:main:openclaw-os` because `knownAgentIds` hadn't
        // hydrated yet at upload time. Without this, the workspace pane and
        // `ThreadArtifactPanels` skip those uploads, so clicking the
        // user-message chip opens an artifactId with no registered panel
        // (blank preview pane). Fetch any referenced ids that the list
        // missed and union them in.
        const knownIds = new Set(remoteUploads.map((u) => u.id));
        const referencedIds = new Set<string>();
        for (const m of msgs) {
          if (m.role === "user") {
            for (const id of extractMessageUploadIds(m.content)) referencedIds.add(id);
          }
        }
        const missingIds = Array.from(referencedIds).filter((id) => !knownIds.has(id));
        if (missingIds.length > 0) {
          const fetched = await Promise.all(
            missingIds.map(async (id) => {
              try {
                const record = await uploadsStore.getUpload(id);
                if (!record) return null;
                const { content: _content, ...meta } = record;
                return uploadMetaToThreadUpload(meta);
              } catch (error) {
                console.warn("[claw] uploads.get fallback failed:", error);
                return null;
              }
            }),
          );
          for (const upload of fetched) {
            if (upload) remoteUploads.push(upload);
          }
        }
      }

      setWorkspaceByThread((current) => {
        // Drop pending entries whose `remoteId` is already present in the
        // freshly-fetched metas — otherwise the same upload would render
        // twice (once as the local pending entry, once as the server-sent
        // entry from `remoteUploads`).
        const remoteIds = new Set(remoteUploads.map((u) => u.id));
        const existingPending = (current[threadId]?.uploads ?? []).filter(
          (upload) =>
            upload.status === "pending" && !(upload.remoteId && remoteIds.has(upload.remoteId)),
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
                (m.reasoning ? [{ type: "reasoning" as const, text: m.reasoning }] : []),
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
    [knownAgentIds, loadThread, setWorkspaceByThread],
  );

  return { adaptedFetchThreadList, adaptedLoadThread };
}
