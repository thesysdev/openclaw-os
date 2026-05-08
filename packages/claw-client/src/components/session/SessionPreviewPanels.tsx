"use client";

import { AppDetail, type AppContinueConversationHandler } from "@/components/apps/AppDetail";
import { ArtifactContentView } from "@/components/artifacts/ArtifactContentView";
import { ArtifactDetail } from "@/components/artifacts/ArtifactDetail";
import type {
  AppRecord,
  AppStore,
  AppSummary,
  ArtifactStore,
  ArtifactSummary,
  UploadStore,
} from "@/lib/engines/types";
import type { LinkedAppContext, ThreadUpload } from "@/lib/session-workspace";
import {
  sessionAppPreviewId,
  sessionArtifactPreviewId,
  sessionUploadPreviewId,
} from "@/lib/session-workspace";
import { ArtifactPanel } from "@openuidev/react-ui";
import { useEffect, useMemo, useState } from "react";

// Text-like kinds need the *decoded* file body as the renderer's `content`
// (ReactMarkdown / a `<pre>` will otherwise display the raw `data:...` URL
// verbatim). Image/PDF/HTML kinds want the data URL as-is so `<img>` /
// `<iframe>` can consume it directly.
const TEXT_KINDS = new Set(["markdown", "text", "code"]);

function decodeBase64ToText(base64: string): string {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return "";
  }
}

export function UploadPreviewPanel({
  upload,
  uploadStore,
}: {
  upload: ThreadUpload;
  uploadStore?: UploadStore;
}) {
  // For text/markdown/code/html we keep the decoded body; for binary previews
  // we keep a `data:` URL the renderer can hand to `<img>`/`<iframe>`.
  const [fetchedText, setFetchedText] = useState<string | null>(null);
  const [fetchedDataUrl, setFetchedDataUrl] = useState<string | null>(null);

  const immediateText = upload.textContent ?? null;
  const immediatePreviewUrl = upload.previewUrl ?? null;

  useEffect(() => {
    // Always drop prior fetched bytes first so a panel that was remounted with
    // a different upload id can't flash the previous file's preview.
    setFetchedText(null);
    setFetchedDataUrl(null);
    if (immediateText || immediatePreviewUrl) return;
    if (!uploadStore || !upload.remoteId) return;
    let cancelled = false;
    void uploadStore.getUpload(upload.remoteId).then((record) => {
      if (cancelled || !record) return;
      if (TEXT_KINDS.has(upload.kind)) {
        setFetchedText(decodeBase64ToText(record.content));
      } else {
        setFetchedDataUrl(`data:${record.mimeType};base64,${record.content}`);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [immediateText, immediatePreviewUrl, upload.kind, upload.remoteId, uploadStore]);

  const isTextKind = TEXT_KINDS.has(upload.kind);
  const textBody = immediateText ?? (isTextKind ? fetchedText : null);
  const previewSource = immediatePreviewUrl ?? (isTextKind ? null : fetchedDataUrl);
  // For text kinds the renderer needs the decoded body as `content`; for
  // binary kinds it consumes the data URL via `metadata.previewUrl` (the
  // image/pdf branches read `previewUrl`).
  const content = textBody ?? previewSource;

  return (
    <ArtifactContentView
      title={upload.name}
      kind={upload.kind}
      content={content}
      metadata={{
        fileName: upload.name,
        mimeType: upload.mimeType,
        previewUrl: previewSource ?? undefined,
        size: upload.size,
        status: upload.status,
      }}
    />
  );
}

export function SessionPreviewPanels({
  apps,
  allApps,
  linkedApp,
  artifacts,
  uploads,
  appStore,
  artifactStore,
  uploadStore,
  pinnedAppIds,
  onTogglePinned,
  onRefineApp,
  onAppContinueConversation,
  onRefreshApps,
  onRefreshArtifacts,
}: {
  apps: AppSummary[];
  allApps: AppSummary[];
  linkedApp: LinkedAppContext | null;
  artifacts: ArtifactSummary[];
  uploads: ThreadUpload[];
  appStore?: AppStore;
  artifactStore?: ArtifactStore;
  uploadStore?: UploadStore;
  pinnedAppIds: Set<string>;
  onTogglePinned: (appId: string) => void;
  onRefineApp: (record: AppRecord) => void | Promise<void>;
  onAppContinueConversation?: AppContinueConversationHandler;
  onRefreshApps: () => void;
  onRefreshArtifacts: () => void;
}) {
  const resolvedApps = useMemo(() => {
    // Prefer the global summary copy so panel keys pick up refreshed `updatedAt` values.
    const latestAppsById = new Map(allApps.map((app) => [app.id, app]));
    return apps.map((app) => latestAppsById.get(app.id) ?? app);
  }, [allApps, apps]);

  const resolvedLinkedApp = useMemo(() => {
    if (!linkedApp) return null;

    return (
      allApps.find((app) => app.id === linkedApp.appId) ??
      resolvedApps.find((app) => app.id === linkedApp.appId) ?? {
        id: linkedApp.appId,
        title: linkedApp.title,
        agentId: linkedApp.agentId,
        sessionKey: linkedApp.sessionKey,
        createdAt: "",
        updatedAt: "",
      }
    );
  }, [allApps, linkedApp, resolvedApps]);

  const appPanels = useMemo(() => {
    if (!resolvedLinkedApp) {
      return resolvedApps;
    }

    const linkedIndex = resolvedApps.findIndex((app) => app.id === resolvedLinkedApp.id);
    if (linkedIndex === -1) {
      return [resolvedLinkedApp, ...resolvedApps];
    }

    return resolvedApps.map((app) => (app.id === resolvedLinkedApp.id ? resolvedLinkedApp : app));
  }, [resolvedApps, resolvedLinkedApp]);

  return (
    <>
      {appStore &&
        appPanels.map((app) => (
          <ArtifactPanel
            key={`${app.id}:${app.updatedAt}`}
            artifactId={sessionAppPreviewId(app.id)}
            title={app.title}
          >
            <div className="h-full overflow-hidden">
              <AppDetail
                appId={app.id}
                apps={appStore}
                updatedAt={app.updatedAt}
                mode="panel"
                isPinned={pinnedAppIds.has(app.id)}
                onTogglePinned={onTogglePinned}
                onRefine={onRefineApp}
                onContinueConversation={onAppContinueConversation}
                onDeleted={onRefreshApps}
              />
            </div>
          </ArtifactPanel>
        ))}

      {artifactStore &&
        artifacts.map((artifact) => (
          <ArtifactPanel
            key={`${artifact.id}:${artifact.updatedAt}`}
            artifactId={sessionArtifactPreviewId(artifact.id)}
            title={artifact.title}
          >
            <div className="h-full overflow-hidden">
              <ArtifactDetail
                artifactId={artifact.id}
                artifacts={artifactStore}
                updatedAt={artifact.updatedAt}
                mode="panel"
                onDeleted={onRefreshArtifacts}
              />
            </div>
          </ArtifactPanel>
        ))}

      {uploads.map((upload) => (
        <ArtifactPanel
          key={upload.id}
          artifactId={sessionUploadPreviewId(upload.id)}
          title={upload.name}
        >
          <div className="h-full overflow-auto bg-sunk-light">
            <UploadPreviewPanel upload={upload} uploadStore={uploadStore} />
          </div>
        </ArtifactPanel>
      ))}
    </>
  );
}
