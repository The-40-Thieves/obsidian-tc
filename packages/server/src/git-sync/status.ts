import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite } from "./git";

export interface GitSyncConflict {
  at: string;
  branch: string;
  reason: string;
  attempts?: number;
}

export interface GitSyncStatus {
  lastPullAt: string | null;
  lastPushAt: string | null;
  head: string | null;
  lastError: string | null;
  conflicts: GitSyncConflict[];
}

const EMPTY_STATUS: GitSyncStatus = {
  lastPullAt: null,
  lastPushAt: null,
  head: null,
  lastError: null,
  conflicts: [],
};

export class StatusStore {
  readonly path: string;
  private value: GitSyncStatus = { ...EMPTY_STATUS, conflicts: [] };

  constructor(private readonly stateDir: string) {
    this.path = join(stateDir, "status.json");
  }

  async initialize(): Promise<void> {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as Partial<GitSyncStatus>;
      this.value = {
        lastPullAt: parsed.lastPullAt ?? null,
        lastPushAt: parsed.lastPushAt ?? null,
        head: parsed.head ?? null,
        lastError: parsed.lastError ?? null,
        conflicts: Array.isArray(parsed.conflicts) ? parsed.conflicts : [],
      };
    } catch {
      this.value = { ...EMPTY_STATUS, conflicts: [] };
    }
    await this.write();
  }

  async update(patch: Partial<GitSyncStatus>): Promise<void> {
    this.value = { ...this.value, ...patch };
    await this.write();
  }

  async addConflict(conflict: GitSyncConflict, head: string): Promise<void> {
    this.value = {
      ...this.value,
      lastPullAt: new Date().toISOString(),
      lastPushAt: new Date().toISOString(),
      head,
      lastError: conflict.reason,
      conflicts: [...this.value.conflicts, conflict],
    };
    await this.write();
  }

  private async write(): Promise<void> {
    await atomicWrite(this.path, `${JSON.stringify(this.value, null, 2)}\n`, 0o600);
  }
}
