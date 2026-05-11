/**
 * Build script — emits the artifacts the plugin needs at runtime:
 *
 *   skills/openui-app/SKILL.md               — durable apps (Query/Mutation/$state); a real skill
 *   prompts/openui-inline-ui.md              — inline UI in chat replies (static); inlined into the
 *                                              Claw system prompt by src/index.ts, NOT a skill
 *   src/generated/openui-schema.json         — drives the lint loop in lint-openui.ts
 *
 * Re-run with `pnpm generate` whenever @openuidev/react-ui changes its
 * component surface or this file's preambles.
 *
 * Why the libraries are imported here (and not in src/index.ts):
 *   `openuiLibrary` carries `"use client"` + React imports. They are fine
 *   to import in a Node build script, but cannot run inside the plugin
 *   process. So we generate the prompt + schema once at build time and
 *   ship the resulting strings as filesystem artefacts.
 */
import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import {
  openuiAdditionalRules,
  openuiChatAdditionalRules,
  openuiChatExamples,
  openuiChatLibrary,
  openuiChatPromptOptions,
  openuiExamples,
  openuiLibrary,
  openuiPromptOptions,
} from "@openuidev/react-ui/genui-lib";

const __dirname = dirname(fileURLToPath(import.meta.url));
const generatedDir = join(__dirname, "src", "generated");
const skillsDir = join(__dirname, "skills");
const promptsDir = join(__dirname, "prompts");

mkdirSync(generatedDir, { recursive: true });
mkdirSync(promptsDir, { recursive: true });
mkdirSync(join(skillsDir, "openui-app"), { recursive: true });

// ─────────────────────────────────────────────────────────────────────────────
// 1. openui-inline-ui prompt — inline UI in a chat reply.
//    Static surface only: no Query, no Mutation, no $variables, no builtins,
//    no filters. Just component signatures + Action({@ToAssistant, @OpenUrl}).
//    Written as a plain prompt file (no frontmatter): src/index.ts reads it at
//    startup and inlines it into the Claw system prompt. It is NOT a skill.
// ─────────────────────────────────────────────────────────────────────────────

const CHAT_PREAMBLE = `You are rendering generative UI inline in a chat reply, using a small DSL called openui-lang.

DSL SHAPE — every program is identifier-equals-component-call assignments:

  identifier = Component(arg1, arg2)
  root = Card([child1, child2])

NOT JSX (\`<Section>\`). NOT object literals (\`Section { ... }\`). NOT MDX. If you catch yourself writing braces around component bodies or angle brackets, stop — you are hallucinating a different DSL. Your training data does not contain openui-lang.

Wrap your openui-lang code in triple-backtick fences tagged \`openui-lang\`. The renderer ONLY extracts code from those fences.

Three response shapes:
1. Plain text — for simple questions ("hi", "what time is it", "explain X").
2. Text + UI — short prose, then a fenced openui-lang block (most common shape).
3. UI only — when the user explicitly asks for a chart, table, form, or follow-ups.

Render UI when ANY of these apply:
- Chart, graph, plot, trend, comparison, table, breakdown, summary, visualization.
- Compare or rank 2+ things; series of numbers; leaderboards.
- Multi-field input ("plan a trip", "fill out X", "set up Y") — render a Form with FormControls + submit Button. Never a numbered question list.
- Answer would exceed ~10 lines — wrap in \`SectionBlock([SectionItem(...)])\`.
- Suggesting next actions — end with \`FollowUpBlock([FollowUpItem(...)])\`.

This surface is STATIC: no \`Query\`, no \`Mutation\`, no \`$state\` runtime. The \`value\` arg on Input/TextArea/Select takes a static default string — it is NOT a \`$state\` binding (chat has nothing to bind to). To collect form data, attach \`Action([@ToAssistant("...")])\` to the submit Button so the form contents come back as a user message.

If the user wants live data, refresh, or write operations, STOP and use the openui-app skill — that path calls \`app_create\`.

COMMON MISTAKES (the renderer drops them or shows broken UI):

- Section { } or <Section>           → SectionBlock([SectionItem("id", "Trigger", [content])])
- Heading("Title")                   → CardHeader("Title", "Subtitle") or TextContent("Title", "large-heavy")
- Markdown(...)                      → MarkDownRenderer(...)
- Badge(...)                         → Tag(text, null, "sm", "info" | "success" | "warning" | "danger")
- Divider()                          → Separator()
- Stack([a, b], "row", "m")          → chat has NO Stack. Use Tabs/Carousel/SectionBlock, or stack vertically inside Card (the default).
- Input(name, ph, "text", null, $x)  → chat has NO $state. Pass a static string default: Input(name, ph, "text", null, "default")
- FollowUp("text", "msg")            → FollowUpItem("text") — one arg, the clickable text
- TabItem("rev", "Revenue", revTab)  → TabItem("rev", "Revenue", [revTab]) — content MUST be an array, even with one child
- AccordionItem same — three args, content array
- "col" direction                    → "column" (or omit; column is the default)
- @Map(rows, ...)                    → there is no @Map in chat (no live data anyway). Just inline literal arrays.
- Triple-backticks INSIDE MarkDownRenderer text → close the outer openui-lang fence early. NEVER nest triple-backticks. Use single backticks or describe code in prose.

STREAMING ORDER — define dependencies right after their parent, breadth-first. A reference resolves only once its definition has streamed in, so a child defined far below its parent renders late. In particular: a Form's Buttons argument (2nd positional) is the submit affordance — define \`btns\` and its Button(s) IMMEDIATELY after \`form = Form(...)\`, BEFORE the FormControl fields, or the submit button only pops in at the very end. Same for any container: \`Card([a, b])\` → define \`a\`, then \`b\`, then their internals. Don't push all leaf definitions to the bottom.`;

// `inlineMode: true` would inject upstream's "## Inline Mode" block, which
// talks about patching existing UI — concept doesn't apply to chat replies
// (every assistant turn renders a fresh Card), and risks the agent emitting
// partial-statement responses that don't render. Our CHAT_PREAMBLE already
// covers fence-wrapping + when to use UI vs plain text, so we drop the flag.
//
// `bindings: false` suppresses the top-level Bindings section but the upstream
// component-signature builder still annotates props as `$binding<...>` —
// post-process to strip those so the agent doesn't think it can wire $vars
// into a Form whose state has nowhere to live.
const chatPromptRaw = openuiChatLibrary.prompt({
  ...openuiChatPromptOptions,
  preamble: CHAT_PREAMBLE,
  toolCalls: false,
  bindings: false,
  examples: openuiChatExamples,
  additionalRules: openuiChatAdditionalRules,
});

const chatPrompt = chatPromptRaw
  // ORDER MATTERS: drop the "Props marked `$binding<type>` accept a
  // `$variable` reference" explainer line FIRST, while the literal
  // `$binding<type>` substring is still in the prose. Then rewrite the
  // remaining `$binding<...>` annotations on signatures.
  .replace(/\nProps marked `\$binding<type>` accept[^\n]*\n/g, "\n")
  // `value?: $binding<string>` → `value?: string` on signatures.
  .replace(/\$binding<([^>]+)>/g, "$1");

// Plain prompt file — NO YAML frontmatter. This is not a skill: src/index.ts
// reads prompts/openui-inline-ui.md at startup and inlines the whole thing into
// the Claw system prompt via the `before_prompt_build` hook. (Auto-injecting it
// as an `always: true` skill too would just duplicate ~250 lines per session.)
writeFileSync(
  join(promptsDir, "openui-inline-ui.md"),
  chatPrompt.trimEnd() + "\n",
  "utf8",
);
console.log(`✓ prompts/openui-inline-ui.md (${chatPrompt.length} chars)`);

// ─────────────────────────────────────────────────────────────────────────────
// 2. openui-app skill — durable apps with live data.
//    Full v0.5 surface: Query, Mutation, $variables, builtins, filters,
//    Action with @Run/@Set/@Reset, edit mode for incremental patches.
// ─────────────────────────────────────────────────────────────────────────────

const CREATOR_PREAMBLE = `You are about to create or edit a durable app using openui-lang — a small DSL specific to this product. Apps persist via \`app_create\` / \`app_update\` and run independently after creation; the runtime calls tools directly on every refresh with NO LLM in the loop.

DSL SHAPE — every program is identifier-equals-component-call assignments:

  identifier = Component(arg1, arg2)
  root = Stack([child1, child2])

NOT JSX (\`<Section>\`). NOT object literals (\`Section { ... }\`). NOT MDX. Your training data does not contain openui-lang.

\`app_create\` and \`app_update\` take RAW openui-lang in the \`code\` / \`patch\` argument — no fences. Wrap in fences (tagged \`openui-lang\`) only when previewing inline.

CRITICAL — Query first arg is ONE of these four strings, no exceptions:
- \`"exec"\`        — shell. Args: \`{command: "..."}\`
- \`"read"\`        — file read. Args: \`{file_path: "..."}\`
- \`"db_query"\`    — read SQLite. Args: \`{sql: "SELECT ...", params?: {...}, namespace?: "default"}\`
- \`"db_execute"\`  — write SQLite (only inside \`Mutation\`). Args: \`{sql: "INSERT ...", params?: {...}, namespace?: "default"}\`

There is NO \`"fetch"\`, NO \`"http"\`, NO \`"github_pull_requests"\`, NO MCP-qualified tool name. To call an external API, write a Node script that calls the API and shells out via \`Query("exec", {command: "node ~/.openclaw/workspace/scripts/your-script.js"})\`.

\`@Run\` / \`@Set\` / \`@Reset\` take a REFERENCE to a top-level statement, never an inline call. Per-row mutations: route the row id through a \`$state\`, then sequence \`@Set\` → \`@Run(mutationRef)\` → \`@Run(refreshQueryRef)\`.

Tables are COLUMN-oriented. \`Table([Col("Label", dataArray), Col("Count", countArray, "number")])\` — the third \`Col\` arg is a TYPE hint, not a label.

CALL \`app_create\` IMMEDIATELY when the code is ready. Do not wait for your final paragraph. After the tool returns, keep streaming explanation/follow-ups.

If \`app_create\` or \`app_update\` returns \`validationErrors\`, the code IS saved — but lint flagged issues. ALWAYS fix via a TINY follow-up \`app_update\` (1–10 statements) with ONLY the corrected statements. The runtime merges by statement name; untouched lines stay put. NEVER re-emit the whole program — that's the failure mode we're avoiding (slower, costs tokens, risks introducing new errors).

LAYOUT — preventing pathologies the renderer can't shrink out of:
- Max 3 KPI Cards per row, NO wrap. For 4–6 KPIs, use TWO \`Stack(..., "row", "m", "stretch")\` rows. \`wrap=true\` on a row of Cards triggers a known interaction with the Card width style that collapses tile text to single characters.
- Do NOT nest \`Stack\` directly inside another \`Stack\` as a flex child. If you need a header with a left block + right block, wrap the inner block in \`Card([...], "clear")\` so it gets proper flex sizing. (\`Stack\` itself doesn't set \`min-width: 0\`, so as a flex child it can't shrink and will overflow.)

KPI STRIP RECIPE — use this exactly. There is no \`KPI\` / \`Metric\` / \`StatCard\` component:

  kpiRow = Stack([k1, k2, k3], "row", "m", "stretch")
  k1 = Card([TextContent("Open PRs", "small"), TextContent("" + @Count(prs), "large-heavy"), Tag("17 overdue", null, "sm", "warning")], "sunk")
  k2 = Card([TextContent("MRR", "small"), TextContent("$" + @Round(stripe.mrr, 0), "large-heavy")], "sunk")
  k3 = Card([TextContent("Runway", "small"), TextContent("" + stripe.runway + " mo", "large-heavy")], "sunk")

For 6 KPIs, two rows: \`kpiGrid = Stack([row1, row2], "column", "m", "stretch")\` then two row Stacks of 3 each.

SQL — verify columns BEFORE SELECT. Either run \`db_query\` with \`PRAGMA table_info(<table>)\` first, or write \`SELECT *\` and project columns in the UI. NEVER extrapolate column names from a pattern (\`churn_count_30d\` existing does not mean \`churn_count_60d\` exists). The runtime fails with \`no such column\` and your app shows an error.

Multi-line statements are OK inside brackets and ternaries — newlines are ignored by the parser.

COMMON MISTAKES (these will lint-fail or break the render):

- Section { } or <Section>            → Accordion([AccordionItem("id", "Title", [content])]) — there is no SectionBlock in apps
- Heading("Title")                    → CardHeader("Title", "Subtitle") or TextContent("Title", "large-heavy")
- KpiCard / KPI / StatCard / Metric   → Card+TextContent recipe above
- Markdown(...)                       → MarkDownRenderer(...)
- Badge(...)                          → Tag(text, null, "sm", "info" | "success" | "warning" | "danger")
- Divider()                           → Separator()
- Tab(...)                            → TabItem("id", "Trigger", [content])
- Grid(...)                           → two Stack rows of max 3 children — NOT wrap=true
- FollowUpBlock / SectionBlock / ListBlock — chat-only; in apps use Accordion / Tabs / @Each(rows, "r", Card([...]))
- @Map(rows, ...)                     → @Each(rows, "r", ...)
- @JsonParse / @ParseJSON             → does not exist; Query("exec") auto-parses stdout starting with \`{\` or \`[\`
- @FormatDate / @FormatNumber         → do not exist; use string concat or @Round + concat
- @Length                             → @Count(array)
- @Find                               → @First(@Filter(array, "field", "==", value))
- TabItem("rev", "Revenue", revTab)   → TabItem("rev", "Revenue", [revTab]) — content MUST be an array
- AccordionItem same                  → three args, content array
- "col" direction                     → "column" (or omit; column is the default)

ENUM ENFORCEMENT (the lint validates these and reports \`validationErrors\` on the \`app_create\` / \`app_update\` response):
- Stack/Card direction: \`"row"\` | \`"column"\` only
- Card variant: \`"card"\` | \`"sunk"\` | \`"clear"\` (no \`"compact"\`/\`"primary"\`/\`"muted"\`/\`"warning"\`)
- Tag variant: \`"neutral"\` | \`"info"\` | \`"success"\` | \`"warning"\` | \`"danger"\` (no \`"negative"\`/\`"positive"\`/\`"medium"\`)
- TextContent size: \`"small"\` | \`"default"\` | \`"large"\` | \`"small-heavy"\` | \`"large-heavy"\` (no \`"huge"\`)`;

const creatorPrompt = openuiLibrary.prompt({
  ...openuiPromptOptions,
  preamble: CREATOR_PREAMBLE,
  toolCalls: true,
  bindings: true,
  editMode: true,
  inlineMode: true,
  examples: openuiExamples,
  additionalRules: openuiAdditionalRules,
});

const CREATOR_FRONTMATTER = `---
name: openui-app
description: Build, edit, or read durable apps in the workspace. REQUIRED before calling \`app_create\`, \`app_update\`, \`get_app\`, or \`create_markdown_artifact\`. Full reactive surface — \`$state\`, \`Query\`, \`Mutation\`, \`@Run\`/\`@Set\`/\`@Reset\`, scheduled refresh, persistent SQLite. Use for dashboards, briefings, command centers, trackers — any persistent surface the user reopens.
---

`;

const CREATOR_WORKFLOW = `

---

## Plugin tools and workflow

Beyond the openui-lang surface above, this skill teaches the agent how to wire openui-lang into the Claw plugin's tool surface (\`app_create\`, \`app_update\`, \`get_app\`, \`create_markdown_artifact\`, \`exec\`, \`read\`, \`db_query\`, \`db_execute\`).

### Creating an app

1. Write the complete openui-lang code.
2. Call \`app_create({title, code})\` with the title and the full RAW code (no fences — \`app_create\` takes raw text).
3. Call \`app_create\` immediately once the code is ready. Do NOT wait for your final paragraph.

\`\`\`
app_create({title: "Sales Dashboard", code: "root = Stack([header, chart])\\nheader = CardHeader(\\"Sales\\")\\nchart = BarChart([\\"Q1\\",\\"Q2\\"], [Series(\\"Rev\\", [100, 200])])"})
\`\`\`

The app is stored in the Apps panel. The user can open, refine, and return to it later.

### Apps with live data — discover → script → generate

Follow these three steps in order. Do NOT skip straight to generating markup.

**Step 1: Discover data.** Use the \`exec\` tool to explore what's available:

\`\`\`
exec({command: "vm_stat"})
exec({command: "ps aux --sort=-%mem | head -10"})
exec({command: "df -h"})
\`\`\`

Inspect the raw output — understand its format, fields, and what can be extracted.

**System binaries — use absolute paths inside scripts.** The \`exec\` tool runs commands through \`/bin/sh\`, but apps run with a minimal sandbox PATH that often misses \`/usr/sbin\` (where macOS \`sysctl\`, \`netstat\`, \`pwd_mkdb\` live). When you \`write\` a script for an app, hard-code absolute paths for any system binary that isn't in \`/usr/bin\` or \`/bin\`:

- \`/usr/sbin/sysctl\` (NOT \`sysctl\`)
- \`/usr/sbin/netstat\`, \`/usr/sbin/lsof\`, \`/usr/sbin/ioreg\`
- \`/usr/local/bin/<tool>\` or \`/opt/homebrew/bin/<tool>\` for brew-installed tools

Rule of thumb: if you discovered the binary works in your interactive \`exec\` test but the app shows "command not found" on first refresh, it's a PATH-vs-script-environment mismatch — switch to an absolute path.

**Step 2: Write and save a data script.** Raw command output is rarely in a shape the UI can bind to directly. Write a self-contained script that:

- Calls the raw commands from step 1.
- Parses and transforms the output into clean JSON.
- Prints the JSON via \`console.log(JSON.stringify(...))\`.

Save with the \`write\` tool (preferred) or \`exec\`:

\`\`\`
write({path: "~/.openclaw/workspace/scripts/my-data.js", content: "const os = require('os');\\n..."})
\`\`\`

Then test:

\`\`\`
exec({command: "node ~/.openclaw/workspace/scripts/my-data.js"})
\`\`\`

Verify the output is valid JSON like \`{"totalGB":16.0,"freeGB":2.1,"pct":86.9}\`. Embedding multi-line scripts inside Query strings causes escaping nightmares — saved script files keep the Query call readable.

**Step 3: Generate the app.** Create openui-lang with \`Query()\` statements that call the saved script:

\`\`\`
data = Query("exec", {command: "node ~/.openclaw/workspace/scripts/my-data.js"}, {totalGB: 16.0, freeGB: 2.1, pct: 86.9}, 5)
\`\`\`

- First arg: tool name — always \`"exec"\` (or \`"read"\` for file reads).
- Second arg: args object passed directly to the tool — for exec, just \`{command: "..."}\`.
- Third arg: defaults — use the REAL JSON output from your step 2 test.
- Fourth arg: refresh interval in seconds.
- Access fields directly: \`data.fieldA\` — stdout is auto-parsed, no \`.result\` wrapper.

### Persistent app state (SQLite)

For todos, notes, saved filters, or any CRUD data, use the SQLite tools rather than faking state.

1. In the agent turn, call \`db_execute\` to create the schema.
2. In the app markup, use \`Query("db_query", ...)\` for reads.
3. Use \`Mutation("db_execute", ...)\` for writes.
4. Trigger the read query again after writes with \`Action([@Run(writeMutation), @Run(readQuery)])\`.

\`\`\`
db_execute({sql: "CREATE TABLE IF NOT EXISTS todos (id INTEGER PRIMARY KEY, text TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)", namespace: "todos"})
\`\`\`

\`\`\`openui-lang
$text = ""
todos = Query("db_query", {sql: "SELECT id, text, done, created_at FROM todos ORDER BY created_at DESC", namespace: "todos"}, {rows: []}, 5)
createTodo = Mutation("db_execute", {sql: "INSERT INTO todos (text) VALUES ($text)", params: {text: $text}, namespace: "todos"})
addButton = Button("Add", Action([@Run(createTodo), @Run(todos), @Reset($text)]))
\`\`\`

- \`db_query\` returns \`{namespace, rows: [...]}\`.
- \`db_execute\` returns \`{namespace, changes, lastInsertRowid}\`.
- Use the same \`namespace\` across setup, reads, and writes for one app.
- Prefer SQL parameters over string interpolation for user input.

### Editing apps (refine flow)

When the user wants to change an existing app — including the in-app "Refine" button which prefills the chat composer with \`Refine app "<title>" (id: <id>): ...\` — follow this pattern:

1. Call \`get_app({id: "..."})\` to see the current code.
2. Identify what needs to change.
3. Call \`app_update({id: "...", patch: "chart = LineChart(...)..."})\` with ONLY the changed/new statements.

The runtime merges by statement name:
- Same name → replaced.
- New name → added.
- Missing from patch → kept unchanged.

A typical edit is 1-5 statements. NEVER output the entire program as a patch. The lint loop returns \`validationErrors\` when rules are violated; when you see them, call \`app_update\` again with ONLY the corrected statements.

### Manual refresh buttons

If the user wants a visible refresh control, re-run the declared \`Query()\` refs:

\`\`\`openui-lang
refreshBtn = Button("↻ Refresh", Action([@Run(overview), @Run(procs)]), "secondary", "normal", "small")
\`\`\`

A plain \`Button("Refresh")\` sends a message to the assistant; it does NOT refresh queries. Manual refresh always targets declared query refs via \`@Run(queryRef)\`.

### Scheduled updates (cron-driven apps)

A cron's prompt is its ONLY context at fire time — no session memory. Prompts must include the target explicitly: either \`db_execute\` with \`namespace\` + table schema, OR \`app_update\` with \`app_id\`. Prefer DB writes for recurring data; \`app_update\` only when the layout shape changes.

### Creating artifacts

When the user wants a report, document, summary, or reference material saved:

\`\`\`
create_markdown_artifact({title: "Q1 Report", content: "# Q1 Report\\n\\n## Revenue\\n..."})
\`\`\`

Call \`create_markdown_artifact\` as soon as the content is ready so the artifact appears during the run, not only after your final paragraph.

### When to use what

- **Inline UI** (fenced \`openui-lang\` via the openui-inline-ui skill) — quick visualizations, previews, one-off charts.
- **App** (\`app_create\`) — dashboards, tools, forms the user will return to. Persistent.
- **Artifact** (\`create_markdown_artifact\`) — reports, summaries, documents. Persistent.
- **Plain text** — questions, explanations, conversation.
`;

writeFileSync(
  join(skillsDir, "openui-app", "SKILL.md"),
  CREATOR_FRONTMATTER + creatorPrompt + CREATOR_WORKFLOW,
  "utf8",
);
console.log(`✓ skills/openui-app/SKILL.md (${creatorPrompt.length} chars + workflow)`);

// ─────────────────────────────────────────────────────────────────────────────
// 3. openui-schema.json — drives the runtime lint loop in lint-openui.ts.
//    Was previously a TS module wrapping a giant JSON.stringify with a triple
//    cast; JSON is the natural shape, parsed at import time by the bundler.
// ─────────────────────────────────────────────────────────────────────────────

const librarySchema = openuiLibrary.toJSONSchema();
const componentNames = Object.keys(librarySchema.$defs ?? {});

writeFileSync(
  join(generatedDir, "openui-schema.json"),
  JSON.stringify({ schema: librarySchema, componentNames }, null, 2),
  "utf8",
);
console.log(`✓ src/generated/openui-schema.json (${componentNames.length} components)`);
