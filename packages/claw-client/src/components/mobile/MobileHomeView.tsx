"use client";

import {
  Cpu,
  FileText,
  Image as ImageIcon,
  LayoutGrid,
  Plus,
  ScrollText,
  Table2,
} from "lucide-react";
import { useMemo } from "react";

import { AgentCard, type AgentCardData } from "@/components/cards/AgentCard";
import { Greeting } from "@/components/home/Greeting";
import {
  APP_EXAMPLE_PROMPT,
  ARTIFACT_EXAMPLE_PROMPT,
  primeComposer,
  type HomeViewProps,
} from "@/components/home/HomeView";
import { SectionHeader } from "@/components/home/SectionHeader";
import { MobileButton } from "@/components/mobile/MobileButton";
import { MobileCronRow } from "@/components/mobile/MobileCronRow";
import { MobileListCard, MobileListRow } from "@/components/mobile/MobileListRow";
import { Button } from "@/components/ui/Button";
import { Counter } from "@/components/ui/Counter";
import type { ClawThread } from "@/types/claw-thread";

const ARTIFACT_ICON: Record<string, typeof FileText> = {
  doc: FileText,
  csv: Table2,
  image: ImageIcon,
};

function buildAgents(threads: ClawThread[]): AgentCardData[] {
  const map = new Map<string, { id: string; name: string; threadCount: number }>();
  for (const t of threads) {
    const id = t.clawAgentId ?? t.id;
    const existing = map.get(id);
    if (!existing) {
      map.set(id, { id, name: t.clawKind === "main" ? t.title : id, threadCount: 1 });
    } else {
      existing.threadCount += 1;
      if (t.clawKind === "main") existing.name = t.title;
    }
  }
  return [...map.values()].map((g) => ({
    id: g.id,
    name: g.name,
    icon: Cpu,
    status: "idle",
    unread: 0,
  }));
}

function truncate(value: string, max = 48): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function ViewAllButton({ count, onClick }: { count: number; onClick: () => void }) {
  return (
    <MobileButton variant="secondary" fullWidth onClick={onClick} className="mt-s">
      <span>View all</span>
      <Counter size="md" color="neutral" kind="secondary">
        {count}
      </Counter>
    </MobileButton>
  );
}

export function MobileHomeView({
  threads,
  apps,
  artifacts,
  cronJobs,
  userName,
  composer,
  onNavigate,
  onOpenThread,
  onOpenApp,
  onOpenArtifact,
  onOpenCron,
}: HomeViewProps) {
  const agents = useMemo(() => buildAgents(threads as ClawThread[]), [threads]);
  const recentApps = useMemo(
    () => [...apps].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [apps],
  );
  const recentArtifacts = useMemo(
    () => [...artifacts].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [artifacts],
  );
  const visibleCrons = useMemo(() => cronJobs.slice(0, 3), [cronJobs]);

  const openAgent = (agent: AgentCardData) => {
    const main = (threads as ClawThread[]).find(
      (t) => (t.clawAgentId ?? t.id) === agent.id && t.clawKind === "main",
    );
    if (main) onOpenThread(main.id);
  };

  return (
    <div className="claw-fade-in flex h-full flex-1 flex-col overflow-hidden bg-background">
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1080px] px-ml pb-ml pt-ml">
          <Greeting name={userName} />

          <section className="mb-ml">
            <SectionHeader title="Top agents" />
            {agents.length === 0 ? (
              <div className="flex min-h-[130px] flex-col items-center justify-center gap-m rounded-2xl border border-dashed border-border-default px-ml text-sm text-text-neutral-tertiary">
                <p>Get work done with your first agent.</p>
                <Button variant="primary" size="md" icon={Plus}>
                  Create agent
                </Button>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-s">
                  {agents.slice(0, 4).map((a) => (
                    <AgentCard key={a.id} agent={a} onClick={() => openAgent(a)} />
                  ))}
                </div>
                <ViewAllButton count={agents.length} onClick={() => onNavigate("agents")} />
              </>
            )}
          </section>

          <section className="mb-ml">
            <SectionHeader title="Top apps" />
            {recentApps.length === 0 ? (
              <div className="flex min-h-[150px] flex-col items-center justify-center gap-m rounded-2xl border border-dashed border-border-default/70 px-ml text-center font-body text-sm text-text-neutral-tertiary dark:border-border-default">
                <p>
                  Ask your agent to create dashboards,
                  <br />
                  work trackers, marketing calendars, etc.
                </p>
                <Button
                  variant="secondary"
                  size="md"
                  onClick={() => primeComposer(APP_EXAMPLE_PROMPT, true)}
                >
                  Create an example
                </Button>
              </div>
            ) : (
              <MobileListCard>
                {recentApps.slice(0, 6).map((app) => (
                  <MobileListRow
                    key={app.id}
                    icon={LayoutGrid}
                    title={app.title}
                    subtitle={`by ${truncate(app.agentId)}`}
                    category="app"
                    onClick={() => onOpenApp(app.id)}
                  />
                ))}
              </MobileListCard>
            )}
            {recentApps.length > 0 ? (
              <ViewAllButton count={recentApps.length} onClick={() => onNavigate("apps")} />
            ) : null}
          </section>

          <section className="mb-ml">
            <SectionHeader title="Recent artifacts" />
            {recentArtifacts.length === 0 ? (
              <div className="flex min-h-[150px] flex-col items-center justify-center gap-m rounded-2xl border border-dashed border-border-default/70 px-ml text-center font-body text-sm text-text-neutral-tertiary dark:border-border-default">
                <p>
                  Ask your agent to create
                  <br />
                  slides and reports.
                </p>
                <Button
                  variant="secondary"
                  size="md"
                  onClick={() => primeComposer(ARTIFACT_EXAMPLE_PROMPT, true)}
                >
                  Create an example
                </Button>
              </div>
            ) : (
              <MobileListCard>
                {recentArtifacts.slice(0, 3).map((art) => {
                  const Icon = ARTIFACT_ICON[art.kind] ?? ScrollText;
                  return (
                    <MobileListRow
                      key={art.id}
                      icon={Icon}
                      title={art.title}
                      subtitle={`by ${truncate(art.source.agentId)}`}
                      category="artifact"
                      onClick={() => onOpenArtifact(art.id)}
                    />
                  );
                })}
              </MobileListCard>
            )}
            {recentArtifacts.length > 0 ? (
              <ViewAllButton
                count={recentArtifacts.length}
                onClick={() => onNavigate("artifacts")}
              />
            ) : null}
          </section>

          <section className="mb-3xl">
            <SectionHeader title="Cron Jobs" />
            {visibleCrons.length === 0 ? (
              <div className="flex min-h-[150px] items-center justify-center rounded-2xl border border-dashed border-border-default px-ml text-center text-sm text-text-neutral-tertiary">
                <p>
                  Ask your agent to schedule recurring jobs
                  <br />
                  like daily digests or weekly reports.
                </p>
              </div>
            ) : (
              <MobileListCard>
                {visibleCrons.map((job) => (
                  <MobileCronRow
                    key={job.id}
                    job={job}
                    threads={threads}
                    onClick={() => onOpenCron?.(job.id)}
                  />
                ))}
              </MobileListCard>
            )}
            {cronJobs.length > 0 ? (
              <ViewAllButton count={cronJobs.length} onClick={() => onNavigate("crons")} />
            ) : null}
          </section>
        </div>
      </div>

      {/* Sticky composer footer — same SessionComposer used in chat. */}
      {composer ? <div className="shrink-0 bg-background px-ml pb-s pt-xs">{composer}</div> : null}
    </div>
  );
}
