"use client";

import type { OpenClawEngine } from "@/lib/engines/openclaw/OpenClawEngine";
import { shouldSurfaceNotification, type NotificationRecord } from "@/lib/notifications";
import { useCallback, useState, type Dispatch, type RefObject, type SetStateAction } from "react";

/**
 * Notifications-side of the gateway: state + read/write helpers.
 *
 * Returns `setNotifications` so sibling sub-hooks (e.g. `useCronGateway`) can
 * patch the cached list when they have just paid for a `listNotifications`
 * round-trip and don't need this hook to repeat it.
 */
export function useNotificationsGateway(engineRef: RefObject<OpenClawEngine | null>): {
  notifications: NotificationRecord[];
  setNotifications: Dispatch<SetStateAction<NotificationRecord[]>>;
  refreshNotifications: () => Promise<NotificationRecord[]>;
  markNotificationsRead: (ids?: string[]) => Promise<boolean>;
  upsertNotification: (
    notification: Omit<NotificationRecord, "id" | "createdAt" | "updatedAt" | "unread" | "readAt">,
  ) => Promise<boolean>;
} {
  const [notifications, setNotifications] = useState<NotificationRecord[]>([]);

  const refreshNotifications = useCallback(async (): Promise<NotificationRecord[]> => {
    const next = await engineRef.current?.listNotifications();
    const list = (next ?? []).filter(shouldSurfaceNotification);
    setNotifications(list);
    return list;
  }, [engineRef]);

  const markNotificationsRead = useCallback(
    async (ids?: string[]): Promise<boolean> => {
      const ok = await engineRef.current?.markNotificationsRead(ids);
      if (ok) {
        await refreshNotifications();
      }
      return ok ?? false;
    },
    [engineRef, refreshNotifications],
  );

  const upsertNotification = useCallback(
    async (
      notification: Omit<
        NotificationRecord,
        "id" | "createdAt" | "updatedAt" | "unread" | "readAt"
      >,
    ): Promise<boolean> => {
      const ok = await engineRef.current?.upsertNotification(notification);
      if (ok) {
        await refreshNotifications();
      }
      return ok ?? false;
    },
    [engineRef, refreshNotifications],
  );

  return {
    notifications,
    setNotifications,
    refreshNotifications,
    markNotificationsRead,
    upsertNotification,
  };
}
