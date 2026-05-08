"use client";

import { loadPinnedAppIds, savePinnedAppIds } from "@/lib/app-pins";
import { useCallback, useEffect, useState } from "react";

export interface PinnedApps {
  pinnedAppIds: Set<string>;
  togglePinnedApp: (appId: string) => void;
}

/**
 * Persist-backed pinned-app set. Hydrates from `app-pins` storage on mount
 * and writes through on every toggle.
 */
export function usePinnedApps(): PinnedApps {
  const [pinnedAppIds, setPinnedAppIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    setPinnedAppIds(new Set(loadPinnedAppIds()));
  }, []);

  const togglePinnedApp = useCallback((appId: string) => {
    setPinnedAppIds((current) => {
      const next = new Set(current);
      if (next.has(appId)) next.delete(appId);
      else next.add(appId);
      savePinnedAppIds(next);
      return next;
    });
  }, []);

  return { pinnedAppIds, togglePinnedApp };
}
