"use client";

import { COMPACTION_SENTINEL, ERROR_SENTINEL, GATEWAY_SENTINEL } from "@/lib/chat/history-merger";
import { extractAssistantTimeline } from "@/lib/chat/timeline";
import { separateContentAndContext, wrapContext } from "@/lib/content-parser";
import { parseInlineResponse } from "@/lib/detection";
import { buildContinueConversationPayload, handleOpenUrlAction } from "@/lib/renderer-actions";
import type { AssistantMessage as AssistantMsg } from "@openuidev/react-headless";
import { useThread } from "@openuidev/react-headless";
import type { ActionEvent } from "@openuidev/react-lang";
import { Renderer } from "@openuidev/react-lang";
import { Callout, Shell } from "@openuidev/react-ui";
import { openuiChatLibrary } from "@openuidev/react-ui/genui-lib";
import { ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, Loader2, X } from "lucide-react";
import { useCallback, useId, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

interface Props {
  message: AssistantMsg;
}

type ResolvedToolTrace = {
  id: string;
  name: string;
  request: string | null;
  output: string | null;
  isError: boolean;
  durationMs: number | null;
};

type ResolvedTimelineItem =
  | {
      kind: "assistant_update";
      key: string;
      text: string;
    }
  | {
      kind: "reasoning";
      key: string;
      text: string;
    }
  | {
      kind: "tool";
      key: string;
      traceId: string;
    };

function prettyPayload(value: string | null): string | null {
  if (!value) return null;

  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

// Shared prose styling for any markdown rendered inside an assistant
// surface — bubble *and* timeline trace. Keeping the base in one place so
// future tweaks (font sizes, code/link colors) propagate uniformly.
const BASE_MARKDOWN_CLASSES =
  "prose prose-sm max-w-none dark:prose-invert prose-p:leading-relaxed prose-p:text-md prose-headings:font-semibold prose-headings:tracking-tight prose-li:text-md prose-strong:font-semibold prose-pre:bg-sunk-light prose-pre:border prose-pre:border-border-default/30 prose-pre:rounded-lg prose-pre:text-sm prose-pre:text-text-neutral-primary prose-code:text-sm prose-code:text-text-neutral-primary prose-code:before:content-none prose-code:after:content-none prose-a:text-text-accent-primary prose-a:underline-offset-2";

const ASSISTANT_MARKDOWN_CLASSES = `${BASE_MARKDOWN_CLASSES} prose-h1:text-lg prose-h2:text-lg prose-h3:text-md prose-table:text-sm`;

// Trace blocks live in narrower, denser rows — kill paragraph margins and
// tighten heading spacing so reasoning/tool detail panels don't bloat.
const TRACE_MARKDOWN_CLASSES = `${BASE_MARKDOWN_CLASSES} prose-p:my-0 prose-headings:mb-2 prose-headings:mt-0`;

// ── New compact "Behind the scenes" timeline ─────────────────────────────────
//
// Structure:
//   <ThinkingPanel>                  → "Worked for Xs" header + light-gray body
//     <TimelineRow status category summary>  ← each step (reasoning / tool)
//       body (reasoning text | tool input/output tabs)
//     </TimelineRow>
//   </ThinkingPanel>

type TimelineStatus = "success" | "error" | "neutral" | "pending";

// 16×16 white/background icon tile for the row leading glyph — the icon
// inside is what carries the status color. A visually-hidden label is
// included so the status is conveyed without relying on color alone.
const STATUS_LABEL: Record<TimelineStatus, string> = {
  success: "Succeeded",
  error: "Failed",
  pending: "In progress",
  neutral: "Step",
};

function StatusGlyph({ status }: { status: TimelineStatus }) {
  const base =
    "flex h-4 w-4 shrink-0 items-center justify-center rounded-[5px] border border-border-default/60 bg-background";
  const srLabel = <span className="sr-only">{STATUS_LABEL[status]}.</span>;
  if (status === "success") {
    return (
      <span className={base} role="img" aria-label={STATUS_LABEL[status]}>
        {srLabel}
        <Check size={10} strokeWidth={3} className="text-status-online" aria-hidden="true" />
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className={base} role="img" aria-label={STATUS_LABEL[status]}>
        {srLabel}
        <X size={10} strokeWidth={3} className="text-status-error" aria-hidden="true" />
      </span>
    );
  }
  if (status === "pending") {
    return (
      <span className={base} role="img" aria-label={STATUS_LABEL[status]}>
        {srLabel}
        <span
          aria-hidden="true"
          className="h-[3px] w-[3px] animate-pulse rounded-full bg-text-accent-primary"
        />
      </span>
    );
  }
  // neutral = reasoning → white tile + solid purple dot
  return (
    <span className={base} role="img" aria-label={STATUS_LABEL[status]}>
      {srLabel}
      <span aria-hidden="true" className="h-[3px] w-[3px] rounded-full bg-cat-context" />
    </span>
  );
}

function TimelineMeta({
  category,
  time,
  upTokens,
  downTokens,
}: {
  category: string;
  time?: string | null;
  upTokens?: number;
  downTokens?: number;
}) {
  const parts: ReactNode[] = [<span key="cat">{category}</span>];
  if (time) parts.push(<span key="time">{time}</span>);
  if (upTokens && upTokens > 0) {
    parts.push(
      <span
        key="up"
        className="inline-flex items-center gap-[2px]"
        aria-label={`${upTokens.toLocaleString()} output tokens`}
      >
        <ArrowUp size={10} strokeWidth={2.25} aria-hidden="true" />
        {upTokens.toLocaleString()}
      </span>,
    );
  }
  if (downTokens && downTokens > 0) {
    parts.push(
      <span
        key="down"
        className="inline-flex items-center gap-[2px]"
        aria-label={`${downTokens.toLocaleString()} input tokens`}
      >
        <ArrowDown size={10} strokeWidth={2.25} aria-hidden="true" />
        {downTokens.toLocaleString()}
      </span>,
    );
  }
  return (
    <span className="flex shrink-0 items-center gap-xs font-label text-sm text-text-neutral-tertiary/60">
      {parts.map((p, i) => (
        <span key={i} className="flex items-center gap-xs">
          {i > 0 ? (
            <span
              aria-hidden="true"
              className="inline-block h-[3px] w-[3px] shrink-0 rounded-full bg-text-neutral-tertiary/50"
            />
          ) : null}
          {p}
        </span>
      ))}
    </span>
  );
}

function TimelineRow({
  status,
  category,
  summary,
  time,
  upTokens,
  downTokens,
  children,
  defaultOpen = false,
}: {
  status: TimelineStatus;
  category: string;
  summary: ReactNode;
  time?: string | null;
  upTokens?: number;
  downTokens?: number;
  children?: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={panelId}
        className={`group flex w-full items-center gap-s rounded-m px-xs py-2xs text-left transition-colors hover:bg-sunk dark:hover:bg-elevated-light ${
          open ? "bg-sunk/40 dark:bg-elevated-light/40" : ""
        }`}
      >
        <StatusGlyph status={status} />
        <span className="min-w-0 flex-1 truncate font-body text-sm text-text-neutral-primary">
          {summary}
        </span>
        <TimelineMeta category={category} time={time} upTokens={upTokens} downTokens={downTokens} />
        <ChevronRight
          size={12}
          aria-hidden="true"
          className={`shrink-0 text-text-neutral-tertiary transition-[opacity,transform] duration-150 ${
            open ? "rotate-90 opacity-100" : "opacity-0 group-hover:opacity-100"
          }`}
        />
      </button>
      <div
        id={panelId}
        role="region"
        aria-label={`${category} details`}
        hidden={!open}
        className="overflow-hidden transition-[max-height,opacity] duration-300 ease-out"
        style={{ maxHeight: open ? 2000 : 0, opacity: open ? 1 : 0 }}
      >
        {/* Indent expanded body to align with the category text (tile 16px + gap 8px). */}
        <div className="ml-[24px] mt-2xs rounded-m border border-border-default/25 bg-background px-s py-s dark:border-border-default/16 dark:bg-foreground">
          {children}
        </div>
      </div>
    </div>
  );
}

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`-mb-px border-b-2 px-2xs pb-xs font-label text-sm transition-colors ${
        active
          ? "border-text-neutral-primary text-text-neutral-primary font-medium"
          : "border-transparent text-text-neutral-tertiary hover:text-text-neutral-secondary"
      }`}
    >
      {children}
    </button>
  );
}

function ToolCallDetail({
  input,
  output,
  isError,
  isPending,
}: {
  input: string | null;
  output: string | null;
  isError: boolean;
  isPending: boolean;
}) {
  const [tab, setTab] = useState<"input" | "output">("input");
  const formatted = useMemo(() => {
    const source = tab === "input" ? input : output;
    if (!source) return isPending && tab === "output" ? "Waiting for tool output…" : "—";
    return prettyPayload(source) ?? source;
  }, [tab, input, output, isPending]);

  return (
    <div>
      <div className="mb-xs flex gap-ml border-b border-border-default/40">
        <TabBtn active={tab === "input"} onClick={() => setTab("input")}>
          Input
        </TabBtn>
        <TabBtn active={tab === "output"} onClick={() => setTab("output")}>
          Output
          {isError ? <span className="ml-2xs text-text-danger-primary">· error</span> : null}
        </TabBtn>
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-m bg-background px-s py-xs font-code text-sm leading-body text-text-neutral-secondary">
        {formatted}
      </pre>
    </div>
  );
}

function ReasoningDetail({ content }: { content: string }) {
  return (
    <p className="whitespace-pre-wrap font-body text-sm leading-body text-text-neutral-secondary">
      {content}
    </p>
  );
}

function ThinkingPanel({
  totalDurationMs,
  toolCallCount,
  inputTokens,
  outputTokens,
  isStreaming,
  children,
}: {
  totalDurationMs: number;
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
  isStreaming: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(isStreaming);
  const panelId = useId();
  const seconds = totalDurationMs > 0 ? (totalDurationMs / 1000).toFixed(1) : null;

  const parts: ReactNode[] = [];
  if (isStreaming) {
    parts.push("Working…");
  } else {
    if (seconds) parts.push(`Worked for ${seconds}s`);
    if (toolCallCount > 0) {
      parts.push(`${toolCallCount} tool call${toolCallCount === 1 ? "" : "s"}`);
    }
    if (inputTokens > 0) {
      parts.push(
        <span
          className="inline-flex items-center gap-[2px]"
          aria-label={`${inputTokens.toLocaleString()} input tokens`}
        >
          <ArrowDown size={11} strokeWidth={2.25} aria-hidden="true" />
          {inputTokens.toLocaleString()}
        </span>,
      );
    }
    if (outputTokens > 0) {
      parts.push(
        <span
          className="inline-flex items-center gap-[2px]"
          aria-label={`${outputTokens.toLocaleString()} output tokens`}
        >
          <ArrowUp size={11} strokeWidth={2.25} aria-hidden="true" />
          {outputTokens.toLocaleString()}
        </span>,
      );
    }
  }
  if (parts.length === 0) parts.push("Work trace");

  return (
    <div className="w-full max-w-3xl">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={panelId}
        className="group flex items-center gap-s rounded-m px-2xs py-2xs font-label text-sm text-text-neutral-tertiary/70 transition-colors hover:bg-sunk/50 hover:text-text-neutral-tertiary dark:hover:bg-elevated-light/50"
      >
        <span
          aria-hidden="true"
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded-[5px] border border-border-default/60 bg-background"
        >
          {isStreaming ? (
            <Loader2 size={10} className="animate-spin text-text-accent-primary" />
          ) : (
            <ChevronDown
              size={10}
              className={`transition-transform duration-200 ${open ? "rotate-0" : "-rotate-90"}`}
            />
          )}
        </span>
        <span className="flex items-center gap-xs">
          {parts.map((p, i) => (
            <span key={i} className="flex items-center gap-xs">
              {i > 0 ? (
                <span
                  aria-hidden="true"
                  className="inline-block h-[3px] w-[3px] shrink-0 rounded-full bg-text-neutral-tertiary/50"
                />
              ) : null}
              <span>{p}</span>
            </span>
          ))}
        </span>
      </button>
      <div
        id={panelId}
        role="region"
        aria-label="Work trace"
        hidden={!open}
        className="overflow-hidden transition-[max-height,opacity] duration-300 ease-out"
        style={{ maxHeight: open ? 10000 : 0, opacity: open ? 1 : 0 }}
      >
        <div className="mt-xs space-y-xs rounded-4xl bg-foreground p-m dark:bg-sunk-deep">
          {children}
        </div>
      </div>
    </div>
  );
}

/** First sentence (or first ~100 chars) of a reasoning block for the row summary. */
function oneLineSummary(text: string, max = 100): string {
  if (!text) return "";
  const firstSentence = text.split(/[.\n]/, 1)[0]?.trim() ?? "";
  const base = firstSentence || text.trim();
  return base.length > max ? `${base.slice(0, max - 1)}…` : base;
}

function CompactionDivider({ label }: { label: string }) {
  return (
    <Shell.AssistantMessageContainer>
      <div
        role="separator"
        aria-label={label}
        className="my-s flex w-full max-w-3xl items-center gap-s"
      >
        <span className="h-px flex-1 bg-border-default/50" />
        <span className="font-label text-xs uppercase tracking-wide text-text-neutral-tertiary">
          {label}
        </span>
        <span className="h-px flex-1 bg-border-default/50" />
      </div>
    </Shell.AssistantMessageContainer>
  );
}

export function AssistantMessage({ message }: Props) {
  // Compaction markers are emitted by `history-merger` as assistant messages
  // tagged with COMPACTION_SENTINEL. Hand them off to a separate component
  // so this one doesn't conditionally call hooks.
  if (typeof message.content === "string" && message.content.startsWith(COMPACTION_SENTINEL)) {
    return (
      <CompactionDivider
        label={message.content.slice(COMPACTION_SENTINEL.length) || "Context compacted"}
      />
    );
  }

  const messages = useThread((s) => s.messages);
  const isRunning = useThread((s) => s.isRunning);
  const processMessage = useThread((s) => s.processMessage);
  const updateMessage = useThread((s) => s.updateMessage);

  // Latch: a message can only be "streaming" during the run that originally
  // produced it. After RUN_FINISHED, ChatApp reloads history which remounts
  // this component under the canonical message id — so we initialize the
  // latch from `isRunning` at mount: if no run is active when we mount, this
  // is a historical message and its spinner must stay off forever, regardless
  // of any future `isRunning` flips.
  const wasStreamingRef = useRef(false);
  const hasEndedRef = useRef(!isRunning);

  const rawIsStreaming = useMemo(() => {
    if (!isRunning) return false;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "assistant") {
        return messages[i]?.id === message.id;
      }
    }
    return false;
  }, [isRunning, messages, message.id]);

  if (rawIsStreaming) {
    wasStreamingRef.current = true;
  } else if (wasStreamingRef.current) {
    hasEndedRef.current = true;
  }

  const isStreaming = rawIsStreaming && !hasEndedRef.current;

  // Parse <context> suffix out of content; remaining is the response body.
  const { content: responseBody, contextString } = useMemo(() => {
    if (!message.content) return { content: null, contextString: null };
    return separateContentAndContext(message.content);
  }, [message.content]);

  const initialState = useMemo(() => {
    if (!contextString) return undefined;
    try {
      const parsed = JSON.parse(contextString);
      if (Array.isArray(parsed)) {
        for (let i = parsed.length - 1; i >= 0; i -= 1) {
          const candidate = parsed[i];
          if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
            return candidate;
          }
        }
      }
      if (typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
      return undefined;
    } catch {
      return undefined;
    }
  }, [contextString]);

  const toolCalls = message.toolCalls ?? [];
  const toolCallById = useMemo(
    () => new Map(toolCalls.map((toolCall) => [toolCall.id, toolCall])),
    [toolCalls],
  );

  const handleStateUpdate = useCallback(
    (state: Record<string, unknown>) => {
      const code = responseBody ?? "";
      const fullMessage = code + "\n" + wrapContext(JSON.stringify([state]));
      updateMessage({ ...message, content: fullMessage });
    },
    [updateMessage, message, responseBody],
  );

  const handleAction = useCallback(
    (event: ActionEvent) => {
      if (handleOpenUrlAction(event)) return;

      const payload = buildContinueConversationPayload(event, initialState);
      if (payload) processMessage(payload);
    },
    [initialState, processMessage],
  );

  const rawContent = responseBody ?? message.content ?? "";
  const { visibleText, interleavedParts } = useMemo(
    () => extractAssistantTimeline(rawContent),
    [rawContent],
  );

  const { timelineItems, toolTraceMap, runUsage } = useMemo(() => {
    const traceMap = new Map<string, ResolvedToolTrace>();
    const items: ResolvedTimelineItem[] = [];
    const orderedToolIds = new Set<string>();
    let usage: { inputTokens: number; outputTokens: number } | null = null;

    const ensureTrace = (toolCallId: string): ResolvedToolTrace => {
      const existing = traceMap.get(toolCallId);
      if (existing) return existing;

      const fallbackToolCall = toolCallById.get(toolCallId);
      const trace: ResolvedToolTrace = {
        id: toolCallId,
        name: fallbackToolCall?.function.name ?? "Tool",
        request: fallbackToolCall?.function.arguments ?? null,
        output: null,
        isError: false,
        durationMs: null,
      };
      traceMap.set(toolCallId, trace);
      return trace;
    };

    interleavedParts.forEach((part, index) => {
      if (part.kind === "text") {
        if (part.text.trim()) {
          items.push({
            kind: "assistant_update",
            key: `assistant-update-${index}`,
            text: part.text,
          });
        }
        return;
      }

      const segment = part.segment;
      if (segment.type === "assistant_update") {
        if (segment.text.trim()) {
          items.push({
            kind: "assistant_update",
            key: `assistant-update-segment-${index}`,
            text: segment.text,
          });
        }
        return;
      }

      if (segment.type === "reasoning") {
        if (segment.text.trim()) {
          items.push({
            kind: "reasoning",
            key: `reasoning-${index}`,
            text: segment.text,
          });
        }
        return;
      }

      if (segment.type === "usage") {
        usage = {
          inputTokens: segment.inputTokens,
          outputTokens: segment.outputTokens,
        };
        return;
      }

      if (segment.type === "tool_call") {
        const trace = ensureTrace(segment.toolCallId);
        if (segment.toolName) trace.name = segment.toolName;
        if (segment.args) trace.request = segment.args;
      } else {
        const trace = ensureTrace(segment.toolCallId);
        trace.output = segment.output;
        trace.isError = segment.isError ?? false;
        trace.durationMs = segment.durationMs ?? trace.durationMs;
      }

      if (!orderedToolIds.has(segment.toolCallId)) {
        orderedToolIds.add(segment.toolCallId);
        items.push({
          kind: "tool",
          key: `tool-${segment.toolCallId}`,
          traceId: segment.toolCallId,
        });
      }
    });

    toolCalls.forEach((toolCall) => {
      if (orderedToolIds.has(toolCall.id)) {
        const existingTrace = traceMap.get(toolCall.id);
        if (existingTrace) {
          if (!existingTrace.request) existingTrace.request = toolCall.function.arguments;
          if (existingTrace.name === "Tool") existingTrace.name = toolCall.function.name;
        }
        return;
      }

      const trace = ensureTrace(toolCall.id);
      if (!trace.request) trace.request = toolCall.function.arguments;
      if (!trace.name) trace.name = toolCall.function.name;
      orderedToolIds.add(toolCall.id);
      items.push({
        kind: "tool",
        key: `tool-fallback-${toolCall.id}`,
        traceId: toolCall.id,
      });
    });

    if (!isStreaming) {
      traceMap.forEach((trace) => {
        if (!trace.output) {
          trace.output = "Tool finished without output.";
        }
      });
    }

    return {
      timelineItems: items,
      toolTraceMap: traceMap,
      runUsage: usage,
    };
  }, [interleavedParts, isStreaming, toolCallById, toolCalls]);

  const errorIdx = visibleText.indexOf(ERROR_SENTINEL);
  const isError = errorIdx !== -1;
  const textContent = isError ? visibleText.slice(0, errorIdx) : visibleText;
  const isGatewayInjected = textContent.startsWith(GATEWAY_SENTINEL);
  const finalAssistantText = isGatewayInjected
    ? textContent.slice(GATEWAY_SENTINEL.length)
    : textContent;
  const errorMessage = isError ? visibleText.slice(errorIdx + ERROR_SENTINEL.length) : null;

  const { segments } = useMemo(() => parseInlineResponse(finalAssistantText), [finalAssistantText]);

  const renderedSegments = segments.map((segment, i) =>
    segment.type === "openui" ? (
      <Renderer
        key={`openui-${i}`}
        library={openuiChatLibrary}
        response={segment.content}
        isStreaming={isStreaming}
        onAction={handleAction}
        onStateUpdate={handleStateUpdate}
        initialState={initialState}
        onError={(errors) => {
          // Inline assistant UI doesn't have an AppDetail-style debug panel,
          // so surface render errors via console.warn (visible in DevTools)
          // rather than a silent console.log. AppDetail.tsx mirrors these
          // into its tool log, but here we'd just bloat every chat with a
          // Callout for user-invisible parser glitches.
          if (errors.length > 0) {
            console.warn("[claw:assistant-render]", { messageId: message.id, errors });
          }
        }}
      />
    ) : isGatewayInjected ? (
      <div
        key={`text-${i}`}
        className="openclaw-os-assistant-markdown mr-auto w-full max-w-3xl border-l-2 border-border-default/40 bg-transparent pl-m"
      >
        {i === 0 ? (
          <div className="mb-xs inline-flex items-center gap-xs rounded-full bg-text-neutral-tertiary/10 px-s py-[2px] font-body text-xs text-text-neutral-tertiary">
            Gateway
          </div>
        ) : null}
        <div className={ASSISTANT_MARKDOWN_CLASSES}>
          <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{segment.content}</ReactMarkdown>
        </div>
      </div>
    ) : (
      <div
        key={`text-${i}`}
        className="openclaw-os-assistant-markdown mr-auto w-full max-w-3xl rounded-4xl border border-border-default/40 bg-background px-ml py-m shadow-sm dark:border-border-default/20 dark:bg-sunk-deep"
      >
        <div className={ASSISTANT_MARKDOWN_CLASSES}>
          <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{segment.content}</ReactMarkdown>
        </div>
      </div>
    ),
  );

  return (
    <Shell.AssistantMessageContainer>
      {timelineItems.length > 0 ? (
        <ThinkingPanel
          isStreaming={isStreaming}
          totalDurationMs={Array.from(toolTraceMap.values()).reduce(
            (sum, t) => sum + (t.durationMs ?? 0),
            0,
          )}
          toolCallCount={toolTraceMap.size}
          {...(() => {
            // Prefer authoritative counts from the gateway's chat:final usage
            // (encoded as a `usage` timeline segment). Fallback to a char/4
            // estimate for in-progress runs and historical messages where
            // the segment isn't present (e.g. older runs, history reload
            // paths that strip non-visible markers).
            if (runUsage) return runUsage;
            let inChars = 0;
            let outChars = (message.content ?? "").length;
            toolTraceMap.forEach((t) => {
              outChars += (t.request ?? "").length;
              inChars += (t.output ?? "").length;
            });
            return {
              inputTokens: Math.round(inChars / 4),
              outputTokens: Math.round(outChars / 4),
            };
          })()}
        >
          {timelineItems.map((item, index, items) => {
            const isLast = index === items.length - 1;

            if (item.kind === "assistant_update") {
              return (
                <TimelineRow
                  key={item.key}
                  status="neutral"
                  category="Message"
                  summary={oneLineSummary(item.text)}
                >
                  <div className={TRACE_MARKDOWN_CLASSES}>
                    <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
                      {item.text}
                    </ReactMarkdown>
                  </div>
                </TimelineRow>
              );
            }

            if (item.kind === "reasoning") {
              return (
                <TimelineRow
                  key={item.key}
                  status={isStreaming && isLast ? "pending" : "neutral"}
                  category="Reasoning"
                  summary={oneLineSummary(item.text)}
                  defaultOpen={isStreaming && isLast}
                >
                  <ReasoningDetail content={item.text} />
                </TimelineRow>
              );
            }

            const trace = toolTraceMap.get(item.traceId);
            if (!trace) return null;
            const isPending = isStreaming && !trace.output;
            const status: TimelineStatus = isPending
              ? "pending"
              : trace.isError
                ? "error"
                : "success";

            return (
              <TimelineRow
                key={item.key}
                status={status}
                category="Tool call"
                summary={isPending ? `${trace.name} · running…` : trace.name}
              >
                <ToolCallDetail
                  input={trace.request}
                  output={trace.output}
                  isError={trace.isError}
                  isPending={isPending}
                />
              </TimelineRow>
            );
          })}
        </ThinkingPanel>
      ) : null}

      {renderedSegments}

      {errorMessage && (
        <Callout variant="danger" title="Something went wrong" description={errorMessage} />
      )}
    </Shell.AssistantMessageContainer>
  );
}
