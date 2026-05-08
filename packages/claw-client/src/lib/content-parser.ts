export function wrapContent(text: string): string {
  return `<content>${text}</content>`;
}

export function wrapContext(json: string): string {
  return `<context>${json}</context>`;
}

export function separateContentAndContext(raw: string): {
  content: string;
  contextString: string | null;
} {
  let contextString: string | null = null;
  let content = raw;

  // Strip the `<context>...</context>` block. Anchored anywhere in the string,
  // not just at the end — when the openclaw gateway persists a user message
  // with media attachments, the saved transcript wraps the body with a
  // `[media attached: <path> (<mime>)]` prefix and a `<file>...</file>` block
  // appended *after* the `<context>` close tag (so the LLM sees the file
  // contents alongside the user's text). Without `*?` + the loose anchor, the
  // greedy `\s*$` end-anchor fails on those messages and the entire raw
  // string — including the file body — leaks into the bubble after history
  // reload.
  const contextMatch = content.match(/<context>([\s\S]*?)<\/context>/);
  if (contextMatch) {
    contextString = contextMatch[1] ?? null;
    const start = contextMatch.index ?? 0;
    const end = start + contextMatch[0].length;
    content = (content.slice(0, start) + content.slice(end)).trim();
  }

  // Pull the `<content>...</content>` body. Same reason for the loose anchor:
  // the saved transcript may have `[media attached:]` text in front of it.
  const contentMatch = content.match(/<content>([\s\S]*?)<\/content>/);
  if (contentMatch) {
    content = contentMatch[1] ?? "";
  } else {
    // No `<content>` wrapper — this is either a plain message or a saved
    // transcript with the wrapper stripped server-side. Defensively drop any
    // gateway framing so the bubble shows just the user's text.
    content = content
      .replace(/^\s*(?:\[media attached:[^\]]*\]\s*)+/i, "")
      .replace(/<file\b[\s\S]*?<\/file>\s*/g, "")
      .trim();
  }

  return { content, contextString };
}
