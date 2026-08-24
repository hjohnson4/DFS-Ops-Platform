import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createApp } from "../server/app";

// Vercel serverless function entrypoint for the DFS Ops API.
//
// vercel.json routes every /api/* request here. Vercel serves the built static
// frontend (client) directly from the CDN, so this function is API-only — it
// never serves index.html or static assets.
//
// The Express app is built once per warm Lambda instance and reused across
// invocations. Because createApp() does async route registration, we memoize
// the promise so concurrent cold-start invocations share a single build.

type ExpressApp = Awaited<ReturnType<typeof createApp>>;

let appPromise: Promise<ExpressApp> | null = null;

function getApp(): Promise<ExpressApp> {
  if (!appPromise) {
    appPromise = createApp();
  }
  return appPromise;
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  const app = await getApp();
  // Express is itself a (req, res) request listener; VercelRequest/Response are
  // thin extensions of Node's IncomingMessage/ServerResponse, so we hand off
  // directly. Express reads the raw req/res and writes the response.
  (app as unknown as (req: VercelRequest, res: VercelResponse) => void)(
    req,
    res,
  );
}
