"use client";

import { Bot, Wrench, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { HeaderIconButton } from "@/components/layout/HeaderIconButton";
import { MobileButton } from "@/components/mobile/MobileButton";
import { SegmentedTabs } from "@/components/ui/SegmentedTabs";
import { ConnectionState } from "@/lib/gateway/types";
import { validateGatewayUrl } from "@/lib/gateway/url";
import { useBodyScrollLock } from "@/lib/hooks/useBodyScrollLock";
import type { Settings } from "@/lib/storage";

const INSTALL_COMMAND =
  "curl -fsSL https://raw.githubusercontent.com/thesysdev/openclaw-os/main/scripts/setup-tunnel.mjs -o /tmp/claw-setup.mjs && node /tmp/claw-setup.mjs";

function MobileAutomatedSetup() {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(INSTALL_COMMAND);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard permission denied — ignore */
    }
  };
  return (
    <div className="flex flex-col gap-ml">
      <div className="flex flex-col gap-xs">
        <label className="font-label text-sm font-medium text-text-neutral-secondary">
          Run this on your Mac Mini:
        </label>
        <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg border border-border-default bg-sunk-light px-m py-s font-mono text-sm text-text-neutral-secondary dark:border-border-default/16 dark:bg-foreground">
          {INSTALL_COMMAND}
        </pre>
        <MobileButton variant="primary" fullWidth onClick={handleCopy}>
          {copied ? "Copied!" : "Copy"}
        </MobileButton>
      </div>
      <p className="text-sm text-text-neutral-tertiary">
        This command provisions a Cloudflare Tunnel, installs{" "}
        <code className="rounded bg-foreground px-1 font-mono">cloudflared</code> as a system
        service, and prints a link to open in your browser. You&apos;ll need{" "}
        <code className="rounded bg-foreground px-1 font-mono">sudo</code> access and Node.js 18+.
      </p>
    </div>
  );
}

interface Props {
  open: boolean;
  currentSettings: Settings | null;
  connectionState: ConnectionState;
  onClose: () => void;
  onSave: (settings: Settings) => void;
}

type Tab = "automated" | "manual";

export function MobileSettingsDialog({
  open,
  currentSettings,
  connectionState,
  onClose,
  onSave,
}: Props) {
  useBodyScrollLock(open);

  const [tab, setTab] = useState<Tab>("automated");
  const [gatewayUrl, setGatewayUrl] = useState(currentSettings?.gatewayUrl ?? "");
  const [token, setToken] = useState(currentSettings?.token ?? "");
  const [pending, setPending] = useState(false);
  // See SettingsDialog for the snapshot-based race rationale.
  const submitSnapshotRef = useRef<ConnectionState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setGatewayUrl(currentSettings?.gatewayUrl ?? "");
    setToken(currentSettings?.token ?? "");
    setPending(false);
    submitSnapshotRef.current = null;
    setError(null);
  }, [open]);

  useEffect(() => {
    if (!pending) return;
    const snapshot = submitSnapshotRef.current;
    if (snapshot !== null && connectionState === snapshot) return;
    if (connectionState === ConnectionState.CONNECTED) {
      setPending(false);
      submitSnapshotRef.current = null;
      setError(null);
      onClose();
    } else if (connectionState === ConnectionState.UNREACHABLE) {
      setPending(false);
      submitSnapshotRef.current = null;
      setError("Couldn't reach the gateway at that URL. Check the address and try again.");
    } else if (connectionState === ConnectionState.AUTH_FAILED) {
      setPending(false);
      submitSnapshotRef.current = null;
      setError("Gateway rejected the auth token. Run `openclaw auth token` to get a fresh one.");
    }
  }, [pending, connectionState, onClose]);

  if (!open) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedUrl = gatewayUrl.trim();
    const validation = validateGatewayUrl(trimmedUrl);
    if (!validation.ok) {
      setError(validation.error);
      return;
    }
    const trimmedToken = token.trim() || undefined;
    const credsChanged =
      trimmedUrl !== currentSettings?.gatewayUrl || trimmedToken !== currentSettings?.token;
    const next: Settings = {
      gatewayUrl: trimmedUrl,
      token: trimmedToken,
      deviceToken: credsChanged ? undefined : currentSettings?.deviceToken,
    };
    setError(null);
    setPending(true);
    submitSnapshotRef.current = connectionState;
    onSave(next);
  };

  return (
    <div className="fixed inset-0 z-[80] flex flex-col bg-background">
      <header
        className="flex shrink-0 items-center justify-between gap-s bg-background px-ml py-m"
        style={{ paddingTop: "max(12px, env(safe-area-inset-top))" }}
      >
        <h2 className="font-heading text-md font-bold text-text-neutral-primary">Settings</h2>
        <HeaderIconButton onClick={onClose} label="Close settings">
          <X size={18} />
        </HeaderIconButton>
      </header>

      <div
        className="min-h-0 flex-1 overflow-y-auto px-ml pb-ml pt-m"
        style={{ paddingBottom: "max(16px, env(safe-area-inset-bottom))" }}
      >
        <SegmentedTabs<Tab>
          value={tab}
          onChange={setTab}
          options={[
            { value: "automated", label: "Automated", icon: Bot },
            { value: "manual", label: "Manual", icon: Wrench },
          ]}
          ariaLabel="Setup mode"
        />

        {tab === "automated" ? (
          <div className="mt-ml">
            <MobileAutomatedSetup />
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="mt-ml flex flex-col gap-ml">
            <p className="text-sm text-text-neutral-tertiary">
              Connect Claw to your OpenClaw gateway. Run{" "}
              <code className="rounded bg-foreground px-1 font-mono">openclaw config show</code> in
              a terminal to see your gateway URL and token.
            </p>

            <div className="flex flex-col gap-xs">
              <label className="font-label text-sm font-medium text-text-neutral-secondary">
                Gateway URL
              </label>
              <input
                type="url"
                required
                placeholder="ws://localhost:18789"
                value={gatewayUrl}
                onChange={(e) => setGatewayUrl(e.target.value)}
                disabled={pending}
                className="h-11 rounded-lg border border-border-default bg-background px-m text-sm text-text-neutral-primary outline-none placeholder:text-text-neutral-tertiary focus:ring-2 focus:ring-border-default disabled:opacity-60 dark:border-border-default/16 dark:bg-foreground"
              />
              <p className="text-sm text-text-neutral-tertiary">
                Use <code className="font-mono">ws://</code> for local,{" "}
                <code className="font-mono">wss://</code> for remote.
              </p>
            </div>

            <div className="flex flex-col gap-xs">
              <label className="font-label text-sm font-medium text-text-neutral-secondary">
                Auth Token
              </label>
              <input
                type="password"
                placeholder="Paste your token here"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                disabled={pending}
                className="h-11 rounded-lg border border-border-default bg-background px-m text-sm text-text-neutral-primary outline-none placeholder:text-text-neutral-tertiary focus:ring-2 focus:ring-border-default disabled:opacity-60 dark:border-border-default/16 dark:bg-foreground"
              />
              <p className="text-sm text-text-neutral-tertiary">
                Run{" "}
                <code className="rounded bg-foreground px-1 font-mono">openclaw auth token</code> to
                get your token. Stored locally — only needed once per device.
              </p>
            </div>

            {error ? (
              <div
                role="alert"
                className="rounded-lg border border-status-error bg-danger-background px-m py-s text-sm text-text-danger-primary"
              >
                {error}
              </div>
            ) : null}

            {pending ? (
              <div className="flex items-center gap-s text-sm text-text-neutral-tertiary">
                <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-status-warning" />
                Connecting to {gatewayUrl.trim()}…
              </div>
            ) : null}

            <MobileButton type="submit" variant="primary" fullWidth disabled={pending}>
              {pending ? "Connecting…" : "Save & Connect"}
            </MobileButton>
          </form>
        )}
      </div>
    </div>
  );
}
