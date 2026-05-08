"use client";

import { useChatAppContext } from "@/components/chat/ChatAppContext";
import {
  NotificationToastViewport,
  type NotificationToastNotice,
} from "@/components/chat/NotificationToastViewport";
import { CommandPalette } from "@/components/CommandPalette";
import { CronTrayHost } from "@/components/crons/CronTrayHost";
import { navigate } from "@/lib/hooks/useHashRoute";
import type { ClawThreadListItem } from "@/types/gateway-responses";

interface Props {
  /** Toasts pushed by `useNotificationToasts`. */
  toasts: NotificationToastNotice[];
  onDismissToast: (toastId: string) => void;
  paletteOpen: boolean;
  onClosePalette: () => void;
  cronTrayJobId: string | null;
  isCurrentRouteChat: boolean;
  isMobile: boolean;
}

/**
 * The overlay stack rendered at the root of every shell — toast viewport,
 * command palette, and the cron tray when one is active. Mobile and desktop
 * shells differ in their main chrome (sidebar vs MobileShell) but share
 * these overlays exactly.
 */
export function AppOverlays({
  toasts,
  onDismissToast,
  paletteOpen,
  onClosePalette,
  cronTrayJobId,
  isCurrentRouteChat,
  isMobile,
}: Props) {
  const {
    threads,
    appList,
    artifactList,
    cronJobs,
    cronRuns,
    setCronTrayJobId,
    onUpdateCronJob,
    onRunCronJob,
    onRemoveCronJob,
    onRefreshCronData,
    openNotification,
  } = useChatAppContext();

  return (
    <>
      <NotificationToastViewport
        toasts={toasts}
        onDismiss={onDismissToast}
        onOpen={(notification, toastId) => {
          onDismissToast(toastId);
          void openNotification(notification);
        }}
      />
      <CommandPalette
        open={paletteOpen}
        onClose={onClosePalette}
        threads={threads as unknown as ClawThreadListItem[]}
        apps={appList}
        artifacts={artifactList}
        onTarget={(target) => {
          if (target.kind === "thread") {
            navigate({ view: "chat", sessionId: target.threadId });
          } else if (target.kind === "app") {
            navigate({ view: "app", appId: target.appId });
          } else if (target.kind === "artifact") {
            navigate({ view: "artifact", artifactId: target.artifactId });
          } else if (target.kind === "command") {
            // Focus the composer and prime it with the command. If user isn't
            // in a chat, drop them into the home route first so the composer
            // is visible.
            if (!isCurrentRouteChat) navigate({ view: "home" });
            const evt = new CustomEvent("openclaw-os:prime-composer", {
              detail: { text: `/${target.command.name} ` },
            });
            window.dispatchEvent(evt);
          }
        }}
      />
      {cronTrayJobId ? (
        <CronTrayHost
          jobId={cronTrayJobId}
          cronJobs={cronJobs}
          runs={cronRuns}
          threads={threads}
          isMobile={isMobile}
          onClose={() => setCronTrayJobId(null)}
          onOpenThread={(threadId) => {
            setCronTrayJobId(null);
            navigate({ view: "chat", sessionId: threadId });
          }}
          onUpdateCronJob={onUpdateCronJob}
          onRunCronJob={onRunCronJob}
          onRemoveCronJob={onRemoveCronJob}
          onRefreshCronData={onRefreshCronData}
        />
      ) : null}
    </>
  );
}
