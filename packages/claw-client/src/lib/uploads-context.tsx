"use client";

import type { UploadMeta, UploadStore } from "@/lib/engines/types";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

type UploadsContextValue = {
  store: UploadStore | null;
  /**
   * Upload metadata indexed by remoteId. Includes (a) the session-scoped
   * `uploads.list` result, (b) locally-put seeds, and (c) any uploads
   * back-filled lazily by `ensureMeta` for ids that didn't appear in (a)
   * or (b) — typically history messages whose uploads were stored under a
   * different sessionKey.
   */
  metasById: Map<string, UploadMeta>;
  ensureMeta: (remoteId: string) => Promise<UploadMeta | null>;
  getPreviewDataUrl: (remoteId: string) => Promise<string | null>;
};

const UploadsContext = createContext<UploadsContextValue>({
  store: null,
  metasById: new Map(),
  ensureMeta: async () => null,
  getPreviewDataUrl: async () => null,
});

export type UploadsSeed = {
  /** Meta pushed locally as soon as `uploads.put` resolves — merged over the `uploads.list` result. */
  meta: UploadMeta;
  /** Base64 preview synthesized from the originally-picked File so the first render gets a thumbnail without a plugin round-trip. */
  previewDataUrl?: string;
};

export function UploadsProvider({
  children,
  store,
  sessionKey,
  seeds = [],
}: {
  children: React.ReactNode;
  store: UploadStore | undefined;
  sessionKey: string | null;
  /**
   * Locally-put uploads that may not be in the server's `listUploads` response
   * yet. Merged in by remoteId so `useUploadMeta` resolves immediately after
   * the put resolves, without waiting for a refetch.
   */
  seeds?: UploadsSeed[];
}) {
  const [metas, setMetas] = useState<UploadMeta[]>([]);
  // Lazily back-filled metas for uploads not in the session-scoped list.
  // Keyed by remoteId, never evicted (per-session lifetime is fine).
  const [extraMetasById, setExtraMetasById] = useState<Map<string, UploadMeta>>(() => new Map());
  const [blobCache] = useState<Map<string, string>>(() => new Map());

  useEffect(() => {
    if (!store || !sessionKey) {
      setMetas([]);
      return;
    }
    let cancelled = false;
    void store.listUploads(sessionKey).then((list) => {
      if (!cancelled) setMetas(list);
    });
    return () => {
      cancelled = true;
    };
  }, [store, sessionKey]);

  // Scope seeds to the current session so stale entries from a prior thread
  // don't bleed into the `metasById` lookup.
  const scopedSeeds = useMemo(
    () => (sessionKey ? seeds.filter((seed) => seed.meta.sessionKey === sessionKey) : []),
    [seeds, sessionKey],
  );

  // Seed the blob cache with any data URLs the caller already has on hand,
  // so `InlineUploadChip` renders a thumbnail on first paint instead of waiting
  // for `uploads.get` to round-trip through the plugin.
  useEffect(() => {
    for (const seed of scopedSeeds) {
      if (seed.previewDataUrl && !blobCache.has(seed.meta.id)) {
        blobCache.set(seed.meta.id, seed.previewDataUrl);
      }
    }
  }, [scopedSeeds, blobCache]);

  const ensureMeta = useCallback(
    async (remoteId: string): Promise<UploadMeta | null> => {
      // Synchronous hits first.
      const fromList = metas.find((m) => m.id === remoteId);
      if (fromList) return fromList;
      const fromSeed = scopedSeeds.find((s) => s.meta.id === remoteId)?.meta;
      if (fromSeed) return fromSeed;
      const fromExtra = extraMetasById.get(remoteId);
      if (fromExtra) return fromExtra;

      if (!store) return null;
      const record = await store.getUpload(remoteId);
      if (!record) return null;
      const { content, ...meta } = record;
      // Seed both meta and blob caches in one round-trip.
      if (!blobCache.has(remoteId)) {
        blobCache.set(remoteId, `data:${record.mimeType};base64,${content}`);
      }
      setExtraMetasById((prev) => {
        if (prev.has(remoteId)) return prev;
        const next = new Map(prev);
        next.set(remoteId, meta);
        return next;
      });
      return meta;
    },
    [blobCache, extraMetasById, metas, scopedSeeds, store],
  );

  const value = useMemo<UploadsContextValue>(() => {
    const combined = new Map<string, UploadMeta>();
    for (const meta of metas) combined.set(meta.id, meta);
    for (const seed of scopedSeeds) combined.set(seed.meta.id, seed.meta);
    for (const [id, meta] of extraMetasById) combined.set(id, meta);
    return {
      store: store ?? null,
      metasById: combined,
      ensureMeta,
      getPreviewDataUrl: async (remoteId: string) => {
        if (blobCache.has(remoteId)) return blobCache.get(remoteId) ?? null;
        if (!store) return null;
        const record = await store.getUpload(remoteId);
        if (!record) return null;
        const dataUrl = `data:${record.mimeType};base64,${record.content}`;
        blobCache.set(remoteId, dataUrl);
        return dataUrl;
      },
    };
  }, [blobCache, ensureMeta, extraMetasById, metas, scopedSeeds, store]);

  return <UploadsContext.Provider value={value}>{children}</UploadsContext.Provider>;
}

export function useUploadsContext(): UploadsContextValue {
  return useContext(UploadsContext);
}

export function useUploadMeta(remoteId: string | undefined): UploadMeta | null {
  const { metasById, ensureMeta } = useUploadsContext();
  const cached = remoteId ? (metasById.get(remoteId) ?? null) : null;

  // If the id isn't in the session-scoped list (history message whose upload
  // was stored under a different sessionKey, or a put that hasn't seeded yet),
  // fetch it directly. `ensureMeta` is idempotent and seeds the shared map,
  // so the next render hits the cached path.
  useEffect(() => {
    if (!remoteId || cached) return;
    void ensureMeta(remoteId);
  }, [cached, ensureMeta, remoteId]);

  return cached;
}

export function useUploadPreview(remoteId: string | undefined): string | null {
  const { getPreviewDataUrl } = useUploadsContext();
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!remoteId) {
      setDataUrl(null);
      return;
    }
    let cancelled = false;
    void getPreviewDataUrl(remoteId).then((result) => {
      if (!cancelled) setDataUrl(result);
    });
    return () => {
      cancelled = true;
    };
  }, [getPreviewDataUrl, remoteId]);

  return dataUrl;
}
