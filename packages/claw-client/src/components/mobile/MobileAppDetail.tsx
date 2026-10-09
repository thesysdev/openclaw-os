"use client";

import type { ActionEvent } from "@openuidev/react-lang";
import { Renderer } from "@openuidev/react-lang";
import { Callout } from "@openuidev/react-ui";
import { openuiLibrary } from "@openuidev/react-ui/genui-lib";
import { Code2, Eye, Layers, MoreVertical, Sparkles, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { AppContinueConversationHandler } from "@/components/apps/AppDetail";
import type { TitleSwitcherItem } from "@/components/chat/TitleSwitcher";
import { HeaderIconButton } from "@/components/layout/HeaderIconButton";
import { MobileButton } from "@/components/mobile/MobileButton";
import { MobileDetailHeader } from "@/components/mobile/MobileDetailHeader";
import { MobileMenuDrawer } from "@/components/mobile/MobileMenuDrawer";
import { MobileSwitcherSheet } from "@/components/mobile/MobileSwitcherSheet";
import { SegmentedTabs } from "@/components/ui/SegmentedTabs";
import type { AppRecord, AppStore } from "@/lib/engines/types";
import { buildContinueConversationPayload, handleOpenUrlAction } from "@/lib/renderer-actions";

type ViewMode = "preview" | "code";

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
          /* fall through */
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
  onRefine?: (record: AppRecord) => void | Promise<void>;
  onContinueConversation?: AppContinueConversationHandler;
  onClose: () => void;
  /** Peer apps for the title switcher. */
  siblings?: TitleSwitcherItem[];
  onSwitch?: (appId: string) => void;
}

export function MobileAppDetail({
  appId,
  apps,
  updatedAt,
  onDeleted,
  onRefine,
  onContinueConversation,
  onClose,
  siblings,
  onSwitch,
}: Props) {
  const [record, setRecord] = useState<AppRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("preview");
  const [renderErrors, setRenderErrors] = useState<string[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [switchOpen, setSwitchOpen] = useState(false);
  const hasSiblings = (siblings?.length ?? 0) > 1 && Boolean(onSwitch);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setNotFound(false);
    setRecord(null);
    setRenderErrors([]);
    apps
      .getApp(appId)
      .then((r) => {
        if (cancelled) return;
        if (!r) setNotFound(true);
        else setRecord(r);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      // A newer app selection or update owns the preview now.
      cancelled = true;
    };
  }, [appId, apps, updatedAt]);

  const handleAction = useCallback(
    (event: ActionEvent) => {
      if (handleOpenUrlAction(event)) return;
      const payload = buildContinueConversationPayload(event);
      if (payload && onContinueConversation && record) {
        onContinueConversation({ message: payload, appRecord: record });
      }
    },
    [onContinueConversation, record],
  );

  const toolProvider = useMemo(() => {
    const invokeScopedTool = async (
      toolName: string,
      args: Record<string, unknown>,
    ): Promise<unknown> => {
      const result = await apps.invokeTool(toolName, args, record?.sessionKey);
      return normalizeToolResult(result);
    };
    return {
      exec: async (args: Record<string, unknown>) => invokeScopedTool("exec", args),
      read: async (args: Record<string, unknown>) => invokeScopedTool("read", args),
      db_query: async (args: Record<string, unknown>) => invokeScopedTool("db_query", args),
      db_execute: async (args: Record<string, unknown>) => invokeScopedTool("db_execute", args),
    };
  }, [apps, record?.sessionKey]);

  const handleDelete = async () => {
    try {
      await apps.deleteApp(appId);
      onDeleted?.();
      onClose();
    } catch {
      /* swallow — caller may surface error */
    }
  };

  if (loading) {
    return (
      <div className="flex h-full flex-1 items-center justify-center bg-background">
        <p className="text-sm text-text-neutral-tertiary">Loading app…</p>
      </div>
    );
  }
  if (notFound || !record) {
    return (
      <div className="flex h-full flex-1 flex-col bg-background">
        <MobileDetailHeader onBack={onClose} title={{ label: "Not found" }} />
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-text-neutral-secondary">App not found</p>
        </div>
      </div>
    );
  }

  return (
    <div className="claw-fade-in flex h-full flex-1 flex-col bg-background">
      <MobileDetailHeader
        onBack={onClose}
        title={{
          label: record.title,
          onTap: hasSiblings ? () => setSwitchOpen(true) : undefined,
        }}
        actions={
          <>
            {onRefine ? (
              <MobileButton variant="secondary" onClick={() => void onRefine(record)}>
                <Sparkles size={14} />
                Refine
              </MobileButton>
            ) : null}
            <HeaderIconButton onClick={() => setMenuOpen(true)} label="Open menu">
              <MoreVertical size={18} />
            </HeaderIconButton>
          </>
        }
      />

      {hasSiblings && onSwitch ? (
        <MobileSwitcherSheet
          open={switchOpen}
          onClose={() => setSwitchOpen(false)}
          title="Switch app"
          activeId={appId}
          options={(siblings ?? []).map((s) => ({
            id: s.id,
            label: s.label,
            description: s.trailingText,
          }))}
          onSelect={(id) => onSwitch(id)}
        />
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto p-ml">
        {renderErrors.length > 0 && (
          <div className="mb-4">
            <Callout
              variant="danger"
              title="This app has render errors"
              description={renderErrors[0] ?? "Renderer error"}
            />
          </div>
        )}
        {viewMode === "preview" ? (
          <Renderer
            library={openuiLibrary}
            response={record.content}
            toolProvider={toolProvider}
            onAction={handleAction}
            onError={(errors) => {
              setRenderErrors(
                errors.map((error) =>
                  typeof error === "string"
                    ? error
                    : error instanceof Error
                      ? error.message
                      : JSON.stringify(error),
                ),
              );
            }}
          />
        ) : (
          <pre className="overflow-auto rounded-2xl bg-inverted-background p-ml text-sm text-background">
            {record.content}
          </pre>
        )}
      </div>

      <MobileMenuDrawer
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        title={record.title}
        header={
          <div className="flex items-center justify-between gap-m">
            <div className="flex items-center gap-m">
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border-default/70 bg-background text-text-neutral-tertiary shadow-sm dark:border-border-default/16 dark:bg-elevated-light">
                <Layers size={14} />
              </div>
              <span className="text-sm font-medium text-text-neutral-secondary">Mode</span>
            </div>
            <div className="w-[88px] shrink-0">
              <SegmentedTabs<ViewMode>
                value={viewMode}
                onChange={setViewMode}
                options={[
                  { value: "preview", label: "Preview", icon: Eye, iconOnly: true },
                  { value: "code", label: "Code", icon: Code2, iconOnly: true },
                ]}
                ariaLabel="View mode"
              />
            </div>
          </div>
        }
        items={[
          {
            key: "delete",
            label: "Delete app",
            icon: Trash2,
            destructive: true,
            onSelect: () => void handleDelete(),
          },
        ]}
      />
    </div>
  );
}
