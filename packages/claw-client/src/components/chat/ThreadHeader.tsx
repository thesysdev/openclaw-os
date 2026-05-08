"use client";

import { AgentTopBar } from "@/components/chat/AgentTopBar";
import { smartBack } from "@/components/chat/smart-back";
import { TopBar } from "@/components/chat/TopBar";
import { MobileAgentTopBar } from "@/components/mobile/MobileAgentTopBar";
import { navigate } from "@/lib/hooks/useHashRoute";
import type { ClawThread } from "@/types/claw-thread";
import { ArrowLeft } from "lucide-react";

interface Props {
  allThreads: ClawThread[];
  selectedThreadId: string | null;
  isMobile: boolean;
  createSession: (agentId: string) => Promise<string | null>;
  deleteSession: (threadId: string) => Promise<boolean>;
  renameSession: (threadId: string, label: string) => Promise<boolean>;
  onOpenMobileWorkspace: () => void;
}

/**
 * Chat header — picks Mobile vs Desktop AgentTopBar, derives the agent map
 * + sessions list for the current thread, and falls back to a placeholder
 * `TopBar` while a freshly-created session hasn't reached `loadThreads` yet.
 */
export function ThreadHeader({
  allThreads,
  selectedThreadId,
  isMobile,
  createSession,
  deleteSession,
  renameSession,
  onOpenMobileWorkspace,
}: Props) {
  const currentThread = allThreads.find((t) => t.id === selectedThreadId);

  // Fresh-session race: createSession resolves and we navigate to the new
  // thread id before `loadThreads` has pushed it into the list. Render a
  // minimal placeholder so the chat surface still has chrome.
  if (!currentThread) {
    return (
      <TopBar
        leading={
          <button
            type="button"
            onClick={() => navigate({ view: isMobile ? "agents" : "home" })}
            className="flex h-8 w-8 items-center justify-center rounded-m text-text-neutral-secondary hover:bg-foreground"
            aria-label="Back"
          >
            <ArrowLeft size={16} />
          </button>
        }
      >
        <span className="font-heading text-md font-medium text-text-neutral-primary">New chat</span>
      </TopBar>
    );
  }

  const currentAgentId = currentThread.clawAgentId ?? currentThread.id;

  // agentId → main thread title (or first thread title as fallback).
  const agentNameMap = new Map<string, string>();
  for (const t of allThreads) {
    const aid = t.clawAgentId ?? t.id;
    if (!agentNameMap.has(aid)) agentNameMap.set(aid, aid);
    if (t.clawKind === "main") agentNameMap.set(aid, t.title);
  }
  const allAgents = [...agentNameMap.entries()].map(([id, name]) => ({ id, name }));
  const sessions = allThreads.filter((t) => (t.clawAgentId ?? t.id) === currentAgentId);

  const findMain = (agentId: string): ClawThread | undefined =>
    allThreads.find((t) => (t.clawAgentId ?? t.id) === agentId && t.clawKind === "main") ??
    allThreads.find((t) => (t.clawAgentId ?? t.id) === agentId);

  const onSwitchAgent = (a: { id: string }) => {
    const target = findMain(a.id);
    if (target) navigate({ view: "chat", sessionId: target.id });
  };
  const onSelectSession = (threadId: string) => navigate({ view: "chat", sessionId: threadId });
  const onNewSession = async () => {
    const newId = await createSession(currentAgentId);
    if (newId) navigate({ view: "chat", sessionId: newId });
  };
  const onDeleteSession = async () => {
    await deleteSession(currentThread.id);
    navigate({ view: "agents" });
  };
  const onDeleteAgent = async () => {
    const main = findMain(currentAgentId);
    if (main) {
      await deleteSession(main.id);
      navigate({ view: "agents" });
    }
  };

  if (isMobile) {
    return (
      <MobileAgentTopBar
        agent={{ id: currentAgentId, name: agentNameMap.get(currentAgentId) ?? currentAgentId }}
        allAgents={allAgents}
        activeSession={{ id: currentThread.id, title: currentThread.title }}
        sessions={sessions}
        onBack={smartBack(() => navigate({ view: "agents" }))}
        onSwitchAgent={onSwitchAgent}
        onSelectSession={onSelectSession}
        onNewSession={onNewSession}
        onOpenWorkspace={onOpenMobileWorkspace}
        onDeleteSession={onDeleteSession}
        onDeleteAgent={onDeleteAgent}
      />
    );
  }

  return (
    <AgentTopBar
      agent={{ id: currentAgentId, name: agentNameMap.get(currentAgentId) ?? currentAgentId }}
      allAgents={allAgents}
      activeSession={{ id: currentThread.id, title: currentThread.title }}
      sessions={sessions}
      onBack={() => navigate({ view: "home" })}
      onSwitchAgent={onSwitchAgent}
      onSelectSession={onSelectSession}
      onNewSession={onNewSession}
      onRenameSession={async (next) => {
        await renameSession(currentThread.id, next);
      }}
      onDeleteSession={onDeleteSession}
      // Renaming the agent = renaming its main thread (the one whose title
      // bubbles up as the agent name in the sidebar).
      onRenameAgent={async (next) => {
        const main = findMain(currentAgentId);
        if (main) await renameSession(main.id, next);
      }}
      onDeleteAgent={onDeleteAgent}
    />
  );
}
