"use client";

/**
 * Maps OpenClaw gateway events to AG-UI events that @openuidev/react-headless understands.
 *
 * OpenClaw streams (event:agent payload):
 *   "assistant" → text delta        data: AssistantStreamData
 *   "thinking"  → reasoning tokens  data: ThinkingStreamData   (cap: "thinking-events")
 *   "tool"      → tool call phases  data: ToolStreamData        (cap: "tool-events")
 *
 * AG-UI events emitted (EventType from @ag-ui/core via @openuidev/react-headless):
 *   TEXT_MESSAGE_START / TEXT_MESSAGE_CONTENT / TEXT_MESSAGE_END
 *   TOOL_CALL_START / TOOL_CALL_ARGS / TOOL_CALL_END
 *   RUN_FINISHED / RUN_ERROR
 *
 * Reasoning/tool chronology is serialized into invisible timeline markers inside
 * the assistant content stream so the client can replay one coherent run.
 */

import { ERROR_SENTINEL, GATEWAY_SENTINEL } from "@/lib/chat/history-merger";
import { encodeAssistantTimelineSegment } from "@/lib/chat/timeline";
import type { AgentEvent, ChatEvent } from "@/lib/gateway/types";
import { EventType } from "@openuidev/react-headless";

const DEBUG_STORAGE_KEY = "openclaw-os-debug-events";
const TOOL_RESULT_KNOWN_KEYS = new Set(["phase", "name", "toolCallId", "isError", "durationMs"]);

function resolveToolResultPayload(data: Record<string, unknown>): unknown {
  if (data["result"] !== undefined) return data["result"];

  for (const key of ["output", "content", "text", "value", "payload"]) {
    if (data[key] !== undefined) {
      return data[key];
    }
  }

  const remainingEntries = Object.entries(data).filter(
    ([key, value]) => !TOOL_RESULT_KNOWN_KEYS.has(key) && value !== undefined,
  );
  if (remainingEntries.length === 0) return undefined;

  return Object.fromEntries(remainingEntries);
}

export function createOpenClawAGUIMapper(onEvent: (event: Record<string, unknown>) => void): {
  onAgentEvent: (evt: AgentEvent) => void;
  onChatEvent: (evt: ChatEvent) => void;
} {
  let messageId: string | null = null;
  let emittedTextContent = false;
  // Whether we've streamed visible assistant text into the current run's
  // trailing text run. Used to decide if a v4 `replace` event needs a
  // boundary marker to relegate the superseded draft.
  let assistantTextStreamed = false;
  const activeToolCallIds = new Set<string>();

  const extractTextFromMessageContent = (message: unknown): string => {
    if (!message || typeof message !== "object") return "";
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .map((part) => {
        if (!part || typeof part !== "object") return "";
        const p = part as { type?: unknown; text?: unknown };
        if (p.type === "text" && typeof p.text === "string") return p.text;
        return "";
      })
      .join("");
  };

  const debugEnabled = (): boolean => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem(DEBUG_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  };

  const debugLog = (label: string, payload: Record<string, unknown>) => {
    if (!debugEnabled()) return;
    console.info("[claw:mapper]", label, payload);
  };

  const emitEvent = (event: Record<string, unknown>) => {
    debugLog("emit", event);
    onEvent(event);
  };

  const stringifyToolPayload = (value: unknown): string => {
    if (typeof value === "string") return value;
    if (value === undefined) return "";

    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  };

  const ensureMessageStarted = (runId: string) => {
    if (!messageId) {
      messageId = runId;
      assistantTextStreamed = false;
      emitEvent({ type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" });
    }
  };

  const emitErrorAsMessage = (runId: string, error: string) => {
    ensureMessageStarted(runId);
    emitEvent({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId,
      delta: `${ERROR_SENTINEL}${error}`,
    });
    emitEvent({ type: EventType.TEXT_MESSAGE_END, messageId });
    emitEvent({ type: EventType.RUN_FINISHED });
  };

  return {
    onAgentEvent(evt: AgentEvent) {
      if (evt.stream === "thinking") {
        const delta =
          typeof evt.data.delta === "string"
            ? evt.data.delta
            : typeof evt.data.text === "string"
              ? evt.data.text
              : "";
        if (delta) {
          debugLog("agent:thinking->reasoning", {
            runId: evt.runId,
            seq: evt.seq,
            activeToolCallIds: [...activeToolCallIds],
            delta,
          });
          ensureMessageStarted(evt.runId);
          emitEvent({
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId,
            delta: encodeAssistantTimelineSegment({
              type: "reasoning",
              text: delta,
            }),
          });
        }
        return;
      }

      if (evt.stream === "tool") {
        if (evt.data.phase === "start") {
          ensureMessageStarted(evt.runId);
          const toolCallId =
            typeof evt.data.toolCallId === "string" ? evt.data.toolCallId : crypto.randomUUID();
          const toolName = typeof evt.data.name === "string" ? evt.data.name : "unknown";
          const args = stringifyToolPayload(evt.data.args ?? {});
          activeToolCallIds.add(toolCallId);
          debugLog("agent:tool:start", {
            runId: evt.runId,
            seq: evt.seq,
            toolCallId,
            toolName,
            activeToolCallIds: [...activeToolCallIds],
            args,
          });
          emitEvent({
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId,
            delta: encodeAssistantTimelineSegment({
              type: "tool_call",
              toolCallId,
              toolName,
              ...(args ? { args } : {}),
            }),
          });
          emitEvent({
            type: EventType.TOOL_CALL_START,
            toolCallId,
            toolCallName: toolName,
            parentMessageId: messageId,
          });
          emitEvent({ type: EventType.TOOL_CALL_ARGS, toolCallId, delta: args });
        } else if (evt.data.phase === "result") {
          ensureMessageStarted(evt.runId);
          const toolCallId =
            typeof evt.data.toolCallId === "string" ? evt.data.toolCallId : crypto.randomUUID();
          const resolvedResult = resolveToolResultPayload(evt.data as Record<string, unknown>);
          const output =
            resolvedResult === undefined
              ? evt.data.isError
                ? "Tool failed without output."
                : "Tool finished without output."
              : stringifyToolPayload(resolvedResult);
          debugLog("agent:tool:result", {
            runId: evt.runId,
            seq: evt.seq,
            toolCallId,
            activeToolCallIds: [...activeToolCallIds],
            isError: evt.data.isError,
            durationMs: evt.data.durationMs,
            output,
          });
          emitEvent({
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId,
            delta: encodeAssistantTimelineSegment({
              type: "tool_result",
              toolCallId,
              output,
              ...(evt.data.isError ? { isError: true } : {}),
              ...(typeof evt.data.durationMs === "number"
                ? { durationMs: evt.data.durationMs }
                : {}),
            }),
          });
          emitEvent({ type: EventType.TOOL_CALL_END, toolCallId });
          activeToolCallIds.delete(toolCallId);
        }
        return;
      }

      if (evt.stream === "assistant") {
        // v4 `replace`: the new cumulative text does NOT extend what we've
        // already streamed (a rewrite — e.g. a heartbeat placeholder swapped
        // for the real answer). AG-UI text content is append-only, so we
        // can't mutate the prior text in place. Emit an `assistant_update`
        // boundary marker: `extractAssistantTimeline` keeps only the LAST
        // text run as the visible answer and relegates the superseded text
        // before the marker into a collapsed draft row — the same primitive
        // history-merger uses. Without the marker the old and new text would
        // concatenate ("GotGot it…"-style duplication).
        if (evt.data.replace === true) {
          const replacement =
            typeof evt.data.text === "string" && evt.data.text
              ? evt.data.text
              : typeof evt.data.delta === "string"
                ? evt.data.delta
                : "";
          ensureMessageStarted(evt.runId);
          if (assistantTextStreamed) {
            emitEvent({
              type: EventType.TEXT_MESSAGE_CONTENT,
              messageId,
              delta: encodeAssistantTimelineSegment({ type: "assistant_update", text: "" }),
            });
            assistantTextStreamed = false;
          }
          if (replacement) {
            emittedTextContent = true;
            assistantTextStreamed = true;
            emitEvent({
              type: EventType.TEXT_MESSAGE_CONTENT,
              messageId,
              delta: replacement,
            });
          }
          return;
        }
        // Normal stream: `data.delta` is already incremental — the gateway
        // subtracts cumulative snapshots upstream and emits only the new
        // tokens. Forward straight to the AG-UI consumer; no dedupe needed.
        if (typeof evt.data.delta === "string" && evt.data.delta) {
          ensureMessageStarted(evt.runId);
          emittedTextContent = true;
          assistantTextStreamed = true;
          emitEvent({
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId,
            delta: evt.data.delta,
          });
        }
        return;
      }

      if (evt.stream === "lifecycle") {
        const ld = evt.data as import("@/lib/gateway/types").LifecycleStreamData;
        if (ld.phase === "error") {
          emitErrorAsMessage(evt.runId, ld.error ?? "Agent error");
        }
        return;
      }
    },

    onChatEvent(evt: ChatEvent) {
      // `chat.delta` carries cumulative snapshots of the same text that
      // `agent.assistant` is already streaming incrementally. Listening to
      // both produced the "GotGot it. Let me build…" tail-overlap repeat.
      // Drop chat.delta entirely — agent.assistant is the sole text source.
      if (evt.state === "final" || evt.state === "aborted") {
        debugLog("chat:final", {
          runId: evt.runId,
          seq: evt.seq,
          state: evt.state,
          activeToolCallIds: [...activeToolCallIds],
          stopReason: evt.stopReason,
          usage: evt.usage,
        });
        ensureMessageStarted(evt.runId);
        if (!emittedTextContent) {
          const finalText = extractTextFromMessageContent(evt.message);
          if (finalText) {
            const isGatewayInjected =
              !!evt.message &&
              typeof evt.message === "object" &&
              (evt.message as { model?: unknown }).model === "gateway-injected";
            const delta = isGatewayInjected ? `${GATEWAY_SENTINEL}${finalText}` : finalText;
            emittedTextContent = true;
            emitEvent({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta });
          }
        }
        // Encode authoritative token usage into the message timeline so the
        // ThinkingPanel can display real Anthropic counts instead of a
        // char/4 estimate. Skipped on `aborted` runs where usage is absent.
        if (evt.usage) {
          emitEvent({
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId,
            delta: encodeAssistantTimelineSegment({
              type: "usage",
              inputTokens: evt.usage.input ?? 0,
              outputTokens: evt.usage.output ?? 0,
              ...(typeof evt.usage.cacheRead === "number"
                ? { cacheReadTokens: evt.usage.cacheRead }
                : {}),
              ...(typeof evt.usage.cacheWrite === "number"
                ? { cacheWriteTokens: evt.usage.cacheWrite }
                : {}),
              ...(typeof evt.usage.total === "number" ? { totalTokens: evt.usage.total } : {}),
            }),
          });
        }
        emitEvent({ type: EventType.TEXT_MESSAGE_END, messageId });
        emitEvent({ type: EventType.RUN_FINISHED });
        activeToolCallIds.clear();
      } else if (evt.state === "error") {
        debugLog("chat:error", {
          runId: evt.runId,
          seq: evt.seq,
          activeToolCallIds: [...activeToolCallIds],
          errorMessage: evt.errorMessage ?? "Agent error",
        });
        emitErrorAsMessage(evt.runId, evt.errorMessage ?? "Agent error");
        activeToolCallIds.clear();
      }
    },
  };
}
