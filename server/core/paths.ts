import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** Plugin data lives outside the install root, which `paseo plugin remove` deletes. */
export function dataDir(...segments: string[]): string {
  const home = process.env.PASEO_HOME || path.join(homedir(), ".paseo");
  const dir = path.join(home, "plugin-data", "pr-review", ...segments);
  mkdirSync(dir, { recursive: true });
  return dir;
}
