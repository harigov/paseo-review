import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  /** Max bytes kept from stdout; extra output is dropped and `truncated` is set. */
  maxBuffer?: number;
  input?: string;
  env?: Record<string, string>;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
  truncated: boolean;
}

const FALLBACK_DIRS = ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin", "/snap/bin"];
const resolved = new Map<string, string>();

/** The daemon's PATH can be minimal (no Homebrew); resolve gh/git with fallbacks. */
export function resolveExecutable(name: string): string {
  const cached = resolved.get(name);
  if (cached) return cached;
  const dirs = [...(process.env.PATH ?? "").split(path.delimiter), ...FALLBACK_DIRS].filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) {
      resolved.set(name, candidate);
      return candidate;
    }
  }
  return name;
}

export class CommandError extends Error {
  constructor(
    message: string,
    readonly result: RunResult,
  ) {
    super(message);
  }
}

/** Run an executable without a shell. Rejects on non-zero exit unless `allowFailure`. */
export function run(
  command: string,
  args: string[],
  options: RunOptions & { allowFailure?: boolean } = {},
): Promise<RunResult> {
  const maxBuffer = options.maxBuffer ?? 64 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const child = spawn(resolveExecutable(command), args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        GH_PROMPT_DISABLED: "1",
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
        NO_COLOR: "1",
        ...options.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let truncated = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (outBytes >= maxBuffer) {
        truncated = true;
        return;
      }
      outBytes += chunk.length;
      out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    const timer = options.timeoutMs
      ? setTimeout(() => child.kill("SIGKILL"), options.timeoutMs)
      : null;
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      const result: RunResult = {
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        code: code ?? -1,
        truncated,
      };
      if (result.code !== 0 && !options.allowFailure) {
        reject(
          new CommandError(
            `${command} ${args.slice(0, 3).join(" ")} failed (${result.code}): ${result.stderr.trim().slice(0, 500)}`,
            result,
          ),
        );
        return;
      }
      resolve(result);
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}
