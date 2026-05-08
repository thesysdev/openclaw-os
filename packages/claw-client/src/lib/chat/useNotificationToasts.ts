"use client";

import type { NotificationToastNotice } from "@/components/chat/NotificationToastViewport";
import type { NotificationRecord } from "@/lib/notifications";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Route =
  | { view: "chat"; sessionId: string }
  | { view: "app"; appId: string }
  | { view: "artifact"; artifactId: string }
  | { view: string; [key: string]: unknown };

const TOAST_TTL_MS = 5000;
const AUTO_MARK_READ_DELAY_MS = 1500;
const MAX_TOASTS = 4;

/**
 * Notification toast plumbing extracted from ChatApp:
 *  - tracks which notifications have already been toasted (so we don't pop
 *    the same one twice across re-renders)
 *  - anchors "what counts as new" to page-load time, since the first render
 *    lands before `engine.listNotifications()` resolves and otherwise every
 *    item in the async-loaded list would look brand-new on reload
 *  - auto-dismisses each toast after `TOAST_TTL_MS`
 *  - auto-marks-as-read any unread notification that matches the current
 *    route after a short dwell, so the inbox badge clears as the user reads
 */
export function useNotificationToasts(
  notifications: NotificationRecord[],
  route: Route,
  markRead: (ids?: string[]) => Promise<boolean>,
) {
  const [toasts, setToasts] = useState<NotificationToastNotice[]>([]);
  const seenIdsRef = useRef<Set<string>>(new Set());
  const loadTimeRef = useRef<number>(Date.now());

  const unreadCount = useMemo(() => notifications.filter((n) => n.unread).length, [notifications]);

  const matchesRoute = useCallback(
    (n: NotificationRecord) => {
      switch (n.target.view) {
        case "chat":
          return route.view === "chat" && route.sessionId === n.target.sessionId;
        case "app":
          return route.view === "app" && route.appId === n.target.appId;
        case "artifact":
          return route.view === "artifact" && route.artifactId === n.target.artifactId;
        default:
          return false;
      }
    },
    [route],
  );

  // Toast newly-arrived unread notifications that don't match the current route.
  useEffect(() => {
    const loadTime = loadTimeRef.current;
    const fresh = notifications.filter((n) => {
      if (!n.unread) return false;
      if (seenIdsRef.current.has(n.id)) return false;
      if (matchesRoute(n)) return false;
      // Prefer `metadata.runAtMs` (the actual cron run time) over the
      // server-set `createdAt`, which can drift on every upsert and make
      // hours-old runs look brand-new on reload.
      const runAtMs = typeof n.metadata?.["runAtMs"] === "number" ? n.metadata["runAtMs"] : null;
      const eventTime = runAtMs ?? Date.parse(n.createdAt);
      return !(Number.isFinite(eventTime) && eventTime < loadTime);
    });

    if (fresh.length > 0) {
      setToasts((current) => {
        const existing = new Set(current.map((t) => t.notification.id));
        const additions = fresh
          .filter((n) => !existing.has(n.id))
          .map((n) => ({ id: `toast:${n.id}`, notification: n }));
        return [...current, ...additions].slice(-MAX_TOASTS);
      });
    }

    seenIdsRef.current = new Set(notifications.map((n) => n.id));
  }, [matchesRoute, notifications]);

  // Auto-dismiss after TTL.
  useEffect(() => {
    if (toasts.length === 0) return;
    const timers = toasts.map((toast) =>
      window.setTimeout(() => {
        setToasts((current) => current.filter((t) => t.id !== toast.id));
      }, TOAST_TTL_MS),
    );
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [toasts]);

  // Auto-mark-as-read any unread notification whose target matches the
  // current route — clears the inbox badge as the user reads.
  useEffect(() => {
    const ids = notifications.filter((n) => n.unread && matchesRoute(n)).map((n) => n.id);
    if (ids.length === 0) return;
    const timeoutId = window.setTimeout(() => {
      void markRead(ids);
    }, AUTO_MARK_READ_DELAY_MS);
    return () => window.clearTimeout(timeoutId);
  }, [matchesRoute, notifications, markRead]);

  const dismiss = useCallback((toastId: string) => {
    setToasts((current) => current.filter((t) => t.id !== toastId));
  }, []);

  return { toasts, dismiss, unreadCount };
}
