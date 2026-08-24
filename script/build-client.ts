import { build as viteBuild } from "vite";
import { rm } from "node:fs/promises";

// Client-only build for the Vercel deployment target.
//
// On Vercel the API is a serverless function (api/index.ts) compiled by the
// @vercel/node builder straight from TypeScript source — we do NOT bundle the
// server ourselves here. This script therefore only builds the static frontend
// into dist/public, which vercel.json serves from the CDN.
//
// (The pplx.app / standalone target still uses script/build.ts, which builds
// BOTH the client and a bundled dist/index.cjs server.)

async function buildClient() {
  await rm("dist/public", { recursive: true, force: true });
  console.log("building client (Vercel target)...");
  await viteBuild();
  console.log("client build complete → dist/public");
}

buildClient().catch((err) => {
  console.error(err);
  process.exit(1);
});
