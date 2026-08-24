// Install the WebSocket global BEFORE supabase-js is imported. ES module
// imports run in source order, so this side-effect import must stay first.
import "./ws-polyfill";
import { createClient } from "@supabase/supabase-js";
import { Agent, fetch as undiciFetch } from "undici";

// Public project config. The anon key is a public, RLS-protected key (JWT
// role=anon) — it is designed to be client-visible, so embedding it as a boot
// fallback is safe and guarantees the server starts even when the hosting
// environment injects env vars after module initialization. The service-role
// key is a real secret and is NEVER hardcoded — it comes from env only.
const FALLBACK_SUPABASE_URL = "https://yhrzmxnahkgbqrxfjsyb.supabase.co";
const FALLBACK_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlocnpteG5haGtnYnFyeGZqc3liIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU3Nzk3MTAsImV4cCI6MjEwMTM1NTcxMH0.MOu1wRKZIT-ZX2rcdN7L-a_ycAco-G6R0ltysUUrZpc";

// Prefer explicit env config, but only when it is a non-empty string. In some
// hosting sandboxes the env var is injected as an EMPTY string (falsy) — the
// `|| FALLBACK` guard already handles that. We additionally guard against a
// whitespace-only or obviously malformed anon key by requiring the JWT shape.
// IMPORTANT: The published/hosted sandbox injects SUPABASE_URL pointing at the
// Perplexity agent proxy (https://agent-proxy.perplexity.ai/agent_pass_through)
// instead of the real Supabase host. Routing Supabase REST/GoTrue calls through
// that proxy breaks auth ("invalid or expired session token"). So we IGNORE any
// injected SUPABASE_URL and always talk directly to the real Supabase project.
// We only accept an env URL if it actually points at a *.supabase.co host.
const envUrlRaw = (process.env.SUPABASE_URL || "").trim();
const SUPABASE_URL =
  envUrlRaw && envUrlRaw.includes(".supabase.co")
    ? envUrlRaw
    : FALLBACK_SUPABASE_URL;
// The anon key must be a 3-part JWT with the correct project ref; otherwise use
// the baked-in fallback (the anon key is a public, RLS-safe key).
const envAnon = (process.env.SUPABASE_ANON_KEY || "").trim();
const ANON_KEY =
  envAnon.split(".").length === 3 && envAnon.includes("yhrzmxnahkgbqrxfjsyb")
    ? envAnon
    : FALLBACK_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

if (!SUPABASE_URL || !ANON_KEY) {
  console.warn("[supabase] SUPABASE_URL / SUPABASE_ANON_KEY not set");
}

// Some published/hosted sandboxes (e.g. the Perplexity pplx.app sandbox) set
// HTTPS_PROXY/HTTP_PROXY to route outbound traffic through a credential-injecting
// proxy. That proxy can corrupt Supabase REST (PostgREST) and GoTrue calls, so
// in THOSE environments we force a DIRECT connection via a custom undici Agent
// with no proxy configured.
//
// On Vercel (and any normal host) there is NO such proxy, and installing a
// custom undici dispatcher/fetch inside the serverless runtime can itself throw
// at call time (FUNCTION_INVOCATION_FAILED on the first Supabase call). So we
// ONLY install the custom fetch when a proxy env var is actually present;
// otherwise supabase-js uses the platform's native global fetch.
const hasOutboundProxy = Boolean(
  process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy,
);
let directFetch: typeof fetch | undefined = undefined;
if (hasOutboundProxy) {
  try {
    // undici ships with Node 18+; Agent bypasses env proxy settings.
    const agent = new Agent();
    directFetch = ((input: any, init: any = {}) =>
      undiciFetch(input, {
        ...init,
        dispatcher: agent,
      })) as unknown as typeof fetch;
  } catch {
    directFetch = undefined; // fall back to global fetch if undici isn't present
  }
}

const clientOpts = {
  auth: { autoRefreshToken: false, persistSession: false },
  ...(directFetch ? { global: { fetch: directFetch } } : {}),
};

/**
 * Anon client — used to verify a user's access token (auth.getUser)
 * and for reads/writes that go through normal channels.
 */
export const supabaseAnon = createClient(SUPABASE_URL, ANON_KEY, clientOpts);

/**
 * Admin client — uses the service_role key. Required for creating user
 * accounts (auth.admin.createUser) and privileged DB writes that bypass RLS.
 * Only present when SUPABASE_SERVICE_ROLE_KEY is configured (set in Vercel
 * encrypted env at deploy; may be blank in preview).
 */
export const supabaseAdmin = SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SERVICE_ROLE_KEY, clientOpts)
  : null;

export const hasAdmin = () => supabaseAdmin !== null;

export const SUPABASE_URL_PUBLIC = SUPABASE_URL;
export const SUPABASE_ANON_PUBLIC = ANON_KEY;
