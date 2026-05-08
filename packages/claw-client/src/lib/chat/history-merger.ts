/**
 * Merges OpenClaw chat.history messages into UI-ready turns.
 *
 * A single assistant "turn" in OpenClaw history spans multiple messages:
 *   assistant(toolCall) → toolResult → assistant(toolCall) → toolResult → assistant(text)
 * This module collapses them into one message so the UI shows a single bubble
 * with tool calls + final content together.
 *
 * Special cases:
 *   - assistant messages with type:"thinking" content blocks → captured in a
 *     lightweight assistant timeline so replay order matches the live stream.
 */

import type { AssistantTimelineSegment } from "@/lib/chat/timeline";
import type { ChatHistoryMessage } from "@/lib/gateway/types";

export type ToolCallOutput = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export const ERROR_SENTINEL = "<!--AGENT_ERROR-->";
export const GATEWAY_SENTINEL = "<!--GATEWAY-->";
export const COMPACTION_SENTINEL = "<!--COMPACTION-->";

export type MergedMessage =
  | {
      id: string;
      role: "user" | "assistant";
      content: string | null;
      toolCalls?: ToolCallOutput[];
      timeline?: AssistantTimelineSegment[];
    }
  | { id: string; role: "activity"; activityType: string; content: Record<string, unknown> };

function extractText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts = (content as Array<{ type?: string; text?: string }>)
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "");
  return parts.length ? parts.join("") : null;
}

function extractToolCalls(content: unknown): ToolCallOutput[] {
  if (!Array.isArray(content)) return [];
  return (content as Array<{ type?: string; id?: string; name?: string; arguments?: unknown }>)
    .filter((c) => c.type === "toolCall")
    .map((c) => ({
      id: c.id ?? crypto.randomUUID(),
      type: "function" as const,
      function: {
        name: c.name ?? "unknown",
        arguments:
          typeof c.arguments === "string" ? c.arguments : JSON.stringify(c.arguments ?? {}),
      },
    }));
}

function extractThinking(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const parts = (content as Array<{ type?: string; thinking?: string }>)
    .filter((c) => c.type === "thinking")
    .map((c) => c.thinking ?? "");
  return parts.length ? parts.join("") : null;
}

function stringifyContent(content: unknown): string | null {
  if (typeof content === "string") return content;

  const text = extractText(content);
  if (text !== null) return text;

  if (content == null) return null;

  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}

function resolveToolMessageOutput(message: ChatHistoryMessage): string | null {
  const candidate = message as ChatHistoryMessage & {
    result?: unknown;
    output?: unknown;
    payload?: unknown;
    text?: unknown;
    value?: unknown;
  };

  return (
    stringifyContent(candidate.content) ??
    stringifyContent(candidate.result) ??
    stringifyContent(candidate.output) ??
    stringifyContent(candidate.payload) ??
    stringifyContent(candidate.text) ??
    stringifyContent(candidate.value)
  );
}

function hoistTrailingAssistantUpdates(
  message: MergedMessage & { role: "assistant" },
): MergedMessage & { role: "assistant" } {
  const timeline = message.timeline ?? [];
  if (timeline.length === 0) return message;

  let splitIndex = timeline.length;
  while (splitIndex > 0 && timeline[splitIndex - 1]?.type === "assistant_update") {
    splitIndex -= 1;
  }

  if (splitIndex === timeline.length) {
    return message;
  }

  const trailingText = timeline
    .slice(splitIndex)
    .filter(
      (segment): segment is Extract<AssistantTimelineSegment, { type: "assistant_update" }> =>
        segment.type === "assistant_update",
    )
    .map((segment) => segment.text)
    .join("");

  return {
    ...message,
    content: `${message.content ?? ""}${trailingText}` || null,
    timeline: timeline.slice(0, splitIndex),
  };
}

export function mergeHistoryMessages(raw: ChatHistoryMessage[]): MergedMessage[] {
  const output: MergedMessage[] = [];
  let pending: (MergedMessage & { role: "assistant" }) | null = null;

  const flush = () => {
    if (pending) {
      const finalized = hoistTrailingAssistantUpdates(pending);
      if (
        finalized.content !== null ||
        (finalized.toolCalls && finalized.toolCalls.length > 0) ||
        (finalized.timeline && finalized.timeline.length > 0)
      ) {
        output.push(finalized);
      }
      pending = null;
    }
  };

  for (const m of raw) {
    if (m.role === "user") {
      flush();
      output.push({
        id: m.__openclaw?.id ?? m.id ?? crypto.randomUUID(),
        role: "user",
        content: extractText(m.content),
      });
      continue;
    }

    if (m.role === "assistant") {
      // Gateway-injected replies (model:"gateway-injected") are deterministic,
      // self-contained turns produced by command handlers (/status, /help, …).
      // They must not merge with adjacent assistant messages, otherwise two
      // consecutive `/status` runs would fuse into one bubble.
      const isGatewayInjected = (m as unknown as { model?: string }).model === "gateway-injected";
      if (isGatewayInjected) {
        // Run-abort snapshots: the gateway also persists the buffered partial
        // as a `gateway-injected` message tagged `openclawAbort` whenever a
        // run is aborted (chat-transcript-inject.ts:96). The previous
        // assistant message already carries that partial in our merged view,
        // so emitting the snapshot would double-render the same content as a
        // "Gateway"-tagged duplicate. Drop the snapshot and let the existing
        // assistant message stand on its own.
        const isAbortSnapshot = Boolean(
          (m as unknown as { openclawAbort?: { aborted?: boolean } }).openclawAbort?.aborted,
        );
        if (isAbortSnapshot) {
          continue;
        }
        flush();
        const text = extractText(m.content);
        if (text) {
          output.push({
            id: m.__openclaw?.id ?? m.id ?? crypto.randomUUID(),
            role: "assistant",
            content: `${GATEWAY_SENTINEL}${text}`,
          });
        }
        continue;
      }

      const text = extractText(m.content);
      const thinking = extractThinking(m.content);
      const contentTools = extractToolCalls(m.content);
      const legacyTools: ToolCallOutput[] = (m.tool_calls ?? []).map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.function.name, arguments: tc.function.arguments },
      }));
      const allTools = [...contentTools, ...legacyTools];

      if (!text && allTools.length === 0 && m.stopReason === "error" && m.errorMessage) {
        flush();
        pending = {
          id: m.__openclaw?.id ?? m.id ?? crypto.randomUUID(),
          role: "assistant",
          content: `${ERROR_SENTINEL}${m.errorMessage}`,
        };
        continue;
      }

      if (!text && !thinking && allTools.length === 0) {
        continue;
      }

      // Only TOOLS force text into the timeline — they create a
      // need-to-flush boundary because tool I/O is interleaved with text in
      // a multi-message assistant turn. `thinking` doesn't: it always sits in
      // the timeline regardless of where the text lands. Treating thinking as
      // an "interleaver" caused OpenRouter's `[thinking, text]` saved-content
      // shape to push the visible answer into an `assistant_update` row,
      // which `hoistTrailingAssistantUpdates` then couldn't recover (because
      // the trailing segment is `reasoning`, not `assistant_update`).
      const hasInterleavedActivity = allTools.length > 0;

      if (!pending) {
        pending = {
          id: m.__openclaw?.id ?? m.id ?? crypto.randomUUID(),
          role: "assistant",
          content: null,
          ...(allTools.length ? { toolCalls: allTools } : {}),
          timeline: [],
        };
      } else {
        if (allTools.length) {
          pending.toolCalls = [...(pending.toolCalls ?? []), ...allTools];
        }
      }

      if (hasInterleavedActivity) {
        if (pending.content) {
          pending.timeline = [
            ...(pending.timeline ?? []),
            {
              type: "assistant_update",
              text: pending.content,
            },
          ];
          pending.content = null;
        }

        if (text) {
          pending.timeline = [
            ...(pending.timeline ?? []),
            {
              type: "assistant_update",
              text,
            },
          ];
        }
      } else if (text) {
        pending.content = pending.content ? `${pending.content}${text}` : text;
      }

      if (thinking) {
        pending.timeline = [
          ...(pending.timeline ?? []),
          {
            type: "reasoning",
            text: thinking,
          },
        ];
      }

      if (allTools.length > 0) {
        pending.timeline = [
          ...(pending.timeline ?? []),
          ...allTools.map((toolCall) => ({
            type: "tool_call" as const,
            toolCallId: toolCall.id,
            toolName: toolCall.function.name,
            args: toolCall.function.arguments,
          })),
        ];
      }
      continue;
    }

    if (m.role === "tool" || (m.role as string) === "toolResult") {
      if (!pending) continue;

      const toolCallId =
        m.tool_call_id ??
        pending.toolCalls?.[pending.toolCalls.length - 1]?.id ??
        crypto.randomUUID();
      const output = resolveToolMessageOutput(m);
      const fallbackError =
        typeof m.error === "string" && m.error.trim().length > 0
          ? m.error.trim()
          : typeof m.errorMessage === "string" && m.errorMessage.trim().length > 0
            ? m.errorMessage.trim()
            : null;
      const resultText = [output, fallbackError].filter(Boolean).join("\n\n");

      pending.timeline = [
        ...(pending.timeline ?? []),
        {
          type: "tool_result",
          toolCallId,
          output: resultText || "Tool finished without output.",
          ...(fallbackError ? { isError: true } : {}),
        },
      ];
      continue;
    }

    // System messages with `__openclaw.kind === "compaction"` are markers
    // for where the gateway compacted the transcript. Emit them as a thin
    // assistant-shaped message tagged with COMPACTION_SENTINEL so the
    // renderer can show a centered divider instead of a bubble.
    if (m.role === "system" && m.__openclaw?.kind === "compaction") {
      flush();
      output.push({
        id: m.__openclaw?.id ?? m.id ?? crypto.randomUUID(),
        role: "assistant",
        content: `${COMPACTION_SENTINEL}Context compacted`,
      });
      continue;
    }

    // system / other roles — skip (they sit between assistant messages in the same turn)
  }
  flush();
  return output;
}
