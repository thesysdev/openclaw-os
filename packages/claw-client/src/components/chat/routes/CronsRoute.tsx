"use client";

import { useChatAppContext } from "@/components/chat/ChatAppContext";
import { CronsView } from "@/components/crons/CronsView";
import { MobileCronsView } from "@/components/mobile/MobileCronsView";
import { navigate } from "@/lib/hooks/useHashRoute";
import { useIsMobile } from "@/lib/hooks/useIsMobile";
import { Shell } from "@openuidev/react-ui";

interface Props {
  initialSelectedId: string | undefined;
}

export function CronsRoute({ initialSelectedId }: Props) {
  const isMobile = useIsMobile();
  const {
    cronJobs,
    cronRuns,
    threads,
    onUpdateCronJob,
    onRunCronJob,
    onRemoveCronJob,
    onRefreshCronData,
  } = useChatAppContext();

  const props = {
    cronJobs,
    runs: cronRuns,
    threads,
    initialSelectedId,
    onOpenThread: (threadId: string) => navigate({ view: "chat", sessionId: threadId }),
    onUpdateCronJob,
    onRunCronJob,
    onRemoveCronJob,
    onRefreshCronData,
  };

  return (
    <Shell.ThreadContainer>
      {isMobile ? <MobileCronsView {...props} /> : <CronsView {...props} />}
    </Shell.ThreadContainer>
  );
}
