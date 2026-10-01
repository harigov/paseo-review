import type { PluginHandlerContext } from "@getpaseo/plugin/server";

export type PaseoApi = PluginHandlerContext["paseo"];

// The server contribution only receives `paseo` inside handlers and hooks.
// Every handler wrapper records it so background work (precompute) can reuse it.
let current: PaseoApi | null = null;
const waiters: Array<(api: PaseoApi) => void> = [];

export function rememberPaseo(api: PaseoApi | undefined | null): void {
  if (!api) return;
  current = api;
  while (waiters.length) waiters.shift()?.(api);
}

export function getPaseo(): PaseoApi | null {
  return current;
}

export function waitForPaseo(): Promise<PaseoApi> {
  if (current) return Promise.resolve(current);
  return new Promise((resolve) => waiters.push(resolve));
}
