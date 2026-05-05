import type { Thread } from "@openuidev/react-headless";

import type { CronJobRecord } from "@/lib/cron";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export function truncate(value: string, max = 48): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function humanFrequency(job: CronJobRecord): string {
  const s = job.schedule;
  if (!s) return "Manual";
  if (s.kind === "cron" && s.expr) return s.expr;
  // Older gateway shape used `kind: "interval"` with `everyMs`. 2026.5.x ships
  // some interval jobs as `kind: "every"` (sometimes with the same `everyMs`,
  // sometimes without). Render the human interval when we have the duration,
  // and fall back to a friendly label when we don't — never the raw kind.
  if ((s.kind === "interval" || s.kind === "every") && s.everyMs) {
    const ms = s.everyMs;
    if (ms < HOUR_MS) return `Every ${Math.round(ms / MINUTE_MS)} min`;
    if (ms < DAY_MS) return `Every ${Math.round(ms / HOUR_MS)} h`;
    return `Every ${Math.round(ms / DAY_MS)} d`;
  }
  if (s.kind === "every" || s.kind === "interval") return "Recurring";
  return s.kind || "Manual";
}

export function cronOwnerLabel(job: CronJobRecord, threads: Thread[]): string {
  const sessionKey = job.sessionKey ?? "";
  const agentPart = sessionKey.split(":")[0] ?? "";
  // Resolve to the agent's display name via its main thread; fall back to the ID.
  const mainThread = agentPart
    ? threads.find(
        (t) =>
          // @ts-expect-error claw-augmented thread fields
          (t.clawAgentId ?? t.id) === agentPart && t.clawKind === "main",
      )
    : undefined;
  const agentName = mainThread?.title ?? agentPart;
  return agentName ? truncate(agentName) : "";
}
