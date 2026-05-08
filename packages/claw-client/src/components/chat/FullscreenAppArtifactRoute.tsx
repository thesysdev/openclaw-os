"use client";

import { AppDetail } from "@/components/apps/AppDetail";
import { ArtifactDetail } from "@/components/artifacts/ArtifactDetail";
import { useChatAppContext } from "@/components/chat/ChatAppContext";
import { smartBack } from "@/components/chat/smart-back";
import { MobileAppDetail } from "@/components/mobile/MobileAppDetail";
import { MobileArtifactDetail } from "@/components/mobile/MobileArtifactDetail";
import { navigate } from "@/lib/hooks/useHashRoute";
import { useIsMobile } from "@/lib/hooks/useIsMobile";
import { buildAppSiblings, buildArtifactSiblings, makeAgentNameResolver } from "@/lib/siblings";
import { useMemo } from "react";

type Route = { view: "app"; appId: string } | { view: "artifact"; artifactId: string };

interface Props {
  route: Route;
}

/**
 * Full-screen route for standalone app/artifact URLs (`#/apps/<id>`,
 * `#/artifacts/<id>`). Mirrors the in-chat preview modal so the UX is
 * identical whether the user lands here from sidebar nav, the home page,
 * or an in-thread workspace tile.
 */
export function FullscreenAppArtifactRoute({ route }: Props) {
  const isMobile = useIsMobile();
  const {
    apps,
    artifacts,
    threads,
    appList,
    artifactList,
    pinnedAppIds,
    onTogglePinned,
    onRefreshApps,
    onRefreshArtifacts,
    onRefineApp,
    onRefineArtifact,
    onAppContinueConversation,
  } = useChatAppContext();

  const activeAppUpdatedAt = useMemo(
    () => (route.view === "app" ? appList.find((a) => a.id === route.appId)?.updatedAt : undefined),
    [appList, route],
  );
  const activeArtifactUpdatedAt = useMemo(
    () =>
      route.view === "artifact"
        ? artifactList.find((a) => a.id === route.artifactId)?.updatedAt
        : undefined,
    [artifactList, route],
  );

  const agentNameFor = makeAgentNameResolver(threads);
  const appSiblings = buildAppSiblings(appList, agentNameFor);
  const artifactSiblings = buildArtifactSiblings(artifactList, agentNameFor);

  if (isMobile && route.view === "app" && apps) {
    return (
      <MobileAppDetail
        appId={route.appId}
        apps={apps}
        updatedAt={activeAppUpdatedAt}
        onContinueConversation={onAppContinueConversation}
        onRefine={onRefineApp}
        onDeleted={onRefreshApps}
        onClose={smartBack(() => navigate({ view: "apps" }))}
        siblings={appSiblings}
        onSwitch={(nextAppId) => navigate({ view: "app", appId: nextAppId })}
      />
    );
  }

  if (isMobile && route.view === "artifact" && artifacts) {
    return (
      <MobileArtifactDetail
        artifactId={route.artifactId}
        artifacts={artifacts}
        updatedAt={activeArtifactUpdatedAt}
        onRefine={onRefineArtifact}
        onDeleted={onRefreshArtifacts}
        onClose={smartBack(() => navigate({ view: "artifacts" }))}
        siblings={artifactSiblings}
        onSwitch={(nextArtId) => navigate({ view: "artifact", artifactId: nextArtId })}
      />
    );
  }

  return (
    <div className="relative flex h-full min-w-0 flex-1 bg-background dark:bg-sunk">
      <div className="flex min-w-0 flex-1 flex-col">
        {route.view === "app" && apps ? (
          <AppDetail
            appId={route.appId}
            apps={apps}
            updatedAt={activeAppUpdatedAt}
            mode="panel"
            isPinned={pinnedAppIds.has(route.appId)}
            onTogglePinned={onTogglePinned}
            onRefine={onRefineApp}
            onContinueConversation={onAppContinueConversation}
            onDeleted={() => {
              onRefreshApps();
              navigate({ view: "home" });
            }}
            onClose={() => navigate({ view: "home" })}
            siblings={appSiblings}
            onSwitch={(nextAppId) => navigate({ view: "app", appId: nextAppId })}
          />
        ) : null}
        {route.view === "artifact" && artifacts ? (
          <ArtifactDetail
            artifactId={route.artifactId}
            artifacts={artifacts}
            updatedAt={activeArtifactUpdatedAt}
            mode="panel"
            onDeleted={() => {
              onRefreshArtifacts();
              navigate({ view: "home" });
            }}
            onClose={() => navigate({ view: "home" })}
            onRefine={onRefineArtifact}
            siblings={artifactSiblings}
            onSwitch={(nextArtId) => navigate({ view: "artifact", artifactId: nextArtId })}
          />
        ) : null}
      </div>
    </div>
  );
}
