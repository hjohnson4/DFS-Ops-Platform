import { build as viteBuild } from "vite";
import { rm, writeFile } from "node:fs/promises";

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

  // Stamp a build version the running app can poll to detect new deploys.
  // Content-hashed JS/CSS filenames change every build, but this file lives at a
  // stable URL (/version.json), so the client can compare the version it booted
  // with against the currently-deployed one and prompt a refresh when they
  // differ. VERCEL_GIT_COMMIT_SHA is set automatically on Vercel builds; we fall
  // back to a build timestamp locally.
  const version =
    process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) ||
    `build-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  await writeFile(
    "dist/public/version.json",
    JSON.stringify({ version, built_at: new Date().toISOString() }) + "\n",
    "utf8",
  );
  console.log(`client build complete → dist/public (version ${version})`);
}

buildClient().catch((err) => {
  console.error(err);
  process.exit(1);
});
