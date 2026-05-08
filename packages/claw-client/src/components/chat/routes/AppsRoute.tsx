"use client";

import { AppsView } from "@/components/apps/AppsView";
import { useChatAppContext } from "@/components/chat/ChatAppContext";
import { MobileAppsView } from "@/components/mobile/MobileAppsView";
import { sessionRouteIdFromSessionKey } from "@/lib/chat/useGateway";
import { navigate } from "@/lib/hooks/useHashRoute";
import { useIsMobile } from "@/lib/hooks/useIsMobile";
import { Shell } from "@openuidev/react-ui";

export function AppsRoute() {
  const isMobile = useIsMobile();
  const { appList, pinnedAppIds, knownAgentIds, onDeleteApp, onRefreshApps } = useChatAppContext();
  const onOpenApp = (appId: string) => navigate({ view: "app", appId });

  return (
    <Shell.ThreadContainer>
      {isMobile ? (
        <MobileAppsView
          apps={appList}
          pinnedAppIds={pinnedAppIds}
          onOpenApp={onOpenApp}
          onDeleteApp={async (appId) => {
            await onDeleteApp(appId);
            onRefreshApps();
          }}
          onRefineApp={(app) => {
            const id = app.sessionKey
              ? sessionRouteIdFromSessionKey(app.sessionKey, knownAgentIds.current)
              : null;
            if (id) navigate({ view: "chat", sessionId: id });
          }}
        />
      ) : (
        <AppsView apps={appList} pinnedAppIds={pinnedAppIds} onOpenApp={onOpenApp} />
      )}
    </Shell.ThreadContainer>
  );
}
