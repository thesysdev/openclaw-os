"use client";

import { useChatAppContext } from "@/components/chat/ChatAppContext";
import { HomeView } from "@/components/home/HomeView";
import { MobileHomeView } from "@/components/mobile/MobileHomeView";
import { navigate } from "@/lib/hooks/useHashRoute";
import { useIsMobile } from "@/lib/hooks/useIsMobile";
import type { ReactNode } from "react";

interface Props {
  composer: ReactNode;
}

export function HomeRoute({ composer }: Props) {
  const isMobile = useIsMobile();
  const {
    threads,
    appList,
    artifactList,
    notifications,
    cronJobs,
    cronRuns,
    openNotification,
    onMarkNotificationsRead,
    setCronTrayJobId,
  } = useChatAppContext();

  const props = {
    threads,
    apps: appList,
    artifacts: artifactList,
    notifications,
    cronJobs,
    cronRuns,
    onNavigate: (view: "agents" | "apps" | "artifacts" | "crons") => navigate({ view }),
    onOpenThread: (threadId: string) => navigate({ view: "chat", sessionId: threadId }),
    onOpenApp: (appId: string) => navigate({ view: "app", appId }),
    onOpenArtifact: (artifactId: string) => navigate({ view: "artifact", artifactId }),
    onOpenNotif: async (notifId: string) => {
      const target = notifications.find((n) => n.id === notifId);
      if (target) await openNotification(target);
    },
    onMarkNotifRead: (notifId: string) => {
      void onMarkNotificationsRead([notifId]);
    },
    onMarkAllNotifsRead: async () => {
      await onMarkNotificationsRead();
    },
    onOpenCron: (jobId: string) => setCronTrayJobId(jobId),
    composer,
  };

  return (
    <div className="flex h-full min-w-0 flex-1 overflow-hidden">
      {isMobile ? <MobileHomeView {...props} /> : <HomeView {...props} />}
    </div>
  );
}
