/**
 * Wrap a JSON payload as a `<context>` block. The block is appended to a
 * message's body so structured metadata (linked-app, thread-uploads, refine
 * state, form submissions) round-trips through the gateway and is recoverable
 * by the UI on history reload — the LLM sees the JSON inline, the chat
 * bubble strips it for display.
 *
 * `<content>` wrapping is intentionally NOT used: the gateway's slash-command
 * detector scans the message body for a leading `/`, and a wrapper would
 * defeat it. AssistantMessage's refine-state path follows the same pattern
 * (`${body}<context>...</context>`) — keeping user and assistant messages
 * symmetric here.
 *
 * The JSON's literal `<` / `>` characters are escaped to their `<` /
 * `>` JSON-unicode form before wrapping. Without this, a form field
 * that captures user-typed text (a feedback field, a code snippet) carrying
 * literal `<context>` / `</context>` markers would collide with our framing
 * tags — the parser's `lastIndexOf` anchor would bind to the user's tag and
 * truncate the content body. JSON parsers decode `<` back to `<`
 * transparently, so the round-trip is lossless.
 */
export function wrapContext(json: string): string {
  const safe = json.replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
  return `<context>${safe}</context>`;
}

/**
 * Legacy wrapper. New messages don't use it; kept exported only so that
 * messages stored under the old format are still round-trippable through
 * `separateContentAndContext` (which peels the wrapper on read).
 */
export function wrapContent(text: string): string {
  return `<content>${text}</content>`;
}

export function separateContentAndContext(raw: string): {
  content: string;
  contextString: string | null;
} {
  let content = raw;
  let contextString: string | null = null;

  // Anchor on the LAST `<context>...</context>` pair, requiring that nothing
  // significant follows the close tag (only whitespace and gateway-appended
  // `<file>...</file>` blocks, which may be truncated mid-body). Using
  // `lastIndexOf` instead of regex backtracking avoids the trap where a
  // greedy/non-greedy match captures from a user-typed `<context>` mid-text
  // through to our real context's close — the engine would erroneously fold
  // user text into the contextString.
  const closeIdx = content.lastIndexOf("</context>");
  const openIdx = closeIdx !== -1 ? content.lastIndexOf("<context>", closeIdx) : -1;
  if (closeIdx !== -1 && openIdx !== -1 && openIdx < closeIdx) {
    const tail = content.slice(closeIdx + "</context>".length);
    // Tail must be empty, whitespace, or a sequence of `<file>...</file>`
    // blocks (possibly truncated — the gateway sometimes serves a clipped
    // transcript with the file body cut off mid-content, no close tag).
    if (/^(?:\s*<file\b[\s\S]*?(?:<\/file>|$))*\s*$/.test(tail)) {
      contextString = content.slice(openIdx + "<context>".length, closeIdx);
      content = content.slice(0, openIdx).trim();
      // Strip the `[media attached: ...]` prefix the gateway prepends to
      // file-bearing messages. Only attempted when we actually matched a
      // context block — plain messages aren't gateway-framed, so leaving
      // unrelated text alone is the safe default.
      content = content.replace(/^\s*(?:\[media attached:[^\]]*\]\s*)+/i, "").trim();
    }
  }

  // Backward compatibility: messages saved under the old format were wrapped
  // in `<content>X</content>`. New messages don't wrap. Peel if present.
  const contentMatch = content.match(/^<content>([\s\S]*?)<\/content>$/);
  if (contentMatch) {
    content = contentMatch[1] ?? "";
  }

  return { content, contextString };
}
