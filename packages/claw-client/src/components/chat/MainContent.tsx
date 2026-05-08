"use client";

import { useChatAppContext } from "@/components/chat/ChatAppContext";
import { FullscreenAppArtifactRoute } from "@/components/chat/FullscreenAppArtifactRoute";
import { AgentsRoute } from "@/components/chat/routes/AgentsRoute";
import { AppsRoute } from "@/components/chat/routes/AppsRoute";
import { ArtifactsRoute } from "@/components/chat/routes/ArtifactsRoute";
import { CronsRoute } from "@/components/chat/routes/CronsRoute";
import { HomeRoute } from "@/components/chat/routes/HomeRoute";
import type { ReactNode } from "react";

export type Route =
  | { view: "home" }
  | { view: "agents" }
  | { view: "apps" }
  | { view: "artifacts" }
  | { view: "crons"; selectedId?: string }
  | { view: "app"; appId: string }
  | { view: "artifact"; artifactId: string }
  | { view: "chat"; sessionId: string };

interface Props {
  route: Route;
  homeComposer: ReactNode;
  /** Rendered for `route.view === "chat"` and as the fallback when an
   *  app/artifact deep-link arrives before the engine stores have landed. */
  threadArea: ReactNode;
}

/**
 * Thin dispatcher — picks the route component to render for the active view.
 * Each route reads what it needs from `<ChatAppProvider>`. The chat surface
 * stays as a passed-in slot because it depends on a lot of chat-specific
 * props that don't belong in the cross-route context.
 */
export function MainContent({ route, homeComposer, threadArea }: Props) {
  const { apps, artifacts } = useChatAppContext();

  switch (route.view) {
    case "home":
      return <HomeRoute composer={homeComposer} />;
    case "agents":
      return <AgentsRoute />;
    case "apps":
      return <AppsRoute />;
    case "artifacts":
      // Pre-connect deep-link: the engine's artifact store hasn't landed yet.
      // Fall through to the chat surface rather than render an empty shell.
      if (!artifacts) return <>{threadArea}</>;
      return <ArtifactsRoute />;
    case "crons":
      return <CronsRoute initialSelectedId={route.selectedId} />;
    case "app":
    case "artifact":
      // Same fallthrough — `/apps/<id>` opened cold has no `apps` store yet.
      if (route.view === "app" && !apps) return <>{threadArea}</>;
      if (route.view === "artifact" && !artifacts) return <>{threadArea}</>;
      return <FullscreenAppArtifactRoute route={route} />;
    default:
      return <>{threadArea}</>;
  }
}
