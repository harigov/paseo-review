import type { RpcInput, RpcOutput, PluginRpcContract } from "@getpaseo/plugin";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import type { ZodType } from "zod";
import { rememberPaseo } from "./paseo";

/**
 * Register an RPC handler that records the daemon API for background work and logs failures.
 * All areas must register handlers through this helper.
 */
export function handle<I extends ZodType, O extends ZodType>(
  server: PluginServerContext,
  contract: PluginRpcContract<I, O>,
  fn: (input: RpcInput<PluginRpcContract<I, O>>, context: PluginHandlerContext) => Promise<RpcOutput<PluginRpcContract<I, O>>> | RpcOutput<PluginRpcContract<I, O>>,
): void {
  server.handle(contract, async (input, context) => {
    rememberPaseo(context.paseo);
    try {
      return (await fn(input as RpcInput<PluginRpcContract<I, O>>, context)) as never;
    } catch (error) {
      console.error(`[pr-review] ${contract.name} failed:`, error);
      throw error;
    }
  });
}
