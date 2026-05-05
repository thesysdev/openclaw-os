import fs from "node:fs/promises";
import path from "node:path";
import { generateSecureUuid } from "openclaw/plugin-sdk/infra-runtime";

/** Hard cap per upload. 25 MB covers screenshots and most documents; anything
 *  larger should go through a proper object store, not a plugin state dir. */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** Hard cap per session — defends against a runaway agent tool that spams
 *  putUpload and fills the local disk. */
const MAX_SESSION_BYTES = 200 * 1024 * 1024;

const ALLOWED_MIME_PREFIXES = ["image/", "video/", "audio/", "text/"];
const ALLOWED_MIME_EXACT = new Set([
  "application/pdf",
  "application/json",
  "application/xml",
  "application/zip",
  "application/x-zip-compressed",
  "application/octet-stream",
]);

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/svg+xml": "svg",
  "application/pdf": "pdf",
};

function extFromMime(mimeType: string, fallbackName: string): string {
  const direct = MIME_EXT[mimeType.toLowerCase()];
  if (direct) return direct;
  const fromName = path.extname(fallbackName).replace(/^\./, "").toLowerCase();
  if (fromName && /^[a-z0-9]{1,8}$/.test(fromName)) return fromName;
  return "bin";
}

function isAllowedMime(mimeType: string): boolean {
  const lowered = mimeType.toLowerCase();
  if (ALLOWED_MIME_EXACT.has(lowered)) return true;
  return ALLOWED_MIME_PREFIXES.some((prefix) => lowered.startsWith(prefix));
}

export type StoredUploadMeta = {
  id: string;
  sessionKey: string;
  name: string;
  mimeType: string;
  size: number;
  createdAt: string;
};

export type StoredUpload = StoredUploadMeta & {
  /** Base64-encoded file content. */
  content: string;
};

type UploadIndex = {
  version: 1;
  entries: StoredUploadMeta[];
};

const EMPTY_INDEX: UploadIndex = { version: 1, entries: [] };

export class UploadStoreError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "UploadStoreError";
  }
}

export class UploadStore {
  private dir: string;
  /** Module-global promise chain so concurrent writes serialize cleanly. */
  private indexChain: Promise<unknown> = Promise.resolve();

  constructor(stateDir: string) {
    this.dir = path.join(stateDir, "plugins", "openclaw-os", "uploads");
  }

  private indexPath(): string {
    return path.join(this.dir, "index.json");
  }

  private binPath(id: string, mimeType: string, name: string): string {
    return path.join(this.dir, `${id}.${extFromMime(mimeType, name)}`);
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
  }

  private async readIndex(): Promise<UploadIndex> {
    try {
      const raw = await fs.readFile(this.indexPath(), "utf-8");
      const parsed = JSON.parse(raw) as UploadIndex;
      if (parsed?.version === 1 && Array.isArray(parsed.entries)) return parsed;
    } catch {
      // Fall through to rebuild from sidecar files — handles migration from
      // the earlier indexless layout where each upload had <id>.json + <id>.ext.
    }
    return this.rebuildIndexFromSidecars();
  }

  private async rebuildIndexFromSidecars(): Promise<UploadIndex> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.dir);
    } catch {
      return { ...EMPTY_INDEX };
    }
    const jsons = entries.filter((file) => file.endsWith(".json") && file !== "index.json");
    const records = await Promise.all(
      jsons.map(async (file) => {
        try {
          const raw = await fs.readFile(path.join(this.dir, file), "utf-8");
          const parsed = JSON.parse(raw) as StoredUploadMeta;
          if (parsed && typeof parsed.id === "string" && typeof parsed.sessionKey === "string") {
            return parsed;
          }
        } catch {
          // ignore malformed sidecars
        }
        return null;
      }),
    );
    return {
      version: 1,
      entries: records.filter((meta): meta is StoredUploadMeta => meta != null),
    };
  }

  private async writeIndex(index: UploadIndex): Promise<void> {
    await fs.writeFile(this.indexPath(), JSON.stringify(index, null, 2), "utf-8");
  }

  /** Run `update` serially against the latest index, persisting the result. */
  private async mutateIndex<T>(
    update: (
      index: UploadIndex,
    ) => Promise<{ next: UploadIndex; result: T }> | { next: UploadIndex; result: T },
  ): Promise<T> {
    const chained = this.indexChain.then(async () => {
      await this.ensureDir();
      const current = await this.readIndex();
      const outcome = await update(current);
      await this.writeIndex(outcome.next);
      return outcome.result;
    });
    this.indexChain = chained.catch(() => undefined);
    return chained;
  }

  async put(params: {
    sessionKey: string;
    name: string;
    mimeType: string;
    content: string;
    size?: number;
  }): Promise<StoredUploadMeta> {
    if (!params.sessionKey || typeof params.sessionKey !== "string") {
      throw new UploadStoreError("invalid_session", "sessionKey is required");
    }
    if (!params.content) {
      throw new UploadStoreError("invalid_content", "base64 content is required");
    }
    if (!isAllowedMime(params.mimeType)) {
      throw new UploadStoreError("mime_rejected", `mime type not allowed: ${params.mimeType}`);
    }

    const bytes = Buffer.from(params.content, "base64");
    if (bytes.byteLength === 0) {
      throw new UploadStoreError("empty_content", "decoded content is empty");
    }
    if (bytes.byteLength > MAX_UPLOAD_BYTES) {
      throw new UploadStoreError("too_large", `upload exceeds ${MAX_UPLOAD_BYTES} bytes`);
    }

    await this.ensureDir();

    return this.mutateIndex(async (current) => {
      const sessionBytes = current.entries
        .filter((entry) => entry.sessionKey === params.sessionKey)
        .reduce((acc, entry) => acc + entry.size, 0);
      if (sessionBytes + bytes.byteLength > MAX_SESSION_BYTES) {
        throw new UploadStoreError(
          "session_quota",
          `session upload quota exceeded (${MAX_SESSION_BYTES} bytes)`,
        );
      }

      const meta: StoredUploadMeta = {
        id: generateSecureUuid(),
        sessionKey: params.sessionKey,
        name: params.name || "attachment",
        mimeType: params.mimeType,
        size: params.size ?? bytes.byteLength,
        createdAt: new Date().toISOString(),
      };
      // Write the binary before updating the index so the index only reflects
      // bytes that are actually on disk.
      await fs.writeFile(this.binPath(meta.id, meta.mimeType, meta.name), bytes);
      return {
        next: { ...current, entries: [...current.entries, meta] },
        result: meta,
      };
    });
  }

  async list(sessionKey?: string): Promise<StoredUploadMeta[]> {
    await this.ensureDir();
    const index = await this.readIndex();
    const filtered = sessionKey
      ? index.entries.filter((entry) => entry.sessionKey === sessionKey)
      : index.entries;
    return [...filtered].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getMeta(id: string): Promise<StoredUploadMeta | null> {
    const index = await this.readIndex();
    return index.entries.find((entry) => entry.id === id) ?? null;
  }

  async get(id: string): Promise<StoredUpload | null> {
    const meta = await this.getMeta(id);
    if (!meta) return null;
    try {
      const bytes = await fs.readFile(this.binPath(meta.id, meta.mimeType, meta.name));
      return { ...meta, content: bytes.toString("base64") };
    } catch {
      return null;
    }
  }

  async delete(id: string): Promise<void> {
    const meta = await this.getMeta(id);
    if (meta) {
      try {
        await fs.unlink(this.binPath(meta.id, meta.mimeType, meta.name));
      } catch {
        // already gone
      }
    }
    await this.mutateIndex((current) => ({
      next: {
        ...current,
        entries: current.entries.filter((entry) => entry.id !== id),
      },
      result: undefined,
    }));
  }

  /** Delete all uploads for a session — call when the session is deleted. */
  async deleteBySession(sessionKey: string): Promise<number> {
    const victims = await this.list(sessionKey);
    if (victims.length === 0) return 0;
    await Promise.all(
      victims.map(async (meta) => {
        try {
          await fs.unlink(this.binPath(meta.id, meta.mimeType, meta.name));
        } catch {
          // already gone
        }
      }),
    );
    await this.mutateIndex((current) => ({
      next: {
        ...current,
        entries: current.entries.filter((entry) => entry.sessionKey !== sessionKey),
      },
      result: undefined,
    }));
    return victims.length;
  }
}
