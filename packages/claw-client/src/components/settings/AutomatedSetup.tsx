"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/Button";

const INSTALL_COMMAND =
  "curl -fsSL https://raw.githubusercontent.com/thesysdev/openclaw-os/main/scripts/setup-tunnel.mjs -o /tmp/claw-setup.mjs && node /tmp/claw-setup.mjs";

export function AutomatedSetup() {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(INSTALL_COMMAND);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex flex-col gap-l">
      <div className="flex flex-col gap-xs">
        <label className="font-label text-sm font-medium text-text-neutral-secondary">
          Run this on your Mac Mini:
        </label>
        <pre
          className="overflow-auto whitespace-pre-wrap break-all rounded-lg border border-border-default bg-sunk-light p-m font-mono text-sm text-text-neutral-secondary dark:border-border-default/16 dark:bg-elevated"
          style={{ height: 120 }}
        >
          {INSTALL_COMMAND}
        </pre>
        <Button
          variant="secondary"
          size="md"
          icon={copied ? Check : Copy}
          onClick={handleCopy}
          className="mt-xs w-full justify-center"
        >
          {copied ? "Copied" : "Copy command"}
        </Button>
      </div>

      <p className="font-body text-md leading-snug text-text-neutral-tertiary">
        This command provisions a Cloudflare Tunnel, installs{" "}
        <code className="rounded bg-sunk-light px-3xs font-mono text-sm dark:bg-elevated">
          cloudflared
        </code>{" "}
        as a system service, and prints a link to open in your browser. You&apos;ll need{" "}
        <code className="rounded bg-sunk-light px-3xs font-mono text-sm dark:bg-elevated">
          sudo
        </code>{" "}
        access and Node.js 18+.
      </p>
    </div>
  );
}
