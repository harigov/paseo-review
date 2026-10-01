import { readFile, writeFile } from "node:fs/promises";
import { dataDir, repoDataFile } from "../core/paths";

export interface LocalViewedRecord {
  headSha: string;
  viewedAt: string;
}

export type LocalViewedRecords = Record<string, LocalViewedRecord>;

function fileFor(repo: string, number: number): string {
  // `repoDataFile` validates `repo` is a plain owner/name slug, so a crafted repo string
  // (e.g. containing "..") can't write outside the "viewed" data directory.
  return repoDataFile(dataDir("viewed"), repo, number);
}

/** Serializes read-modify-write cycles per PR so concurrent `fileViewedRpc` calls (e.g. marking
 * several files viewed in quick succession) don't race and silently drop each other's writes. */
const queues = new Map<string, Promise<unknown>>();

function withFileQueue<T>(repo: string, number: number, work: () => Promise<T>): Promise<T> {
  const key = `${repo.toLowerCase()}#${number}`;
  const prior = queues.get(key) ?? Promise.resolve();
  const next = prior.then(work, work);
  // Keep the chain alive for the next caller, but don't let a rejection pin it forever.
  queues.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}

/** Locally recorded "what blob did the viewer see" map, keyed by file path. Used for the
 * "changed since you viewed" feature; GitHub's own viewed state has no memory of which blob
 * was reviewed, only whether the file is currently dirty since the last mark. */
export async function getLocalViewedRecords(repo: string, number: number): Promise<LocalViewedRecords> {
  try {
    const raw = await readFile(fileFor(repo, number), "utf8");
    return JSON.parse(raw) as LocalViewedRecords;
  } catch {
    return {};
  }
}

async function writeRecords(repo: string, number: number, records: LocalViewedRecords): Promise<void> {
  await writeFile(fileFor(repo, number), JSON.stringify(records, null, 2), "utf8");
}

export function recordViewed(repo: string, number: number, filePath: string, headSha: string): Promise<void> {
  return withFileQueue(repo, number, async () => {
    const records = await getLocalViewedRecords(repo, number);
    records[filePath] = { headSha, viewedAt: new Date().toISOString() };
    await writeRecords(repo, number, records);
  });
}

export function removeViewed(repo: string, number: number, filePath: string): Promise<void> {
  return withFileQueue(repo, number, async () => {
    const records = await getLocalViewedRecords(repo, number);
    if (filePath in records) {
      delete records[filePath];
      await writeRecords(repo, number, records);
    }
  });
}
