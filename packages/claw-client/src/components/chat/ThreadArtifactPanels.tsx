"use client";

import { AppDetail, type AppContinueConversationHandler } from "@/components/apps/AppDetail";
import { ArtifactDetail } from "@/components/artifacts/ArtifactDetail";
import { DetailTopBar } from "@/components/layout/DetailTopBar";
import { UploadPreviewPanel } from "@/components/session/SessionPreviewPanels";
import type {
  AppStore,
  AppSummary,
  ArtifactStore,
  ArtifactSummary,
  UploadStore,
} from "@/lib/engines/types";
import { navigate } from "@/lib/hooks/useHashRoute";
import {
  sessionAppPreviewId,
  sessionArtifactPreviewId,
  sessionUploadPreviewId,
  type ThreadUpload,
} from "@/lib/session-workspace";
import { buildAppSiblings, buildArtifactSiblings, makeAgentNameResolver } from "@/lib/siblings";
import type { ClawThread } from "@/types/claw-thread";
import { useActiveArtifact, useArtifactStore } from "@openuidev/react-headless";
import { ArtifactPanel } from "@openuidev/react-ui";

interface Props {
  appList: AppSummary[];
  artifactList: ArtifactSummary[];
  paneUploads: ThreadUpload[];
  threads: ClawThread[];
  apps: AppStore | undefined;
  artifacts: ArtifactStore | undefined;
  uploads: UploadStore | undefined;
  pinnedAppIds: Set<string>;
  onTogglePinned: (appId: string) => void;
  onAppContinueConversation: AppContinueConversationHandler;
  onRefreshSummaries: () => void;
}

/**
 * Registers one `<ArtifactPanel>` per known app/artifact/upload. Each panel
 * portals into the `<ArtifactPortalTarget>` mounted by `ClawThreadContainer`.
 *
 * The panels render no DOM until activated, so iterating the FULL `appList`
 * / `artifactList` (not session-filtered) is essentially free and guarantees
 * a panel is ready for any cross-session refine target.
 */
export function ThreadArtifactPanels({
  appList,
  artifactList,
  paneUploads,
  threads,
  apps,
  artifacts,
  uploads,
  pinnedAppIds,
  onTogglePinned,
  onAppContinueConversation,
  onRefreshSummaries,
}: Props) {
  const artifactStore = useArtifactStore();
  const { activeArtifactId } = useActiveArtifact();
  const agentNameFor = makeAgentNameResolver(threads);
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
              // In-chat panel: omit onRefine so the Refine action hides — the
              // user is already in the refine session (composer is primed and
              // `linkedApp` is set).
              onContinueConversation={onAppContinueConversation}
              onDeleted={onRefreshSummaries}
              onClose={handleClose}
              onFullscreen={(record) => navigate({ view: "app", appId: record.id })}
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
              onFullscreen={(record) => navigate({ view: "artifact", artifactId: record.id })}
              // In-chat panel: omit onRefine — see comment on <AppDetail> above.
              siblings={artifactSiblings}
              onSwitch={(nextArtId) =>
                artifactStore.getState().openArtifact(sessionArtifactPreviewId(nextArtId))
              }
            />
          ) : null}
        </ArtifactPanel>
      ))}

      {paneUploads
        // Skip non-previewable kinds (`file` — binaries we don't decode). The
        // chip in `UserMessage` is rendered as a static `<div>` for these so
        // there's nothing to portal into; registering a panel here would
        // either show a placeholder or leak the raw `data:` URL into a `<pre>`
        // (the renderer's `file` fallback uses `resolveTextContent`).
        .filter((upload) => upload.kind !== "file")
        .map((upload) => (
          // The user-message chip clicks `sessionUploadPreviewId(remoteId)`
          // (extracted from message content). For pending entries that haven't
          // been replaced by their `listUploads` counterpart yet, `upload.id`
          // is a locally-generated id while `upload.remoteId` is the plugin
          // meta id — register against the remoteId so the chip's open()
          // finds this panel mid-stream, not just after history reload.
          <ArtifactPanel
            key={upload.remoteId ?? upload.id}
            artifactId={sessionUploadPreviewId(upload.remoteId ?? upload.id)}
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
}
