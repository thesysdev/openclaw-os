"use client";

import { ArtifactContentView } from "@/components/artifacts/ArtifactContentView";
import { TitleSwitcher, type TitleSwitcherItem } from "@/components/chat/TitleSwitcher";
import { TopBar } from "@/components/chat/TopBar";
import { DetailTopBar } from "@/components/layout/DetailTopBar";
import { IconButton } from "@/components/layout/sidebar/IconButton";
import { TextTile } from "@/components/layout/sidebar/Tile";
import { Button } from "@/components/ui/Button";
import type { ArtifactRecord, ArtifactStore } from "@/lib/engines/types";
import { artifactsHash } from "@/lib/hooks/useHashRoute";
import { Check, Copy, Maximize2, RotateCw, Sparkles, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";

interface Props {
  artifactId: string;
  artifacts: ArtifactStore;
  updatedAt?: string;
  mode?: "page" | "panel";
  onDeleted?: () => void;
  onClose?: () => void;
  onCustomize?: (record: ArtifactRecord) => void;
  onShare?: (record: ArtifactRecord) => void;
  onRefine?: (record: ArtifactRecord) => void | Promise<void>;
  /** Open this artifact in its standalone fullscreen route. Wired only by
   *  the in-chat sidepane caller — when set, panel mode renders a
   *  "fullscreen" button. */
  onFullscreen?: (record: ArtifactRecord) => void;
  /** Peers shown in the title switcher dropdown. */
  siblings?: TitleSwitcherItem[];
  /** Called when the user picks a different peer from the title dropdown. */
  onSwitch?: (artifactId: string) => void;
}

export function ArtifactDetail({
  artifactId,
  artifacts,
  updatedAt,
  mode = "page",
  onDeleted,
  onClose,
  onCustomize,
  onShare,
  onRefine,
  onFullscreen,
  siblings,
  onSwitch,
}: Props) {
  const [record, setRecord] = useState<ArtifactRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Bumped to force a refetch without `window.location.reload()`.
  const [refreshTick, setRefreshTick] = useState(0);
  const [contentCopied, setContentCopied] = useState(false);

  useEffect(() => {
    setLoading(true);
    setNotFound(false);
    setRecord(null);
    artifacts
      .getArtifact(artifactId)
      .then((r) => {
        if (!r) setNotFound(true);
        else setRecord(r);
      })
      .finally(() => setLoading(false));
  }, [artifactId, artifacts, updatedAt, refreshTick]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-text-neutral-tertiary">Loading…</p>
      </div>
    );
  }

  if (notFound || !record) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <p className="text-sm font-medium text-text-neutral-secondary">Artifact not found</p>
        <a
          href={artifactsHash()}
          className="text-sm text-text-neutral-tertiary underline underline-offset-2 hover:text-text-neutral-secondary"
        >
          ← Back to artifacts
        </a>
      </div>
    );
  }

  const contentDisplay =
    typeof record.content === "string" ? record.content : JSON.stringify(record.content, null, 2);

  async function handleDelete() {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setDeleting(true);
    try {
      await artifacts.deleteArtifact(artifactId);
      // Routing belongs to the parent — `onDeleted` from ChatApp already
      // navigates home. Mutating `window.location.hash` here used to cause
      // a second navigation when the parent also routed.
      onDeleted?.();
    } catch {
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  // Shared two-step delete control — same shape as AppDetail's, kept in sync
  // by lifting both into a single render fragment we can drop into either
  // mode's TopBar.
  const deleteControl = confirmDelete ? (
    <>
      <Button variant="borderless" size="sm" onClick={() => setConfirmDelete(false)}>
        Cancel
      </Button>
      <Button variant="destructive" size="sm" disabled={deleting} onClick={handleDelete}>
        {deleting ? "Deleting…" : "Confirm delete"}
      </Button>
    </>
  ) : (
    <IconButton
      icon={Trash2}
      variant="tertiary"
      size="md"
      title="Delete artifact"
      onClick={handleDelete}
    />
  );

  return (
    <div className="flex h-full flex-col">
      {mode === "page" && (
        <DetailTopBar
          title={record.title}
          onClose={
            onClose ??
            (() => {
              window.location.hash = artifactsHash();
            })
          }
          onCustomize={onCustomize ? () => onCustomize(record) : undefined}
          onShare={onShare ? () => onShare(record) : undefined}
          onDelete={() => void handleDelete()}
          renameLabel="Rename artifact"
          deleteLabel="Delete artifact"
          onRename={(next) => {
            // Backend rename API isn't available yet — keep the change
            // local so the user sees the title flip immediately. Hook up
            // when the gateway gains `artifacts.rename`.
            setRecord((r) => (r ? { ...r, title: next } : r));
          }}
          onRefresh={() => setRefreshTick((t) => t + 1)}
        />
      )}

      <TopBar
        actions={
          <>
            <IconButton
              icon={RotateCw}
              variant="tertiary"
              size="md"
              title="Refresh"
              onClick={() => setRefreshTick((t) => t + 1)}
            />
            <IconButton
              icon={contentCopied ? Check : Copy}
              variant="tertiary"
              size="md"
              title={contentCopied ? "Copied" : "Copy content"}
              onClick={() => {
                void navigator.clipboard.writeText(contentDisplay).then(() => {
                  setContentCopied(true);
                  window.setTimeout(() => setContentCopied(false), 1500);
                });
              }}
            />
            {onFullscreen ? (
              <IconButton
                icon={Maximize2}
                variant="tertiary"
                size="md"
                title="Open fullscreen"
                onClick={() => onFullscreen(record)}
              />
            ) : null}
            {onRefine ? (
              <Button
                variant="tertiary"
                size="md"
                icon={Sparkles}
                onClick={() => void onRefine(record)}
              >
                Refine
              </Button>
            ) : null}
            {deleteControl}
            {mode === "panel" && onClose ? (
              <IconButton
                icon={X}
                variant="tertiary"
                size="md"
                title="Close"
                aria-label="Close"
                onClick={onClose}
              />
            ) : null}
          </>
        }
      >
        {mode === "panel" ? (
          <>
            <TextTile label={record.title} category="artifacts" />
            <TitleSwitcher
              activeId={artifactId}
              currentLabel={record.title}
              items={siblings ?? []}
              onSelect={onSwitch ?? (() => {})}
              renameLabel="Rename artifact"
              deleteLabel="Delete artifact"
              // Rename has no backend API yet — keep the change local so the
              // user sees the title update immediately. Hook up to a real
              // artifacts mutation when the gateway gains `artifacts.rename`.
              onRename={(next) => {
                setRecord((r) => (r ? { ...r, title: next } : r));
              }}
              onDelete={() => {
                void handleDelete();
              }}
            />
          </>
        ) : null}
      </TopBar>

      <div className="min-h-0 flex-1 overflow-auto">
        <ArtifactContentView
          title={record.title}
          kind={record.kind}
          content={contentDisplay}
          metadata={record.metadata}
        />
      </div>
    </div>
  );
}
