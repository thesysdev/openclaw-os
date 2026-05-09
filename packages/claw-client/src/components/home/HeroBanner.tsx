"use client";

/**
 * Hero banner for OpenClaw OS - appears on the home page.
 * On mobile, displays "Meet OpenClaw OS" as the main message.
 */
export function HeroBanner() {
  return (
    <a
      href="https://www.openui.com/openclaw-os"
      target="_blank"
      rel="noopener noreferrer"
      className="mb-m block w-full overflow-hidden rounded-2xl bg-gradient-to-br from-blue-500/10 via-purple-500/10 to-pink-500/10 border border-border-default/50 transition-all hover:shadow-lg dark:border-border-default/20"
    >
      <div className="px-ml py-m">
        <h2 className="font-heading text-lg font-bold text-text-neutral-primary">
          Meet OpenClaw OS
        </h2>
        <p className="mt-xs font-body text-sm text-text-neutral-secondary">
          The generative UI workspace for OpenClaw
        </p>
      </div>
    </a>
  );
}

/**
 * Mobile-optimized hero banner - shows only the main message
 */
export function MobileHeroBanner() {
  return (
    <a
      href="https://www.openui.com/openclaw-os"
      target="_blank"
      rel="noopener noreferrer"
      className="mb-m block w-full overflow-hidden rounded-2xl bg-gradient-to-br from-blue-500/10 via-purple-500/10 to-pink-500/10 border border-border-default/50 transition-all active:scale-[0.98] dark:border-border-default/20"
    >
      <div className="px-ml py-m text-center">
        <h2 className="font-heading text-lg font-bold text-text-neutral-primary">
          Meet OpenClaw OS
        </h2>
      </div>
    </a>
  );
}
