import fs from "node:fs/promises";
import path from "node:path";
import { generateSecureUuid } from "openclaw/plugin-sdk/infra-runtime";

const MAX_VERSIONS = 25;

export type VersionEntry = {
  content: string;
  timestamp: string;
  source: "create" | "edit" | "restore";
};

export type StoredApp = {
  id: string;
  title: string;
  /** OpenUI Lang markup — the live app content rendered by the Renderer. */
  content: string;
  /** Session key of the originating thread. */
  sessionKey: string;
  /** agentId that created this app. */
  agentId: string;
  /** Append-only version history. */
  versions: VersionEntry[];
  createdAt: string;
  updatedAt: string;
};

export class AppStore {
  private dir: string;

  constructor(stateDir: string) {
    this.dir = path.join(stateDir, "plugins", "openclaw-os", "apps");
  }

  private filePath(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
  }

  async create(
    data: Omit<StoredApp, "id" | "createdAt" | "updatedAt" | "versions">,
  ): Promise<StoredApp> {
    await this.ensureDir();
    const now = new Date().toISOString();
    const record: StoredApp = {
      id: generateSecureUuid(),
      ...data,
      versions: [{ content: data.content, timestamp: now, source: "create" }],
      createdAt: now,
      updatedAt: now,
    };
    await fs.writeFile(this.filePath(record.id), JSON.stringify(record, null, 2), "utf-8");
    return record;
  }

  async update(
    id: string,
    patch: Partial<Pick<StoredApp, "title" | "content">>,
  ): Promise<StoredApp> {
    const existing = await this.get(id);
    if (!existing) throw new Error(`App not found: ${id}`);

    // Push current content to version history before overwriting.
    const versions = existing.versions ?? [];
    if (patch.content !== undefined && patch.content !== existing.content) {
      versions.push({
        content: existing.content,
        timestamp: existing.updatedAt,
        source: "edit",
      });
      while (versions.length > MAX_VERSIONS) versions.shift();
    }

    const updated: StoredApp = {
      ...existing,
      ...patch,
      versions,
      updatedAt: new Date().toISOString(),
    };
    await fs.writeFile(this.filePath(id), JSON.stringify(updated, null, 2), "utf-8");
    return updated;
  }

  async restore(id: string, versionIndex: number): Promise<StoredApp> {
    const existing = await this.get(id);
    if (!existing) throw new Error(`App not found: ${id}`);
    const versions = existing.versions ?? [];
    const target = versions[versionIndex];
    if (!target) throw new Error(`Version ${versionIndex} not found for app ${id}`);

    // Restoring creates a new head — non-destructive.
    versions.push({
      content: existing.content,
      timestamp: existing.updatedAt,
      source: "restore",
    });
    while (versions.length > MAX_VERSIONS) versions.shift();

    const updated: StoredApp = {
      ...existing,
      content: target.content,
      versions,
      updatedAt: new Date().toISOString(),
    };
    await fs.writeFile(this.filePath(id), JSON.stringify(updated, null, 2), "utf-8");
    return updated;
  }

  async list(): Promise<StoredApp[]> {
    await this.ensureDir();
    let entries: string[];
    try {
      entries = await fs.readdir(this.dir);
    } catch {
      return [];
    }
    const jsonFiles = entries.filter((e) => e.endsWith(".json"));
    const records = await Promise.all(
      jsonFiles.map(async (file) => {
        try {
          const raw = await fs.readFile(path.join(this.dir, file), "utf-8");
          return JSON.parse(raw) as StoredApp;
        } catch {
          return null;
        }
      }),
    );
    return (records.filter(Boolean) as StoredApp[]).sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );
  }

  async get(id: string): Promise<StoredApp | null> {
    try {
      const raw = await fs.readFile(this.filePath(id), "utf-8");
      const record = JSON.parse(raw) as StoredApp;
      // Backfill versions for old records that don't have them.
      if (!record.versions) record.versions = [];
      return record;
    } catch {
      return null;
    }
  }

  async delete(id: string): Promise<void> {
    try {
      await fs.unlink(this.filePath(id));
    } catch {
      // Already gone — treat as success.
    }
  }
}
