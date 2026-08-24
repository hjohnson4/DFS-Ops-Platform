import express, { Response, NextFunction } from "express";
import type { Request, Express } from "express";
import { registerRoutes } from "./routes";
import { createServer } from "node:http";

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

/**
 * Build the Express app with all middleware and API routes registered.
 *
 * This is the shared core used by BOTH runtime targets:
 *   - server/index.ts  → standalone long-running server (local dev + pplx.app)
 *   - api/index.ts      → Vercel serverless function wrapper
 *
 * It deliberately does NOT call listen(), serve static assets, or set up Vite.
 * Static/SPA serving is handled by the standalone server (serveStatic) or by
 * Vercel's static hosting (see vercel.json). Keeping this factory free of those
 * concerns lets the serverless function stay a thin API-only handler.
 *
 * `registerRoutes` historically takes an http.Server (its signature predates
 * this split and it only ever returned it — there are no WebSocket upgrades),
 * so we pass a throwaway server instance to satisfy the type without listening.
 */
export async function createApp(): Promise<Express> {
  const app = express();
  // Throwaway server purely to satisfy registerRoutes' signature. It is never
  // listened on. No route uses it for upgrades/WebSockets (verified).
  const throwawayServer = createServer(app);

  app.use(
    express.json({
      // Daily-report ingestion posts the emailed .xlsx as base64, so allow a
      // generous body size for the attachment payload.
      limit: "25mb",
      verify: (req, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );

  app.use(express.urlencoded({ extended: false }));

  app.use((req, res, next) => {
    const start = Date.now();
    const path = req.path;
    let capturedJsonResponse: Record<string, any> | undefined = undefined;

    const originalResJson = res.json;
    res.json = function (bodyJson, ...args) {
      capturedJsonResponse = bodyJson;
      return originalResJson.apply(res, [bodyJson, ...args]);
    };

    res.on("finish", () => {
      const duration = Date.now() - start;
      if (path.startsWith("/api")) {
        let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
        if (capturedJsonResponse) {
          logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
        }

        log(logLine);
      }
    });

    next();
  });

  await registerRoutes(throwawayServer, app);

  // Any unmatched /api/* request (wrong path or unsupported method) returns a
  // JSON 404 instead of falling through to the SPA catch-all, which would
  // otherwise return index.html with a 200 and silently mask the problem.
  app.all(/^\/api\//, (req: Request, res: Response) => {
    res
      .status(404)
      .json({ message: `No API route for ${req.method} ${req.path}` });
  });

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  return app;
}
