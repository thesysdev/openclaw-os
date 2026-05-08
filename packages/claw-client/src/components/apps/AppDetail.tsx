"use client";

import { TitleSwitcher, type TitleSwitcherItem } from "@/components/chat/TitleSwitcher";
import { TopBar } from "@/components/chat/TopBar";
import { DetailTopBar } from "@/components/layout/DetailTopBar";
import { IconButton } from "@/components/layout/sidebar/IconButton";
import { TextTile } from "@/components/layout/sidebar/Tile";
import { Button } from "@/components/ui/Button";
import { SegmentedTabs } from "@/components/ui/SegmentedTabs";
import type { AppRecord, AppStore } from "@/lib/engines/types";
import { buildContinueConversationPayload, handleOpenUrlAction } from "@/lib/renderer-actions";
import type { ActionEvent } from "@openuidev/react-lang";
import { Renderer } from "@openuidev/react-lang";
import { Callout } from "@openuidev/react-ui";
import { openuiLibrary } from "@openuidev/react-ui/genui-lib";
import {
  Bug,
  Check,
  Code2,
  Copy,
  Eye,
  Maximize2,
  Pin,
  RotateCw,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppDebugPanel } from "./AppDebugPanel";
import { useToolInvocationLog } from "./useToolInvocationLog";

/**
 * Called when a `ContinueConversation` action fires inside a standalone app
 * view. Implementations are expected to route the message to the app's
 * origin chat session, pin the app into that session's workspace, and open
 * the app preview on the side (mirroring the Refine flow) — see
 * `ChatAppInner.handleAppContinueConversation`.
 */
export type AppContinueConversationHandler = (payload: {
  message: { role: "user"; content: string };
  appRecord: AppRecord;
}) => void;

function normalizeToolResult(result: unknown): unknown {
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const candidate = result as Record<string, unknown>;
    const stdout = candidate["stdout"];
    if (typeof stdout === "string") {
      const trimmed = stdout.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          return JSON.parse(trimmed);
        } catch {
          // Fall through to the raw tool result below.
        }
      }
    }
  }

  return result;
}

interface Props {
  appId: string;
  apps: AppStore;
  updatedAt?: string;
  onDeleted?: () => void;
  isPinned?: boolean;
  onTogglePinned?: (appId: string) => void;
  onRefine?: (record: AppRecord) => void | Promise<void>;
  /**
   * Handler invoked when the app emits a `ContinueConversation` action
   * (e.g. a Button with `Action([@ToAssistant("...")])`). The parent is
   * responsible for routing the message to the app's origin thread.
   */
  onContinueConversation?: AppContinueConversationHandler;
  /** Close the fullscreen detail (e.g. navigate home). */
  onClose?: () => void;
  /** Opens the parent agent chat. */
  onCustomize?: (record: AppRecord) => void;
  /** Share action. */
  onShare?: (record: AppRecord) => void;
  /** Open this app in its standalone fullscreen route. Wired only by the
   *  in-chat sidepane caller — when set, panel mode renders a "fullscreen"
   *  button that mirrors how Refine sends the user to a thread. */
  onFullscreen?: (record: AppRecord) => void;
  mode?: "page" | "panel";
  /** Peers shown in the title switcher dropdown. */
  siblings?: TitleSwitcherItem[];
  /** Called when the user picks a different peer from the title dropdown. */
  onSwitch?: (appId: string) => void;
}

export function AppDetail({
  appId,
  apps,
  updatedAt,
  onDeleted,
  isPinned = false,
  onTogglePinned,
  onRefine,
  onContinueConversation,
  onClose,
  onCustomize,
  onShare,
  onFullscreen,
  mode = "page",
  siblings,
  onSwitch,
}: Props) {
  const [record, setRecord] = useState<AppRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [viewMode, setViewMode] = useState<"preview" | "code">("preview");
  const [renderErrors, setRenderErrors] = useState<string[]>([]);
  const [debugOpen, setDebugOpen] = useState(false);
  // Bumped to force a refetch without `window.location.reload()` — keeps the
  // surrounding React tree (other open chats, scroll positions) intact.
  const [refreshTick, setRefreshTick] = useState(0);
  const [codeCopied, setCodeCopied] = useState(false);

  // Captures the latest reactive state from the Renderer so @ToAssistant
  // actions can prefix the user's message with what the app was showing.
  const stateRef = useRef<Record<string, unknown>>({});
  const toolLog = useToolInvocationLog();
  // `toolLog` itself is a fresh object every render; its callbacks are stable.
  const { record: recordToolEntry, updateStatus: updateToolStatus } = toolLog;

  useEffect(() => {
    setLoading(true);
    setNotFound(false);
    setRecord(null);
    setRenderErrors([]);
    apps
      .getApp(appId)
      .then((r) => {
        if (!r) setNotFound(true);
        else setRecord(r);
      })
      .finally(() => setLoading(false));
  }, [appId, apps, updatedAt, refreshTick]);

  // Route built-in Renderer actions through the shared handler module.
  //   - `OpenUrl`              → open in a new tab.
  //   - `ContinueConversation` → delegated to the parent via
  //     `onContinueConversation`, which is expected to select the app's
  //     origin thread and post the message there. Silently no-ops when the
  //     parent didn't supply a handler (e.g. a preview surface that doesn't
  //     own routing).
  const handleAction = useCallback(
    (event: ActionEvent) => {
      if (handleOpenUrlAction(event)) return;

      // Prefix the message with appId + live reactive state so the assistant
      // can (a) call get_app(id) for the static code, (b) see what the user
      // was looking at without re-asking. Query result status is deliberately
      // NOT included — the agent can just query the DB itself.
      const appContext =
        record != null
          ? {
              appId: record.id,
              appTitle: record.title,
              currentState: { ...stateRef.current },
            }
          : undefined;

      const payload = buildContinueConversationPayload(event, undefined, appContext);
      if (payload && onContinueConversation && record) {
        onContinueConversation({ message: payload, appRecord: record });
      }
    },
    [onContinueConversation, record],
  );

  // Build a toolProvider that bridges Query/Mutation in the app markup to
  // gateway RPCs — no LLM hop; the plugin executes tools directly.
  // record.sessionKey scopes every tool call to the app's agent session so
  // exec approvals, memory access, etc. are attributed correctly.
  const toolProvider = useMemo(() => {
    const invokeScopedTool = async (
      toolName: string,
      args: Record<string, unknown>,
    ): Promise<unknown> => {
      const startedAt = Date.now();
      const entryId = recordToolEntry({ toolName, args, startedAt });
      try {
        const result = await apps.invokeTool(toolName, args, record?.sessionKey);
        const normalized = normalizeToolResult(result);
        updateToolStatus(entryId, {
          result: normalized,
          status: "ok",
          finishedAt: Date.now(),
        });
        return normalized;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        updateToolStatus(entryId, {
          error: message,
          status: "error",
          finishedAt: Date.now(),
        });
        throw err;
      }
    };

    return {
      exec: async (args: Record<string, unknown>) => invokeScopedTool("exec", args),
      read: async (args: Record<string, unknown>) => invokeScopedTool("read", args),
      db_query: async (args: Record<string, unknown>) => invokeScopedTool("db_query", args),
      db_execute: async (args: Record<string, unknown>) => invokeScopedTool("db_execute", args),
    };
  }, [apps, record?.sessionKey, recordToolEntry, updateToolStatus]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-text-neutral-tertiary">Loading app…</p>
      </div>
    );
  }

  if (notFound || !record) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <p className="text-sm font-medium text-text-neutral-secondary">App not found</p>
      </div>
    );
  }

  async function handleDelete() {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setDeleting(true);
    try {
      await apps.deleteApp(appId);
      onDeleted?.();
    } catch {
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      {mode === "page" && (
        <DetailTopBar
          title={record.title}
          onClose={onClose ?? (() => undefined)}
          onCustomize={onCustomize ? () => onCustomize(record) : undefined}
          onShare={onShare ? () => onShare(record) : undefined}
          onDelete={onDeleted ? () => void handleDelete() : undefined}
          renameLabel="Rename app"
          deleteLabel="Delete app"
          onRename={(next) => {
            // Backend rename API isn't available yet — keep the change
            // local so the user sees the title flip immediately. Hook up
            // when the gateway gains `apps.rename`.
            setRecord((r) => (r ? { ...r, title: next } : r));
          }}
          onRefresh={() => setRefreshTick((t) => t + 1)}
        />
      )}

      <TopBar
        actions={
          <>
            <Button
              variant="tertiary"
              size="md"
              icon={Bug}
              onClick={() => setDebugOpen((v) => !v)}
              title="Toggle debug panel"
              className={debugOpen ? "bg-alert-background text-text-alert-primary" : ""}
            >
              Debug
            </Button>
            <IconButton
              icon={RotateCw}
              variant="tertiary"
              size="md"
              title="Refresh"
              onClick={() => setRefreshTick((t) => t + 1)}
            />
            {viewMode === "code" ? (
              <IconButton
                icon={codeCopied ? Check : Copy}
                variant="tertiary"
                size="md"
                title={codeCopied ? "Copied" : "Copy code"}
                onClick={() => {
                  void navigator.clipboard.writeText(record.content).then(() => {
                    setCodeCopied(true);
                    window.setTimeout(() => setCodeCopied(false), 1500);
                  });
                }}
              />
            ) : null}
            {onFullscreen ? (
              <IconButton
                icon={Maximize2}
                variant="tertiary"
                size="md"
                title="Open fullscreen"
                onClick={() => onFullscreen(record)}
              />
            ) : null}
            {onTogglePinned && (
              <Button
                variant={isPinned ? "secondary" : "tertiary"}
                size="md"
                icon={Pin}
                onClick={() => onTogglePinned(appId)}
              >
                {isPinned ? "Pinned" : "Pin"}
              </Button>
            )}
            {onRefine && (
              <Button
                variant="tertiary"
                size="md"
                icon={Sparkles}
                onClick={() => void onRefine(record)}
              >
                Refine
              </Button>
            )}
            {confirmDelete ? (
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
                title="Delete app"
                onClick={handleDelete}
              />
            )}
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
            <TextTile label={record.title} category="apps" />
            <TitleSwitcher
              activeId={appId}
              currentLabel={record.title}
              items={siblings ?? []}
              onSelect={onSwitch ?? (() => {})}
              renameLabel="Rename app"
              deleteLabel="Delete app"
              // Rename has no backend API yet — keep the change local so the
              // user sees the title update immediately. Hook up to a real
              // app-store mutation when the gateway gains `apps.rename`.
              onRename={(next) => {
                setRecord((r) => (r ? { ...r, title: next } : r));
              }}
              onDelete={() => {
                void handleDelete();
              }}
            />
          </>
        ) : null}
        <div className="w-[88px]">
          <SegmentedTabs<"preview" | "code">
            value={viewMode}
            onChange={setViewMode}
            options={[
              { value: "preview", label: "Preview", icon: Eye, iconOnly: true },
              { value: "code", label: "Code", icon: Code2, iconOnly: true },
            ]}
            ariaLabel="View mode"
          />
        </div>
      </TopBar>

      <div className="min-h-0 flex-1 overflow-auto p-ml">
        {debugOpen && (
          <>
            {renderErrors.length > 0 && (
              <div className="mb-4">
                <Callout
                  variant="danger"
                  title="This app has render errors"
                  description={renderErrors[0] ?? "Renderer error"}
                />
              </div>
            )}
            <div className="mb-4">
              <AppDebugPanel
                log={toolLog.log}
                onClear={toolLog.clear}
                onClose={() => setDebugOpen(false)}
              />
            </div>
          </>
        )}

        {viewMode === "preview" ? (
          <Renderer
            library={openuiLibrary}
            response={record.content}
            toolProvider={toolProvider}
            onAction={handleAction}
            onStateUpdate={(state) => {
              stateRef.current = state;
            }}
            onError={(errors) => {
              const messages = errors.map((error) =>
                typeof error === "string"
                  ? error
                  : error instanceof Error
                    ? error.message
                    : JSON.stringify(error),
              );
              setRenderErrors(messages);
              // Surface render errors in the debug log too — the toolProvider
              // instrumentation only catches Query/Mutation failures, not AST
              // or prop validation errors raised by the Renderer itself.
              if (messages.length > 0) {
                const now = Date.now();
                const id = toolLog.record({
                  toolName: "renderer-error",
                  args: { count: messages.length },
                  startedAt: now,
                });
                toolLog.updateStatus(id, {
                  error: messages.join("\n\n"),
                  status: "error",
                  finishedAt: now,
                });
              }
            }}
          />
        ) : (
          <pre className="overflow-auto rounded-2xl bg-inverted-background p-ml text-sm text-background">
            {record.content}
          </pre>
        )}
      </div>
    </div>
  );
}
