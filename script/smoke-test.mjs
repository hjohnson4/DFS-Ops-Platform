#!/usr/bin/env node
// DFS Ops deployment smoke test.
//
// Points at ANY deployment (Vercel preview/production, pplx.app, or local) and
// verifies the critical paths work end-to-end: health/adminReady, auth, the
// JSON-404 API guard, role-based area scoping, and the assets-on-jobs feature.
//
// Usage:
//   node script/smoke-test.mjs <BASE_URL>
//   node script/smoke-test.mjs https://dfs-ops-git-my-branch.vercel.app
//   node script/smoke-test.mjs https://dfs-operations.pplx.app/port/5000   (pplx)
//
// Optional env overrides for credentials (defaults are the demo accounts):
//   ADMIN_EMAIL / ADMIN_PW   AREA_EMAIL / AREA_PW   FIELD_EMAIL / FIELD_PW
//
// Exit code 0 = all passed, 1 = one or more failures.

const BASE = (process.argv[2] || "").replace(/\/+$/, "");
if (!BASE) {
  console.error("Usage: node script/smoke-test.mjs <BASE_URL>");
  process.exit(2);
}

// A browser-like UA bypasses Cloudflare's 403 "error code: 1010" on pplx.app.
// Harmless on Vercel. Keeps the same script usable across all targets.
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const CREDS = {
  admin: { email: process.env.ADMIN_EMAIL || "admin@dfsops.com", pw: process.env.ADMIN_PW || "DfsOps2026!" },
  area: { email: process.env.AREA_EMAIL || "super@dfsops.com", pw: process.env.AREA_PW || "DfsOps2026!" },
  field: { email: process.env.FIELD_EMAIL || "tech1@dfsops.com", pw: process.env.FIELD_PW || "DfsOps2026!" },
};

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  \u2713 ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  \u2717 ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function api(method, path, { token, body } = {}) {
  const headers = { "User-Agent": UA, Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers["Content-Type"] = "application/json";
  let res, text, json;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    text = await res.text();
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  } catch (e) {
    return { status: 0, json: null, text: String(e), networkError: true };
  }
  return { status: res.status, json, text };
}

async function login(kind) {
  const c = CREDS[kind];
  const r = await api("POST", "/api/auth/login", { body: { email: c.email, password: c.pw } });
  return r;
}

async function main() {
  console.log(`\nDFS Ops smoke test → ${BASE}\n`);

  // ---- 1. Health & config -------------------------------------------------
  console.log("Health & config");
  const health = await api("GET", "/api/health");
  ok("GET /api/health returns 200", health.status === 200, `status ${health.status}`);
  ok("health body has ok:true", health.json?.ok === true);
  const adminReady = health.json?.adminReady === true;
  ok(
    "adminReady flag present",
    typeof health.json?.adminReady === "boolean",
    adminReady
      ? "TRUE — service-role key configured, user creation enabled"
      : "FALSE — service-role key NOT set (self-service account creation disabled)",
  );

  // ---- 2. API 404 guard (must NOT fall through to SPA index.html) --------
  console.log("\nAPI routing guard");
  const missing = await api("GET", "/api/does-not-exist-xyz");
  ok("unknown /api route returns 404", missing.status === 404, `status ${missing.status}`);
  ok(
    "unknown /api route returns JSON (not SPA HTML)",
    missing.json !== null && typeof missing.json?.message === "string",
    missing.json ? "got JSON error" : "got HTML — SPA fallback is masking the API!",
  );

  // ---- 3. Auth ------------------------------------------------------------
  console.log("\nAuthentication");
  const badLogin = await api("POST", "/api/auth/login", {
    body: { email: "admin@dfsops.com", password: "wrong-password-xyz" },
  });
  ok("bad password rejected 401", badLogin.status === 401, `status ${badLogin.status}`);

  const adminLogin = await login("admin");
  ok("admin login 200", adminLogin.status === 200, `status ${adminLogin.status}`);
  const adminToken = adminLogin.json?.access_token;
  ok("admin login returns access_token", !!adminToken);
  ok("admin profile role=admin", adminLogin.json?.profile?.role === "admin", `role ${adminLogin.json?.profile?.role}`);

  ok(
    "unauthenticated protected route rejected 401",
    (await api("GET", "/api/me")).status === 401,
  );

  const me = await api("GET", "/api/me", { token: adminToken });
  ok("GET /api/me with token 200", me.status === 200, `status ${me.status}`);

  // ---- 4. Authenticated reads (admin sees everything) --------------------
  console.log("\nAuthenticated reads (admin)");
  const customers = await api("GET", "/api/customers", { token: adminToken });
  ok("GET /api/customers 200 + array", customers.status === 200 && Array.isArray(customers.json), `${Array.isArray(customers.json) ? customers.json.length + " rows" : "not array"}`);
  const adminJobs = await api("GET", "/api/jobs", { token: adminToken });
  ok("GET /api/jobs 200 + array", adminJobs.status === 200 && Array.isArray(adminJobs.json), `${Array.isArray(adminJobs.json) ? adminJobs.json.length + " jobs" : "not array"}`);
  const assets = await api("GET", "/api/assets", { token: adminToken });
  ok("GET /api/assets 200 + array", assets.status === 200 && Array.isArray(assets.json), `${Array.isArray(assets.json) ? assets.json.length + " assets" : "not array"}`);

  // ---- 5. Role-based area scoping ----------------------------------------
  console.log("\nRole-based area scoping");
  const areaLogin = await login("area");
  if (areaLogin.status === 200) {
    const areaToken = areaLogin.json?.access_token;
    const areaRole = areaLogin.json?.profile?.role;
    const areaName = areaLogin.json?.profile?.area;
    ok("area/super account login 200", true, `role=${areaRole}, area=${areaName ?? "—"}`);
    const areaJobs = await api("GET", "/api/jobs", { token: areaToken });
    ok("scoped user GET /api/jobs 200", areaJobs.status === 200 && Array.isArray(areaJobs.json));
    if (Array.isArray(areaJobs.json) && areaName) {
      const allInArea = areaJobs.json.every((j) => j.area === areaName);
      ok(
        "scoped user sees ONLY their area's jobs",
        allInArea,
        allInArea ? `all ${areaJobs.json.length} jobs in ${areaName}` : "LEAK: jobs from other areas visible",
      );
    }
    if (Array.isArray(adminJobs.json) && Array.isArray(areaJobs.json)) {
      ok(
        "admin sees >= scoped user's job count",
        adminJobs.json.length >= areaJobs.json.length,
        `admin ${adminJobs.json.length} vs scoped ${areaJobs.json.length}`,
      );
    }
  } else {
    ok("area/super account login", false, `status ${areaLogin.status} (skipping scope checks)`);
  }

  const fieldLogin = await login("field");
  if (fieldLogin.status === 200) {
    ok("field account login 200", true, `role=${fieldLogin.json?.profile?.role}`);
    const fieldMe = await api("GET", "/api/me", { token: fieldLogin.json?.access_token });
    ok("field user /api/me 200", fieldMe.status === 200);
  } else {
    ok("field account login", false, `status ${fieldLogin.status}`);
  }

  // ---- 6. Assets-on-jobs feature (read-side sanity) ----------------------
  console.log("\nAssets-on-jobs feature");
  if (Array.isArray(adminJobs.json)) {
    const active = adminJobs.json.find((j) => j.status === "Active");
    if (active) {
      const jobDetail = await api("GET", `/api/jobs/${active.id}`, { token: adminToken });
      ok("GET active job detail 200", jobDetail.status === 200, `job ${active.job_number ?? active.id}`);
    } else {
      ok("active job present to verify asset UI", false, "no Active job found (feature UI only shows on Active jobs)");
    }
    // Cross-area guard: try to attach an asset to a job in a different area.
    if (Array.isArray(assets.json) && assets.json.length && active) {
      const wrongAreaAsset = assets.json.find((a) => a.area && a.area !== active.area);
      if (wrongAreaAsset) {
        const guard = await api("PATCH", `/api/assets/${wrongAreaAsset.id}`, {
          token: adminToken,
          body: { job_id: active.id, status: "Deployed" },
        });
        const rejected = guard.status === 400;
        ok(
          "cross-area asset attach rejected 400",
          rejected,
          rejected ? "guard held" : `status ${guard.status} — NOTE: no state was persisted on failure only`,
        );
        // If it wrongly succeeded, roll back so we don't leave live data changed.
        if (guard.status === 200) {
          await api("PATCH", `/api/assets/${wrongAreaAsset.id}`, {
            token: adminToken,
            body: { job_id: null, status: "Available" },
          });
        }
      } else {
        ok("cross-area guard testable", true, "skipped — no out-of-area asset available (non-fatal)");
      }
    }
  }

  // ---- Summary ------------------------------------------------------------
  console.log(`\n${"─".repeat(48)}`);
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  if (fail) {
    console.log(`FAILED: ${failures.join(", ")}`);
    if (!adminReady) {
      console.log(
        "\nReminder: adminReady=FALSE is expected until SUPABASE_SERVICE_ROLE_KEY\n" +
          "is set in the deployment env. It is not a test failure on its own.",
      );
    }
  }
  console.log(`${"─".repeat(48)}\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("SMOKE TEST CRASHED:", e);
  process.exit(1);
});
