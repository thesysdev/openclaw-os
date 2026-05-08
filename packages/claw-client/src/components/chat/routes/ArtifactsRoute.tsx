"use client";

import { ArtifactsView } from "@/components/artifacts/ArtifactsView";
import { useChatAppContext } from "@/components/chat/ChatAppContext";
import { MobileArtifactsView } from "@/components/mobile/MobileArtifactsView";
import { sessionRouteIdFromSessionKey } from "@/lib/chat/useGateway";
import { navigate } from "@/lib/hooks/useHashRoute";
import { useIsMobile } from "@/lib/hooks/useIsMobile";
import { Shell } from "@openuidev/react-ui";

export function ArtifactsRoute() {
  const isMobile = useIsMobile();
  const { artifacts, knownAgentIds, connectionState, onRefreshArtifacts } = useChatAppContext();

  if (!artifacts) return null;

  const onOpenArtifact = (artifactId: string) => navigate({ view: "artifact", artifactId });

  return (
    <Shell.ThreadContainer>
      {isMobile ? (
        <MobileArtifactsView
          artifacts={artifacts}
          onOpenArtifact={onOpenArtifact}
          connectionState={connectionState}
          onDeleteArtifact={async (artifactId) => {
            await artifacts.deleteArtifact(artifactId);
            onRefreshArtifacts();
          }}
          onRefineArtifact={(artifact) => {
            const id = artifact.source?.sessionId
              ? sessionRouteIdFromSessionKey(artifact.source.sessionId, knownAgentIds.current)
              : null;
            if (id) navigate({ view: "chat", sessionId: id });
          }}
        />
      ) : (
        <ArtifactsView
          artifacts={artifacts}
          onOpenArtifact={onOpenArtifact}
          connectionState={connectionState}
        />
      )}
    </Shell.ThreadContainer>
  );
}
