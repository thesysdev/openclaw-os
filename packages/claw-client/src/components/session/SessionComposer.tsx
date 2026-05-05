"use client";

import { IconButton } from "@/components/layout/sidebar/IconButton";
import { Tag } from "@/components/layout/sidebar/Tag";
import { ContextRing, type ContextBreakdownItem } from "@/components/ui/ContextRing";
import {
  dispatchSlashCommand,
  listCommands,
  matchCommands,
  parseSlashCommand,
  type CommandContext,
} from "@/lib/commands";
import { wrapContent, wrapContext } from "@/lib/content-parser";
import type { GatewayCommand } from "@/lib/engines/types";
import {
  ROTATING_WORD_STAGGER_MS,
  useRotatingPlaceholder,
} from "@/lib/hooks/useRotatingPlaceholder";
import { useSpeechToText } from "@/lib/hooks/useSpeechToText";
import { qualifyModel } from "@/lib/models";
import type {
  LinkedAppContext,
  LinkedArtifactContext,
  ThreadUpload,
} from "@/lib/session-workspace";
import { buildThreadContextPayload } from "@/lib/session-workspace";
import type { ModelChoice } from "@/types/gateway-responses";
import { useThread } from "@openuidev/react-headless";
import { CornerDownLeft, Mic, Plus, Square, X } from "lucide-react";

import { MobileSwitcherSheet } from "@/components/mobile/MobileSwitcherSheet";
import { useIsMobile } from "@/lib/hooks/useIsMobile";

import { Button } from "@/components/ui/Button";
import { effectiveSendKey, usePreferences } from "@/lib/preferences";
import { THINKING_LEVELS } from "@/lib/thinking-levels";
import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Text-button dropdown — renders the current label as a borderless Button; on
 * click, reveals a panel of options above the trigger (composer sits at the
 * bottom of the page, so the panel opens upward).
 *
 * Includes search, scroll, and keyboard nav for backends with many models
 * (OpenRouter ships ~200). Search appears once `options.length > 8` so the
 * effort picker (4 options) stays simple.
 */
function TextButtonSelect({
  value,
  options,
  onChange,
  title,
}: {
  value: string;
  options: ReadonlyArray<{ value: string; label: string; description?: string; group?: string }>;
  onChange: (value: string) => void;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const isMobile = useIsMobile();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const showSearch = options.length > 8;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q),
    );
  }, [options, query]);

  // Reset state on close so reopening starts fresh; auto-focus the search
  // input on open so the user can start typing immediately.
  useEffect(() => {
    if (!open) {
      setQuery("");
      setActiveIndex(0);
      return;
    }
    if (showSearch) {
      requestAnimationFrame(() => searchRef.current?.focus());
    }
  }, [open, showSearch]);

  useEffect(() => {
    if (!open || isMobile) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("mousedown", onDown);
    };
  }, [open, isMobile]);

  // Clamp activeIndex when filtered shrinks below the current index.
  useEffect(() => {
    if (activeIndex >= filtered.length) {
      setActiveIndex(Math.max(0, filtered.length - 1));
    }
  }, [activeIndex, filtered.length]);

  // Keep the active row scrolled into view as the user navigates.
  useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-row-index="${activeIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  const current = options.find((o) => o.value === value) ?? options[0];

  const commit = (next: string) => {
    onChange(next);
    setOpen(false);
  };

  const onPanelKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((idx) => Math.min(filtered.length - 1, idx + 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((idx) => Math.max(0, idx - 1));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const chosen = filtered[activeIndex];
      if (chosen) commit(chosen.value);
    }
  };

  return (
    <div ref={ref} className="relative">
      <Button
        variant="borderless"
        size="sm"
        onClick={() => setOpen((o) => !o)}
        title={title}
        className="!font-normal"
      >
        {current?.label ?? "Default"}
      </Button>
      {isMobile ? (
        <MobileSwitcherSheet
          open={open}
          onClose={() => setOpen(false)}
          title={title ?? "Select"}
          activeId={value}
          options={options.map((o) => ({
            id: o.value,
            label: o.label,
            description: o.description ?? o.group,
          }))}
          onSelect={(id) => onChange(id)}
        />
      ) : open ? (
        <div
          className="absolute bottom-full right-0 z-50 mb-2xs flex w-[280px] flex-col rounded-lg border border-border-default bg-popover-background shadow-xl dark:bg-elevated"
          onKeyDown={onPanelKeyDown}
        >
          {showSearch ? (
            <div className="border-b border-border-default/40 p-2xs">
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActiveIndex(0);
                }}
                placeholder="Search…"
                className="w-full rounded-m bg-transparent px-s py-xs font-body text-sm text-text-neutral-primary outline-none placeholder:text-text-neutral-tertiary"
              />
            </div>
          ) : null}
          <div ref={listRef} className="max-h-[min(60vh,360px)] overflow-y-auto p-3xs">
            {filtered.length === 0 ? (
              <div className="px-s py-m text-center font-body text-sm text-text-neutral-tertiary">
                No matches
              </div>
            ) : null}
            {filtered.map((opt, idx) => {
              const isActive = opt.value === value;
              const isHighlighted = idx === activeIndex;
              return (
                <button
                  key={opt.value}
                  data-row-index={idx}
                  type="button"
                  onClick={() => commit(opt.value)}
                  onMouseEnter={() => setActiveIndex(idx)}
                  className={`flex w-full items-center justify-between gap-s rounded-m px-s py-xs text-left font-body text-sm transition-colors ${
                    isHighlighted
                      ? "bg-sunk-light text-text-neutral-primary dark:bg-highlight-subtle"
                      : "text-text-neutral-secondary hover:bg-sunk-light dark:hover:bg-highlight-subtle"
                  }`}
                >
                  <span className={`truncate ${isActive ? "font-medium" : "font-regular"}`}>
                    {opt.label}
                  </span>
                  {opt.group ? (
                    <span className="shrink-0 text-sm text-text-neutral-tertiary/70">
                      {opt.group}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Map a file extension to one of the `Tag` variants. Pickers stay
 *  conservative: documents get info-blue, images green, code accent
 *  (purple/indigo), spreadsheets success-green, slides warning-amber,
 *  PDFs danger-red, archives neutral-gray. Anything unrecognized falls
 *  through to neutral. */
type TagVariant = "neutral" | "accent" | "success" | "warning" | "danger" | "info";
function extensionVariant(ext: string): TagVariant {
  const e = ext.toLowerCase();
  if (e === "pdf") return "danger";
  if (["png", "jpg", "jpeg", "webp", "gif", "svg", "heic", "avif"].includes(e)) return "success";
  if (["doc", "docx", "txt", "md", "rtf"].includes(e)) return "info";
  if (["xlsx", "xls", "csv", "tsv", "numbers"].includes(e)) return "success";
  if (["pptx", "ppt", "key"].includes(e)) return "warning";
  if (
    [
      "js",
      "jsx",
      "ts",
      "tsx",
      "py",
      "rb",
      "go",
      "rs",
      "java",
      "c",
      "cpp",
      "h",
      "swift",
      "kt",
      "php",
    ].includes(e)
  )
    return "accent";
  if (["json", "yaml", "yml", "xml", "html", "css", "scss", "toml"].includes(e)) return "info";
  return "neutral";
}

function splitFileName(label: string): { name: string; ext: string } {
  const dotIdx = label.lastIndexOf(".");
  if (dotIdx <= 0 || dotIdx === label.length - 1) return { name: label, ext: "" };
  return { name: label.slice(0, dotIdx), ext: label.slice(dotIdx + 1) };
}

function UploadChip({ label, onRemove }: { label: string; onRemove?: () => void }) {
  const { name, ext } = splitFileName(label);
  const variant = extensionVariant(ext);
  return (
    <span
      title={label}
      className="inline-flex max-w-full items-center gap-xs rounded-md border border-border-default/60 bg-background p-xs text-sm shadow-sm dark:border-border-default/30 dark:bg-elevated-light"
    >
      {ext ? (
        <Tag size="md" variant={variant}>
          {ext.toUpperCase()}
        </Tag>
      ) : null}
      <span className="max-w-[160px] truncate text-sm text-text-neutral-secondary">{name}</span>
      {onRemove ? (
        <button
          type="button"
          className="rounded-full p-0.5 text-text-neutral-tertiary transition-colors hover:bg-sunk hover:text-text-neutral-secondary"
          onClick={onRemove}
          title={`Remove ${label}`}
        >
          <X className="h-3 w-3" />
        </button>
      ) : null}
    </span>
  );
}

/**
 * Shared display shape for the slash menu. Both our local commands (which run
 * client-side) and OpenClaw's gateway commands (which get intercepted by the
 * server when typed) project into this.
 */
type SlashEntry = {
  name: string;
  description: string;
  argHint?: string;
  source: "local" | "gateway";
};

function SlashMenu({
  entries,
  activeIndex,
  onSelect,
  onHover,
  placement = "above",
}: {
  entries: SlashEntry[];
  activeIndex: number;
  onSelect: (entry: SlashEntry) => void;
  onHover: (index: number) => void;
  /** "above" → opens upward (default, for chat composer at viewport bottom).
   *  "below" → opens downward (for home composer where content sits below). */
  placement?: "above" | "below";
}) {
  const activeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);
  if (entries.length === 0) return null;
  const placementClasses = placement === "below" ? "top-full mt-xs" : "bottom-full mb-xs";
  return (
    <div
      className={`absolute left-0 right-0 z-20 max-h-64 overflow-y-auto rounded-xl border border-border-default/70 bg-background p-3xs shadow-xl dark:border-border-default/30 dark:bg-elevated ${placementClasses}`}
    >
      {entries.map((entry, index) => (
        <button
          key={`${entry.source}:${entry.name}`}
          ref={index === activeIndex ? activeRef : undefined}
          type="button"
          onClick={() => onSelect(entry)}
          onMouseEnter={() => onHover(index)}
          className={`flex w-full items-center gap-s rounded-m px-s py-xs text-left transition-colors ${
            index === activeIndex
              ? "bg-info-background"
              : "hover:bg-sunk-light dark:hover:bg-highlight-subtle"
          }`}
        >
          <span className="shrink-0 font-mono text-sm font-medium text-text-info-primary">
            /{entry.name}
          </span>
          <span className="min-w-0 flex-1 truncate text-right font-body text-sm text-text-neutral-tertiary">
            {entry.description}
            {entry.argHint ? (
              <span className="ml-2xs text-text-neutral-tertiary/70">{entry.argHint}</span>
            ) : null}
          </span>
          {entry.source === "gateway" ? (
            <span className="shrink-0 rounded-s bg-sunk-light px-2xs py-3xs font-label text-[10px] font-medium uppercase tracking-wide text-text-neutral-tertiary">
              gateway
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

export function SessionComposer({
  uploads,
  linkedApp,
  linkedArtifact,
  onPickFiles,
  onAddFiles,
  onRemoveUpload,
  onUploadsSent,
  commandContext,
  gatewayCommands = [],
  onDispatchGatewayCommand,
  models = [],
  gatewayDefaultModelId = null,
  agentDefaultModelId = null,
  currentModel = "",
  currentEffort = "",
  effortDefault = null,
  effortOptions = null,
  onModelChange,
  onEffortChange,
  contextTokens,
  contextLimit,
  contextBreakdown,
  rotatingPlaceholders,
  rotatingPlaceholderFillWith,
  rotateIntervalMs = 3000,
  slashMenuPlacement = "above",
}: {
  uploads: ThreadUpload[];
  linkedApp: LinkedAppContext | null;
  linkedArtifact: LinkedArtifactContext | null;
  onPickFiles: () => void;
  /**
   * Adds raw `File`s — used by drag-drop and clipboard paste. Optional so the
   * composer can be embedded in contexts (e.g. read-only previews) where file
   * attachment isn't relevant.
   */
  onAddFiles?: (files: File[]) => void | Promise<void>;
  onRemoveUpload: (uploadId: string) => void;
  onUploadsSent: (uploadIds: string[]) => void;
  commandContext?: () => CommandContext;
  gatewayCommands?: GatewayCommand[];
  models?: ModelChoice[];
  /** Gateway's resolved default model id (qualified `provider/model`) when the
   *  server exposes it via `models.list.defaultId`. May be null on older
   *  gateways; the picker falls back to a heuristic. */
  gatewayDefaultModelId?: string | null;
  /** Per-agent primary model (qualified `provider/model`) from
   *  `cfg.agents.byId.{id}.model.primary`. When the session has no explicit
   *  override, this is what the gateway will actually run — surfacing it in
   *  the picker label keeps the displayed default honest. */
  agentDefaultModelId?: string | null;
  /** Qualified model id (provider/id) currently selected, or "" for default. */
  currentModel?: string;
  /** Current thinking/effort level, or "" for default. */
  currentEffort?: string;
  /** Model-specific default thinking level (from `SessionRow.thinkingDefault`).
   *  Used to render the `""` option as `Default (<resolved>)`. */
  effortDefault?: string | null;
  /** Allowed thinking levels for the current model (from
   *  `SessionRow.thinkingOptions`). When set, filters the dropdown so models
   *  that don't support e.g. `adaptive` don't show it. */
  effortOptions?: string[] | null;
  onModelChange?: (value: string) => void;
  onEffortChange?: (value: string) => void;
  /** Tokens used / total context-window for the active model. */
  contextTokens?: number;
  contextLimit?: number;
  contextBreakdown?: ContextBreakdownItem[];
  /**
   * Called when the user submits a slash command that matches a gateway
   * command we know how to intercept locally (e.g. `/reset` → `sessions.reset`
   * RPC). Return `true` if the command was handled and the message should NOT
   * be sent to the LLM. Return `false` to fall through to `chat.send`.
   */
  onDispatchGatewayCommand?: (name: string, args: string) => Promise<boolean>;
  /** When set, the placeholder cycles through these strings while the
   *  textarea is empty. Used on the home page to surface conversation
   *  starters as auto-completes. */
  rotatingPlaceholders?: ReadonlyArray<string>;
  /** Optional parallel array (same length + ordering as
   *  `rotatingPlaceholders`). When the user presses Tab, the textarea
   *  fills with the entry from this array instead of the displayed
   *  placeholder — lets the home composer show a concise hint while
   *  still sending the model a richer prompt. Falls back to the
   *  displayed placeholder when the entry is missing. */
  rotatingPlaceholderFillWith?: ReadonlyArray<string>;
  /** Milliseconds between rotation steps. Default 3000. Ignored when the
   *  user prefers reduced motion — only the first item is shown. */
  rotateIntervalMs?: number;
  /** Where the slash-command dropdown should open relative to the
   *  composer. Default `"above"` — chat composers sit at the bottom of
   *  the viewport so there's no room below. The home composer sits
   *  near the top with sections under it, so it passes `"below"`. */
  slashMenuPlacement?: "above" | "below";
}) {
  const processMessage = useThread((state) => state.processMessage);
  const cancelMessage = useThread((state) => state.cancelMessage);
  const isRunning = useThread((state) => state.isRunning);
  const isLoadingMessages = useThread((state) => state.isLoadingMessages);
  const prefs = usePreferences();
  const stt = useSpeechToText();
  const sttBaselineRef = useRef("");
  const [textContent, setTextContent] = useState("");
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  const [isDragOver, setIsDragOver] = useState(false);
  const dragDepthRef = useRef(0);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Rotating-placeholder UX (home composer only — `rotatingPlaceholders`
  // is undefined for chat). The hook owns the cycle interval, the
  // per-word streaming, and the snap-to-end-on-focus behavior.
  const [composerFocused, setComposerFocused] = useState(false);
  const rotation = useRotatingPlaceholder({
    items: rotatingPlaceholders ?? [],
    fillWith: rotatingPlaceholderFillWith,
    intervalMs: rotateIntervalMs,
    hasContent: textContent.length > 0,
    isFocused: composerFocused,
  });

  const pendingUploads = useMemo(
    () => uploads.filter((upload) => upload.status === "pending"),
    [uploads],
  );

  // Auto-grow the textarea: reset height then pin to scrollHeight. Capped by
  // the `max-h-48` class on the element itself (which enables scrolling after
  // the cap is hit).
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  }, [textContent]);

  const slashMatches = useMemo<SlashEntry[]>(() => {
    const trimmed = textContent.trimStart();
    if (!trimmed.startsWith("/")) return [];
    // Only show menu while the user is still composing the command token.
    const afterSlash = trimmed.slice(1);
    const hasSpace = /\s/.test(afterSlash);
    if (hasSpace) return [];

    const localEntries: SlashEntry[] = (
      afterSlash.length === 0 ? listCommands() : matchCommands(afterSlash)
    ).map((cmd) => ({
      name: cmd.name,
      description: cmd.description,
      argHint: cmd.argHint,
      source: "local",
    }));

    const gatewayEntries: SlashEntry[] = gatewayCommands
      .filter((cmd) => cmd.name.toLowerCase().startsWith(afterSlash.toLowerCase()))
      .map((cmd) => ({
        name: cmd.name,
        description: cmd.description,
        argHint: cmd.argHint,
        source: "gateway",
      }));

    // Local wins on name collisions so host-specific behavior can override
    // whatever the gateway registered under the same name.
    const seen = new Set(localEntries.map((entry) => entry.name));
    const filteredGateway = gatewayEntries.filter((entry) => !seen.has(entry.name));

    return [...localEntries, ...filteredGateway].sort((a, b) => a.name.localeCompare(b.name));
  }, [textContent, gatewayCommands]);

  useEffect(() => {
    if (slashActiveIndex >= slashMatches.length) {
      setSlashActiveIndex(Math.max(0, slashMatches.length - 1));
    }
  }, [slashActiveIndex, slashMatches.length]);

  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<{ text?: string }>).detail;
      if (!detail?.text) return;
      setTextContent(detail.text);
      requestAnimationFrame(() => textareaRef.current?.focus());
    };
    window.addEventListener("openclaw-os:prime-composer", listener as EventListener);
    return () =>
      window.removeEventListener("openclaw-os:prime-composer", listener as EventListener);
  }, []);

  const applySlashCompletion = (entry: SlashEntry) => {
    setTextContent(`/${entry.name}${entry.argHint ? " " : ""}`);
    setSlashActiveIndex(0);
    textareaRef.current?.focus();
  };

  const isCommandInput = textContent.trimStart().startsWith("/");
  const parsedCommand = isCommandInput ? parseSlashCommand(textContent) : null;

  const isDisabled =
    isRunning ||
    isLoadingMessages ||
    (!textContent.trim() && pendingUploads.length === 0 && !parsedCommand);

  const handleSubmit = async () => {
    if (isDisabled) return;

    // Slash command path — short-circuit without sending to the LLM.
    if (parsedCommand && commandContext) {
      const context = commandContext();
      const result = await dispatchSlashCommand(textContent, context);
      if (result.handled) {
        setTextContent(result.replaceInput ?? "");
        return;
      }
    }

    // Gateway-command interception: for slash commands that map to a direct
    // RPC (e.g. /reset → sessions.reset), dispatch locally rather than routing
    // through `chat.send`. The gateway's webchat channel doesn't run the
    // slash-command handler on chat.send the way other channels do.
    if (onDispatchGatewayCommand) {
      const trimmed = textContent.trimStart();
      if (trimmed.startsWith("/")) {
        const spaceIdx = trimmed.search(/\s/);
        const name = (
          spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx)
        ).toLowerCase();
        const args = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();
        // Clear input *before* awaiting so the slash menu and the "/compact"
        // text disappear immediately, instead of hanging around for the full
        // duration of the RPC (compaction is ~1s).
        setTextContent("");
        const handled = await onDispatchGatewayCommand(name, args);
        if (handled) return;
      }
    }

    const humanText =
      textContent.trim() ||
      `Attached ${pendingUploads.length} file${pendingUploads.length === 1 ? "" : "s"}.`;
    const contextPayload = buildThreadContextPayload({
      linkedApp,
      linkedArtifact,
      uploads: pendingUploads,
    });
    const contentParts =
      contextPayload.length > 0
        ? [wrapContent(humanText), wrapContext(JSON.stringify(contextPayload))]
        : [humanText];

    const uploadIds = pendingUploads.map((upload) => upload.id);
    setTextContent("");

    const sendPromise = processMessage({
      role: "user",
      content: contentParts.join(""),
      attachments: pendingUploads.flatMap((upload) =>
        upload.attachment ? [upload.attachment] : [],
      ),
    } as any);

    if (uploadIds.length > 0) {
      onUploadsSent(uploadIds);
    }

    await sendPromise;
  };

  // Drag-drop & clipboard-paste plumbing. Both route through `onAddFiles`,
  // which mirrors the file-picker path. We use a depth counter for dragenter/
  // dragleave so nested children inside the composer don't toggle the overlay
  // off as the cursor moves between them.
  const handleDragEnter = (e: React.DragEvent) => {
    if (!onAddFiles) return;
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault();
    dragDepthRef.current += 1;
    setIsDragOver(true);
  };
  const handleDragOver = (e: React.DragEvent) => {
    if (!onAddFiles) return;
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };
  const handleDragLeave = (e: React.DragEvent) => {
    if (!onAddFiles) return;
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDragOver(false);
  };
  const handleDrop = (e: React.DragEvent) => {
    if (!onAddFiles) return;
    e.preventDefault();
    dragDepthRef.current = 0;
    setIsDragOver(false);
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length === 0) return;
    void onAddFiles(files);
  };
  const handlePaste = (e: React.ClipboardEvent) => {
    if (!onAddFiles) return;
    const items = Array.from(e.clipboardData?.items ?? []);
    const files: File[] = [];
    for (const item of items) {
      if (item.kind !== "file") continue;
      const file = item.getAsFile();
      if (file) files.push(file);
    }
    if (files.length === 0) return;
    e.preventDefault();
    void onAddFiles(files);
  };

  return (
    <div
      className={`openclaw-os-session-composer relative mb-1 w-full rounded-xl border border-border-default/25 bg-foreground p-[2px] sm:mb-3 dark:border-border-default/8 ${
        isDragOver ? "ring-2 ring-text-accent-primary ring-offset-2" : ""
      }`}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragOver && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-background/85 dark:bg-foreground/85">
          <span className="font-label text-sm font-medium text-text-accent-primary">
            Drop files to attach
          </span>
        </div>
      )}
      {slashMatches.length > 0 && (
        <SlashMenu
          entries={slashMatches}
          activeIndex={slashActiveIndex}
          onSelect={applySlashCompletion}
          onHover={setSlashActiveIndex}
          placement={slashMenuPlacement}
        />
      )}

      {/* Bordered input card — only the textarea + send/stop button live here. */}
      <div className="overflow-hidden rounded-lg bg-background shadow-md">
        {pendingUploads.length > 0 && (
          <div className="flex flex-wrap items-center gap-xs p-s">
            {pendingUploads.map((upload) => (
              <UploadChip
                key={upload.id}
                label={upload.name}
                onRemove={() => onRemoveUpload(upload.id)}
              />
            ))}
          </div>
        )}

        <div className="flex items-end gap-xs pl-s pr-2xs py-2xs">
          <div className="relative flex flex-1 items-end">
            <textarea
              ref={textareaRef}
              value={textContent}
              onChange={(event) => setTextContent(event.target.value)}
              onPaste={handlePaste}
              onFocus={() => setComposerFocused(true)}
              onBlur={() => setComposerFocused(false)}
              rows={1}
              // Suppress the native placeholder while a rotating overlay is
              // active — the overlay carries both the rotating text + the
              // [Tab] chip and we don't want a double-print.
              placeholder={
                rotation.current || isCommandInput
                  ? ""
                  : effectiveSendKey(prefs) === "mod-enter"
                    ? "Type / for commands · ⌘↵ to send"
                    : "Type / for commands"
              }
              className="max-h-48 min-h-12 w-full resize-none bg-transparent py-2xs text-sm leading-5 text-text-neutral-primary outline-none placeholder:text-text-neutral-tertiary"
              onKeyDown={(event) => {
                if (slashMatches.length > 0) {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setSlashActiveIndex((idx) => Math.min(slashMatches.length - 1, idx + 1));
                    return;
                  }
                  if (event.key === "ArrowUp") {
                    event.preventDefault();
                    setSlashActiveIndex((idx) => Math.max(0, idx - 1));
                    return;
                  }
                  if (event.key === "Tab") {
                    const chosen = slashMatches[slashActiveIndex];
                    if (chosen) {
                      event.preventDefault();
                      applySlashCompletion(chosen);
                      return;
                    }
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setTextContent("");
                    return;
                  }
                  // Enter falls through to submission — literal text wins.
                }
                // Rotating-placeholder Tab-fill: empty textarea + no slash
                // menu open → accept the current placeholder. Cursor lands
                // at the end (set after state flush via the autoFocus hop
                // below — `setSelectionRange` on the next tick).
                if (
                  event.key === "Tab" &&
                  !event.shiftKey &&
                  rotation.fillText &&
                  textContent.length === 0 &&
                  slashMatches.length === 0
                ) {
                  event.preventDefault();
                  const fill = rotation.fillText;
                  setTextContent(fill);
                  requestAnimationFrame(() => {
                    const ta = textareaRef.current;
                    if (!ta) return;
                    ta.setSelectionRange(fill.length, fill.length);
                  });
                  return;
                }
                if (event.key === "Enter" && !event.shiftKey) {
                  const mode = effectiveSendKey(prefs);
                  const wantsMod = mode === "mod-enter";
                  const hasMod = event.metaKey || event.ctrlKey;
                  if (wantsMod && !hasMod) return; // let newline insert
                  if (!wantsMod && hasMod) return; // ⌘↵ ignored in plain mode
                  event.preventDefault();
                  void handleSubmit();
                }
              }}
            />
            {rotation.current && textContent.length === 0 ? (
              // `inset-0` + `items-start` + same py/leading as the
              // textarea → the placeholder sits on the exact same
              // baseline as typed text. `items-start` (not `center`)
              // is what keeps it pinned to the first line now that
              // the textarea has a 2-line `min-h`. Each word's
              // `wordIndex` drives its `animation-delay`; the TAB
              // chip waits for `streamDone` before fading in.
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 flex items-start gap-xs py-2xs"
              >
                <span className="min-w-0 truncate text-sm leading-5 text-text-neutral-tertiary/70">
                  {rotation.tokens.map((token, i) =>
                    token.wordIndex < 0 ? (
                      <span key={`${rotation.rotationKey}-${i}`}>{token.text}</span>
                    ) : (
                      <span
                        key={`${rotation.rotationKey}-${i}`}
                        className="claw-word-blur-in inline-block"
                        style={{
                          animationDelay: `${token.wordIndex * ROTATING_WORD_STAGGER_MS}ms`,
                        }}
                      >
                        {token.text}
                      </span>
                    ),
                  )}
                </span>
                {rotation.streamDone ? (
                  // h-5 matches the placeholder's leading-5 (20px) so the
                  // shorter Tag sits visually centered on the first text
                  // line — without this wrapper `items-start` on the parent
                  // pins the Tag's top edge to the container top, which
                  // reads as "floating above" the placeholder text.
                  <span className="flex h-5 shrink-0 items-center">
                    <Tag
                      key={`tab-${rotation.rotationKey}`}
                      size="md"
                      variant="neutral"
                      className="claw-fade-in opacity-70"
                    >
                      TAB
                    </Tag>
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
          <IconButton
            icon={isRunning ? Square : CornerDownLeft}
            variant="ghost"
            size="md"
            title={
              isRunning ? "Stop" : parsedCommand ? `Run /${parsedCommand.command.name}` : "Send"
            }
            disabled={!isRunning && isDisabled}
            onClick={isRunning ? cancelMessage : () => void handleSubmit()}
          />
        </div>
      </div>

      {/* Controls row — lives OUTSIDE the bordered card, no fill. */}
      <div className="flex flex-wrap items-center justify-between gap-y-1 gap-x-3 px-1">
        <div className="flex items-center gap-xs">
          <IconButton
            icon={Plus}
            variant="tertiary"
            size="md"
            title="Add context / attach files"
            onClick={onPickFiles}
            className="hover:!bg-transparent dark:hover:!bg-transparent"
          />
          {stt.supported ? (
            <IconButton
              icon={Mic}
              variant={stt.listening ? "primary" : "tertiary"}
              size="md"
              title={stt.listening ? "Stop dictation" : "Dictate (speech-to-text)"}
              className={stt.listening ? "" : "hover:!bg-transparent dark:hover:!bg-transparent"}
              onClick={() => {
                if (stt.listening) {
                  stt.stop();
                  return;
                }
                // Capture the current text once so each interim update
                // appends to the original baseline rather than
                // compounding the streaming transcript.
                sttBaselineRef.current = textContent.replace(/\s+$/, "");
                stt.start((text) => {
                  const sep = sttBaselineRef.current ? " " : "";
                  setTextContent(sttBaselineRef.current + sep + text);
                });
              }}
            />
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-3xs font-body text-sm text-text-neutral-tertiary">
          {contextTokens != null && contextLimit && contextLimit > 0 ? (
            <>
              <ContextRing used={contextTokens} limit={contextLimit} breakdown={contextBreakdown} />
              <span aria-hidden="true" className="ml-2xs text-text-neutral-tertiary/60">
                ·
              </span>
            </>
          ) : null}
          {onModelChange
            ? (() => {
                const hint = agentDefaultModelId ?? gatewayDefaultModelId;
                const defaultModel = hint
                  ? (models.find(
                      (m) =>
                        qualifyModel(m.id, m.provider) === hint ||
                        m.id === hint ||
                        hint.endsWith(`/${m.id}`),
                    ) ?? null)
                  : null;
                // openclaw's `models.list` can repeat the same qualified id (e.g.
                // `openrouter/auto` appears once from the provider catalog and
                // again from the configured alias entry). Dedupe so the picker
                // doesn't show duplicates or trip React's key-uniqueness check.
                const seen = new Set<string>();
                const uniqueModels: typeof models = [];
                for (const m of models) {
                  const key = qualifyModel(m.id, m.provider);
                  if (seen.has(key)) continue;
                  seen.add(key);
                  uniqueModels.push(m);
                }
                return (
                  <TextButtonSelect
                    value={currentModel}
                    onChange={onModelChange}
                    title="Model"
                    options={[
                      {
                        value: "",
                        // When we can identify the resolved default model, label
                        // the row "Default (Name)". Filter that same model out of
                        // the list below so it doesn't appear twice.
                        label: defaultModel ? `Default (${defaultModel.name})` : "Default",
                      },
                      ...uniqueModels
                        .filter((m) => m !== defaultModel)
                        .map((m) => ({
                          value: qualifyModel(m.id, m.provider),
                          label: m.name,
                          group: m.provider,
                        })),
                    ]}
                  />
                );
              })()
            : null}
          {onModelChange && onEffortChange ? (
            <span aria-hidden="true" className="text-text-neutral-tertiary/60">
              ·
            </span>
          ) : null}
          {onEffortChange ? (
            <TextButtonSelect
              value={currentEffort}
              onChange={onEffortChange}
              title="Reasoning effort"
              options={THINKING_LEVELS.filter(
                (t) => t.value === "" || !effortOptions || effortOptions.includes(t.value),
              ).map((t) => ({
                value: t.value,
                label: t.value === "" && effortDefault ? `Default (${effortDefault})` : t.label,
              }))}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
