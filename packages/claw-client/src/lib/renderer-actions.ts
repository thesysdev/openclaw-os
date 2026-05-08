"use client";

import { wrapContext } from "@/lib/content-parser";
import { BuiltinActionType, type ActionEvent } from "@openuidev/react-lang";

/**
 * Shared handlers for `Renderer.onAction` events. Both the inline assistant-
 * message renderer and the standalone `AppDetail` renderer want identical
 * behavior for built-in action types; this module keeps them in sync.
 *
 * Only two AG-UI built-in action types reach `onAction`:
 *   - `BuiltinActionType.OpenUrl`              → `window.open`
 *   - `BuiltinActionType.ContinueConversation` → post a user message to chat
 * `@Run` / `@Set` / `@Reset` are resolved inside the Renderer and never
 * surface here.
 */

/**
 * Open the URL from an `OpenUrl` action in a new tab.
 * Returns `true` when the event was handled, `false` otherwise so callers can
 * fall through to other handlers.
 */
export function handleOpenUrlAction(event: ActionEvent): boolean {
  if (event.type !== BuiltinActionType.OpenUrl) return false;
  const url = event.params?.["url"] as string | undefined;
  if (typeof window !== "undefined" && url) {
    // `window.open(..., "noopener")` returns null on success per spec — the new
    // browsing context is intentionally hidden from the opener. Treating that
    // null as "popup blocked" and falling back to a synthetic anchor click
    // opens a second tab on every navigation. Trust window.open instead; the
    // call happens in the same user-gesture window, so popup blockers will
    // honor it.
    window.open(url, "_blank", "noopener,noreferrer");
  }
  return true;
}

/**
 * Build the chat-message payload for a `ContinueConversation` action.
 *
 * The renderer emits a `humanFriendlyMessage` plus an optional `formState`.
 * We wrap both into the same `<content>` / `<context>` envelope that the
 * rest of the chat pipeline expects, so continuations from apps look
 * indistinguishable from continuations triggered by inline chat UI.
 *
 * Pass `fallbackFormState` when the caller has a context-derived default
 * (e.g. an assistant message's `initialState`) to fall back to when the
 * action itself didn't carry `formState` — apps don't have that concept
 * and should omit it.
 */
export interface AppActionContext {
  appId: string;
  appTitle: string;
  currentState?: Record<string, unknown>;
}

// Strip reactive state whose name suggests sensitive material before it flows
// into the user-visible context prefix. Errs on the side of caution — fields
// matching common secret/credential names are replaced with a marker rather
// than their values.
const SECRET_KEY_PATTERN = /password|token|secret|apikey|api_key|auth/i;
function redactState(state: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state)) {
    if (SECRET_KEY_PATTERN.test(key)) out[key] = "[redacted]";
    else out[key] = value;
  }
  return out;
}

function truncateJson(value: unknown, maxChars: number): string {
  try {
    const json = JSON.stringify(value);
    return json.length > maxChars ? json.slice(0, maxChars) + "…[truncated]" : json;
  } catch {
    return '"[unserializable]"';
  }
}

// Includes appId so the assistant can call `get_app(id)` for full static code
// context. Live reactive state goes here too because only the client knows it
// — state is not recoverable server-side through get_app.
function formatAppContextPrefix(ctx: AppActionContext): string {
  const parts: string[] = [`App: "${ctx.appTitle}" (${ctx.appId})`];
  if (ctx.currentState && Object.keys(ctx.currentState).length > 0) {
    parts.push(`state: ${truncateJson(redactState(ctx.currentState), 800)}`);
  }
  return `[${parts.join(" · ")}]`;
}

export function buildContinueConversationPayload(
  event: ActionEvent,
  fallbackFormState?: Record<string, unknown>,
  appContext?: AppActionContext,
): { role: "user"; content: string } | null {
  if (event.type !== BuiltinActionType.ContinueConversation) return null;

  // Prepend app context so the assistant sees what the user was looking at
  // when they clicked. The chat bubble strips the trailing `<context>` block
  // (which carries the typed-context envelope for `session-workspace`) and
  // displays the rest as the visible message.
  const humanMessage = event.humanFriendlyMessage;
  const prefixed = appContext
    ? `${formatAppContextPrefix(appContext)}\n${humanMessage}`
    : humanMessage;

  const ctx: unknown[] = [`User clicked: ${humanMessage}`];

  const formState =
    event.formState ??
    (fallbackFormState && typeof fallbackFormState === "object" ? fallbackFormState : undefined);
  if (formState) ctx.push(formState);

  return {
    role: "user",
    content: prefixed + wrapContext(JSON.stringify(ctx)),
  };
}
