import { QueryClient, QueryFunction } from "@tanstack/react-query";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

// ---- Auth token store -----------------------------------------------------
// The access token lives in memory. The refresh token is kept in memory too
// (so a long session survives the ~1 hour access-token expiry), and when the
// user ticks "Remember me" it is ALSO saved in localStorage so they stay
// signed in after closing the browser. Storage is wrapped in try/catch because
// it is blocked in some sandboxed previews — there we fall back to memory.
let accessToken: string | null = null;
let refreshToken: string | null = null;
let remember = false;
const RT_KEY = "dfs-ops-remember-token";
const EMAIL_KEY = "dfs-ops-remember-email";

function store(): Storage | null {
  try {
    const s = window.localStorage;
    s.setItem("__dfs_t", "1");
    s.removeItem("__dfs_t");
    return s;
  } catch {
    return null;
  }
}

export function setSession(
  access: string | null,
  refresh?: string | null,
  rememberMe?: boolean,
) {
  accessToken = access;
  refreshToken = refresh ?? null;
  if (rememberMe !== undefined) remember = rememberMe;
  const s = store();
  if (s) {
    if (remember && refreshToken) s.setItem(RT_KEY, refreshToken);
    else s.removeItem(RT_KEY);
  }
}

export function setAccessToken(token: string | null) {
  if (token === null) setSession(null, null, false);
  else accessToken = token;
}
export function getAccessToken(): string | null {
  return accessToken;
}
export function hasRememberedLogin(): boolean {
  return !!store()?.getItem(RT_KEY);
}
export function getRememberedEmail(): string {
  return store()?.getItem(EMAIL_KEY) || "";
}
export function setRememberedEmail(email: string | null) {
  const s = store();
  if (!s) return;
  if (email) s.setItem(EMAIL_KEY, email);
  else s.removeItem(EMAIL_KEY);
}

// Swap the refresh token for a new session. Single-flight so parallel 401s
// share one refresh. Returns true when a new access token is in place.
let inflight: Promise<boolean> | null = null;
export function refreshSession(): Promise<boolean> {
  if (inflight) return inflight;
  const saved = store()?.getItem(RT_KEY) || null;
  const rt = refreshToken || saved;
  if (!rt) return Promise.resolve(false);
  const keep = remember || (!refreshToken && !!saved);
  inflight = (async () => {
    try {
      const res = await fetch(`${API_BASE}/api/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: rt }),
      });
      if (res.status === 401 || res.status === 403) {
        setSession(null, null, false); // token is dead — sign in again
        return false;
      }
      if (!res.ok) return false; // temporary problem — keep the token
      const d = await res.json();
      setSession(d.access_token, d.refresh_token, keep);
      return true;
    } catch {
      return false;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

const isAuthUrl = (url: string) => url.startsWith("/api/auth/");

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const t = getAccessToken();
  return t ? { ...extra, Authorization: `Bearer ${t}` } : extra;
}

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const body = await res.json();
      msg = body.message || msg;
    } catch {
      /* non-json */
    }
    const err = new Error(msg) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const send = () =>
    fetch(`${API_BASE}${url}`, {
      method,
      headers: authHeaders(data ? { "Content-Type": "application/json" } : {}),
      body: data ? JSON.stringify(data) : undefined,
    });
  let res = await send();
  // Expired access token: refresh once and retry.
  if (res.status === 401 && !isAuthUrl(url) && (await refreshSession())) res = await send();
  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const url = queryKey.join("/");
    const send = () => fetch(`${API_BASE}${url}`, { headers: authHeaders() });
    let res = await send();
    if (res.status === 401 && !isAuthUrl(url) && (await refreshSession())) res = await send();
    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }
    await throwIfResNotOk(res);
    return await res.json();
  };

// A 401 means the in-memory token is missing/expired — retrying won't help and
// only delays the sign-in redirect. Everything else (network blips, a cold
// Supabase connection, transient Cloudflare 5xx) is worth a couple of retries
// so a single hiccup doesn't make a list look empty.
function isAuthError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /\b401\b|unauthorized|not authenticated|invalid token|jwt/i.test(msg);
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: true,
      staleTime: 30_000,
      // Retry transient failures up to 2 times with backoff; never retry auth.
      retry: (failureCount, error) =>
        !isAuthError(error) && failureCount < 2,
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 4000),
    },
    mutations: {
      retry: false,
    },
  },
});
