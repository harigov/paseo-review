import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "../core/paths";
import { splitRepo } from "./gh";

export interface LocalViewedRecord {
  headSha: string;
  viewedAt: string;
}

export type LocalViewedRecords = Record<string, LocalViewedRecord>;

function fileFor(repo: string, number: number): string {
  const { owner, name } = splitRepo(repo);
  return path.join(dataDir("viewed"), `${owner}__${name}__${number}.json`);
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

export async function recordViewed(repo: string, number: number, filePath: string, headSha: string): Promise<void> {
  const records = await getLocalViewedRecords(repo, number);
  records[filePath] = { headSha, viewedAt: new Date().toISOString() };
  await writeRecords(repo, number, records);
}

export async function removeViewed(repo: string, number: number, filePath: string): Promise<void> {
  const records = await getLocalViewedRecords(repo, number);
  if (filePath in records) {
    delete records[filePath];
    await writeRecords(repo, number, records);
  }
}
