"use client";

import { IconButton } from "@/components/layout/sidebar/IconButton";
import { CategoryTile, TextTile } from "@/components/layout/sidebar/Tile";
import type { AppSummary, ArtifactSummary } from "@/lib/engines/types";
import {
  sessionAppPreviewId,
  sessionArtifactPreviewId,
  sessionUploadPreviewId,
  type ThreadUpload,
  type ThreadWorkspaceState,
} from "@/lib/session-workspace";
import { useArtifactStore } from "@openuidev/react-headless";
import { Database, FileText, LayoutGrid, PanelRightOpen } from "lucide-react";

interface Props {
  paneApps: AppSummary[];
  paneArtifacts: ArtifactSummary[];
  paneUploads: ThreadUpload[];
  paneLinkedApp: ThreadWorkspaceState["linkedApp"];
  activeArtifactId: string | null | undefined;
  onExpand: () => void;
}

/**
 * The 48px-wide collapsed workspace pane. Auto-collapses when an artifact
 * preview opens (the side-pane already claims the right edge, the full
 * Workspace would compete) — this strip lets the user re-expand from inside
 * the slide-in.
 */
export function ThreadWorkspaceStrip({
  paneApps,
  paneArtifacts,
  paneUploads,
  paneLinkedApp,
  activeArtifactId,
  onExpand,
}: Props) {
  const artifactStore = useArtifactStore();

  return (
    <aside className="hidden h-full w-12 shrink-0 flex-col items-center overflow-y-auto border-l border-border-default/50 bg-transparent dark:border-border-default/16 lg:flex">
      <div className="flex min-h-[48px] w-full items-center justify-center border-b border-border-default px-2xs dark:border-border-default/16">
        <IconButton
          icon={PanelRightOpen}
          variant="tertiary"
          size="md"
          title="Expand thread workspace"
          aria-label="Expand thread workspace"
          onClick={onExpand}
        />
      </div>

      <div className="flex w-full flex-col items-center gap-2xs py-m">
        <CategoryTile icon={LayoutGrid} category="apps" subtle />
        {paneApps.map((app) => {
          const isActive = activeArtifactId === sessionAppPreviewId(app.id);
          return (
            <button
              key={app.id}
              type="button"
              title={app.title}
              onClick={() => artifactStore.getState().openArtifact(sessionAppPreviewId(app.id))}
              className="rounded-m p-2xs transition-colors hover:bg-sunk-light dark:hover:bg-highlight-subtle"
            >
              <TextTile label={app.title} category={isActive ? "apps" : null} active={isActive} />
            </button>
          );
        })}
      </div>

      <div className="h-px w-full bg-border-default/50 dark:bg-border-default/16" />

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

      <div className="flex w-full flex-col items-center gap-2xs py-m">
        <CategoryTile icon={Database} category="home" subtle />
        {paneLinkedApp ? (
          <button
            type="button"
            title={paneLinkedApp.title}
            onClick={() =>
              artifactStore.getState().openArtifact(sessionAppPreviewId(paneLinkedApp.appId))
            }
            className="rounded-m p-2xs transition-colors hover:bg-sunk-light dark:hover:bg-highlight-subtle"
          >
            <TextTile
              label={paneLinkedApp.title}
              category={
                activeArtifactId === sessionAppPreviewId(paneLinkedApp.appId) ? "apps" : null
              }
              active={activeArtifactId === sessionAppPreviewId(paneLinkedApp.appId)}
            />
          </button>
        ) : null}
        {paneUploads.map((upload) => {
          // Match the artifactId that ThreadArtifactPanels registers — the
          // remoteId for sent uploads, falling back to the local id for
          // pre-`uploads.put` pending entries.
          const previewId = sessionUploadPreviewId(upload.remoteId ?? upload.id);
          const isActive = activeArtifactId === previewId;
          // `file` kind has no preview UI — render the tile as a static label
          // (matches `InlineUploadChip` in `UserMessage`) so we don't open an
          // empty/garbage panel on click.
          if (upload.kind === "file") {
            return (
              <div key={upload.id} title={upload.name} className="rounded-m p-2xs">
                <TextTile label={upload.name} />
              </div>
            );
          }
          return (
            <button
              key={upload.id}
              type="button"
              title={upload.name}
              onClick={() => artifactStore.getState().openArtifact(previewId)}
              className="rounded-m p-2xs transition-colors hover:bg-sunk-light dark:hover:bg-highlight-subtle"
            >
              <TextTile label={upload.name} category={isActive ? "home" : null} active={isActive} />
            </button>
          );
        })}
      </div>
    </aside>
  );
}
