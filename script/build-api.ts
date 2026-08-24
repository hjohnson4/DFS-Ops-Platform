import { build as esbuild } from "esbuild";

// Bundle the Vercel serverless API entry (api/index.ts) and ALL of its local
// imports (server/*, shared/*) into a single self-contained file. This mirrors
// what script/build.ts does for the standalone server: bundling means Node's
// ESM loader never has to resolve extensionless relative imports at runtime,
// which is what crashed the function on Vercel (ERR_MODULE_NOT_FOUND for
// '/var/task/server/app'). The @vercel/node runtime then just runs this one
// already-resolved file.
//
// Node deps stay external (Vercel installs them from package.json / node_modules);
// only our own TS source is inlined.

async function buildApi() {
  await esbuild({
    entryPoints: ["api/index.ts"],
    platform: "node",
    target: "node20",
    bundle: true,
    format: "esm",
    outfile: "api/index.mjs",
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    minify: false,
    // Keep ALL node_modules (including transitive CJS deps like undici) external
    // — Vercel installs them from package.json. We only bundle our own TS source
    // (server/*, shared/*, api/*) so there are no extensionless relative imports
    // for Node's ESM loader to choke on at runtime. Bundling node_modules as ESM
    // breaks CJS packages that use dynamic require() (e.g. undici -> require('assert')).
    packages: "external",
    logLevel: "info",
  });

  console.log("API bundled -> api/index.mjs");
}

buildApi().catch((err) => {
  console.error(err);
  process.exit(1);
});
