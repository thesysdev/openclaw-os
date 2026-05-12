"use client";

import { separateContentAndContext } from "@/lib/content-parser";
import type { UploadMeta } from "@/lib/engines/types";

export type WorkspacePreviewKind = "image" | "pdf" | "markdown" | "code" | "text" | "ppt" | "file";

export type GatewayAttachmentPayload = {
  type?: string;
  mimeType: string;
  fileName: string;
  content: string;
};

export type ThreadUploadStatus = "pending" | "sent";

export type ThreadUpload = {
  id: string;
  /** Plugin-side upload id returned by `uploads.put`; used to fetch bytes back on reload. */
  remoteId?: string;
  name: string;
  mimeType: string;
  size: number;
  kind: WorkspacePreviewKind;
  attachment?: GatewayAttachmentPayload;
  previewUrl?: string;
  textContent?: string;
  createdAt: number;
  status: ThreadUploadStatus;
};

export type LinkedAppContext = {
  appId: string;
  title: string;
  agentId: string;
  sessionKey: string;
};

export type LinkedArtifactContext = {
  artifactId: string;
  title: string;
  agentId: string;
  sessionKey: string;
};

export type ThreadWorkspaceState = {
  uploads: ThreadUpload[];
  linkedApp: LinkedAppContext | null;
  linkedArtifact: LinkedArtifactContext | null;
};

type ThreadUploadContextEntry = {
  type: "thread_uploads";
  /** Plugin-side upload ids that bind to this user message. */
  remoteIds: string[];
};

type LinkedAppContextEntry = {
  type: "linked_app";
  appId: string;
  title: string;
  agentId: string;
  sessionKey: string;
};

type LinkedArtifactContextEntry = {
  type: "linked_artifact";
  artifactId: string;
  title: string;
  agentId: string;
  sessionKey: string;
};

type ThreadContextEntry =
  | ThreadUploadContextEntry
  | LinkedAppContextEntry
  | LinkedArtifactContextEntry;

type ThreadWorkspaceMessageLike = {
  role?: string;
  content?: unknown;
};

export const EMPTY_THREAD_WORKSPACE: ThreadWorkspaceState = {
  uploads: [],
  linkedApp: null,
  linkedArtifact: null,
};

function isTextLikeFile(name: string, mimeType: string): boolean {
  return (
    mimeType.startsWith("text/") ||
    mimeType.includes("json") ||
    mimeType.includes("javascript") ||
    mimeType.includes("typescript") ||
    mimeType.includes("xml") ||
    mimeType.includes("yaml") ||
    mimeType.includes("toml") ||
    /\.(c|cc|cpp|cs|css|go|html|java|js|json|jsx|kt|md|mjs|php|py|rb|rs|scss|sh|sql|svg|toml|ts|tsx|txt|xml|yaml|yml)$/i.test(
      name,
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isLinkedAppContextEntry(value: unknown): value is LinkedAppContextEntry {
  return (
    isRecord(value) &&
    value["type"] === "linked_app" &&
    typeof value["appId"] === "string" &&
    typeof value["title"] === "string" &&
    typeof value["agentId"] === "string" &&
    typeof value["sessionKey"] === "string"
  );
}

function isLinkedArtifactContextEntry(value: unknown): value is LinkedArtifactContextEntry {
  return (
    isRecord(value) &&
    value["type"] === "linked_artifact" &&
    typeof value["artifactId"] === "string" &&
    typeof value["title"] === "string" &&
    typeof value["agentId"] === "string" &&
    typeof value["sessionKey"] === "string"
  );
}

function parseThreadContextEntries(contextString: string | null): ThreadContextEntry[] {
  if (!contextString) return [];

  try {
    const parsed = JSON.parse(contextString);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => normalizeContextEntry(entry))
      .filter((entry): entry is ThreadContextEntry => entry != null);
  } catch {
    return [];
  }
}

function normalizeContextEntry(value: unknown): ThreadContextEntry | null {
  if (isLinkedAppContextEntry(value)) return value;
  if (isLinkedArtifactContextEntry(value)) return value;
  if (!isRecord(value) || value["type"] !== "thread_uploads") return null;

  const remoteIdsValue = value["remoteIds"];
  if (Array.isArray(remoteIdsValue)) {
    return {
      type: "thread_uploads",
      remoteIds: remoteIdsValue.filter((id): id is string => typeof id === "string"),
    };
  }
  // Legacy shape: files: [{id, remoteId?, ...}]
  const filesValue = value["files"];
  if (Array.isArray(filesValue)) {
    const remoteIds = filesValue
      .map((file) =>
        isRecord(file) && typeof file["remoteId"] === "string" ? file["remoteId"] : null,
      )
      .filter((id): id is string => id != null);
    return { type: "thread_uploads", remoteIds };
  }
  return null;
}

export function extractMessageUploadIds(messageContent: unknown): string[] {
  if (typeof messageContent !== "string") return [];
  const { contextString } = separateContentAndContext(messageContent);
  const entries = parseThreadContextEntries(contextString);
  const ids: string[] = [];
  for (const entry of entries) {
    if (entry.type === "thread_uploads") ids.push(...entry.remoteIds);
  }
  return ids;
}

export function uploadMetaToThreadUpload(meta: UploadMeta): ThreadUpload {
  return {
    id: meta.id,
    remoteId: meta.id,
    name: meta.name,
    mimeType: meta.mimeType,
    size: meta.size,
    kind: inferWorkspacePreviewKind(meta.name, meta.mimeType),
    createdAt: Date.parse(meta.createdAt) || Date.now(),
    status: "sent",
  };
}

export function inferWorkspacePreviewKind(
  name: string,
  mimeType: string,
  kind?: string,
): WorkspacePreviewKind {
  const loweredKind = (kind ?? "").toLowerCase();
  if (loweredKind === "markdown") return "markdown";
  if (loweredKind === "image") return "image";
  if (loweredKind === "pdf") return "pdf";
  if (loweredKind === "code") return "code";
  if (loweredKind === "ppt" || loweredKind === "pptx") return "ppt";

  const loweredName = name.toLowerCase();
  const loweredMime = mimeType.toLowerCase();

  if (loweredMime.startsWith("image/")) return "image";
  if (loweredMime === "application/pdf" || loweredName.endsWith(".pdf")) return "pdf";
  if (
    loweredMime.includes("powerpoint") ||
    loweredName.endsWith(".ppt") ||
    loweredName.endsWith(".pptx")
  ) {
    return "ppt";
  }
  if (loweredName.endsWith(".md") || loweredMime === "text/markdown") return "markdown";
  if (isTextLikeFile(name, mimeType)) {
    if (
      /\.(c|cc|cpp|cs|css|go|html|java|js|json|jsx|kt|mjs|php|py|rb|rs|scss|sh|sql|svg|toml|ts|tsx|xml|yaml|yml)$/i.test(
        loweredName,
      )
    ) {
      return "code";
    }
    return "text";
  }
  return "file";
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

export async function fileToThreadUpload(file: File): Promise<ThreadUpload> {
  const dataUrl = await readFileAsDataUrl(file);
  const base64 = dataUrl.split(",", 2)[1] ?? "";
  const kind = inferWorkspacePreviewKind(file.name, file.type);
  const canReadText = isTextLikeFile(file.name, file.type) && file.size <= 256_000;
  const textContent = canReadText ? await file.text().catch(() => undefined) : undefined;
  const previewUrl = kind === "image" || kind === "pdf" ? dataUrl : undefined;

  return {
    id: crypto.randomUUID(),
    name: file.name,
    mimeType: file.type || "application/octet-stream",
    size: file.size,
    kind,
    attachment: {
      type: kind,
      mimeType: file.type || "application/octet-stream",
      fileName: file.name,
      content: base64,
    },
    previewUrl,
    textContent,
    createdAt: Date.now(),
    status: "pending",
  };
}

export function buildThreadContextPayload(params: {
  linkedApp?: LinkedAppContext | null;
  linkedArtifact?: LinkedArtifactContext | null;
  uploads?: ThreadUpload[];
}): unknown[] {
  const payload: unknown[] = [];

  if (params.linkedApp) {
    payload.push({
      type: "linked_app",
      appId: params.linkedApp.appId,
      title: params.linkedApp.title,
      agentId: params.linkedApp.agentId,
      sessionKey: params.linkedApp.sessionKey,
      instruction: `The user's request applies to app "${params.linkedApp.title}" (id: ${params.linkedApp.appId}) — THIS one, even if other apps appear earlier in this conversation. Call get_app with this id, then app_update with this id. Do not create a new app.`,
    });
  }

  if (params.linkedArtifact) {
    payload.push({
      type: "linked_artifact",
      artifactId: params.linkedArtifact.artifactId,
      title: params.linkedArtifact.title,
      agentId: params.linkedArtifact.agentId,
      sessionKey: params.linkedArtifact.sessionKey,
      instruction: `The user's request applies to artifact "${params.linkedArtifact.title}" (id: ${params.linkedArtifact.artifactId}) — THIS one, even if other artifacts appear earlier in this conversation. Call get_artifact with this id, then update_markdown_artifact with this id. Do not create a new artifact.`,
    });
  }

  if (params.uploads && params.uploads.length > 0) {
    const remoteIds = params.uploads
      .map((upload) => upload.remoteId)
      .filter((id): id is string => typeof id === "string");
    if (remoteIds.length > 0) {
      payload.push({ type: "thread_uploads", remoteIds });
    }
  }

  return payload;
}

export function deriveLinkedAppFromMessages(
  messages: ThreadWorkspaceMessageLike[],
): LinkedAppContext | null {
  let linkedApp: LinkedAppContext | null = null;

  for (const message of messages) {
    if (message.role !== "user" || typeof message.content !== "string") continue;
    const { contextString } = separateContentAndContext(message.content);

    for (const entry of parseThreadContextEntries(contextString)) {
      if (entry.type === "linked_app") {
        linkedApp = {
          appId: entry.appId,
          title: entry.title,
          agentId: entry.agentId,
          sessionKey: entry.sessionKey,
        };
      }
    }
  }

  return linkedApp;
}

export function deriveLinkedArtifactFromMessages(
  messages: ThreadWorkspaceMessageLike[],
): LinkedArtifactContext | null {
  let linkedArtifact: LinkedArtifactContext | null = null;

  for (const message of messages) {
    if (message.role !== "user" || typeof message.content !== "string") continue;
    const { contextString } = separateContentAndContext(message.content);

    for (const entry of parseThreadContextEntries(contextString)) {
      if (entry.type === "linked_artifact") {
        linkedArtifact = {
          artifactId: entry.artifactId,
          title: entry.title,
          agentId: entry.agentId,
          sessionKey: entry.sessionKey,
        };
      }
    }
  }

  return linkedArtifact;
}

/** Deprecated shim: uploads now come from the plugin, only links are derived. */
export function deriveThreadWorkspaceFromMessages(
  messages: ThreadWorkspaceMessageLike[],
): ThreadWorkspaceState {
  return {
    uploads: [],
    linkedApp: deriveLinkedAppFromMessages(messages),
    linkedArtifact: deriveLinkedArtifactFromMessages(messages),
  };
}

export function isThreadWorkspaceEmpty(workspace: ThreadWorkspaceState): boolean {
  return (
    workspace.uploads.length === 0 &&
    workspace.linkedApp == null &&
    workspace.linkedArtifact == null
  );
}

export function sessionAppPreviewId(appId: string): string {
  return `session-app:${appId}`;
}

export function sessionArtifactPreviewId(artifactId: string): string {
  return `session-artifact:${artifactId}`;
}

export function sessionUploadPreviewId(uploadId: string): string {
  return `session-upload:${uploadId}`;
}
