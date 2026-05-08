"use client";

import { separateContentAndContext } from "@/lib/content-parser";
import {
  extractMessageUploadIds,
  inferWorkspacePreviewKind,
  sessionUploadPreviewId,
} from "@/lib/session-workspace";
import { useUploadMeta, useUploadPreview } from "@/lib/uploads-context";
import type { UserMessage as UserMsg } from "@openuidev/react-headless";
import { useArtifactStore } from "@openuidev/react-headless";
import { ChevronDown, FileArchive, FileCode2, FileImage, FileText } from "lucide-react";
import { useEffect, useState } from "react";

function FormDataAccordion({ contextString }: { contextString: string }) {
  const [expanded, setExpanded] = useState(false);

  let pretty: string;
  try {
    pretty = JSON.stringify(JSON.parse(contextString), null, 2);
  } catch {
    pretty = contextString;
  }

  return (
    <div className="openui-genui-user-message__form-state">
      <button
        type="button"
        className="openui-genui-user-message__form-state-header"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="openui-genui-user-message__form-state-label">Form data</span>
        <ChevronDown
          size={14}
          className={`openui-genui-user-message__form-state-chevron${expanded ? " openui-genui-user-message__form-state-chevron--expanded" : ""}`}
        />
      </button>
      {expanded && (
        <pre className="openui-genui-user-message__form-state-content text-sm overflow-auto">
          {pretty}
        </pre>
      )}
    </div>
  );
}

function kindIcon(kind: string): React.ComponentType<{ className?: string }> {
  switch (kind) {
    case "code":
      return FileCode2;
    case "image":
      return FileImage;
    case "markdown":
    case "pdf":
    case "text":
      return FileText;
    default:
      return FileArchive;
  }
}

// Kinds whose preview panel actually shows something useful. Anything else
// (`file` — the catch-all for binary blobs we don't decode) renders the chip
// as a non-interactive label so we don't open an empty/garbage panel.
const PREVIEWABLE_KINDS: ReadonlySet<string> = new Set([
  "image",
  "pdf",
  "markdown",
  "text",
  "code",
  "ppt",
]);

function isPreviewable(kind: string): boolean {
  return PREVIEWABLE_KINDS.has(kind);
}

function InlineUploadChip({ remoteId }: { remoteId: string }) {
  const meta = useUploadMeta(remoteId);
  const dataUrl = useUploadPreview(remoteId);
  // Match the workspace's kind so the chip's previewable-ness lines up with
  // whether `ThreadArtifactPanels` will register a panel.
  const kind = meta ? inferWorkspacePreviewKind(meta.name, meta.mimeType) : "file";
  const Icon = kindIcon(kind);
  const name = meta?.name ?? "Attachment";
  const artifactStore = useArtifactStore();
  const previewId = sessionUploadPreviewId(remoteId);
  // Default to clickable while meta is still loading — flipping the chip
  // from static-div to button on meta arrival is a worse UX than briefly
  // showing a clickable placeholder. ThreadArtifactPanels filters
  // `kind === "file"` from `workspace.uploads` (which is set at `addFiles`
  // / history-load time, not bound to meta hydration), so a click during
  // the loading window is a no-op for binaries — no empty panel opens.
  const previewable = !meta || isPreviewable(kind);
  const openArtifact = () => artifactStore.getState().openArtifact(previewId);

  // If this chip unmounts (message scrolls out of a virtualised list, thread
  // swap, etc.) while its preview is open, the artifactStore would otherwise
  // hold on to a previewId pointing at a now-gone panel — the next time the
  // store opens *anything*, the orphaned id can race the new one. Forcibly
  // close on unmount so the store stays consistent with the DOM.
  useEffect(() => {
    return () => {
      const state = artifactStore.getState();
      if (state.activeArtifactId === previewId) {
        state.closeArtifact(previewId);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewId]);

  // Note: the in-thread `<ArtifactPanel>` registration for this upload is
  // owned by `ThreadArtifactPanels` (driven by `workspace.uploads`). We must
  // NOT register a second panel with the same `previewId` here, otherwise
  // both panels portal into the active artifact target and the user sees the
  // file rendered twice. The chip is just a thumbnail/click affordance.

  if (kind === "image" && dataUrl) {
    return (
      <button
        type="button"
        className="group relative overflow-hidden rounded-xl border border-border-default bg-background shadow-sm transition-transform hover:scale-[1.02]"
        onClick={openArtifact}
        title={name}
      >
        <img src={dataUrl} alt={name} className="block h-24 w-24 object-cover" />
      </button>
    );
  }

  // Non-previewable kinds render as a static `<div>` — no `onClick`, no
  // hover/cursor affordance — so the user can still see what was attached
  // without opening a placeholder panel that has nothing useful to show.
  if (!previewable) {
    return (
      <div
        className="inline-flex items-center gap-2 rounded-xl border border-border-default bg-background px-3 py-2 text-left text-sm shadow-sm"
        title={name}
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-foreground text-text-neutral-secondary">
          <Icon className="h-4 w-4" />
        </span>
        <span className="flex max-w-[180px] flex-col">
          <span className="truncate text-sm font-medium text-text-neutral-primary">{name}</span>
          {meta?.mimeType ? (
            <span className="truncate text-sm uppercase tracking-wide text-text-neutral-tertiary">
              {meta.mimeType}
            </span>
          ) : null}
        </span>
      </div>
    );
  }

  return (
    <button
      type="button"
      className="inline-flex items-center gap-2 rounded-xl border border-border-default bg-background px-3 py-2 text-left text-sm shadow-sm transition-colors hover:bg-sunk-light"
      onClick={openArtifact}
      title={name}
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-foreground text-text-neutral-secondary">
        <Icon className="h-4 w-4" />
      </span>
      <span className="flex max-w-[180px] flex-col">
        <span className="truncate text-sm font-medium text-text-neutral-primary">{name}</span>
        {meta?.mimeType ? (
          <span className="truncate text-sm uppercase tracking-wide text-text-neutral-tertiary">
            {meta.mimeType}
          </span>
        ) : null}
      </span>
    </button>
  );
}

function InlineUploads({ remoteIds }: { remoteIds: string[] }) {
  if (remoteIds.length === 0) return null;
  // `mr-auto` + `justify-start` pin the chip row to the left edge of the
  // message column. The user-message bubble itself is left-aligned via
  // globals.css overrides; without these, the openui-shell parent's
  // default flex layout can drift the upload preview toward center.
  return (
    <div className="mb-2 mr-auto flex flex-wrap justify-start gap-2">
      {remoteIds.map((id) => (
        <InlineUploadChip key={id} remoteId={id} />
      ))}
    </div>
  );
}

interface Props {
  message: UserMsg;
}

export function UserMessage({ message }: Props) {
  const rawContent = typeof message.content === "string" ? message.content : "";
  const { content: humanText, contextString } = separateContentAndContext(rawContent);
  const uploadIds = extractMessageUploadIds(rawContent);

  // Anything non-upload (e.g. form_state) is still exposed via the accordion.
  let accordionContext: string | null = null;
  if (contextString) {
    try {
      const parsed = JSON.parse(contextString);
      if (Array.isArray(parsed)) {
        const remaining = parsed.filter(
          (entry) =>
            !entry ||
            typeof entry !== "object" ||
            (entry.type !== "thread_uploads" && entry.type !== "linked_app"),
        );
        if (remaining.length > 0) accordionContext = JSON.stringify(remaining);
      } else {
        accordionContext = contextString;
      }
    } catch {
      accordionContext = contextString;
    }
  }

  return (
    <div className="openui-shell-thread-message-user">
      <div className="openui-genui-user-message">
        <InlineUploads remoteIds={uploadIds} />
        {accordionContext && <FormDataAccordion contextString={accordionContext} />}
        <div className="openui-shell-thread-message-user__content">
          {humanText && <div>{humanText}</div>}
        </div>
      </div>
    </div>
  );
}
