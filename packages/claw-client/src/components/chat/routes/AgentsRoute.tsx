"use client";

import { AgentsView } from "@/components/agents/AgentsView";
import { useChatAppContext } from "@/components/chat/ChatAppContext";
import { MobileAgentsView } from "@/components/mobile/MobileAgentsView";
import { navigate } from "@/lib/hooks/useHashRoute";
import { useIsMobile } from "@/lib/hooks/useIsMobile";
import { Shell } from "@openuidev/react-ui";

export function AgentsRoute() {
  const isMobile = useIsMobile();
  const { threads } = useChatAppContext();
  const onOpenThread = (threadId: string) => navigate({ view: "chat", sessionId: threadId });

  return (
    <Shell.ThreadContainer>
      {isMobile ? (
        <MobileAgentsView threads={threads} onOpenThread={onOpenThread} />
      ) : (
        <AgentsView threads={threads} onOpenThread={onOpenThread} />
      )}
    </Shell.ThreadContainer>
  );
}
