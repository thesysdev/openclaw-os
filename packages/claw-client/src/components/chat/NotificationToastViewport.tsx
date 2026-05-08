"use client";

import type { NotificationRecord } from "@/lib/notifications";
import { BellRing, X } from "lucide-react";

export type NotificationToastNotice = {
  id: string;
  notification: NotificationRecord;
};

export function NotificationToastViewport({
  toasts,
  onDismiss,
  onOpen,
}: {
  toasts: NotificationToastNotice[];
  onDismiss: (toastId: string) => void;
  onOpen: (notification: NotificationRecord, toastId: string) => void;
}) {
  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed right-ml top-ml z-[80] flex w-[min(92vw,380px)] flex-col gap-m">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className="pointer-events-auto overflow-hidden rounded-2xl border border-border-default/80 bg-background shadow-float"
        >
          <div className="flex items-start gap-m px-ml py-m transition-colors hover:bg-sunk-light">
            <div className="mt-3xs flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl bg-info-background text-text-info-primary">
              <BellRing className="h-ml w-ml" />
            </div>
            <button
              type="button"
              className="min-w-0 flex-1 text-left"
              onClick={() => onOpen(toast.notification, toast.id)}
            >
              <div className="flex items-center gap-s">
                <p className="truncate text-sm font-bold text-text-neutral-primary">
                  {toast.notification.title}
                </p>
                {toast.notification.unread ? (
                  <span className="inline-flex h-s w-s shrink-0 rounded-full bg-text-info-primary" />
                ) : null}
              </div>
              <p className="mt-2xs max-h-[4.5rem] overflow-hidden text-sm text-text-neutral-secondary">
                {toast.notification.message}
              </p>
            </button>
            <button
              type="button"
              className="rounded-xl p-2xs text-text-neutral-tertiary transition-colors hover:bg-sunk-light hover:text-text-neutral-primary"
              onClick={() => onDismiss(toast.id)}
            >
              <X className="h-ml w-ml" />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
