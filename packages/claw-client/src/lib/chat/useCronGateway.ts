"use client";

import type { CronJobRecord, CronRunEntry, CronStatusRecord } from "@/lib/cron";
import type { OpenClawEngine } from "@/lib/engines/openclaw/OpenClawEngine";
import { ConnectionState } from "@/lib/gateway/types";
import { shouldSurfaceNotification, type NotificationRecord } from "@/lib/notifications";
import {
  useCallback,
  useEffect,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import { sessionRouteIdFromSessionKey } from "./session-routing";

/**
 * Walk the latest cron-runs list and upsert one notification per run that
 * isn't already represented in `existingNotifications`. Returns `true` iff at
 * least one upsert was issued — lets the caller skip a follow-up
 * `listNotifications` round-trip when nothing actually changed.
 */
async function syncCronNotifications(
  engine: OpenClawEngine,
  runs: readonly CronRunEntry[],
  existingNotifications: readonly NotificationRecord[],
): Promise<boolean> {
  const existingDedupeKeys = new Set(
    existingNotifications
      .map((notification) => notification.dedupeKey)
      .filter((value): value is string => typeof value === "string" && value.length > 0),
  );

  const pending = runs
    .filter(
      (run) =>
        run.status === "error" ||
        run.status === "skipped" ||
        (run.status === "ok" && typeof run.summary === "string" && run.summary.length > 0),
    )
    .slice(0, 12)
    .filter((run) => !existingDedupeKeys.has(`cron-run:${run.jobId}:${run.ts}`));

  if (pending.length === 0) return false;

  await Promise.all(
    pending.map(async (run) => {
      const message =
        run.status === "error"
          ? (run.error ?? "Scheduled run failed.")
          : run.status === "skipped"
            ? (run.summary ?? "Scheduled run was skipped.")
            : (run.summary ?? "Scheduled run completed.");

      await engine.upsertNotification({
        dedupeKey: `cron-run:${run.jobId}:${run.ts}`,
        kind: run.status === "ok" ? "cron_completed" : "cron_attention",
        title: run.jobName ?? run.jobId,
        message,
        // Route to the crons view (focused on this job) instead of a synthetic
        // chat sessionId — cron runs don't have a real chat thread to open.
        target: { view: "crons", jobId: run.jobId },
        source: {
          cronId: run.jobId,
          sessionKey: run.sessionKey,
        },
        metadata: {
          status: run.status,
          summary: run.summary,
          error: run.error,
          deliveryStatus: run.deliveryStatus,
          runAtMs: run.runAtMs,
          nextRunAtMs: run.nextRunAtMs,
        },
      });
    }),
  );
  return true;
}

export interface CronGatewayResult {
  cronJobs: CronJobRecord[];
  cronRuns: CronRunEntry[];
  cronStatus: CronStatusRecord | null;
  refreshCronData: () => Promise<{
    jobs: CronJobRecord[];
    runs: CronRunEntry[];
    status: CronStatusRecord | null;
  }>;
  updateCronJob: (id: string, patch: Record<string, unknown>) => Promise<boolean>;
  runCronJob: (id: string, mode?: "force" | "due") => Promise<boolean>;
  removeCronJob: (id: string) => Promise<boolean>;
}

/**
 * Cron-side of the gateway: jobs/runs/status state, the visibility-aware
 * polling loop, and cron CRUD wrappers.
 *
 * Notifications are coupled to crons (each run can produce a notification),
 * so the caller passes in `refreshNotifications` and `setNotifications`. When
 * the run sync produces no upserts, we patch the local list from the data we
 * already fetched instead of a third round-trip.
 */
export function useCronGateway(
  engineRef: RefObject<OpenClawEngine | null>,
  knownAgentIdsRef: RefObject<Set<string>>,
  connectionState: ConnectionState,
  refreshNotifications: () => Promise<NotificationRecord[]>,
  setNotifications: Dispatch<SetStateAction<NotificationRecord[]>>,
): CronGatewayResult {
  const [cronJobs, setCronJobs] = useState<CronJobRecord[]>([]);
  const [cronRuns, setCronRuns] = useState<CronRunEntry[]>([]);
  const [cronStatus, setCronStatus] = useState<CronStatusRecord | null>(null);

  const refreshCronData = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) {
      setCronJobs([]);
      setCronRuns([]);
      setCronStatus(null);
      return { jobs: [], runs: [], status: null };
    }

    // Fetch notifications alongside cron data so `syncCronNotifications`
    // can dedupe without a second round-trip.
    const [jobs, runs, status, existingNotifications] = await Promise.all([
      engine.listCronJobs(),
      engine.listCronRuns(),
      engine.getCronStatus(),
      engine.listNotifications(),
    ]);

    const normalizedJobs = jobs
      .map((job) => ({
        ...job,
        threadId: job.sessionKey
          ? sessionRouteIdFromSessionKey(job.sessionKey, knownAgentIdsRef.current)
          : undefined,
      }))
      .sort((left, right) => {
        const leftNext = left.state?.nextRunAtMs ?? Number.MAX_SAFE_INTEGER;
        const rightNext = right.state?.nextRunAtMs ?? Number.MAX_SAFE_INTEGER;
        return leftNext - rightNext;
      });

    const normalizedRuns = runs.map((run) => ({
      ...run,
      threadId: run.sessionKey
        ? sessionRouteIdFromSessionKey(run.sessionKey, knownAgentIdsRef.current)
        : run.sessionId,
    }));

    setCronJobs(normalizedJobs);
    setCronRuns(normalizedRuns);
    setCronStatus(status);

    const upserted = await syncCronNotifications(
      engine,
      normalizedRuns,
      existingNotifications ?? [],
    );
    if (upserted) {
      await refreshNotifications();
    } else {
      setNotifications((existingNotifications ?? []).filter(shouldSurfaceNotification));
    }

    return { jobs: normalizedJobs, runs: normalizedRuns, status };
  }, [engineRef, knownAgentIdsRef, refreshNotifications, setNotifications]);

  useEffect(() => {
    if (connectionState !== ConnectionState.CONNECTED) return;

    let intervalId: number | null = null;

    const stopPolling = () => {
      if (intervalId !== null) {
        window.clearInterval(intervalId);
        intervalId = null;
      }
    };

    const startPolling = () => {
      if (document.visibilityState === "hidden" || intervalId !== null) return;
      intervalId = window.setInterval(() => {
        void refreshCronData().catch((error) => {
          console.warn("[claw] cron refresh failed:", error);
        });
      }, 30000);
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        stopPolling();
        return;
      }

      void refreshCronData().catch((error) => {
        console.warn("[claw] cron refresh failed:", error);
      });
      startPolling();
    };

    handleVisibilityChange();
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      stopPolling();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [connectionState, refreshCronData]);

  const updateCronJob = useCallback(
    async (id: string, patch: Record<string, unknown>) =>
      engineRef.current?.updateCronJob(id, patch) ?? false,
    [engineRef],
  );
  const runCronJob = useCallback(
    async (id: string, mode: "force" | "due" = "force") =>
      engineRef.current?.runCronJob(id, mode) ?? false,
    [engineRef],
  );
  const removeCronJob = useCallback(
    async (id: string) => engineRef.current?.removeCronJob(id) ?? false,
    [engineRef],
  );

  return {
    cronJobs,
    cronRuns,
    cronStatus,
    refreshCronData,
    updateCronJob,
    runCronJob,
    removeCronJob,
  };
}
