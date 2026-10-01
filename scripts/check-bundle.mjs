// Approximates Paseo's plugin compiler (packages/server/src/server/plugins/compiler.ts)
// so bundling problems show up before `paseo plugin install`.
import { build } from "esbuild";
import { builtinModules } from "node:module";

const sdk = [
  "@getpaseo/plugin",
  "@getpaseo/plugin/server",
  "@getpaseo/plugin/server/provider",
  "@getpaseo/plugin/server/acp",
  "@getpaseo/plugin/server/usage",
  "@getpaseo/plugin/client",
  "@getpaseo/plugin/client/ui",
  "@getpaseo/plugin/client/react-native",
];
const nodeModules = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

const forbidNodeInClient = {
  name: "forbid-node-in-client",
  setup(b) {
    b.onResolve({ filter: /.*/ }, (args) => {
      if (nodeModules.has(args.path)) {
        return { errors: [{ text: `Node module "${args.path}" imported into client bundle by ${args.importer}` }] };
      }
      if (/(^|\/)server\//.test(args.path) && args.path.startsWith(".")) {
        return { errors: [{ text: `server/ module imported into client bundle: ${args.path} from ${args.importer}` }] };
      }
      return null;
    });
  },
};

const results = await Promise.allSettled([
  build({
    entryPoints: ["index.client.tsx"],
    bundle: true,
    format: "cjs",
    jsx: "automatic",
    platform: "neutral",
    target: "es2020",
    mainFields: ["module", "main"],
    supported: { "async-await": false },
    external: [...sdk, "@tanstack/react-query", "react", "react/jsx-runtime", "react-native", "zod"],
    plugins: [forbidNodeInClient],
    write: false,
    logLevel: "silent",
    metafile: true,
  }),
  build({
    entryPoints: ["index.server.ts"],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node20",
    external: [...sdk, "zod"],
    write: false,
    logLevel: "silent",
  }),
]);

let failed = false;
for (const [name, result] of [["client", results[0]], ["server", results[1]]]) {
  if (result.status === "rejected") {
    failed = true;
    console.error(`✗ ${name} bundle failed:`);
    for (const e of result.reason.errors ?? [result.reason]) console.error("  ", e.text ?? e.message ?? e, e.location ? `(${e.location.file}:${e.location.line})` : "");
  } else {
    console.log(`✓ ${name} bundle ok (${(result.value.outputFiles[0].text.length / 1024).toFixed(0)} KiB)`);
  }
}
process.exit(failed ? 1 : 0);
