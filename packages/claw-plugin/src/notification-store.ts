import fs from "node:fs/promises";
import path from "node:path";
import { generateSecureUuid } from "openclaw/plugin-sdk/infra-runtime";

const MAX_NOTIFICATIONS = 400;

export type NotificationTarget =
  | {
      view: "chat";
      sessionId: string;
    }
  | {
      view: "app";
      appId: string;
    }
  | {
      view: "artifact";
      artifactId: string;
    }
  | {
      view: "home";
    };

export type StoredNotification = {
  id: string;
  kind: string;
  title: string;
  message: string;
  unread: boolean;
  createdAt: string;
  updatedAt: string;
  readAt?: string | null;
  dedupeKey?: string;
  target: NotificationTarget;
  source?: {
    agentId?: string;
    sessionKey?: string;
    appId?: string;
    artifactId?: string;
    cronId?: string;
  };
  metadata?: Record<string, unknown>;
};

export class NotificationStore {
  private dir: string;
  private filePath: string;
  // Serializes read-modify-write operations so two concurrent upserts can't
  // race and either lose data or leave a partially-truncated file behind.
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(stateDir: string) {
    this.dir = path.join(stateDir, "plugins", "openclaw-os", "notifications");
    this.filePath = path.join(this.dir, "notifications.json");
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
  }

  /**
   * Run `op` after any in-flight read-modify-write completes. Each upsert /
   * markRead enqueues itself here so the file is mutated by one operation at
   * a time. Errors don't break the chain — the next caller still gets to run.
   */
  private async withLock<T>(op: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(op, op);
    this.writeQueue = next.catch(() => undefined);
    return next;
  }

  private async readAll(): Promise<StoredNotification[]> {
    await this.ensureDir();

    try {
      const raw = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        console.warn(
          `[claw-plugin] notifications file at ${this.filePath} is not an array — treating as empty`,
        );
        return [];
      }
      return parsed as StoredNotification[];
    } catch (err) {
      // ENOENT (first read on a fresh state dir) is expected — anything else
      // is worth surfacing so a missing/corrupt file doesn't silently look
      // like "no notifications".
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") {
        console.warn(`[claw-plugin] failed to read notifications from ${this.filePath}:`, err);
      }
      return [];
    }
  }

  private async writeAll(items: StoredNotification[]): Promise<void> {
    await this.ensureDir();
    const trimmed = items
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, MAX_NOTIFICATIONS);
    // Atomic write: stage to a sibling temp file, then rename over the real
    // path. POSIX rename is atomic on the same filesystem, so a concurrent
    // reader (or a process killed mid-write) can never observe a partially-
    // truncated file. Combined with the mutex in `withLock`, this prevents
    // the corruption pattern we saw (valid JSON followed by leftover bytes
    // from a longer prior write).
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(trimmed, null, 2), "utf-8");
    await fs.rename(tmpPath, this.filePath);
  }

  async list(): Promise<StoredNotification[]> {
    const items = await this.readAll();
    return items.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async create(
    input: Omit<StoredNotification, "id" | "createdAt" | "updatedAt" | "unread" | "readAt">,
  ): Promise<StoredNotification> {
    return this.withLock(async () => {
      const items = await this.readAll();
      const now = new Date().toISOString();
      const record: StoredNotification = {
        id: generateSecureUuid(),
        ...input,
        unread: true,
        readAt: null,
        createdAt: now,
        updatedAt: now,
      };

      items.unshift(record);
      await this.writeAll(items);
      return record;
    });
  }

  async upsert(
    input: Omit<StoredNotification, "id" | "createdAt" | "updatedAt" | "unread" | "readAt">,
  ): Promise<StoredNotification> {
    if (!input.dedupeKey) {
      return this.create(input);
    }

    return this.withLock(async () => {
      const items = await this.readAll();
      const now = new Date().toISOString();
      const index = items.findIndex((item) => item.dedupeKey === input.dedupeKey);

      if (index === -1) {
        const record: StoredNotification = {
          id: generateSecureUuid(),
          ...input,
          unread: true,
          readAt: null,
          createdAt: now,
          updatedAt: now,
        };
        items.unshift(record);
        await this.writeAll(items);
        return record;
      }

      const existing = items[index]!;
      // Preserve the existing record's read state and id/createdAt. Upsert is
      // idempotent for the *content* (title/message/metadata may evolve as
      // the run finalises), but `unread`/`readAt` are user-owned — wiping
      // them on every poll cycle would resurrect notifications the user
      // already dismissed.
      const updated: StoredNotification = {
        ...existing,
        ...input,
        updatedAt: now,
      };
      items[index] = updated;
      await this.writeAll(items);
      return updated;
    });
  }

  async markRead(ids?: string[]): Promise<number> {
    return this.withLock(async () => {
      const items = await this.readAll();
      const idSet = ids && ids.length > 0 ? new Set(ids) : null;
      const now = new Date().toISOString();
      let changed = 0;

      const updated = items.map((item) => {
        const shouldMark = idSet ? idSet.has(item.id) : item.unread;
        if (!shouldMark || !item.unread) return item;
        changed += 1;
        return {
          ...item,
          unread: false,
          readAt: now,
          updatedAt: now,
        };
      });

      if (changed > 0) {
        await this.writeAll(updated);
      }

      return changed;
    });
  }
}
