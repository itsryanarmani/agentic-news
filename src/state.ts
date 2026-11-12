import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { RenderedArticle } from "./render.js";
import type { Receipt } from "./targets.js";
import { StageError } from "./types.js";

/** Only these outcomes are stored. Rejections are reported, not stored, so a later run may retry them. */
export type StoredStatus = "published" | "pending_approval" | "approved";

export interface StateRecord {
  key: string;
  postKey: string;
  url: string;
  status: StoredStatus;
  at: string;
  /** Kept while pending or approved, so publishing later needs no new fetch. */
  article?: RenderedArticle;
  receipts?: Receipt[];
  approver?: string;
}

export interface StateStore {
  get(key: string): Promise<StateRecord | undefined>;
  put(record: StateRecord): Promise<void>;
  list(): Promise<StateRecord[]>;
}

export class MemoryStateStore implements StateStore {
  private readonly records = new Map<string, StateRecord>();
  async get(key: string) { return this.records.get(key); }
  async put(record: StateRecord) { this.records.set(record.key, structuredClone(record)); }
  async list() { return [...this.records.values()].map((r) => structuredClone(r)); }
}

/** One JSON file keyed by item key. Writes go to a temp file, then rename, so a crash never leaves half a file. */
export class FileStateStore implements StateStore {
  constructor(private readonly path: string) {}

  private async load(): Promise<Record<string, StateRecord>> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new StageError("bad_state_file", `${this.path} must hold a JSON object`);
      }
      return parsed as Record<string, StateRecord>;
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return {};
      throw error;
    }
  }

  async get(key: string) { return (await this.load())[key]; }
  async list() { return Object.values(await this.load()); }

  async put(record: StateRecord) {
    const all = await this.load();
    all[record.key] = record;
    await mkdir(dirname(this.path), { recursive: true });
    const temp = `${this.path}.tmp`;
    await writeFile(temp, `${JSON.stringify(all, null, 2)}\n`, "utf8");
    await rename(temp, this.path);
  }
}

/**
 * Mark a pending item approved. The next live run publishes it. Throws
 * when the key is unknown or not pending, so a typo is not a silent no-op.
 */
export async function approveItem(store: StateStore, key: string, approver: string, now: Date): Promise<StateRecord> {
  const record = (await store.get(key)) ?? (await store.list()).find((r) => r.postKey === key);
  if (!record) throw new StageError("unknown_key", key);
  if (record.status !== "pending_approval") throw new StageError("not_pending", `${key} is ${record.status}`);
  const approved: StateRecord = { ...record, status: "approved", approver, at: now.toISOString() };
  await store.put(approved);
  return approved;
}
