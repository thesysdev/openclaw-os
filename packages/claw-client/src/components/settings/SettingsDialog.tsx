"use client";

import { Wifi, WifiOff, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { IconButton } from "@/components/layout/sidebar/IconButton";
import { Button } from "@/components/ui/Button";
import { ConnectionState } from "@/lib/gateway/types";
import { validateGatewayUrl } from "@/lib/gateway/url";
import type { Settings } from "@/lib/storage";

interface Props {
  open: boolean;
  currentSettings: Settings | null;
  connectionState: ConnectionState;
  onClose: () => void;
  onSave: (settings: Settings) => void;
}

const STATUS_BANNER: Record<
  ConnectionState,
  {
    label: string;
    description: string;
    /** Color applied to the icon — paired with neutral title + neutral surface. */
    accent: string;
    /** Tile background tint matching the accent. */
    tileBg: string;
    /** Tailwind class for the tile's stroke. Uses the `/N` alpha modifier on
     *  the matching border token so the stroke comes through colored but
     *  subtle — paired-down to match the visual weight of the colored Tag
     *  strokes in the sidebar. Token swap handles dark mode automatically. */
    tileBorder: string;
    icon: typeof Wifi;
    /** When true, the icon pulses to convey "in flight" — used for the
     *  CONNECTING / PAIRING transitional states. */
    pulse?: boolean;
  }
> = {
  [ConnectionState.CONNECTED]: {
    label: "Connected",
    description: "The gateway is reachable and ready.",
    accent: "text-text-success-primary",
    tileBg: "bg-success-background",
    tileBorder: "border-border-success/50",
    icon: Wifi,
  },
  [ConnectionState.CONNECTING]: {
    label: "Connecting…",
    description: "Reaching the gateway — hold on.",
    accent: "text-text-alert-primary",
    tileBg: "bg-alert-background",
    tileBorder: "border-border-alert/50",
    icon: Wifi,
    pulse: true,
  },
  [ConnectionState.PAIRING]: {
    label: "Pairing…",
    description: "Waiting for the gateway handshake.",
    accent: "text-text-alert-primary",
    tileBg: "bg-alert-background",
    tileBorder: "border-border-alert/50",
    icon: Wifi,
    pulse: true,
  },
  [ConnectionState.DISCONNECTED]: {
    label: "Disconnected",
    description: "Add a gateway URL below or run the setup command.",
    accent: "text-text-danger-primary",
    tileBg: "bg-danger-background",
    tileBorder: "border-border-danger/50",
    icon: WifiOff,
  },
  [ConnectionState.AUTH_FAILED]: {
    label: "Auth failed",
    description: "The token was rejected. Re-run `openclaw onboard` for a fresh one.",
    accent: "text-text-danger-primary",
    tileBg: "bg-danger-background",
    tileBorder: "border-border-danger/50",
    icon: WifiOff,
  },
  [ConnectionState.UNREACHABLE]: {
    label: "Unreachable",
    description: "Couldn't reach the gateway. Check the URL and try again.",
    accent: "text-text-danger-primary",
    tileBg: "bg-danger-background",
    tileBorder: "border-border-danger/50",
    icon: WifiOff,
  },
};

export function SettingsDialog({ open, currentSettings, connectionState, onClose, onSave }: Props) {
  const [gatewayUrl, setGatewayUrl] = useState(currentSettings?.gatewayUrl ?? "");
  const [token, setToken] = useState(currentSettings?.token ?? "");
  // `pending` = user clicked Save & Connect and we're awaiting the engine's
  // resolution. We hold the dialog open and watch `connectionState` to decide
  // whether to close (CONNECTED) or surface an inline error (UNREACHABLE /
  // AUTH_FAILED). Without this gate, save would close the dialog before the
  // user could see whether their URL/token actually worked.
  const [pending, setPending] = useState(false);
  // Two races to defeat:
  //   1. User clicks Save while state=CONNECTED. The engine's reconnect is
  //      async (setTimeout(0)), so the very next render still shows CONNECTED.
  //      A naive resolver fires onClose() immediately, before the new attempt
  //      even started.
  //   2. The engine emits CONNECTING and then UNREACHABLE in the same tick
  //      (e.g. `new WebSocket()` throws synchronously on a malformed URL like
  //      `ws://host/#frag`). React batches both updates; the dialog only sees
  //      the final UNREACHABLE. A "must see CONNECTING first" gate gets stuck
  //      because the CONNECTING render never arrived.
  //   3. User clicks Save while state=CONNECTED, engine cycles
  //      CONNECTED→CONNECTING→CONNECTED. The post-reconnect state matches the
  //      snapshot, so a "differs from snapshot" gate would never resolve.
  // Solution: snapshot the connectionState at submit time AND remember
  // whether the live state has ever departed it. Once it has, any terminal
  // state resolves — including a return-to-snapshot CONNECTED.
  const submitSnapshotRef = useRef<ConnectionState | null>(null);
  const hasLeftSnapshotRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  // Sync local state from props only when dialog opens — never mid-typing.
  useEffect(() => {
    if (!open) return;
    setGatewayUrl(currentSettings?.gatewayUrl ?? "");
    setToken(currentSettings?.token ?? "");
    setPending(false);
    submitSnapshotRef.current = null;
    hasLeftSnapshotRef.current = false;
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]); // intentionally not depending on currentSettings — see comment above

  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    if (open) el.showModal();
    else el.close();
  }, [open]);

  // Resolve a pending save once we've seen the connection state depart the
  // submit-time snapshot at least once and land on a terminal state. The
  // "has left" latch handles a CONNECTED→CONNECTING→CONNECTED cycle that
  // ends back where it started — without it, the second CONNECTED would
  // hit the "still equal to snapshot" gate and never resolve.
  useEffect(() => {
    if (!pending) return;
    const snapshot = submitSnapshotRef.current;
    if (snapshot !== null && connectionState !== snapshot) {
      hasLeftSnapshotRef.current = true;
    }
    if (snapshot !== null && !hasLeftSnapshotRef.current) return;
    if (connectionState === ConnectionState.CONNECTED) {
      setPending(false);
      submitSnapshotRef.current = null;
      hasLeftSnapshotRef.current = false;
      setError(null);
      onClose();
    } else if (connectionState === ConnectionState.UNREACHABLE) {
      setPending(false);
      submitSnapshotRef.current = null;
      hasLeftSnapshotRef.current = false;
      setError("Couldn't reach the gateway at that URL. Check the address and try again.");
    } else if (connectionState === ConnectionState.AUTH_FAILED) {
      setPending(false);
      submitSnapshotRef.current = null;
      hasLeftSnapshotRef.current = false;
      setError("Gateway rejected the auth token. Run `openclaw onboard` to set a fresh one.");
    }
    // CONNECTING / DISCONNECTED / PAIRING are intermediate — keep waiting.
  }, [pending, connectionState, onClose]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedUrl = gatewayUrl.trim();
    const validation = validateGatewayUrl(trimmedUrl);
    if (!validation.ok) {
      setError(validation.error);
      return;
    }
    const trimmedToken = token.trim() || undefined;
    // Drop the cached deviceToken whenever URL OR token changed — the device
    // token was minted for a specific (URL, token) pair, so any change can
    // invalidate it. Letting the engine re-mint is cheap and avoids an
    // auth-failed retry round-trip.
    const credsChanged =
      trimmedUrl !== currentSettings?.gatewayUrl || trimmedToken !== currentSettings?.token;
    const newSettings: Settings = {
      gatewayUrl: trimmedUrl,
      token: trimmedToken,
      deviceToken: credsChanged ? undefined : currentSettings?.deviceToken,
    };
    setError(null);
    setPending(true);
    // Snapshot the engine's current state and reset the "has left" latch.
    // The resolver waits to observe state depart this snapshot before
    // treating a subsequent terminal state as ours.
    submitSnapshotRef.current = connectionState;
    hasLeftSnapshotRef.current = false;
    // Engine owns the localStorage write via its onSettingsChanged callback —
    // no need to write here.
    onSave(newSettings);
  };

  const banner = STATUS_BANNER[connectionState];
  const Icon = banner.icon;

  return (
    <dialog
      ref={dialogRef}
      className="w-full max-w-lg rounded-2xl border border-border-default/50 bg-background p-l text-text-neutral-primary shadow-2xl outline-none backdrop:bg-overlay dark:border-border-default/16 dark:bg-foreground"
      onClose={onClose}
    >
      <div className="flex flex-col">
        <div className="mb-ml flex items-center justify-between">
          <h2 className="font-heading text-md font-bold text-text-neutral-primary">
            Gateway Settings
          </h2>
          <IconButton
            icon={X}
            variant="tertiary"
            size="md"
            title="Close"
            aria-label="Close"
            onClick={onClose}
          />
        </div>

        <div className="mb-ml flex items-stretch gap-m rounded-lg border border-border-default/50 bg-background p-m dark:border-border-default/16 dark:bg-foreground">
          <div
            className={`flex h-2xl w-2xl shrink-0 items-center justify-center rounded-md border ${banner.tileBg} ${banner.tileBorder}`}
          >
            <Icon size={16} className={`${banner.accent} ${banner.pulse ? "animate-pulse" : ""}`} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-label text-sm font-medium leading-tight text-text-neutral-primary">
              {banner.label}
            </p>
            <p className="mt-3xs font-body text-md leading-snug text-text-neutral-tertiary">
              {banner.description}
            </p>
          </div>
        </div>

        <div className="min-h-0">
          <>
            <p className="mb-ml font-body text-md leading-snug text-text-neutral-tertiary">
              Connect Claw to your OpenClaw gateway. The fastest way is to run{" "}
              <code className="rounded bg-sunk-light px-3xs font-mono text-sm dark:bg-elevated">
                openclaw os url
              </code>{" "}
              in a terminal — it opens this page pre-authenticated. To paste manually, open{" "}
              <code className="rounded bg-sunk-light px-3xs font-mono text-sm dark:bg-elevated">
                ~/.openclaw/openclaw.json
              </code>{" "}
              and copy <code className="font-mono">gateway.port</code> and{" "}
              <code className="font-mono">gateway.auth.token</code>.
            </p>

            <form onSubmit={handleSubmit} className="flex flex-col gap-l">
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
                  className="rounded-lg border border-border-default bg-background px-m py-s font-body text-md text-text-neutral-primary outline-none focus:border-border-interactive-emphasis disabled:opacity-60 dark:border-border-default/16 dark:bg-foreground"
                />
                <p className="font-body text-sm text-text-neutral-tertiary">
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
                  className="rounded-lg border border-border-default bg-background px-m py-s font-body text-md text-text-neutral-primary outline-none focus:border-border-interactive-emphasis disabled:opacity-60 dark:border-border-default/16 dark:bg-foreground"
                />
                <p className="font-body text-sm text-text-neutral-tertiary">
                  Read it from{" "}
                  <code className="rounded bg-sunk-light px-3xs font-mono text-sm dark:bg-elevated">
                    ~/.openclaw/openclaw.json
                  </code>{" "}
                  (<code className="font-mono">gateway.auth.token</code>) or run{" "}
                  <code className="rounded bg-sunk-light px-3xs font-mono text-sm dark:bg-elevated">
                    openclaw onboard
                  </code>{" "}
                  to set a new one. Stored locally — only needed once per device.
                </p>
              </div>

              {error ? (
                <div
                  role="alert"
                  className="rounded-lg border border-border-danger bg-danger-background px-m py-s font-body text-md text-text-danger-primary"
                >
                  {error}
                </div>
              ) : null}

              {pending ? (
                <div className="flex items-center gap-xs font-body text-md text-text-neutral-tertiary">
                  <Wifi size={14} className="animate-pulse" />
                  Connecting to {gatewayUrl.trim()}…
                </div>
              ) : null}

              <div className="mt-s flex justify-end gap-s">
                <Button variant="secondary" size="md" onClick={onClose}>
                  Cancel
                </Button>
                <Button variant="primary" size="md" type="submit" disabled={pending}>
                  {pending ? "Connecting…" : "Save & Connect"}
                </Button>
              </div>
            </form>
          </>
        </div>
      </div>
    </dialog>
  );
}
