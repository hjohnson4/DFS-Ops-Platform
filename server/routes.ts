import type { Express, Request, Response } from "express";
import type { Server } from "node:http";
import { supabaseAnon, supabaseAdmin, hasAdmin } from "./supabase";
import { requireAuth, requireRole, areaScopeOf, jobScopeOf } from "./auth";
import { sendNotificationEmails, sendDailyReportChanges, emailConfigured } from "./email";
import { parseDailyReportWorkbook, ExcelParseError } from "./excelDailyReport";
import * as XLSX from "xlsx";
import { AREAS } from "@shared/schema";
import {
  createUserSchema,
  updateUserSchema,
  createAssetSchema,
  updateAssetSchema,
  createReportSchema,
  uploadServiceReportSchema,
  createCustomerSchema,
  updateCustomerSchema,
  createJobSchema,
  updateJobSchema,
  createPadSchema,
  renamePadSchema,
  createWellSchema,
  openWellSchema,
  closeWellSchema,
  closePadSchema,
  createFieldTicketSchema,
  updateFieldTicketSchema,
  createFieldDailyReportSchema,
  updateFieldDailyReportSchema,
  createJsaSchema,
  updateJsaSchema,
  signoffSchema,
  notifPrefsSchema,
  ingestDailyReportSchema,
  assignDailyReportJobSchema,
  reviewDailyReportSchema,
  updateDailyReportConfigSchema,
  ingestJsaSchema,
  assignJsaJobSchema,
  createCertificationSchema,
  updateCertificationSchema,
  CERT_ROSTER_ROLES,
  createRigUpReportSchema,
  tracksRunHours,
  RUN_HOUR_CATEGORIES,
  serviceStatusFor,
  createMaintenanceScheduleSchema,
  updateMaintenanceScheduleSchema,
  uploadMaintenanceFileSchema,
  createWorkOrderSchema,
  updateWorkOrderSchema,
  WORK_ORDER_MANAGE_ROLES,
  createJobServiceSchema,
  updateJobServiceSchema,
} from "@shared/schema";
import type { ServiceAssetRow, ServiceDashboard } from "@shared/schema";

// Shared secret the scheduled email-analysis task uses to POST reports.
// Set INGEST_TOKEN at deploy (M7); blank means ingest is closed.
const INGEST_TOKEN = process.env.INGEST_TOKEN || "";

export async function registerRoutes(
  httpServer: Server,
  app: Express,
): Promise<Server> {
  // ---- Health / config ----------------------------------------------------
  app.get("/api/health", (_req, res) => {
    // adminReady reflects whether SUPABASE_SERVICE_ROLE_KEY is configured — when
    // true, self-service account creation is enabled. `time` helps confirm a
    // fresh deploy is serving (e.g. after setting the key in the env).
    res.json({ ok: true, adminReady: hasAdmin(), time: new Date().toISOString() });
  });
  // ---- Auth ---------------------------------------------------------------
  // Login: exchange email+password for a Supabase session (access token)
  app.post("/api/auth/login", async (req: Request, res: Response) => {
    const { email, password } = req.body || {};
    if (!email || !password)
      return res.status(400).json({ message: "Email and password required" });

    const { data, error } = await supabaseAnon.auth.signInWithPassword({
      email,
      password,
    });
    if (error || !data.session) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    // Load profile; reject if inactive
    const { data: profile } = await supabaseAnon
      .from("profiles")
      .select("*")
      .eq("id", data.user!.id)
      .single();

    if (!profile)
      return res.status(403).json({ message: "No profile for this account" });
    if (!profile.active)
      return res.status(403).json({ message: "Account deactivated" });

    res.json({
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      profile,
    });
  });

  // Current user
  app.get("/api/me", requireAuth, async (req: Request, res: Response) => {
    // ensure notification prefs exist
    const { data: prefs } = await supabaseAnon
      .from("notification_prefs")
      .select("*")
      .eq("user_id", req.profile!.id)
      .single();
    res.json({ profile: req.profile, prefs: prefs || null });
  });

  // ---- In-app notifications (computed, read-only) -------------------------
  // Derives a live alert feed from current operational state — no dedicated
  // notifications table. Three categories: assets due/overdue for service,
  // daily reports awaiting sign-off (flagged "overdue" past a threshold), and
  // newly received reports still needing a job match. Area-scoped for non-admins.
  // Reviewers (admin/area/super) get the sign-off + new-report alerts; everyone
  // sees maintenance-due. Cheap enough to poll from the header bell.
  app.get(
    "/api/notifications",
    requireAuth,
    async (req: Request, res: Response) => {
      const scope = areaScopeOf(req.profile!);
      const role = req.profile!.role;
      const canReview = role === "admin" || role === "area" || role === "super";
      // Use the anon client (matches the proven /api/daily-reports list route).
      const client = supabaseAnon;
      const now = Date.now();
      const DAY = 24 * 60 * 60 * 1000;
      const SIGNOFF_OVERDUE_DAYS = 2; // pending longer than this = overdue

      type Notification = {
        id: string;
        type: "maintenance_due" | "signoff_overdue" | "signoff_pending" | "new_report";
        severity: "warning" | "info";
        title: string;
        detail: string;
        href: string;
        ts: string | null;
      };
      const items: Notification[] = [];

      // 1) Assets due / overdue for service (run-hour centrifuges).
      let aq = client
        .from("assets")
        .select("id, tag, category, area, run_hours, run_hours_at_service, service_hours_interval")
        .in("category", RUN_HOUR_CATEGORIES as unknown as string[]);
      if (scope) aq = aq.eq("area", scope);
      const { data: assetsData, error: aErr } = await aq;
      if (aErr) console.error("[notifications] assets", aErr.message);
      for (const a of (assetsData || []) as any[]) {
        const { state } = serviceStatusFor(a);
        if (state === "Overdue" || state === "Soon") {
          items.push({
            id: `maint-${a.id}`,
            type: "maintenance_due",
            severity: state === "Overdue" ? "warning" : "info",
            title:
              state === "Overdue"
                ? `${a.tag} is overdue for service`
                : `${a.tag} is due for service soon`,
            detail: `${a.category}${a.area ? ` · ${a.area}` : ""}`,
            href: `/service`,
            ts: null,
          });
        }
      }

      if (canReview) {
        // 2) Daily reports awaiting sign-off + 3) new reports needing a job match.
        let dq = client
          .from("daily_reports")
          .select(
            "id, status, area, well_name, sender_name, sender_email, report_date, received_at",
          )
          .in("status", ["Pending Review", "Needs job match"]);
        if (scope) dq = dq.eq("area", scope);
        const { data: drData, error: dErr } = await dq;
        if (dErr) console.error("[notifications] daily_reports", dErr.message);
        for (const r of (drData || []) as any[]) {
          const who = r.sender_name || r.sender_email || "Unknown sender";
          const well = r.well_name ? ` · ${r.well_name}` : "";
          if (r.status === "Needs job match") {
            items.push({
              id: `newrep-${r.id}`,
              type: "new_report",
              severity: "info",
              title: `New report needs a job match`,
              detail: `${who}${well}${r.area ? ` · ${r.area}` : ""}`,
              href: `/daily-reports/${r.id}`,
              ts: r.received_at || r.report_date || null,
            });
          } else {
            // Pending Review — flag as overdue if older than the threshold.
            const basis = r.report_date || r.received_at;
            const ageDays = basis
              ? (now - new Date(basis).getTime()) / DAY
              : 0;
            const overdue = ageDays >= SIGNOFF_OVERDUE_DAYS;
            items.push({
              id: `signoff-${r.id}`,
              type: overdue ? "signoff_overdue" : "signoff_pending",
              severity: overdue ? "warning" : "info",
              title: overdue
                ? `Sign-off overdue (${Math.floor(ageDays)}d)`
                : `Report awaiting sign-off`,
              detail: `${who}${well}${r.area ? ` · ${r.area}` : ""}`,
              href: `/daily-reports/${r.id}`,
              ts: basis || null,
            });
          }
        }
      }

      // Warnings first, then by most recent timestamp.
      items.sort((x, y) => {
        if (x.severity !== y.severity) return x.severity === "warning" ? -1 : 1;
        const tx = x.ts ? new Date(x.ts).getTime() : 0;
        const ty = y.ts ? new Date(y.ts).getTime() : 0;
        return ty - tx;
      });

      res.json({
        count: items.length,
        warning_count: items.filter((i) => i.severity === "warning").length,
        items,
      });
    },
  );

  // ---- Audit trail --------------------------------------------------------
  // Unified, read-only activity log across every event table:
  //   daily_report_events, jsa_report_events, rig_up_report_events, audit_events
  // Reviewers (admin/area/super) see the full trail; area managers/supers are
  // scoped to their area where the underlying record carries one. Field users
  // only see events they themselves performed. Supports entity/action/actor/
  // date/search filters + pagination, all applied server-side after merge.
  app.get(
    "/api/audit-trail",
    requireAuth,
    async (req: Request, res: Response) => {
      const client = supabaseAnon;
      const profile = req.profile!;
      const scope = areaScopeOf(profile); // null for admin
      const role = profile.role;
      const canSeeAll = role === "admin" || role === "area" || role === "super";

      type Entry = {
        id: string;
        entity: "daily_report" | "jsa" | "rig_up" | "maintenance";
        entity_label: string;
        record_id: string | null;
        actor_id: string | null;
        actor_name: string | null;
        actor_role: string | null;
        action: string;
        detail: string | null;
        area: string | null;
        href: string | null;
        occurred_at: string | null;
      };
      const entries: Entry[] = [];

      // Human-friendly action labels shared across sources.
      const ACTION_LABELS: Record<string, string> = {
        ingested: "Report ingested",
        matched: "Matched to job",
        signed_off: "Signed off",
        changes_requested: "Changes requested",
        reopened: "Reopened",
        submitted: "Submitted",
        received: "Received",
        Filed: "Service report filed",
        filed: "Service report filed",
      };
      const labelFor = (a: string) => ACTION_LABELS[a] || a;

      // 1) Daily report events -> resolve report area + well/job for context.
      {
        const { data: evs, error } = await client
          .from("daily_report_events")
          .select("id, report_id, actor_id, actor_name, actor_role, action, detail, occurred_at")
          .order("occurred_at", { ascending: false })
          .limit(500);
        if (error) console.error("[audit-trail] daily_report_events", error.message);
        const ids = Array.from(new Set((evs || []).map((e: any) => e.report_id).filter(Boolean)));
        const ctx: Record<string, { area: string | null; label: string }> = {};
        if (ids.length) {
          const { data: reps } = await client
            .from("daily_reports")
            .select("id, area, well_name, report_date")
            .in("id", ids as string[]);
          for (const r of (reps || []) as any[]) {
            ctx[r.id] = {
              area: r.area ?? null,
              label: r.well_name || (r.report_date ? `Report ${r.report_date}` : "Daily report"),
            };
          }
        }
        for (const e of (evs || []) as any[]) {
          const c = ctx[e.report_id] || { area: null, label: "Daily report" };
          entries.push({
            id: `dr-${e.id}`,
            entity: "daily_report",
            entity_label: c.label,
            record_id: e.report_id ?? null,
            actor_id: e.actor_id ?? null,
            actor_name: e.actor_name ?? null,
            actor_role: e.actor_role ?? null,
            action: labelFor(e.action),
            detail: e.detail ?? null,
            area: c.area,
            href: e.report_id ? `/daily-reports/${e.report_id}` : null,
            occurred_at: e.occurred_at ?? null,
          });
        }
      }

      // 2) JSA report events.
      {
        const { data: evs, error } = await client
          .from("jsa_report_events")
          .select("id, jsa_id, actor_id, actor_name, actor_role, action, detail, occurred_at")
          .order("occurred_at", { ascending: false })
          .limit(500);
        if (error) console.error("[audit-trail] jsa_report_events", error.message);
        const ids = Array.from(new Set((evs || []).map((e: any) => e.jsa_id).filter(Boolean)));
        const ctx: Record<string, { area: string | null; label: string }> = {};
        if (ids.length) {
          const { data: rows } = await client
            .from("jsa_reports")
            .select("id, area, subject, jsa_date")
            .in("id", ids as string[]);
          for (const r of (rows || []) as any[]) {
            ctx[r.id] = {
              area: r.area ?? null,
              label: r.subject || (r.jsa_date ? `JSA ${r.jsa_date}` : "JSA"),
            };
          }
        }
        for (const e of (evs || []) as any[]) {
          const c = ctx[e.jsa_id] || { area: null, label: "JSA" };
          entries.push({
            id: `jsa-${e.id}`,
            entity: "jsa",
            entity_label: c.label,
            record_id: e.jsa_id ?? null,
            actor_id: e.actor_id ?? null,
            actor_name: e.actor_name ?? null,
            actor_role: e.actor_role ?? null,
            action: labelFor(e.action),
            detail: e.detail ?? null,
            area: c.area,
            href: e.jsa_id ? `/jsa-intake` : null,
            occurred_at: e.occurred_at ?? null,
          });
        }
      }

      // 3) Rig-up report events.
      {
        const { data: evs, error } = await client
          .from("rig_up_report_events")
          .select("id, rig_up_id, actor_id, actor_name, actor_role, action, detail, occurred_at")
          .order("occurred_at", { ascending: false })
          .limit(500);
        if (error) console.error("[audit-trail] rig_up_report_events", error.message);
        const ids = Array.from(new Set((evs || []).map((e: any) => e.rig_up_id).filter(Boolean)));
        const ctx: Record<string, { area: string | null; label: string }> = {};
        if (ids.length) {
          const { data: rows } = await client
            .from("rig_up_reports")
            .select("id, area, title, report_date")
            .in("id", ids as string[]);
          for (const r of (rows || []) as any[]) {
            ctx[r.id] = {
              area: r.area ?? null,
              label: r.title || (r.report_date ? `Rig-up ${r.report_date}` : "Rig-up report"),
            };
          }
        }
        for (const e of (evs || []) as any[]) {
          const c = ctx[e.rig_up_id] || { area: null, label: "Rig-up report" };
          entries.push({
            id: `ru-${e.id}`,
            entity: "rig_up",
            entity_label: c.label,
            record_id: e.rig_up_id ?? null,
            actor_id: e.actor_id ?? null,
            actor_name: e.actor_name ?? null,
            actor_role: e.actor_role ?? null,
            action: labelFor(e.action),
            detail: e.detail ?? null,
            area: c.area,
            href: null,
            occurred_at: e.occurred_at ?? null,
          });
        }
      }

      // 4) Maintenance/service audit_events -> resolve asset for area + tag.
      {
        const { data: evs, error } = await client
          .from("audit_events")
          .select("id, report_id, asset_id, actor_id, actor_name, actor_role, action, occurred_at")
          .order("occurred_at", { ascending: false })
          .limit(500);
        if (error) console.error("[audit-trail] audit_events", error.message);
        const ids = Array.from(new Set((evs || []).map((e: any) => e.asset_id).filter(Boolean)));
        const ctx: Record<string, { area: string | null; label: string }> = {};
        if (ids.length) {
          const { data: rows } = await client
            .from("assets")
            .select("id, area, tag, category")
            .in("id", ids as string[]);
          for (const r of (rows || []) as any[]) {
            ctx[r.id] = {
              area: r.area ?? null,
              label: r.tag ? `${r.tag}${r.category ? ` · ${r.category}` : ""}` : "Asset",
            };
          }
        }
        for (const e of (evs || []) as any[]) {
          const c = (e.asset_id && ctx[e.asset_id]) || { area: null, label: "Service report" };
          entries.push({
            id: `ae-${e.id}`,
            entity: "maintenance",
            entity_label: c.label,
            record_id: e.asset_id ?? e.report_id ?? null,
            actor_id: e.actor_id ?? null,
            actor_name: e.actor_name ?? null,
            actor_role: e.actor_role ?? null,
            action: labelFor(e.action),
            detail: null,
            area: c.area,
            href: "/service",
            occurred_at: e.occurred_at ?? null,
          });
        }
      }

      // ---- Access scoping ---------------------------------------------------
      // Field users only ever see their own actions. Area/super are limited to
      // their area (entries with no area are kept — system/global events).
      let visible = entries;
      if (!canSeeAll) {
        visible = visible.filter((e) => e.actor_id === profile.id);
      } else if (scope) {
        visible = visible.filter((e) => !e.area || e.area === scope);
      }

      // ---- Filters ----------------------------------------------------------
      const q = (req.query.q as string | undefined)?.trim().toLowerCase();
      const entityFilter = req.query.entity as string | undefined;
      const actionFilter = req.query.action as string | undefined;
      const actorFilter = req.query.actor as string | undefined;
      const from = req.query.from as string | undefined; // ISO date (inclusive)
      const to = req.query.to as string | undefined; // ISO date (inclusive)

      if (entityFilter && entityFilter !== "all")
        visible = visible.filter((e) => e.entity === entityFilter);
      if (actionFilter && actionFilter !== "all")
        visible = visible.filter((e) => e.action === actionFilter);
      if (actorFilter && actorFilter !== "all")
        visible = visible.filter((e) => (e.actor_name || "") === actorFilter);
      if (from) {
        const t = new Date(from + "T00:00:00").getTime();
        visible = visible.filter((e) => e.occurred_at && new Date(e.occurred_at).getTime() >= t);
      }
      if (to) {
        const t = new Date(to + "T23:59:59").getTime();
        visible = visible.filter((e) => e.occurred_at && new Date(e.occurred_at).getTime() <= t);
      }
      if (q) {
        visible = visible.filter((e) =>
          [e.actor_name, e.action, e.detail, e.entity_label, e.area]
            .filter(Boolean)
            .some((f) => String(f).toLowerCase().includes(q)),
        );
      }

      // Newest first.
      visible.sort((a, b) => {
        const ta = a.occurred_at ? new Date(a.occurred_at).getTime() : 0;
        const tb = b.occurred_at ? new Date(b.occurred_at).getTime() : 0;
        return tb - ta;
      });

      // Distinct facet values (from the access-scoped set, before filters) so the
      // dropdowns only ever offer choices the user is allowed to see.
      const accessScoped = canSeeAll
        ? (scope ? entries.filter((e) => !e.area || e.area === scope) : entries)
        : entries.filter((e) => e.actor_id === profile.id);
      const actions = Array.from(new Set(accessScoped.map((e) => e.action))).sort();
      const actors = Array.from(
        new Set(accessScoped.map((e) => e.actor_name).filter(Boolean) as string[]),
      ).sort();

      // Pagination.
      const total = visible.length;
      const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "50"), 10) || 50, 1), 200);
      const offset = Math.max(parseInt(String(req.query.offset ?? "0"), 10) || 0, 0);
      const page = visible.slice(offset, offset + limit);

      res.json({
        total,
        limit,
        offset,
        items: page,
        facets: { actions, actors },
      });
    },
  );

  // ---- User management (admin only) ---------------------------------------
  app.get(
    "/api/users",
    requireAuth,
    requireRole("admin"),
    async (_req: Request, res: Response) => {
      const { data, error } = await supabaseAnon
        .from("profiles")
        .select("*")
        .order("created_at", { ascending: true });
      if (error) return res.status(500).json({ message: error.message });
      res.json(data);
    },
  );

  app.post(
    "/api/users",
    requireAuth,
    requireRole("admin"),
    async (req: Request, res: Response) => {
      const parsed = createUserSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });

      if (!hasAdmin() || !supabaseAdmin) {
        return res.status(503).json({
          message:
            "Account creation is not enabled yet. The service role key must be configured in the deployment environment.",
        });
      }

      const { email, name, password, role, area } = parsed.data;

      // 1. Create the auth user (email confirmed so they can log in immediately)
      const { data: created, error: cErr } =
        await supabaseAdmin.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
          user_metadata: { name },
        });
      if (cErr || !created.user)
        return res.status(400).json({ message: cErr?.message || "Could not create user" });

      // 2. Insert profile row
      const { data: profile, error: pErr } = await supabaseAdmin
        .from("profiles")
        .insert({
          id: created.user.id,
          email,
          name,
          role,
          area: role === "admin" ? null : area ?? null,
          active: true,
        })
        .select()
        .single();
      if (pErr) {
        // rollback auth user on profile failure
        await supabaseAdmin.auth.admin.deleteUser(created.user.id);
        return res.status(400).json({ message: pErr.message });
      }

      // 3. Default notification prefs
      await supabaseAdmin.from("notification_prefs").insert({
        user_id: created.user.id,
        on_signed: true,
        on_needs_signoff: role === "area",
        on_filed: false,
      });

      res.status(201).json(profile);
    },
  );

  app.patch(
    "/api/users/:id",
    requireAuth,
    requireRole("admin"),
    async (req: Request, res: Response) => {
      const parsed = updateUserSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      const client = supabaseAdmin || supabaseAnon;
      const { data, error } = await client
        .from("profiles")
        .update(parsed.data)
        .eq("id", req.params.id)
        .select()
        .single();
      if (error) return res.status(400).json({ message: error.message });
      res.json(data);
    },
  );

  // ---- Customers ----------------------------------------------------------
  // Customers are company-wide (a customer can have jobs across areas).
  // Everyone can view; only admin/area managers can create/edit.
  app.get("/api/customers", requireAuth, async (_req: Request, res: Response) => {
    const { data, error } = await supabaseAnon
      .from("customers")
      .select("*")
      .order("name");
    if (error) return res.status(500).json({ message: error.message });
    res.json(data);
  });

  app.get("/api/customers/:id", requireAuth, async (req: Request, res: Response) => {
    const { data, error } = await supabaseAnon
      .from("customers")
      .select("*")
      .eq("id", req.params.id)
      .single();
    if (error || !data)
      return res.status(404).json({ message: "Customer not found" });
    res.json(data);
  });

  app.post(
    "/api/customers",
    requireAuth,
    requireRole("admin", "area"),
    async (req: Request, res: Response) => {
      const parsed = createCustomerSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      const client = supabaseAdmin || supabaseAnon;
      const payload = {
        ...parsed.data,
        email: parsed.data.email === "" ? null : parsed.data.email,
      };
      const { data, error } = await client
        .from("customers")
        .insert(payload)
        .select()
        .single();
      if (error) return res.status(400).json({ message: error.message });
      res.status(201).json(data);
    },
  );

  app.patch(
    "/api/customers/:id",
    requireAuth,
    requireRole("admin", "area"),
    async (req: Request, res: Response) => {
      const parsed = updateCustomerSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      const client = supabaseAdmin || supabaseAnon;
      const patch: any = { ...parsed.data };
      if (patch.email === "") patch.email = null;
      const { data, error } = await client
        .from("customers")
        .update(patch)
        .eq("id", req.params.id)
        .select()
        .single();
      if (error) return res.status(400).json({ message: error.message });
      res.json(data);
    },
  );

  // ---- Jobs ---------------------------------------------------------------
  // Jobs are area-scoped. Field/super/area see their area; admin sees all.
  app.get("/api/jobs", requireAuth, async (req: Request, res: Response) => {
    const scope = areaScopeOf(req.profile!);
    const jobIds = await jobScopeOf(req.profile!);
    // Archive visibility: default hides archived jobs. ?archived=true returns
    // only archived jobs; ?include_archived=true returns both.
    const onlyArchived = String(req.query.archived || "") === "true";
    const includeArchived =
      onlyArchived || String(req.query.include_archived || "") === "true";
    let q = supabaseAnon
      .from("jobs")
      .select("*, customer:customers(name)")
      .order("created_at", { ascending: false });
    if (scope) q = q.eq("area", scope);
    // Field techs assigned to jobs see ONLY those jobs.
    if (jobIds) q = q.in("id", jobIds);
    if (onlyArchived) q = q.not("archived_at", "is", null);
    else if (!includeArchived) q = q.is("archived_at", null);
    const { data, error } = await q;
    if (error) return res.status(500).json({ message: error.message });
    // flatten the joined customer name
    const rows = (data || []).map((j: any) => ({
      ...j,
      customer_name: j.customer?.name ?? "",
      customer: undefined,
    }));
    res.json(rows);
  });

  app.get("/api/jobs/:id", requireAuth, async (req: Request, res: Response) => {
    const { data, error } = await supabaseAnon
      .from("jobs")
      .select("*, customer:customers(name)")
      .eq("id", req.params.id)
      .single();
    if (error || !data)
      return res.status(404).json({ message: "Job not found" });
    // area scope: non-admins can only view jobs in their own area
    const scope = areaScopeOf(req.profile!);
    if (scope && data.area !== scope)
      return res.status(404).json({ message: "Job not found" });
    // job scope: assigned field techs can only view their assigned jobs
    const jobIds = await jobScopeOf(req.profile!);
    if (jobIds && !jobIds.includes(data.id))
      return res.status(404).json({ message: "Job not found" });
    const { customer, ...rest } = data as any;
    // Include the job's current field-tech assignments (id + name) so the
    // edit form can pre-select them.
    const { data: assigns } = await supabaseAnon
      .from("job_assignments")
      .select("profile_id, profile:profiles!job_assignments_profile_id_fkey(name,role)")
      .eq("job_id", data.id);
    const assignments = (assigns || []).map((a: any) => ({
      profile_id: a.profile_id,
      profile_name: a.profile?.name ?? null,
      profile_role: a.profile?.role ?? null,
    }));
    res.json({
      ...rest,
      customer_name: customer?.name ?? "",
      field_tech_ids: assignments.map((a: any) => a.profile_id),
      assignments,
    });
  });

  // Assignable field techs for a given area (used by the job create/edit form).
  // Admin/area/super only. ?area=West Texas narrows to that area; without it,
  // non-admins are scoped to their own area and admins get all field techs.
  app.get(
    "/api/field-techs",
    requireAuth,
    requireRole("admin", "area", "super"),
    async (req: Request, res: Response) => {
      const areaParam = String(req.query.area || "").trim();
      const scope = areaScopeOf(req.profile!);
      const area = areaParam || scope || null;
      let q = supabaseAnon
        .from("profiles")
        .select("id, name, role, area")
        .eq("role", "field")
        .eq("active", true)
        .order("name", { ascending: true });
      // Non-admins can only ever see techs in their own area, regardless of ?area.
      if (scope) q = q.eq("area", scope);
      else if (area) q = q.eq("area", area);
      const { data, error } = await q;
      if (error) return res.status(500).json({ message: error.message });
      res.json(data || []);
    },
  );

  // Assignable supervisors for a given area (used by the job create/edit form).
  // Admin/area/super only. Mirrors /api/field-techs but for the super role.
  app.get(
    "/api/supervisors",
    requireAuth,
    requireRole("admin", "area", "super"),
    async (req: Request, res: Response) => {
      const areaParam = String(req.query.area || "").trim();
      const scope = areaScopeOf(req.profile!);
      const area = areaParam || scope || null;
      let q = supabaseAnon
        .from("profiles")
        .select("id, name, role, area")
        .eq("role", "super")
        .eq("active", true)
        .order("name", { ascending: true });
      if (scope) q = q.eq("area", scope);
      else if (area) q = q.eq("area", area);
      const { data, error } = await q;
      if (error) return res.status(500).json({ message: error.message });
      res.json(data || []);
    },
  );

  // Replace the full set of field-tech assignments for a job. Only field-role
  // profiles in the job's area are eligible; anything else is silently ignored.
  // `assignedBy` is stamped on each new row. Returns a warning string on error
  // (the caller decides whether to surface it) or null on success.
  // Replace the assignment set for ONE role (field or super) on a job without
  // disturbing the other role's assignments. Only active profiles of that role
  // in the job's area are eligible; anything else is silently ignored.
  const syncJobAssignmentsForRole = async (
    client: any,
    jobId: string,
    jobArea: string,
    role: "field" | "super",
    profileIds: string[],
    assignedBy: string,
  ): Promise<string | null> => {
    // Validate: keep only ids that are active profiles of `role` in the area.
    let eligible: string[] = [];
    if (profileIds.length > 0) {
      const { data: people } = await client
        .from("profiles")
        .select("id")
        .in("id", profileIds)
        .eq("role", role)
        .eq("active", true)
        .eq("area", jobArea);
      eligible = (people || []).map((t: { id: string }) => t.id);
    }
    // Find which currently-assigned profiles belong to this role, so we only
    // clear (and replace) that role's rows — leaving the other role intact.
    const { data: existing } = await client
      .from("job_assignments")
      .select("profile_id, profile:profiles!job_assignments_profile_id_fkey(role)")
      .eq("job_id", jobId);
    const roleRowIds = (existing || [])
      .filter((a: any) => a.profile?.role === role)
      .map((a: any) => a.profile_id);
    if (roleRowIds.length > 0) {
      const { error: delErr } = await client
        .from("job_assignments")
        .delete()
        .eq("job_id", jobId)
        .in("profile_id", roleRowIds);
      if (delErr) return delErr.message;
    }
    if (eligible.length > 0) {
      const rows = eligible.map((pid) => ({
        job_id: jobId,
        profile_id: pid,
        assigned_by: assignedBy,
      }));
      const { error: insErr } = await client
        .from("job_assignments")
        .insert(rows);
      if (insErr) return insErr.message;
    }
    return null;
  };

  // Backwards-compatible wrapper: field-tech assignment sync.
  const syncJobFieldTechs = async (
    client: any,
    jobId: string,
    jobArea: string,
    profileIds: string[],
    assignedBy: string,
  ): Promise<string | null> =>
    syncJobAssignmentsForRole(client, jobId, jobArea, "field", profileIds, assignedBy);

  const syncJobSupervisors = async (
    client: any,
    jobId: string,
    jobArea: string,
    profileIds: string[],
    assignedBy: string,
  ): Promise<string | null> =>
    syncJobAssignmentsForRole(client, jobId, jobArea, "super", profileIds, assignedBy);

  app.post(
    "/api/jobs",
    requireAuth,
    requireRole("admin", "area", "super"),
    async (req: Request, res: Response) => {
      const parsed = createJobSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      // non-admins can only create jobs in their own area
      if (req.profile!.role !== "admin" && parsed.data.area !== req.profile!.area)
        return res
          .status(403)
          .json({ message: "You can only create jobs in your area" });
      const client = supabaseAdmin || supabaseAnon;
      const { data, error } = await client
        .from("jobs")
        .insert({
          job_number: parsed.data.job_number,
          area: parsed.data.area,
          customer_id: parsed.data.customer_id,
          description: parsed.data.description ?? null,
          status: parsed.data.status ?? "Active",
          crewing: parsed.data.crewing ?? "Manned",
          started_on: parsed.data.started_on || null,
          ended_on: parsed.data.ended_on || null,
          day_rate: parsed.data.day_rate ?? null,
          well_name: parsed.data.well_name?.trim() || null,
        })
        .select()
        .single();
      if (error) {
        // unique (job_number, area) violation
        if (error.code === "23505")
          return res.status(409).json({
            message: `Job ${parsed.data.job_number} already exists in ${parsed.data.area}`,
          });
        return res.status(400).json({ message: error.message });
      }

      // Assign any selected assets to the new job. Only assets in the same
      // area are eligible; silently ignore any that don't qualify.
      const assetIds = parsed.data.asset_ids ?? [];
      if (assetIds.length > 0) {
        const { error: assignErr } = await client
          .from("assets")
          .update({ job_id: data.id, status: "On Job" })
          .in("id", assetIds)
          .eq("area", data.area);
        if (assignErr)
          // job is already created; report the partial failure without 500ing
          return res
            .status(201)
            .json({ ...data, asset_assign_warning: assignErr.message });
      }

      // Assign any selected field techs to the new job.
      const techIds = parsed.data.field_tech_ids ?? [];
      if (techIds.length > 0) {
        const warn = await syncJobFieldTechs(
          client,
          data.id,
          data.area,
          techIds,
          req.profile!.id,
        );
        if (warn)
          return res
            .status(201)
            .json({ ...data, tech_assign_warning: warn });
      }

      // Assign any selected supervisors to the new job (any crewing type).
      const supIds = parsed.data.supervisor_ids ?? [];
      if (supIds.length > 0) {
        const warn = await syncJobSupervisors(
          client,
          data.id,
          data.area,
          supIds,
          req.profile!.id,
        );
        if (warn)
          return res
            .status(201)
            .json({ ...data, supervisor_assign_warning: warn });
      }
      res.status(201).json(data);
    },
  );

  app.patch(
    "/api/jobs/:id",
    requireAuth,
    requireRole("admin", "area", "super"),
    async (req: Request, res: Response) => {
      const parsed = updateJobSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      const client = supabaseAdmin || supabaseAnon;
      // area scope check
      const { data: job } = await client
        .from("jobs")
        .select("area")
        .eq("id", req.params.id)
        .single();
      if (!job) return res.status(404).json({ message: "Job not found" });
      if (req.profile!.role !== "admin" && job.area !== req.profile!.area)
        return res.status(403).json({ message: "Outside your area" });
      const patch: any = { ...parsed.data };
      if (patch.started_on === "") patch.started_on = null;
      if (patch.ended_on === "") patch.ended_on = null;
      // field_tech_ids / supervisor_ids are not columns on jobs — handle them
      // separately below.
      const fieldTechIds: string[] | undefined = patch.field_tech_ids;
      delete patch.field_tech_ids;
      const supervisorIds: string[] | undefined = patch.supervisor_ids;
      delete patch.supervisor_ids;
      // If field_tech_ids is the only thing being changed, there are no real
      // job columns to update — just read the row back so we can still return
      // it (an empty .update({}) would coerce to no rows and 400).
      let data: any;
      if (Object.keys(patch).length === 0) {
        const { data: current, error: readErr } = await client
          .from("jobs")
          .select()
          .eq("id", req.params.id)
          .single();
        if (readErr)
          return res.status(400).json({ message: readErr.message });
        data = current;
      } else {
        const { data: updated, error } = await client
          .from("jobs")
          .update(patch)
          .eq("id", req.params.id)
          .select()
          .single();
        if (error) return res.status(400).json({ message: error.message });
        data = updated;
      }
      // When field_tech_ids is provided, replace the job's assignment set.
      if (fieldTechIds !== undefined) {
        const warn = await syncJobFieldTechs(
          client,
          data.id,
          data.area,
          fieldTechIds,
          req.profile!.id,
        );
        if (warn) return res.json({ ...data, tech_assign_warning: warn });
      }
      // When supervisor_ids is provided, replace the job's supervisor set.
      if (supervisorIds !== undefined) {
        const warn = await syncJobSupervisors(
          client,
          data.id,
          data.area,
          supervisorIds,
          req.profile!.id,
        );
        if (warn) return res.json({ ...data, supervisor_assign_warning: warn });
      }
      res.json(data);
    },
  );

  // Archive (soft-delete) a job. Preserves the job and all its history
  // (pads/wells/stints, field tickets, daily reports, JSAs) but hides it from
  // the default jobs list. Assigned assets are released back to Available so
  // they can be used on other jobs.
  app.post(
    "/api/jobs/:id/archive",
    requireAuth,
    requireRole("admin", "area", "super"),
    async (req: Request, res: Response) => {
      const client = supabaseAdmin || supabaseAnon;
      const { data: job } = await client
        .from("jobs")
        .select("area, archived_at")
        .eq("id", req.params.id)
        .single();
      if (!job) return res.status(404).json({ message: "Job not found" });
      if (req.profile!.role !== "admin" && job.area !== req.profile!.area)
        return res.status(403).json({ message: "Outside your area" });
      if (job.archived_at)
        return res.status(409).json({ message: "Job is already archived" });
      const { data, error } = await client
        .from("jobs")
        .update({ archived_at: new Date().toISOString() })
        .eq("id", req.params.id)
        .select()
        .single();
      if (error) return res.status(400).json({ message: error.message });
      // Release assets assigned to this job.
      const { error: relErr } = await client
        .from("assets")
        .update({ job_id: null, status: "Available" })
        .eq("job_id", req.params.id);
      if (relErr)
        return res.json({ ...data, asset_release_warning: relErr.message });
      res.json(data);
    },
  );

  // Restore an archived job. Does not re-assign the assets that were released
  // when it was archived — those are picked again from the job page.
  app.post(
    "/api/jobs/:id/unarchive",
    requireAuth,
    requireRole("admin", "area", "super"),
    async (req: Request, res: Response) => {
      const client = supabaseAdmin || supabaseAnon;
      const { data: job } = await client
        .from("jobs")
        .select("area, archived_at")
        .eq("id", req.params.id)
        .single();
      if (!job) return res.status(404).json({ message: "Job not found" });
      if (req.profile!.role !== "admin" && job.area !== req.profile!.area)
        return res.status(403).json({ message: "Outside your area" });
      if (!job.archived_at)
        return res.status(409).json({ message: "Job is not archived" });
      const { data, error } = await client
        .from("jobs")
        .update({ archived_at: null })
        .eq("id", req.params.id)
        .select()
        .single();
      if (error) return res.status(400).json({ message: error.message });
      res.json(data);
    },
  );

  // ---- Field tickets ------------------------------------------------------
  // Flatten the nested job/customer/creator joins into a flat row.
  const flattenTicket = (t: any) => {
    const { job, creator, ...rest } = t;
    return {
      ...rest,
      line_items: Array.isArray(rest.line_items) ? rest.line_items : [],
      job_number: job?.job_number ?? "",
      area: job?.area ?? null,
      job_status: job?.status ?? null,
      customer_id: job?.customer_id ?? null,
      customer_name: job?.customer?.name ?? "",
      customer_contact: job?.customer?.primary_contact ?? null,
      customer_phone: job?.customer?.phone ?? null,
      customer_email: job?.customer?.email ?? null,
      created_by_name: creator?.name ?? null,
    };
  };

  const TICKET_SELECT =
    "*, job:jobs!field_tickets_job_id_fkey(job_number,area,status,customer_id,customer:customers(name,primary_contact,phone,email)), creator:profiles!field_tickets_created_by_fkey(name)";

  // All field tickets across jobs the user can see. Optional ?status=active|past
  // filters on the parent job's status (past = anything not Active).
  app.get("/api/field-tickets", requireAuth, async (req: Request, res: Response) => {
    const scope = areaScopeOf(req.profile!);
    const jobIds = await jobScopeOf(req.profile!);
    const { data, error } = await supabaseAnon
      .from("field_tickets")
      .select(TICKET_SELECT)
      .order("ticket_date", { ascending: false })
      .order("ticket_number", { ascending: false });
    if (error) return res.status(500).json({ message: error.message });
    let rows = (data || []).map(flattenTicket);
    if (scope) rows = rows.filter((r: any) => r.area === scope);
    if (jobIds) rows = rows.filter((r: any) => jobIds.includes(r.job_id));
    const status = String(req.query.status || "").toLowerCase();
    if (status === "active") rows = rows.filter((r: any) => r.job_status === "Active");
    else if (status === "past") rows = rows.filter((r: any) => r.job_status !== "Active");
    res.json(rows);
  });

  // Tickets for a single job.
  app.get(
    "/api/jobs/:id/field-tickets",
    requireAuth,
    async (req: Request, res: Response) => {
      const scope = areaScopeOf(req.profile!);
      // verify the job is visible to this user
      const { data: job } = await supabaseAnon
        .from("jobs")
        .select("area")
        .eq("id", req.params.id)
        .single();
      if (!job) return res.status(404).json({ message: "Job not found" });
      if (scope && job.area !== scope)
        return res.status(404).json({ message: "Job not found" });
      const jobIds = await jobScopeOf(req.profile!);
      if (jobIds && !jobIds.includes(String(req.params.id)))
        return res.status(404).json({ message: "Job not found" });
      const { data, error } = await supabaseAnon
        .from("field_tickets")
        .select(TICKET_SELECT)
        .eq("job_id", req.params.id)
        .order("ticket_date", { ascending: false })
        .order("ticket_number", { ascending: false });
      if (error) return res.status(500).json({ message: error.message });
      res.json((data || []).map(flattenTicket));
    },
  );

  // Create a field ticket on a job. Supervisors and up; job must be Active.
  app.post(
    "/api/jobs/:id/field-tickets",
    requireAuth,
    requireRole("admin", "area", "super"),
    async (req: Request, res: Response) => {
      const parsed = createFieldTicketSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      const client = supabaseAdmin || supabaseAnon;
      // load the parent job for scope + active check
      const { data: job } = await client
        .from("jobs")
        .select("area,status")
        .eq("id", req.params.id)
        .single();
      if (!job) return res.status(404).json({ message: "Job not found" });
      if (req.profile!.role !== "admin" && job.area !== req.profile!.area)
        return res.status(403).json({ message: "Outside your area" });
      if (job.status !== "Active")
        return res
          .status(400)
          .json({ message: "Field tickets can only be created for active jobs." });
      // Recompute each line's total server-side and derive the ticket amount.
      // A manual `amount` (when provided) overrides the line-item sum.
      const lineItems = (parsed.data.line_items ?? []).map((li) => ({
        description: li.description,
        quantity: li.quantity,
        unit_cost: li.unit_cost,
        total: Math.round(li.quantity * li.unit_cost * 100) / 100,
      }));
      const lineTotal = lineItems.reduce((s, li) => s + li.total, 0);
      const amount =
        parsed.data.amount != null
          ? parsed.data.amount
          : lineItems.length > 0
            ? Math.round(lineTotal * 100) / 100
            : null;
      const { data, error } = await client
        .from("field_tickets")
        .insert({
          job_id: req.params.id,
          ticket_date: parsed.data.ticket_date,
          county: parsed.data.county || null,
          well_name: parsed.data.well_name || null,
          po_afe: parsed.data.po_afe || null,
          description: parsed.data.description || null,
          line_items: lineItems,
          asset_ids: parsed.data.asset_ids ?? [],
          amount,
          comments: parsed.data.comments || null,
          created_by: req.profile!.id,
        })
        .select()
        .single();
      if (error) return res.status(400).json({ message: error.message });
      res.status(201).json(data);
    },
  );

  // Load a ticket + its parent job, enforcing area scope and active-job rule.
  // Returns { ticket, job } on success or an Express response already sent.
  const loadTicketForWrite = async (req: Request, res: Response) => {
    const client = supabaseAdmin || supabaseAnon;
    const { data: ticket } = await client
      .from("field_tickets")
      .select("*")
      .eq("id", req.params.id)
      .single();
    if (!ticket) {
      res.status(404).json({ message: "Field ticket not found" });
      return null;
    }
    const { data: job } = await client
      .from("jobs")
      .select("area,status")
      .eq("id", ticket.job_id)
      .single();
    if (!job) {
      res.status(404).json({ message: "Job not found" });
      return null;
    }
    if (req.profile!.role !== "admin" && job.area !== req.profile!.area) {
      res.status(403).json({ message: "Outside your area" });
      return null;
    }
    if (job.status !== "Active") {
      res.status(400).json({
        message: "Field tickets can only be changed while the job is active.",
      });
      return null;
    }
    return { ticket, job, client };
  };

  // Edit a field ticket. Supervisors and up; parent job must be Active.
  app.patch(
    "/api/field-tickets/:id",
    requireAuth,
    requireRole("admin", "area", "super"),
    async (req: Request, res: Response) => {
      const parsed = updateFieldTicketSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      const loaded = await loadTicketForWrite(req, res);
      if (!loaded) return;
      const p = parsed.data;
      const patch: any = {};
      if (p.ticket_date !== undefined) patch.ticket_date = p.ticket_date;
      if (p.county !== undefined) patch.county = p.county || null;
      if (p.well_name !== undefined) patch.well_name = p.well_name || null;
      if (p.po_afe !== undefined) patch.po_afe = p.po_afe || null;
      if (p.description !== undefined) patch.description = p.description || null;
      if (p.comments !== undefined) patch.comments = p.comments || null;
      if (p.asset_ids !== undefined) patch.asset_ids = p.asset_ids ?? [];
      // Recompute line-item totals when line items are edited.
      let newLineTotal: number | null = null;
      if (p.line_items !== undefined) {
        const lineItems = (p.line_items ?? []).map((li) => ({
          description: li.description,
          quantity: li.quantity,
          unit_cost: li.unit_cost,
          total: Math.round(li.quantity * li.unit_cost * 100) / 100,
        }));
        patch.line_items = lineItems;
        newLineTotal =
          lineItems.length > 0
            ? Math.round(lineItems.reduce((s, li) => s + li.total, 0) * 100) / 100
            : null;
      }
      // A manual amount always wins. Otherwise, if line items changed, sync the
      // amount to their new sum.
      if (p.amount !== undefined) patch.amount = p.amount ?? null;
      else if (newLineTotal !== null) patch.amount = newLineTotal;
      const { data, error } = await loaded.client
        .from("field_tickets")
        .update(patch)
        .eq("id", req.params.id)
        .select()
        .single();
      if (error) return res.status(400).json({ message: error.message });
      res.json(data);
    },
  );

  // Delete a field ticket. Supervisors and up; parent job must be Active.
  app.delete(
    "/api/field-tickets/:id",
    requireAuth,
    requireRole("admin", "area", "super"),
    async (req: Request, res: Response) => {
      const loaded = await loadTicketForWrite(req, res);
      if (!loaded) return;
      const { error } = await loaded.client
        .from("field_tickets")
        .delete()
        .eq("id", req.params.id);
      if (error) return res.status(400).json({ message: error.message });
      res.status(204).end();
    },
  );

  // ==== Field daily reports =================================================
  // Field reports are stored in the unified `daily_reports` table with
  // source = 'field'. These routes keep the /api/field-daily-reports paths
  // working for the job-detail page's per-job create/edit/sign-off flow.
  const FDR_TABLE = "daily_reports";
  const flattenFdr = (r: any) => {
    const { job, submitter, signer, ...rest } = r;
    return {
      ...rest,
      job_number: job?.job_number ?? "",
      area: rest.area ?? job?.area ?? null,
      job_status: job?.status ?? null,
      customer_id: rest.customer_id ?? job?.customer_id ?? null,
      customer_name: job?.customer?.name ?? "",
      submitted_by_name: submitter?.name ?? null,
      signed_by_name: signer?.name ?? null,
    };
  };
  const FDR_SELECT =
    "*, job:jobs!daily_reports_job_id_fkey(job_number,area,status,customer_id,customer:customers(name)), submitter:profiles!daily_reports_submitted_by_fkey(name), signer:profiles!daily_reports_signed_by_fkey(name)";

  // All field daily reports the user can see. ?status=pending|signed filters.
  app.get("/api/field-daily-reports", requireAuth, async (req: Request, res: Response) => {
    const scope = areaScopeOf(req.profile!);
    const jobIds = await jobScopeOf(req.profile!);
    const { data, error } = await supabaseAnon
      .from(FDR_TABLE)
      .select(FDR_SELECT)
      .eq("source", "field")
      .order("report_date", { ascending: false })
      .order("report_number", { ascending: false });
    if (error) return res.status(500).json({ message: error.message });
    let rows = (data || []).map(flattenFdr);
    if (scope) rows = rows.filter((r: any) => r.area === scope);
    if (jobIds) rows = rows.filter((r: any) => jobIds.includes(r.job_id));
    const status = String(req.query.status || "").toLowerCase();
    if (status === "pending") rows = rows.filter((r: any) => r.status !== "Signed off");
    else if (status === "signed") rows = rows.filter((r: any) => r.status === "Signed off");
    res.json(rows);
  });

  // Field daily reports for a single job.
  app.get(
    "/api/jobs/:id/field-daily-reports",
    requireAuth,
    async (req: Request, res: Response) => {
      const scope = areaScopeOf(req.profile!);
      const { data: job } = await supabaseAnon
        .from("jobs")
        .select("area")
        .eq("id", req.params.id)
        .single();
      if (!job) return res.status(404).json({ message: "Job not found" });
      if (scope && job.area !== scope)
        return res.status(404).json({ message: "Job not found" });
      const jobIds = await jobScopeOf(req.profile!);
      if (jobIds && !jobIds.includes(String(req.params.id)))
        return res.status(404).json({ message: "Job not found" });
      const { data, error } = await supabaseAnon
        .from(FDR_TABLE)
        .select(FDR_SELECT)
        .eq("job_id", req.params.id)
        .eq("source", "field")
        .order("report_date", { ascending: false })
        .order("report_number", { ascending: false });
      if (error) return res.status(500).json({ message: error.message });
      res.json((data || []).map(flattenFdr));
    },
  );

  // Field daily-report entry has been retired: all daily reports now arrive via
  // the email intake inbox (dfsdailyreports@gmail.com) and are imported by the
  // daily email check. This endpoint is disabled; existing field reports remain
  // readable and manageable through the other field-daily-report routes.
  app.post(
    "/api/jobs/:id/field-daily-reports",
    requireAuth,
    async (_req: Request, res: Response) => {
      return res.status(410).json({
        message:
          "Field daily-report entry has been retired. Email daily reports to the intake inbox instead.",
      });
    },
  );

  // Load a field daily report + parent job, enforcing area scope. `mutating`
  // additionally requires the job to be Active. Returns {report, job, client}.
  const loadFdrForWrite = async (
    req: Request,
    res: Response,
    opts: { requireActive: boolean },
  ) => {
    const client = supabaseAdmin || supabaseAnon;
    const { data: report } = await client
      .from(FDR_TABLE)
      .select("*")
      .eq("id", req.params.id)
      .single();
    if (!report) {
      res.status(404).json({ message: "Daily report not found" });
      return null;
    }
    const { data: job } = await client
      .from("jobs")
      .select("area,status")
      .eq("id", report.job_id)
      .single();
    if (!job) {
      res.status(404).json({ message: "Job not found" });
      return null;
    }
    if (req.profile!.role !== "admin" && job.area !== req.profile!.area) {
      res.status(403).json({ message: "Outside your area" });
      return null;
    }
    if (opts.requireActive && job.status !== "Active") {
      res.status(400).json({
        message: "Daily reports can only be changed while the job is active.",
      });
      return null;
    }
    return { report, job, client };
  };

  // Edit a field daily report. Submitter (field tech) or supervisors+; not
  // once signed off; job must be Active.
  app.patch(
    "/api/field-daily-reports/:id",
    requireAuth,
    async (req: Request, res: Response) => {
      const parsed = updateFieldDailyReportSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      const loaded = await loadFdrForWrite(req, res, { requireActive: true });
      if (!loaded) return;
      const isSupervisor = ["admin", "area", "super"].includes(req.profile!.role);
      if (!isSupervisor && loaded.report.submitted_by !== req.profile!.id)
        return res.status(403).json({ message: "You can only edit your own reports." });
      if (loaded.report.status === "Signed off")
        return res.status(400).json({ message: "This report is signed off and locked." });
      const p = parsed.data;
      const patch: any = {};
      if (p.report_date !== undefined) patch.report_date = p.report_date;
      if (p.well_name !== undefined) patch.well_name = p.well_name || null;
      if (p.work_summary !== undefined) patch.work_summary = p.work_summary || null;
      if (p.crew_hours !== undefined) patch.crew_hours = p.crew_hours ?? null;
      if (p.crew !== undefined) patch.crew = p.crew ?? [];
      if (p.asset_ids !== undefined) patch.asset_ids = p.asset_ids ?? [];
      if (p.comments !== undefined) patch.comments = p.comments || null;
      // KPIs are never edited on field reports — they only come from the emailed
      // Excel workbook — so no `kpis` handling here.
      // Editing a report that had changes requested moves it back to pending.
      if (loaded.report.status === "Changes requested") {
        patch.status = "Pending Review";
        patch.change_notes = null;
      }
      const { data, error } = await loaded.client
        .from(FDR_TABLE)
        .update(patch)
        .eq("id", req.params.id)
        .select()
        .single();
      if (error) return res.status(400).json({ message: error.message });
      res.json(data);
    },
  );

  // Sign off or request changes on a field daily report. Supervisors+ only.
  app.post(
    "/api/field-daily-reports/:id/signoff",
    requireAuth,
    requireRole("admin", "area", "super"),
    async (req: Request, res: Response) => {
      const parsed = signoffSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      const loaded = await loadFdrForWrite(req, res, { requireActive: false });
      if (!loaded) return;
      const nowIso = new Date().toISOString();
      const signOff = parsed.data.action === "sign_off";
      const patch = signOff
        ? {
            status: "Signed off",
            signed_by: req.profile!.id,
            signed_at: nowIso,
            reviewed_by: req.profile!.id,
            reviewed_by_name: req.profile!.name,
            reviewed_at: nowIso,
            change_notes: null,
          }
        : {
            status: "Changes requested",
            signed_by: null,
            signed_at: null,
            reviewed_by: req.profile!.id,
            reviewed_by_name: req.profile!.name,
            reviewed_at: nowIso,
            change_notes: parsed.data.change_notes || null,
          };
      const { data, error } = await loaded.client
        .from(FDR_TABLE)
        .update(patch)
        .eq("id", req.params.id)
        .select()
        .single();
      if (error) return res.status(400).json({ message: error.message });
      // Record activity so the unified report detail's log stays consistent
      // with emailed reports.
      await loaded.client.from("daily_report_events").insert({
        report_id: req.params.id,
        actor_id: req.profile!.id,
        actor_name: req.profile!.name,
        actor_role: req.profile!.role,
        action: signOff ? "signed_off" : "changes_requested",
        detail: signOff ? null : parsed.data.change_notes || null,
      });
      res.json(data);
    },
  );

  // Delete a field daily report. Submitter or supervisors+; job must be Active.
  app.delete(
    "/api/field-daily-reports/:id",
    requireAuth,
    async (req: Request, res: Response) => {
      const loaded = await loadFdrForWrite(req, res, { requireActive: true });
      if (!loaded) return;
      const isSupervisor = ["admin", "area", "super"].includes(req.profile!.role);
      if (!isSupervisor && loaded.report.submitted_by !== req.profile!.id)
        return res.status(403).json({ message: "You can only delete your own reports." });
      const { error } = await loaded.client
        .from(FDR_TABLE)
        .delete()
        .eq("id", req.params.id);
      if (error) return res.status(400).json({ message: error.message });
      res.status(204).end();
    },
  );

  // ==== JSAs (Job Safety Analysis) ==========================================
  const flattenJsa = (r: any) => {
    const { job, submitter, signer, steps, ...rest } = r;
    return {
      ...rest,
      job_number: job?.job_number ?? "",
      area: job?.area ?? null,
      job_status: job?.status ?? null,
      customer_id: job?.customer_id ?? null,
      customer_name: job?.customer?.name ?? "",
      submitted_by_name: submitter?.name ?? null,
      signed_by_name: signer?.name ?? null,
      steps: (steps || []).sort((a: any, b: any) => a.step_order - b.step_order),
    };
  };
  const JSA_SELECT =
    "*, job:jobs!jsas_job_id_fkey(job_number,area,status,customer_id,customer:customers(name)), submitter:profiles!jsas_submitted_by_fkey(name), signer:profiles!jsas_signed_by_fkey(name), steps:jsa_steps(*)";

  app.get("/api/jsas", requireAuth, async (req: Request, res: Response) => {
    const scope = areaScopeOf(req.profile!);
    const jobIds = await jobScopeOf(req.profile!);
    const { data, error } = await supabaseAnon
      .from("jsas")
      .select(JSA_SELECT)
      .order("jsa_date", { ascending: false })
      .order("jsa_number", { ascending: false });
    if (error) return res.status(500).json({ message: error.message });
    let rows = (data || []).map(flattenJsa);
    if (scope) rows = rows.filter((r: any) => r.area === scope);
    if (jobIds) rows = rows.filter((r: any) => jobIds.includes(r.job_id));
    const status = String(req.query.status || "").toLowerCase();
    if (status === "pending") rows = rows.filter((r: any) => r.status !== "Signed off");
    else if (status === "signed") rows = rows.filter((r: any) => r.status === "Signed off");
    res.json(rows);
  });

  app.get(
    "/api/jobs/:id/jsas",
    requireAuth,
    async (req: Request, res: Response) => {
      const scope = areaScopeOf(req.profile!);
      const { data: job } = await supabaseAnon
        .from("jobs")
        .select("area")
        .eq("id", req.params.id)
        .single();
      if (!job) return res.status(404).json({ message: "Job not found" });
      if (scope && job.area !== scope)
        return res.status(404).json({ message: "Job not found" });
      const jobIds = await jobScopeOf(req.profile!);
      if (jobIds && !jobIds.includes(String(req.params.id)))
        return res.status(404).json({ message: "Job not found" });
      const { data, error } = await supabaseAnon
        .from("jsas")
        .select(JSA_SELECT)
        .eq("job_id", req.params.id)
        .order("jsa_date", { ascending: false })
        .order("jsa_number", { ascending: false });
      if (error) return res.status(500).json({ message: error.message });
      res.json((data || []).map(flattenJsa));
    },
  );

  // Insert JSA steps for a jsa_id from the parsed steps array.
  const insertJsaSteps = async (client: any, jsaId: string, steps: any[]) => {
    const rows = steps.map((s, i) => ({
      jsa_id: jsaId,
      step_order: i,
      step_description: s.step_description,
      hazards: s.hazards || null,
      controls: s.controls || null,
    }));
    return client.from("jsa_steps").insert(rows);
  };

  // Create a JSA with steps. Any authenticated user; job Active + in-area.
  app.post(
    "/api/jobs/:id/jsas",
    requireAuth,
    async (req: Request, res: Response) => {
      const parsed = createJsaSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      const client = supabaseAdmin || supabaseAnon;
      const { data: job } = await client
        .from("jobs")
        .select("area,status")
        .eq("id", req.params.id)
        .single();
      if (!job) return res.status(404).json({ message: "Job not found" });
      if (req.profile!.role !== "admin" && job.area !== req.profile!.area)
        return res.status(403).json({ message: "Outside your area" });
      if (job.status !== "Active")
        return res
          .status(400)
          .json({ message: "JSAs can only be created for active jobs." });
      const p = parsed.data;
      const { data: jsa, error } = await client
        .from("jsas")
        .insert({
          job_id: req.params.id,
          jsa_date: p.jsa_date,
          well_name: p.well_name || null,
          task_description: p.task_description || null,
          ppe: p.ppe || null,
          crew: p.crew ?? [],
          submitted_by: req.profile!.id,
        })
        .select()
        .single();
      if (error) return res.status(400).json({ message: error.message });
      const { error: stepErr } = await insertJsaSteps(client, jsa.id, p.steps);
      if (stepErr) {
        await client.from("jsas").delete().eq("id", jsa.id);
        return res.status(400).json({ message: stepErr.message });
      }
      // Re-fetch with steps + join so the client gets the complete record.
      const { data: full } = await client
        .from("jsas")
        .select(JSA_SELECT)
        .eq("id", jsa.id)
        .single();
      res.status(201).json(full ? flattenJsa(full) : jsa);
    },
  );

  const loadJsaForWrite = async (
    req: Request,
    res: Response,
    opts: { requireActive: boolean },
  ) => {
    const client = supabaseAdmin || supabaseAnon;
    const { data: jsa } = await client
      .from("jsas")
      .select("*")
      .eq("id", req.params.id)
      .single();
    if (!jsa) {
      res.status(404).json({ message: "JSA not found" });
      return null;
    }
    const { data: job } = await client
      .from("jobs")
      .select("area,status")
      .eq("id", jsa.job_id)
      .single();
    if (!job) {
      res.status(404).json({ message: "Job not found" });
      return null;
    }
    if (req.profile!.role !== "admin" && job.area !== req.profile!.area) {
      res.status(403).json({ message: "Outside your area" });
      return null;
    }
    if (opts.requireActive && job.status !== "Active") {
      res.status(400).json({
        message: "JSAs can only be changed while the job is active.",
      });
      return null;
    }
    return { jsa, job, client };
  };

  // Edit a JSA (and replace its steps). Submitter or supervisors+; not once
  // signed off; job Active.
  app.patch(
    "/api/jsas/:id",
    requireAuth,
    async (req: Request, res: Response) => {
      const parsed = updateJsaSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      const loaded = await loadJsaForWrite(req, res, { requireActive: true });
      if (!loaded) return;
      const isSupervisor = ["admin", "area", "super"].includes(req.profile!.role);
      if (!isSupervisor && loaded.jsa.submitted_by !== req.profile!.id)
        return res.status(403).json({ message: "You can only edit your own JSAs." });
      if (loaded.jsa.status === "Signed off")
        return res.status(400).json({ message: "This JSA is signed off and locked." });
      const p = parsed.data;
      const patch: any = {};
      if (p.jsa_date !== undefined) patch.jsa_date = p.jsa_date;
      if (p.well_name !== undefined) patch.well_name = p.well_name || null;
      if (p.task_description !== undefined) patch.task_description = p.task_description || null;
      if (p.ppe !== undefined) patch.ppe = p.ppe || null;
      if (p.crew !== undefined) patch.crew = p.crew ?? [];
      if (loaded.jsa.status === "Changes requested") {
        patch.status = "Pending sign-off";
        patch.change_notes = null;
      }
      const { error } = await loaded.client
        .from("jsas")
        .update(patch)
        .eq("id", req.params.id);
      if (error) return res.status(400).json({ message: error.message });
      // Replace steps when provided.
      if (p.steps !== undefined) {
        await loaded.client.from("jsa_steps").delete().eq("jsa_id", req.params.id);
        const { error: stepErr } = await insertJsaSteps(loaded.client, String(req.params.id), p.steps);
        if (stepErr) return res.status(400).json({ message: stepErr.message });
      }
      const { data: full } = await loaded.client
        .from("jsas")
        .select(JSA_SELECT)
        .eq("id", req.params.id)
        .single();
      res.json(full ? flattenJsa(full) : { id: req.params.id });
    },
  );

  // Sign off / request changes on a JSA. Supervisors+ only.
  app.post(
    "/api/jsas/:id/signoff",
    requireAuth,
    requireRole("admin", "area", "super"),
    async (req: Request, res: Response) => {
      const parsed = signoffSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      const loaded = await loadJsaForWrite(req, res, { requireActive: false });
      if (!loaded) return;
      const patch =
        parsed.data.action === "sign_off"
          ? {
              status: "Signed off",
              signed_by: req.profile!.id,
              signed_at: new Date().toISOString(),
              change_notes: null,
            }
          : {
              status: "Changes requested",
              signed_by: null,
              signed_at: null,
              change_notes: parsed.data.change_notes || null,
            };
      const { data, error } = await loaded.client
        .from("jsas")
        .update(patch)
        .eq("id", req.params.id)
        .select()
        .single();
      if (error) return res.status(400).json({ message: error.message });
      res.json(data);
    },
  );

  // Delete a JSA. Submitter or supervisors+; job Active. Steps cascade.
  app.delete(
    "/api/jsas/:id",
    requireAuth,
    async (req: Request, res: Response) => {
      const loaded = await loadJsaForWrite(req, res, { requireActive: true });
      if (!loaded) return;
      const isSupervisor = ["admin", "area", "super"].includes(req.profile!.role);
      if (!isSupervisor && loaded.jsa.submitted_by !== req.profile!.id)
        return res.status(403).json({ message: "You can only delete your own JSAs." });
      const { error } = await loaded.client.from("jsas").delete().eq("id", req.params.id);
      if (error) return res.status(400).json({ message: error.message });
      res.status(204).end();
    },
  );

  // ---- Maintenance schedules (reusable templates) -------------------------
  app.get(
    "/api/maintenance-schedules",
    requireAuth,
    async (_req: Request, res: Response) => {
      const { data, error } = await supabaseAnon
        .from("maintenance_schedules")
        .select("*")
        .order("name");
      if (error) return res.status(500).json({ message: error.message });
      res.json(data);
    },
  );

  app.post(
    "/api/maintenance-schedules",
    requireAuth,
    requireRole("admin", "area"),
    async (req: Request, res: Response) => {
      const parsed = createMaintenanceScheduleSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      const client = supabaseAdmin || supabaseAnon;
      const { data, error } = await client
        .from("maintenance_schedules")
        .insert(parsed.data)
        .select()
        .single();
      if (error) return res.status(400).json({ message: error.message });
      res.status(201).json(data);
    },
  );

  app.patch(
    "/api/maintenance-schedules/:id",
    requireAuth,
    requireRole("admin", "area"),
    async (req: Request, res: Response) => {
      const parsed = updateMaintenanceScheduleSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      const client = supabaseAdmin || supabaseAnon;
      const { data, error } = await client
        .from("maintenance_schedules")
        .update(parsed.data)
        .eq("id", req.params.id)
        .select()
        .single();
      if (error) return res.status(400).json({ message: error.message });
      if (!data) return res.status(404).json({ message: "Schedule not found" });
      res.json(data);
    },
  );

  app.delete(
    "/api/maintenance-schedules/:id",
    requireAuth,
    requireRole("admin", "area"),
    async (req: Request, res: Response) => {
      const client = supabaseAdmin || supabaseAnon;
      // Assets referencing this schedule have their FK set to null (ON DELETE SET NULL).
      const { error } = await client
        .from("maintenance_schedules")
        .delete()
        .eq("id", req.params.id);
      if (error) return res.status(400).json({ message: error.message });
      res.status(204).end();
    },
  );

  // Maintenance reports export (JSON) over a [start,end] window on report_date.
  // Joins the asset (tag/category/area) and filing supervisor; area-scoped via
  // the joined asset area. Returns rows + summary for a branded client PDF.
  app.get(
    "/api/maintenance-reports/export.json",
    requireAuth,
    async (req: Request, res: Response) => {
      const scope = areaScopeOf(req.profile!);
      const client = supabaseAdmin || supabaseAnon;
      const start = String(req.query.start || "");
      const end = String(req.query.end || "");
      const startD = new Date(start + "T00:00:00Z");
      const endD = new Date(end + "T00:00:00Z");
      if (isNaN(startD.getTime()) || isNaN(endD.getTime()) || endD < startD)
        return res.status(400).json({ message: "Provide a valid start and end date (start <= end)" });
      const MS_DAY = 86400000;
      const windowDays = Math.round((endD.getTime() - startD.getTime()) / MS_DAY) + 1;

      const { data, error } = await client
        .from("maintenance_reports")
        .select(
          "id, work_type, status, report_date, filed_at, notes, asset:assets!maintenance_reports_asset_id_fkey(tag,category,area), supervisor:profiles!maintenance_reports_supervisor_id_fkey(name)",
        )
        .gte("report_date", start)
        .lte("report_date", end)
        .order("report_date", { ascending: false })
        .order("filed_at", { ascending: false });
      if (error) return res.status(500).json({ message: error.message });
      let raw = (data || []) as any[];
      // Area scope on the joined asset area (null scope = admin, sees all).
      if (scope) raw = raw.filter((r) => r.asset?.area === scope);

      const byWorkType: Record<string, number> = {};
      const byStatus: Record<string, number> = {};
      const assetsTouched = new Set<string>();
      for (const r of raw) {
        byWorkType[r.work_type] = (byWorkType[r.work_type] || 0) + 1;
        byStatus[r.status] = (byStatus[r.status] || 0) + 1;
        if (r.asset?.tag) assetsTouched.add(r.asset.tag);
      }
      res.json({
        start,
        end,
        window_days: windowDays,
        area_scope: scope || "All areas",
        summary: {
          report_count: raw.length,
          asset_count: assetsTouched.size,
          by_work_type: byWorkType,
          by_status: byStatus,
        },
        rows: raw.map((r) => ({
          report_date: r.report_date,
          filed_at: r.filed_at,
          asset_tag: r.asset?.tag ?? null,
          asset_category: r.asset?.category ?? null,
          area: r.asset?.area ?? null,
          work_type: r.work_type,
          status: r.status,
          supervisor_name: r.supervisor?.name ?? null,
          notes: r.notes,
        })),
      });
    },
  );

  // ---- Assets -------------------------------------------------------------
  app.get("/api/assets", requireAuth, async (req: Request, res: Response) => {
    const scope = areaScopeOf(req.profile!);
    const jobIds = await jobScopeOf(req.profile!);
    let q = supabaseAnon
      .from("assets")
      .select(
        "*, maintenance_schedule:maintenance_schedules(*), job:jobs(id,job_number,well_name,area,status)",
      )
      .order("tag");
    if (scope) q = q.eq("area", scope);
    // Assigned field techs only see assets deployed on their assigned jobs.
    if (jobIds) q = q.in("job_id", jobIds);
    const { data, error } = await q;
    if (error) return res.status(500).json({ message: error.message });
    res.json(data);
  });

  // Utilization export (CSV) over a selectable [start,end] date window.
  // NOTE: this literal route MUST be registered before "/api/assets/:id" so the
  // ":id" param route doesn't capture "utilization.csv".
  // Honesty: there is no per-asset deployment log, so "days deployed" is the
  // overlap of the asset's CURRENT job's [started_on, ended_on] with the window.
  // Assets not on a job, or jobs with no start date, report days_deployed = null.
  app.get(
    "/api/assets/utilization.csv",
    requireAuth,
    async (req: Request, res: Response) => {
      const scope = areaScopeOf(req.profile!);
      const client = supabaseAdmin || supabaseAnon;
      const start = String(req.query.start || "");
      const end = String(req.query.end || "");
      const startD = new Date(start + "T00:00:00Z");
      const endD = new Date(end + "T00:00:00Z");
      if (isNaN(startD.getTime()) || isNaN(endD.getTime()) || endD < startD)
        return res.status(400).json({ message: "Provide a valid start and end date (start <= end)" });
      const MS_DAY = 86400000;
      const windowDays = Math.round((endD.getTime() - startD.getTime()) / MS_DAY) + 1;

      let aq = client
        .from("assets")
        .select(
          "*, job:jobs(id,job_number,well_name,area,status,started_on,ended_on)",
        )
        .order("tag");
      if (scope) aq = aq.eq("area", scope);
      const { data: assetsData, error: aErr } = await aq;
      if (aErr) return res.status(500).json({ message: aErr.message });
      const assets = (assetsData || []) as any[];

      // Count maintenance reports filed within the window, per asset.
      const assetIds = assets.map((a) => a.id);
      const mCount = new Map<string, number>();
      if (assetIds.length) {
        const { data: reps } = await client
          .from("maintenance_reports")
          .select("asset_id, report_date")
          .in("asset_id", assetIds)
          .gte("report_date", start)
          .lte("report_date", end);
        for (const r of reps || [])
          mCount.set(r.asset_id, (mCount.get(r.asset_id) || 0) + 1);
      }

      const clampOverlapDays = (s: string | null, e: string | null): number | null => {
        if (!s) return null; // no start date -> cannot compute honestly
        const js = new Date(s + "T00:00:00Z");
        const je = e ? new Date(e + "T00:00:00Z") : endD; // open-ended -> up to window end
        const lo = Math.max(js.getTime(), startD.getTime());
        const hi = Math.min(je.getTime(), endD.getTime());
        if (hi < lo) return 0;
        return Math.round((hi - lo) / MS_DAY) + 1;
      };

      const esc = (v: any) => {
        if (v === null || v === undefined) return "";
        const s = String(v);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      };
      const header = [
        "Asset #", "Type", "Area", "Status", "Location", "Day rate ($/day)",
        "Run hours", "Days deployed", "Window days", "Utilization %",
        "Est. revenue ($)", "Maintenance events",
      ];
      const lines = [header.join(",")];
      for (const a of assets) {
        const job = a.job;
        const location = job
          ? `${job.well_name || job.job_number} \u00b7 ${job.area}`
          : a.job_or_well || "Yard / unassigned";
        const daysDeployed = job ? clampOverlapDays(job.started_on, job.ended_on) : null;
        const utilPct =
          daysDeployed === null ? null : Math.round((daysDeployed / windowDays) * 1000) / 10;
        const estRevenue =
          daysDeployed === null || a.day_rate === null || a.day_rate === undefined
            ? null
            : Math.round(Number(a.day_rate) * daysDeployed * 100) / 100;
        lines.push([
          esc(a.tag), esc(a.category), esc(a.area), esc(a.status), esc(location),
          esc(a.day_rate), esc(a.run_hours), esc(daysDeployed), esc(windowDays),
          esc(utilPct), esc(estRevenue), esc(mCount.get(a.id) || 0),
        ].join(","));
      }
      const csv = lines.join("\n");
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="asset-utilization_${start}_to_${end}.csv"`,
      );
      res.send(csv);
    },
  );

  // Utilization export (JSON) — same computation as the CSV route above, but
  // returns structured rows + summary so the client can render a branded PDF.
  // MUST also be registered before "/api/assets/:id".
  app.get(
    "/api/assets/utilization.json",
    requireAuth,
    async (req: Request, res: Response) => {
      const scope = areaScopeOf(req.profile!);
      const client = supabaseAdmin || supabaseAnon;
      const start = String(req.query.start || "");
      const end = String(req.query.end || "");
      const startD = new Date(start + "T00:00:00Z");
      const endD = new Date(end + "T00:00:00Z");
      if (isNaN(startD.getTime()) || isNaN(endD.getTime()) || endD < startD)
        return res.status(400).json({ message: "Provide a valid start and end date (start <= end)" });
      const MS_DAY = 86400000;
      const windowDays = Math.round((endD.getTime() - startD.getTime()) / MS_DAY) + 1;

      let aq = client
        .from("assets")
        .select(
          "*, job:jobs(id,job_number,well_name,area,status,started_on,ended_on)",
        )
        .order("tag");
      if (scope) aq = aq.eq("area", scope);
      const { data: assetsData, error: aErr } = await aq;
      if (aErr) return res.status(500).json({ message: aErr.message });
      const assets = (assetsData || []) as any[];

      const assetIds = assets.map((a) => a.id);
      const mCount = new Map<string, number>();
      if (assetIds.length) {
        const { data: reps } = await client
          .from("maintenance_reports")
          .select("asset_id, report_date")
          .in("asset_id", assetIds)
          .gte("report_date", start)
          .lte("report_date", end);
        for (const r of reps || [])
          mCount.set(r.asset_id, (mCount.get(r.asset_id) || 0) + 1);
      }

      const clampOverlapDays = (s: string | null, e: string | null): number | null => {
        if (!s) return null;
        const js = new Date(s + "T00:00:00Z");
        const je = e ? new Date(e + "T00:00:00Z") : endD;
        const lo = Math.max(js.getTime(), startD.getTime());
        const hi = Math.min(je.getTime(), endD.getTime());
        if (hi < lo) return 0;
        return Math.round((hi - lo) / MS_DAY) + 1;
      };

      let totalEstRevenue = 0;
      let deployedCount = 0;
      let utilSum = 0;
      let utilN = 0;
      const rows = assets.map((a) => {
        const job = a.job;
        const location = job
          ? `${job.well_name || job.job_number} \u00b7 ${job.area}`
          : a.job_or_well || "Yard / unassigned";
        const daysDeployed = job ? clampOverlapDays(job.started_on, job.ended_on) : null;
        const utilPct =
          daysDeployed === null ? null : Math.round((daysDeployed / windowDays) * 1000) / 10;
        const estRevenue =
          daysDeployed === null || a.day_rate === null || a.day_rate === undefined
            ? null
            : Math.round(Number(a.day_rate) * daysDeployed * 100) / 100;
        if (estRevenue !== null) totalEstRevenue += estRevenue;
        if (daysDeployed !== null && daysDeployed > 0) deployedCount += 1;
        if (utilPct !== null) { utilSum += utilPct; utilN += 1; }
        return {
          tag: a.tag,
          category: a.category,
          area: a.area,
          status: a.status,
          location,
          day_rate: a.day_rate ?? null,
          run_hours: a.run_hours ?? null,
          days_deployed: daysDeployed,
          utilization_pct: utilPct,
          est_revenue: estRevenue,
          maintenance_events: mCount.get(a.id) || 0,
        };
      });

      res.json({
        start,
        end,
        window_days: windowDays,
        area_scope: scope || "All areas",
        summary: {
          asset_count: rows.length,
          deployed_count: deployedCount,
          avg_utilization_pct: utilN ? Math.round((utilSum / utilN) * 10) / 10 : null,
          total_est_revenue: Math.round(totalEstRevenue * 100) / 100,
        },
        rows,
      });
    },
  );

  // Single asset with schedule + current job + maintenance/inspection history.
  // Powers the asset detail pop-up. Area-scoped for non-admins.
  app.get(
    "/api/assets/:id",
    requireAuth,
    async (req: Request, res: Response) => {
      const scope = areaScopeOf(req.profile!);
      const client = supabaseAdmin || supabaseAnon;
      const { data: asset, error } = await client
        .from("assets")
        .select(
          "*, maintenance_schedule:maintenance_schedules(*), job:jobs(id,job_number,well_name,area,status)",
        )
        .eq("id", req.params.id)
        .single();
      if (error || !asset)
        return res.status(404).json({ message: "Asset not found" });
      if (scope && (asset as any).area !== scope)
        return res.status(403).json({ message: "Outside your area" });

      // Maintenance/inspection history: all reports for this asset, newest first,
      // with the filing supervisor's name joined in.
      const { data: reps } = await client
        .from("maintenance_reports")
        .select(
          "id, work_type, status, report_date, filed_at, notes, supervisor:profiles!maintenance_reports_supervisor_id_fkey(name)",
        )
        .eq("asset_id", req.params.id)
        .order("report_date", { ascending: false })
        .order("filed_at", { ascending: false });
      const history = (reps || []).map((r: any) => ({
        id: r.id,
        work_type: r.work_type,
        status: r.status,
        report_date: r.report_date,
        filed_at: r.filed_at,
        notes: r.notes,
        supervisor_name: r.supervisor?.name ?? null,
      }));
      res.json({ ...asset, history });
    },
  );

  app.post(
    "/api/assets",
    requireAuth,
    requireRole("admin", "area"),
    async (req: Request, res: Response) => {
      const parsed = createAssetSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      // area managers can only add to their own area
      if (req.profile!.role === "area" && parsed.data.area !== req.profile!.area) {
        return res.status(403).json({ message: "You can only add assets in your area" });
      }
      const runHours = tracksRunHours(parsed.data.category)
        ? parsed.data.run_hours ?? 0
        : null;
      const client = supabaseAdmin || supabaseAnon;
      const insert: any = { ...parsed.data, run_hours: runHours };
      // Interval only applies to run-hour assets; otherwise let the DB default stand.
      if (!tracksRunHours(parsed.data.category)) delete insert.service_hours_interval;
      const { data, error } = await client
        .from("assets")
        .insert(insert)
        .select()
        .single();
      if (error) return res.status(400).json({ message: error.message });
      res.status(201).json(data);
    },
  );

  // Assign / unassign an asset to a job (or change its deployment status)
  app.patch(
    "/api/assets/:id",
    requireAuth,
    requireRole("admin", "area"),
    async (req: Request, res: Response) => {
      const parsed = updateAssetSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      const client = supabaseAdmin || supabaseAnon;
      // load the asset for area-scope check
      const { data: asset } = await client
        .from("assets")
        .select("area")
        .eq("id", req.params.id)
        .single();
      if (!asset) return res.status(404).json({ message: "Asset not found" });
      if (req.profile!.role === "area" && asset.area !== req.profile!.area)
        return res.status(403).json({ message: "Outside your area" });
      // if assigning to a job, verify the job exists and is in the same area
      if (parsed.data.job_id) {
        const { data: job } = await client
          .from("jobs")
          .select("area")
          .eq("id", parsed.data.job_id)
          .single();
        if (!job) return res.status(404).json({ message: "Job not found" });
        if (job.area !== asset.area)
          return res
            .status(400)
            .json({ message: "Asset and job must be in the same operating area" });
      }
      const { data, error } = await client
        .from("assets")
        .update(parsed.data)
        .eq("id", req.params.id)
        .select()
        .single();
      if (error) return res.status(400).json({ message: error.message });
      res.json(data);
    },
  );

  // ---- Service dashboard --------------------------------------------------
  // Aggregates centrifuge fleet health for the Service module: active count,
  // machines needing service soon, overdue machines, and reports filed — plus
  // the active-centrifuge list (job/area, technician, run-hrs since service,
  // interval, status). Area-scoped for non-admins.
  app.get(
    "/api/service/dashboard",
    requireAuth,
    async (req: Request, res: Response) => {
      const scope = areaScopeOf(req.profile!);
      const client = supabaseAdmin || supabaseAnon;

      // Centrifuges (run-hour categories) in scope, with parent job number.
      let aq = client
        .from("assets")
        .select("*, job:jobs(id,job_number,area)")
        .in("category", RUN_HOUR_CATEGORIES as unknown as string[])
        .order("tag");
      if (scope) aq = aq.eq("area", scope);
      const { data: assetsData, error: aErr } = await aq;
      if (aErr) return res.status(500).json({ message: aErr.message });
      const assets = (assetsData || []) as any[];

      // Last service technician per asset = supervisor on that asset's most
      // recent maintenance report. One query, reduced client-side.
      const assetIds = assets.map((a) => a.id);
      const techByAsset = new Map<string, string>();
      if (assetIds.length) {
        const { data: reps } = await client
          .from("maintenance_reports")
          .select("asset_id, filed_at, supervisor:profiles!maintenance_reports_supervisor_id_fkey(name)")
          .in("asset_id", assetIds)
          .order("filed_at", { ascending: false });
        for (const r of (reps || []) as any[]) {
          if (!techByAsset.has(r.asset_id) && r.supervisor?.name)
            techByAsset.set(r.asset_id, r.supervisor.name);
        }
      }

      // Reports filed (scope-aware). Count total + pending sign-off.
      const { data: repRows } = await client
        .from("maintenance_reports")
        .select("status, asset:assets(area)");
      let reports = (repRows || []) as any[];
      if (scope) reports = reports.filter((r) => r.asset?.area === scope);
      const reportsFiled = reports.length;
      const reportsPending = reports.filter(
        (r) => r.status !== "Signed off",
      ).length;

      // Build per-asset service status.
      const rows: (ServiceAssetRow & { _deployed: boolean })[] = assets.map(
        (a) => {
          const { hoursSince, interval, state } = serviceStatusFor(a);
          const deployed = (a.status || "").toLowerCase() !== "available";
          return {
            id: a.id,
            tag: a.tag,
            category: a.category,
            area: a.area,
            status: a.status,
            job_id: a.job_id,
            job_number: a.job?.job_number ?? null,
            job_or_well: a.job_or_well,
            technician: techByAsset.get(a.id) ?? null,
            run_hours: a.run_hours,
            run_hours_since_service: hoursSince,
            service_hours_interval: interval,
            last_maintained: a.last_maintained,
            service_state: state,
            _deployed: deployed,
          };
        },
      );

      const metrics: ServiceDashboard["metrics"] = {
        active_centrifuges: rows.filter((r) => r._deployed).length,
        total_centrifuges: rows.length,
        due_soon: rows.filter((r) => r.service_state === "Soon").length,
        overdue: rows.filter((r) => r.service_state === "Overdue").length,
        reports_filed: reportsFiled,
        reports_pending_signoff: reportsPending,
      };

      // List shows active (deployed) centrifuges; overdue/soon first, then by tag.
      const rank: Record<string, number> = {
        Overdue: 0,
        Soon: 1,
        "No baseline": 2,
        OK: 3,
      };
      const centrifuges: ServiceAssetRow[] = rows
        .filter((r) => r._deployed)
        .sort(
          (x, y) =>
            (rank[x.service_state] ?? 9) - (rank[y.service_state] ?? 9) ||
            x.tag.localeCompare(y.tag),
        )
        .map(({ _deployed, ...r }) => r);

      const payload: ServiceDashboard = { metrics, centrifuges };
      res.json(payload);
    },
  );

  // ---- Maintenance reports ------------------------------------------------
  app.get("/api/reports", requireAuth, async (req: Request, res: Response) => {
    const scope = areaScopeOf(req.profile!);
    const jobIds = await jobScopeOf(req.profile!);
    // join asset + supervisor for display
    let q = supabaseAnon
      .from("maintenance_reports")
      .select(
        "*, asset:assets(*), supervisor:profiles!maintenance_reports_supervisor_id_fkey(id,name,area)",
      )
      .order("filed_at", { ascending: false });
    const { data, error } = await q;
    if (error) return res.status(500).json({ message: error.message });
    let rows = data || [];
    // area scoping applied on joined asset area
    if (scope) rows = rows.filter((r: any) => r.asset?.area === scope);
    // assigned field techs only see reports for assets on their assigned jobs
    if (jobIds) rows = rows.filter((r: any) => jobIds.includes(r.asset?.job_id));
    // field techs see only their own filed reports
    if (req.profile!.role === "field")
      rows = rows.filter((r: any) => r.supervisor_id === req.profile!.id);
    res.json(rows);
  });

  app.post(
    "/api/reports",
    requireAuth,
    requireRole("admin", "area", "super"),
    async (req: Request, res: Response) => {
      const parsed = createReportSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      const client = supabaseAdmin || supabaseAnon;

      // fetch asset to validate area scope & run-hours
      const { data: asset } = await client
        .from("assets")
        .select("*")
        .eq("id", parsed.data.asset_id)
        .single();
      if (!asset) return res.status(404).json({ message: "Asset not found" });
      if (req.profile!.role !== "admin" && asset.area !== req.profile!.area)
        return res.status(403).json({ message: "Asset is outside your area" });

      const { data: report, error } = await client
        .from("maintenance_reports")
        .insert({
          asset_id: parsed.data.asset_id,
          supervisor_id: req.profile!.id,
          work_type: parsed.data.work_type,
          notes: parsed.data.notes ?? null,
          report_date: parsed.data.report_date,
          status: "Pending Sign-off",
        })
        .select()
        .single();
      if (error) return res.status(400).json({ message: error.message });

      // update asset run-hours + last_maintained, and snapshot the meter reading
      // at this service so "run hrs since last service" can be computed exactly.
      const patch: any = { last_maintained: parsed.data.report_date };
      if (tracksRunHours(asset.category)) {
        const meterAtService =
          parsed.data.run_hours != null ? parsed.data.run_hours : asset.run_hours;
        if (parsed.data.run_hours != null) patch.run_hours = parsed.data.run_hours;
        if (meterAtService != null) patch.run_hours_at_service = meterAtService;
      }
      await client.from("assets").update(patch).eq("id", asset.id);

      // audit: Filed
      await client.from("audit_events").insert({
        report_id: report.id,
        asset_id: asset.id,
        actor_id: req.profile!.id,
        actor_name: req.profile!.name,
        actor_role: req.profile!.role,
        action: "Filed",
      });

      // notify area managers in this area who want "needs my sign-off"
      sendNotificationEmails("needs_signoff", { report, asset }).catch((e) =>
        console.error("[email] needs_signoff", e),
      );

      res.status(201).json(report);
    },
  );

  // ---- Service report uploads --------------------------------------------
  // Area managers and supervisors upload a service report document (PDF) tied
  // to a specific job where they are servicing equipment. File bytes are stored
  // base64 on the row (same pattern as certification attachments). Admins view
  // all areas; area managers and supervisors view only their own area's jobs.
  // The file_base64 column is intentionally omitted from list selects so the
  // dashboard payload stays small; it is only read by the download route.
  const SERVICE_REPORT_SELECT =
    "id, job_id, file_name, file_mime, file_size, notes, uploaded_by, created_at, job:jobs!service_reports_job_id_fkey(job_number,well_name,area,customer:customers(name)), uploader:profiles!service_reports_uploaded_by_fkey(name)";

  function flattenServiceReport(row: any) {
    const { job, uploader, ...rest } = row;
    return {
      ...rest,
      job_number: job?.job_number ?? null,
      well_name: job?.well_name ?? null,
      area: job?.area ?? null,
      customer_name: job?.customer?.name ?? null,
      uploaded_by_name: uploader?.name ?? null,
    };
  }

  // List uploaded service reports. Admin sees all areas; area managers and
  // supervisors see only reports on jobs in their area.
  app.get(
    "/api/service-reports",
    requireAuth,
    async (req: Request, res: Response) => {
      const scope = areaScopeOf(req.profile!);
      const { data, error } = await supabaseAnon
        .from("service_reports")
        .select(SERVICE_REPORT_SELECT)
        .order("created_at", { ascending: false });
      if (error) return res.status(500).json({ message: error.message });
      let rows = (data || []).map(flattenServiceReport);
      // Area scope on the joined job area (null scope = admin, sees everything).
      if (scope) rows = rows.filter((r: any) => r.area === scope);
      res.json(rows);
    },
  );

  // Service reports export (JSON) over a [start,end] window on created_at.
  // Returns flattened rows + a small summary so the client can render a
  // branded PDF. Area-scoped like the list route above.
  app.get(
    "/api/service-reports/export.json",
    requireAuth,
    async (req: Request, res: Response) => {
      const scope = areaScopeOf(req.profile!);
      const start = String(req.query.start || "");
      const end = String(req.query.end || "");
      const startD = new Date(start + "T00:00:00Z");
      const endD = new Date(end + "T23:59:59Z");
      if (isNaN(startD.getTime()) || isNaN(endD.getTime()) || endD < startD)
        return res.status(400).json({ message: "Provide a valid start and end date (start <= end)" });
      const MS_DAY = 86400000;
      const windowDays = Math.round((endD.getTime() - startD.getTime()) / MS_DAY) + 1;

      const { data, error } = await supabaseAnon
        .from("service_reports")
        .select(SERVICE_REPORT_SELECT)
        .gte("created_at", startD.toISOString())
        .lte("created_at", endD.toISOString())
        .order("created_at", { ascending: false });
      if (error) return res.status(500).json({ message: error.message });
      let rows = (data || []).map(flattenServiceReport);
      if (scope) rows = rows.filter((r: any) => r.area === scope);

      const byArea: Record<string, number> = {};
      const byCustomer: Record<string, number> = {};
      for (const r of rows as any[]) {
        const a = r.area || "—";
        byArea[a] = (byArea[a] || 0) + 1;
        const c = r.customer_name || "—";
        byCustomer[c] = (byCustomer[c] || 0) + 1;
      }
      res.json({
        start,
        end,
        window_days: windowDays,
        area_scope: scope || "All areas",
        summary: {
          report_count: rows.length,
          area_count: Object.keys(byArea).filter((k) => k !== "—").length,
          customer_count: Object.keys(byCustomer).filter((k) => k !== "—").length,
          by_area: byArea,
        },
        rows: (rows as any[]).map((r) => ({
          created_at: r.created_at,
          job_number: r.job_number,
          well_name: r.well_name,
          area: r.area,
          customer_name: r.customer_name,
          file_name: r.file_name,
          file_size: r.file_size,
          uploaded_by_name: r.uploaded_by_name,
          notes: r.notes,
        })),
      });
    },
  );

  // Upload a service report. Area managers + supervisors (admins too). The job
  // must be within the uploader's area scope.
  app.post(
    "/api/service-reports",
    requireAuth,
    requireRole("admin", "area", "super"),
    async (req: Request, res: Response) => {
      const parsed = uploadServiceReportSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      const client = supabaseAdmin || supabaseAnon;

      // Validate the job exists and is within the uploader's area scope.
      const { data: job } = await client
        .from("jobs")
        .select("id, area")
        .eq("id", parsed.data.job_id)
        .single();
      if (!job) return res.status(404).json({ message: "Job not found" });
      const scope = areaScopeOf(req.profile!);
      if (scope && job.area !== scope)
        return res.status(403).json({ message: "Job is outside your area" });

      const bytes = Buffer.from(parsed.data.file_base64, "base64");
      if (bytes.length === 0)
        return res.status(400).json({ message: "Uploaded file is empty" });

      const { data: created, error } = await client
        .from("service_reports")
        .insert({
          job_id: parsed.data.job_id,
          file_name: parsed.data.file_name,
          file_mime: parsed.data.file_mime ?? "application/pdf",
          file_size: bytes.length,
          file_base64: parsed.data.file_base64,
          notes: parsed.data.notes ?? null,
          uploaded_by: req.profile!.id,
        })
        .select(SERVICE_REPORT_SELECT)
        .single();
      if (error) return res.status(400).json({ message: error.message });
      res.status(201).json(flattenServiceReport(created));
    },
  );

  // Download / view an uploaded service report file. Area-scoped like the list.
  app.get(
    "/api/service-reports/:id/file",
    requireAuth,
    async (req: Request, res: Response) => {
      const { data, error } = await supabaseAnon
        .from("service_reports")
        .select(
          "file_name, file_mime, file_base64, job:jobs!service_reports_job_id_fkey(area)",
        )
        .eq("id", req.params.id)
        .single();
      if (error || !data || !(data as any).file_base64)
        return res.status(404).json({ message: "File not found" });
      const scope = areaScopeOf(req.profile!);
      const jobArea = (data as any).job?.area ?? null;
      if (scope && jobArea !== scope)
        return res.status(404).json({ message: "File not found" });
      const buf = Buffer.from((data as any).file_base64, "base64");
      res.setHeader(
        "Content-Type",
        (data as any).file_mime || "application/octet-stream",
      );
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${((data as any).file_name || "service-report").replace(/"/g, "")}"`,
      );
      res.send(buf);
    },
  );

  // Delete an uploaded service report. Admin + area (own area only).
  app.delete(
    "/api/service-reports/:id",
    requireAuth,
    requireRole("admin", "area", "super"),
    async (req: Request, res: Response) => {
      const client = supabaseAdmin || supabaseAnon;
      const { data: existing } = await supabaseAnon
        .from("service_reports")
        .select("id, job:jobs!service_reports_job_id_fkey(area)")
        .eq("id", req.params.id)
        .single();
      if (!existing)
        return res.status(404).json({ message: "Service report not found" });
      const scope = areaScopeOf(req.profile!);
      const jobArea = (existing as any).job?.area ?? null;
      if (scope && jobArea !== scope)
        return res.status(404).json({ message: "Service report not found" });
      const { error } = await client
        .from("service_reports")
        .delete()
        .eq("id", req.params.id);
      if (error) return res.status(400).json({ message: error.message });
      res.status(204).end();
    },
  );

  // ---- Maintenance asset matrix ------------------------------------------
  // Assets that are NOT in the field (no job assignment). Area managers and
  // supervisors log maintenance info or upload maintenance report files for a
  // selected asset here. Admins see all areas; area managers + supervisors see
  // only their own area. Each row carries counts of logged maintenance entries
  // and uploaded report files, plus the most recent activity date.
  app.get(
    "/api/maintenance-matrix",
    requireAuth,
    async (req: Request, res: Response) => {
      const scope = areaScopeOf(req.profile!);
      // "Not in the field" = no assigned job. Area-scope on the asset's area.
      let q = supabaseAnon
        .from("assets")
        .select(
          "id, tag, category, area, status, description, run_hours, run_hours_at_service, service_hours_interval, last_maintained",
        )
        .is("job_id", null)
        .order("tag", { ascending: true });
      if (scope) q = q.eq("area", scope);
      const { data: assets, error } = await q;
      if (error) return res.status(500).json({ message: error.message });
      const rows = assets || [];
      const ids = rows.map((a: any) => a.id);

      // Counts of logged maintenance entries + uploaded files, per asset.
      const entryCount: Record<string, number> = {};
      const entryLast: Record<string, string> = {};
      const fileCount: Record<string, number> = {};
      const fileLast: Record<string, string> = {};
      if (ids.length) {
        const { data: entries } = await supabaseAnon
          .from("maintenance_reports")
          .select("asset_id, filed_at")
          .in("asset_id", ids);
        for (const e of entries || []) {
          entryCount[e.asset_id] = (entryCount[e.asset_id] || 0) + 1;
          if (!entryLast[e.asset_id] || e.filed_at > entryLast[e.asset_id])
            entryLast[e.asset_id] = e.filed_at;
        }
        const { data: files } = await supabaseAnon
          .from("maintenance_report_files")
          .select("asset_id, created_at")
          .in("asset_id", ids);
        for (const f of files || []) {
          fileCount[f.asset_id] = (fileCount[f.asset_id] || 0) + 1;
          if (!fileLast[f.asset_id] || f.created_at > fileLast[f.asset_id])
            fileLast[f.asset_id] = f.created_at;
        }
      }

      const matrix = rows.map((a: any) => {
        const eLast = entryLast[a.id] ?? null;
        const fLast = fileLast[a.id] ?? null;
        const last =
          eLast && fLast ? (eLast > fLast ? eLast : fLast) : eLast || fLast;
        return {
          id: a.id,
          tag: a.tag,
          category: a.category,
          area: a.area,
          status: a.status,
          description: a.description ?? null,
          run_hours: a.run_hours,
          run_hours_at_service: a.run_hours_at_service,
          service_hours_interval: a.service_hours_interval,
          last_maintained: a.last_maintained ?? null,
          entry_count: entryCount[a.id] || 0,
          file_count: fileCount[a.id] || 0,
          last_activity: last,
        };
      });
      res.json(matrix);
    },
  );

  // ---- Maintenance report file uploads (per asset) -----------------------
  // Documents (PDF) attached to a specific asset. Bytes stored base64 on the
  // row (same pattern as certification + service-report uploads). The
  // file_base64 column is omitted from list selects so payloads stay small.
  const MAINTENANCE_FILE_SELECT =
    "id, asset_id, file_name, file_mime, file_size, work_performed, notes, uploaded_by, created_at, asset:assets(tag, area), uploader:profiles!maintenance_report_files_uploaded_by_fkey(name)";

  function flattenMaintenanceFile(row: any) {
    const { asset, uploader, ...rest } = row;
    return {
      ...rest,
      asset_tag: asset?.tag ?? null,
      area: asset?.area ?? null,
      uploaded_by_name: uploader?.name ?? null,
    };
  }

  // Helper: load an asset's area for scope checks. Returns null if not found.
  async function assetAreaOf(client: any, assetId: string | string[]) {
    const { data } = await client
      .from("assets")
      .select("id, area")
      .eq("id", assetId)
      .single();
    return data ? (data.area as string) : null;
  }

  // List uploaded maintenance report files for one asset. Area-scoped.
  app.get(
    "/api/assets/:id/maintenance-files",
    requireAuth,
    async (req: Request, res: Response) => {
      const scope = areaScopeOf(req.profile!);
      const area = await assetAreaOf(supabaseAnon, req.params.id);
      if (area == null)
        return res.status(404).json({ message: "Asset not found" });
      if (scope && area !== scope)
        return res.status(404).json({ message: "Asset not found" });
      const { data, error } = await supabaseAnon
        .from("maintenance_report_files")
        .select(MAINTENANCE_FILE_SELECT)
        .eq("asset_id", req.params.id)
        .order("created_at", { ascending: false });
      if (error) return res.status(500).json({ message: error.message });
      res.json((data || []).map(flattenMaintenanceFile));
    },
  );

  // Upload a maintenance report file to an asset. Admin + area + super, and the
  // asset must be within the uploader's area scope.
  app.post(
    "/api/assets/:id/maintenance-files",
    requireAuth,
    requireRole("admin", "area", "super"),
    async (req: Request, res: Response) => {
      const parsed = uploadMaintenanceFileSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      const client = supabaseAdmin || supabaseAnon;
      const area = await assetAreaOf(client, req.params.id);
      if (area == null)
        return res.status(404).json({ message: "Asset not found" });
      const scope = areaScopeOf(req.profile!);
      if (scope && area !== scope)
        return res.status(403).json({ message: "Asset is outside your area" });

      const bytes = Buffer.from(parsed.data.file_base64, "base64");
      if (bytes.length === 0)
        return res.status(400).json({ message: "Uploaded file is empty" });

      const { data: created, error } = await client
        .from("maintenance_report_files")
        .insert({
          asset_id: req.params.id,
          file_name: parsed.data.file_name,
          file_mime: parsed.data.file_mime ?? "application/pdf",
          file_size: bytes.length,
          file_base64: parsed.data.file_base64,
          work_performed: parsed.data.work_performed,
          notes: parsed.data.notes ?? null,
          uploaded_by: req.profile!.id,
        })
        .select(MAINTENANCE_FILE_SELECT)
        .single();
      if (error) return res.status(400).json({ message: error.message });
      res.status(201).json(flattenMaintenanceFile(created));
    },
  );

  // Download / view an uploaded maintenance report file. Area-scoped.
  app.get(
    "/api/maintenance-files/:fileId/file",
    requireAuth,
    async (req: Request, res: Response) => {
      const { data, error } = await supabaseAnon
        .from("maintenance_report_files")
        .select("file_name, file_mime, file_base64, asset:assets(area)")
        .eq("id", req.params.fileId)
        .single();
      if (error || !data || !(data as any).file_base64)
        return res.status(404).json({ message: "File not found" });
      const scope = areaScopeOf(req.profile!);
      const area = (data as any).asset?.area ?? null;
      if (scope && area !== scope)
        return res.status(404).json({ message: "File not found" });
      const buf = Buffer.from((data as any).file_base64, "base64");
      res.setHeader(
        "Content-Type",
        (data as any).file_mime || "application/octet-stream",
      );
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${((data as any).file_name || "maintenance-report").replace(/"/g, "")}"`,
      );
      res.send(buf);
    },
  );

  // Delete an uploaded maintenance report file. Admin + area + super (own area).
  app.delete(
    "/api/maintenance-files/:fileId",
    requireAuth,
    requireRole("admin", "area", "super"),
    async (req: Request, res: Response) => {
      const client = supabaseAdmin || supabaseAnon;
      const { data: existing } = await supabaseAnon
        .from("maintenance_report_files")
        .select("id, asset:assets(area)")
        .eq("id", req.params.fileId)
        .single();
      if (!existing)
        return res.status(404).json({ message: "File not found" });
      const scope = areaScopeOf(req.profile!);
      const area = (existing as any).asset?.area ?? null;
      if (scope && area !== scope)
        return res.status(404).json({ message: "File not found" });
      const { error } = await client
        .from("maintenance_report_files")
        .delete()
        .eq("id", req.params.fileId);
      if (error) return res.status(400).json({ message: error.message });
      res.status(204).end();
    },
  );

  // -------------------------------------------------------------------------
  // Work Orders (Maintenance module)
  // -------------------------------------------------------------------------
  const WORK_ORDER_SELECT =
    "id, wo_number, asset_id, area, title, wo_type, priority, status, assigned_to, due_date, est_hours, notes, created_by, completed_at, created_at, asset:assets(tag, category), assigned:profiles!work_orders_assigned_to_fkey(name), creator:profiles!work_orders_created_by_fkey(name)";

  function flattenWorkOrder(row: any) {
    const { asset, assigned, creator, ...rest } = row;
    return {
      ...rest,
      asset_tag: asset?.tag ?? null,
      asset_category: asset?.category ?? null,
      assigned_to_name: assigned?.name ?? null,
      created_by_name: creator?.name ?? null,
    };
  }

  // People a work order can be assigned to. Area-scoped list of active
  // profiles. Available to the manage roles (they build the assignee dropdown).
  app.get(
    "/api/work-orders/assignees",
    requireAuth,
    requireRole(...WORK_ORDER_MANAGE_ROLES),
    async (req: Request, res: Response) => {
      const scope = areaScopeOf(req.profile!);
      let query = supabaseAnon
        .from("profiles")
        .select("id, name, role, area")
        .eq("active", true)
        .order("name", { ascending: true });
      // Non-admins only see people in their own area (admins in an area column
      // are null, so include those too for the scoped manager's convenience).
      if (scope) query = query.or(`area.eq.${scope},area.is.null`);
      const { data, error } = await query;
      if (error) return res.status(500).json({ message: error.message });
      res.json(data || []);
    },
  );

  // List work orders. Area-scoped: admins see all, everyone else only their area.
  app.get(
    "/api/work-orders",
    requireAuth,
    async (req: Request, res: Response) => {
      const scope = areaScopeOf(req.profile!);
      let query = supabaseAnon
        .from("work_orders")
        .select(WORK_ORDER_SELECT)
        .order("created_at", { ascending: false });
      if (scope) query = query.eq("area", scope);
      const { data, error } = await query;
      if (error) return res.status(500).json({ message: error.message });
      res.json((data || []).map(flattenWorkOrder));
    },
  );

  // Create a work order. Admin + area + super; asset must be in the creator's
  // area scope. Area is derived from the asset (never trusted from the body).
  app.post(
    "/api/work-orders",
    requireAuth,
    requireRole(...WORK_ORDER_MANAGE_ROLES),
    async (req: Request, res: Response) => {
      const parsed = createWorkOrderSchema.safeParse(req.body);
      if (!parsed.success)
        return res
          .status(400)
          .json({ message: parsed.error.errors[0]?.message || "Invalid input" });
      const input = parsed.data;
      const area = await assetAreaOf(supabaseAnon, input.asset_id);
      if (area == null)
        return res.status(404).json({ message: "Asset not found" });
      const scope = areaScopeOf(req.profile!);
      if (scope && area !== scope)
        return res.status(404).json({ message: "Asset not found" });

      const client = supabaseAdmin || supabaseAnon;
      // Human-friendly sequential WO number (WO-5001, ...).
      const { data: seqData, error: seqErr } = await client.rpc("nextval", {
        seq: "work_order_seq",
      });
      let woNumber: string;
      if (seqErr || seqData == null) {
        // Fallback: derive from count if the RPC helper isn't present.
        const { count } = await client
          .from("work_orders")
          .select("id", { count: "exact", head: true });
        woNumber = `WO-${5001 + (count || 0)}`;
      } else {
        woNumber = `WO-${seqData}`;
      }

      const isCompleted = input.status === "Completed";
      const { data, error } = await client
        .from("work_orders")
        .insert({
          wo_number: woNumber,
          asset_id: input.asset_id,
          area,
          title: input.title,
          wo_type: input.wo_type,
          priority: input.priority ?? "Medium",
          status: input.status ?? "Scheduled",
          assigned_to: input.assigned_to ?? null,
          due_date: input.due_date || null,
          est_hours: input.est_hours ?? null,
          notes: input.notes || null,
          created_by: req.profile!.id,
          completed_at: isCompleted ? new Date().toISOString() : null,
        })
        .select(WORK_ORDER_SELECT)
        .single();
      if (error) return res.status(400).json({ message: error.message });
      res.status(201).json(flattenWorkOrder(data));
    },
  );

  // Update a work order (edit fields, reassign, change status/close). Admin +
  // area + super, within area scope.
  app.patch(
    "/api/work-orders/:id",
    requireAuth,
    requireRole(...WORK_ORDER_MANAGE_ROLES),
    async (req: Request, res: Response) => {
      const parsed = updateWorkOrderSchema.safeParse(req.body);
      if (!parsed.success)
        return res
          .status(400)
          .json({ message: parsed.error.errors[0]?.message || "Invalid input" });
      const client = supabaseAdmin || supabaseAnon;
      const { data: existing } = await supabaseAnon
        .from("work_orders")
        .select("id, area, status, completed_at")
        .eq("id", req.params.id)
        .single();
      if (!existing)
        return res.status(404).json({ message: "Work order not found" });
      const scope = areaScopeOf(req.profile!);
      if (scope && (existing as any).area !== scope)
        return res.status(404).json({ message: "Work order not found" });

      const patch: Record<string, any> = {};
      const input = parsed.data;
      if (input.title !== undefined) patch.title = input.title;
      if (input.wo_type !== undefined) patch.wo_type = input.wo_type;
      if (input.priority !== undefined) patch.priority = input.priority;
      if (input.assigned_to !== undefined) patch.assigned_to = input.assigned_to;
      if (input.due_date !== undefined) patch.due_date = input.due_date || null;
      if (input.est_hours !== undefined) patch.est_hours = input.est_hours;
      if (input.notes !== undefined) patch.notes = input.notes || null;
      if (input.status !== undefined) {
        patch.status = input.status;
        // Stamp/clear completion time when crossing the Completed boundary.
        if (input.status === "Completed" && !(existing as any).completed_at) {
          patch.completed_at = new Date().toISOString();
        } else if (input.status !== "Completed") {
          patch.completed_at = null;
        }
      }
      if (Object.keys(patch).length === 0)
        return res.status(400).json({ message: "No changes provided" });

      const { data, error } = await client
        .from("work_orders")
        .update(patch)
        .eq("id", req.params.id)
        .select(WORK_ORDER_SELECT)
        .single();
      if (error) return res.status(400).json({ message: error.message });
      res.json(flattenWorkOrder(data));
    },
  );

  // Delete a work order. Admin + area + super, within area scope.
  app.delete(
    "/api/work-orders/:id",
    requireAuth,
    requireRole(...WORK_ORDER_MANAGE_ROLES),
    async (req: Request, res: Response) => {
      const client = supabaseAdmin || supabaseAnon;
      const { data: existing } = await supabaseAnon
        .from("work_orders")
        .select("id, area")
        .eq("id", req.params.id)
        .single();
      if (!existing)
        return res.status(404).json({ message: "Work order not found" });
      const scope = areaScopeOf(req.profile!);
      if (scope && (existing as any).area !== scope)
        return res.status(404).json({ message: "Work order not found" });
      const { error } = await client
        .from("work_orders")
        .delete()
        .eq("id", req.params.id);
      if (error) return res.status(400).json({ message: error.message });
      res.status(204).end();
    },
  );

  // Sign off (area managers only)
  app.post(
    "/api/reports/:id/signoff",
    requireAuth,
    requireRole("area", "admin"),
    async (req: Request, res: Response) => {
      const client = supabaseAdmin || supabaseAnon;
      const { data: report } = await client
        .from("maintenance_reports")
        .select("*, asset:assets(*)")
        .eq("id", req.params.id)
        .single();
      if (!report) return res.status(404).json({ message: "Report not found" });
      if (report.status === "Signed off")
        return res.status(400).json({ message: "Already signed off" });
      if (
        req.profile!.role === "area" &&
        report.asset?.area !== req.profile!.area
      )
        return res.status(403).json({ message: "Outside your area" });

      const { error: sErr } = await client.from("sign_offs").insert({
        report_id: report.id,
        area_mgr_id: req.profile!.id,
      });
      if (sErr) return res.status(400).json({ message: sErr.message });

      await client
        .from("maintenance_reports")
        .update({ status: "Signed off" })
        .eq("id", report.id);

      await client.from("audit_events").insert({
        report_id: report.id,
        asset_id: report.asset_id,
        actor_id: req.profile!.id,
        actor_name: req.profile!.name,
        actor_role: req.profile!.role,
        action: "Signed off",
      });

      // notify the supervisor who filed it
      sendNotificationEmails("signed", {
        report,
        asset: report.asset,
        signerName: req.profile!.name,
      }).catch((e) => console.error("[email] signed", e));

      res.json({ ok: true });
    },
  );

  // ---- Audit trail per asset ----------------------------------------------
  app.get(
    "/api/assets/:id/audit",
    requireAuth,
    async (req: Request, res: Response) => {
      const { data, error } = await supabaseAnon
        .from("audit_events")
        .select("*")
        .eq("asset_id", req.params.id)
        .order("occurred_at", { ascending: false });
      if (error) return res.status(500).json({ message: error.message });
      res.json(data);
    },
  );

  // ---- Notification prefs (self) ------------------------------------------
  app.put(
    "/api/notification-prefs",
    requireAuth,
    async (req: Request, res: Response) => {
      const parsed = notifPrefsSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      const client = supabaseAdmin || supabaseAnon;
      const { data, error } = await client
        .from("notification_prefs")
        .upsert({ user_id: req.profile!.id, ...parsed.data })
        .select()
        .single();
      if (error) return res.status(400).json({ message: error.message });
      res.json(data);
    },
  );

  // ---- Daily reports ------------------------------------------------------
  // Ingest: called by the scheduled Gmail-analysis task, NOT a logged-in user.
  // Authenticated with a shared secret header (x-ingest-token).
  app.post("/api/daily-reports/ingest", async (req: Request, res: Response) => {
    if (!INGEST_TOKEN)
      return res.status(503).json({ message: "Ingest not configured (set INGEST_TOKEN)." });
    if (req.header("x-ingest-token") !== INGEST_TOKEN)
      return res.status(401).json({ message: "Bad ingest token" });
    const parsed = ingestDailyReportSchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ message: parsed.error.errors[0].message });
    const client = supabaseAdmin || supabaseAnon;
    const p = parsed.data;

    // Dedupe: if this Gmail message was already imported, return it untouched
    // (never overwrite an analyzed/reviewed report or duplicate its audit trail).
    const { data: existing } = await client
      .from("daily_reports")
      .select("*")
      .eq("email_message_id", p.email_message_id)
      .maybeSingle();
    if (existing) return res.status(200).json({ ...existing, deduped: true });

    // Parse the emailed Excel and read every value straight from the
    // "Report Day N" sheet. Nothing is interpreted from the email body.
    let excel;
    try {
      const buf = Buffer.from(p.attachment_base64, "base64");
      excel = parseDailyReportWorkbook(buf, p.report_day ?? undefined);
    } catch (e: any) {
      if (e instanceof ExcelParseError)
        return res.status(422).json({ message: e.message });
      return res
        .status(422)
        .json({ message: `Failed to parse Excel attachment: ${e?.message ?? e}` });
    }

    // Match the well name from the sheet to a job (job = job_number + area).
    // Matching is case-insensitive on trimmed well_name. Unmatched reports go
    // to a "Needs job match" review queue instead of being silently dropped.
    let job_id: string | null = null;
    let area: string | null = null;
    let customer_id: string | null = null;
    if (excel.well_name) {
      const { data: jobs } = await client
        .from("jobs")
        .select("id, area, customer_id, well_name")
        .not("well_name", "is", null);
      const target = excel.well_name.trim().toLowerCase();
      const match = (jobs || []).find(
        (j: any) => (j.well_name || "").trim().toLowerCase() === target,
      );
      if (match) {
        job_id = match.id;
        area = match.area;
        customer_id = match.customer_id;
      }
    }

    const status = job_id ? "Pending Review" : "Needs job match";
    const row: Record<string, any> = {
      email_message_id: p.email_message_id,
      sender_email: p.sender_email,
      sender_name: p.sender_name ?? null,
      subject: p.subject ?? null,
      received_at: p.received_at ?? new Date().toISOString(),
      raw_body: null,
      source: "email",
      attachment_name: p.attachment_name,
      source_sheet: excel.source_sheet,
      report_day: excel.report_day,
      report_date: excel.report_date,
      well_name: excel.well_name,
      well_context: excel.well_context,
      kpis: excel.kpis,
      kpi_cell_map: excel.kpi_cell_map,
      summary: excel.summary,
      analysis: {},
      area,
      customer_id,
      job_id,
      status,
    };
    const { data, error } = await client
      .from("daily_reports")
      .insert(row)
      .select()
      .single();
    if (error) return res.status(400).json({ message: error.message });
    await client.from("daily_report_events").insert({
      report_id: data.id,
      actor_name: p.sender_name || p.sender_email,
      actor_role: "field",
      action: "ingested",
      detail: `Imported ${excel.source_sheet} from \"${p.attachment_name}\"` +
        (job_id
          ? ` and matched well \"${excel.well_name}\" to a job.`
          : ` — well \"${excel.well_name ?? "(none)"}\" did not match any job; awaiting assignment.`),
    });
    // Incomplete workbook (no day tab had hand-entered activity): still imported,
    // but log a distinct alert so a supervisor / area manager knows to review
    // and sign off. Per policy we never drop the email or fabricate values.
    if (excel.incomplete) {
      await client.from("daily_report_events").insert({
        report_id: data.id,
        actor_name: "System",
        actor_role: "field",
        action: "needs_review",
        detail:
          `No completed day sheet was found in \"${p.attachment_name}\" — ` +
          `imported ${excel.source_sheet} with the values present. ` +
          `A supervisor or area manager should review and sign off.`,
      });
    }
    res.status(201).json(data);
  });

  // Assign an unmatched Excel report to a job (review-queue action).
  // Supervisors+ only. Sets job/area/customer and moves it to Pending Review.
  app.post(
    "/api/daily-reports/:id/assign-job",
    requireAuth,
    requireRole("admin", "area", "super"),
    async (req: Request, res: Response) => {
      const parsed = assignDailyReportJobSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      const client = supabaseAdmin || supabaseAnon;

      const { data: report, error: rErr } = await client
        .from("daily_reports")
        .select("*")
        .eq("id", req.params.id)
        .single();
      if (rErr || !report)
        return res.status(404).json({ message: "Report not found" });

      const { data: job, error: jErr } = await client
        .from("jobs")
        .select("id, area, customer_id, job_number")
        .eq("id", parsed.data.job_id)
        .single();
      if (jErr || !job)
        return res.status(404).json({ message: "Job not found" });

      // Area managers/supervisors can only assign to jobs in their own area.
      const scope = areaScopeOf(req.profile!);
      if (scope && job.area !== scope)
        return res
          .status(403)
          .json({ message: "You can only assign reports to jobs in your area." });

      const { data, error } = await client
        .from("daily_reports")
        .update({
          job_id: job.id,
          area: job.area,
          customer_id: job.customer_id,
          status: "Pending Review",
        })
        .eq("id", report.id)
        .select()
        .single();
      if (error) return res.status(400).json({ message: error.message });
      await client.from("daily_report_events").insert({
        report_id: report.id,
        actor_id: req.profile!.id,
        actor_name: req.profile!.name,
        actor_role: req.profile!.role,
        action: "assigned",
        detail: `Assigned to job ${job.job_number} (${job.area}).`,
      });
      res.json(data);
    },
  );

  // Unified daily-reports list (both emailed + field), area-scoped like jobs,
  // with customer + job identifiers and submitter/signer names joined in.
  // ?source=email|field filters by origin; ?status=pending|signed filters.
  app.get("/api/daily-reports", requireAuth, async (req: Request, res: Response) => {
    const scope = areaScopeOf(req.profile!);
    const jobIds = await jobScopeOf(req.profile!);
    let q = supabaseAnon
      .from("daily_reports")
      .select(
        "*, customer:customers(name), job:jobs(job_number), submitter:profiles!daily_reports_submitted_by_fkey(name), signer:profiles!daily_reports_signed_by_fkey(name)",
      )
      .order("received_at", { ascending: false });
    // area managers/supervisors/field only see their own area (+ any unclassified in their area);
    // admins see all. Unclassified (area is null) are visible to admins only.
    if (scope) q = q.eq("area", scope);
    const srcFilter = String(req.query.source || "").toLowerCase();
    if (srcFilter === "email" || srcFilter === "field") q = q.eq("source", srcFilter);
    const { data, error } = await q;
    if (error) return res.status(500).json({ message: error.message });
    let rows = (data || []).map((r: any) => ({
      ...r,
      customer_name: r.customer?.name ?? null,
      job_number: r.job?.job_number ?? null,
      submitted_by_name: r.submitter?.name ?? null,
      signed_by_name: r.signer?.name ?? null,
      customer: undefined,
      job: undefined,
      submitter: undefined,
      signer: undefined,
    }));
    // Assigned field techs only see daily reports for their assigned job(s).
    if (jobIds) rows = rows.filter((r: any) => jobIds.includes(r.job_id));
    const statusFilter = String(req.query.status || "").toLowerCase();
    if (statusFilter === "pending")
      rows = rows.filter((r: any) => r.status !== "Signed off");
    else if (statusFilter === "signed")
      rows = rows.filter((r: any) => r.status === "Signed off");
    res.json(rows);
  });

  // Single report + its audit events
  app.get("/api/daily-reports/:id", requireAuth, async (req: Request, res: Response) => {
    const { data, error } = await supabaseAnon
      .from("daily_reports")
      .select(
        "*, customer:customers(name), job:jobs(job_number), submitter:profiles!daily_reports_submitted_by_fkey(name), signer:profiles!daily_reports_signed_by_fkey(name)",
      )
      .eq("id", req.params.id)
      .single();
    if (error || !data)
      return res.status(404).json({ message: "Report not found" });
    const scope = areaScopeOf(req.profile!);
    if (scope && data.area !== scope)
      return res.status(404).json({ message: "Report not found" });
    const jobIds = await jobScopeOf(req.profile!);
    if (jobIds && !jobIds.includes(data.job_id))
      return res.status(404).json({ message: "Report not found" });
    const { data: events } = await supabaseAnon
      .from("daily_report_events")
      .select("*")
      .eq("report_id", req.params.id)
      .order("occurred_at", { ascending: false });
    const { customer, job, submitter, signer, ...rest } = data as any;
    res.json({
      ...rest,
      customer_name: customer?.name ?? null,
      job_number: job?.job_number ?? null,
      submitted_by_name: submitter?.name ?? null,
      signed_by_name: signer?.name ?? null,
      events: events || [],
    });
  });

  // Review: sign off OR request changes (area managers + supervisors)
  app.post(
    "/api/daily-reports/:id/review",
    requireAuth,
    requireRole("admin", "area", "super"),
    async (req: Request, res: Response) => {
      const parsed = reviewDailyReportSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      const client = supabaseAdmin || supabaseAnon;

      // load the report + enforce area scope
      const { data: report, error: rErr } = await client
        .from("daily_reports")
        .select("*")
        .eq("id", req.params.id)
        .single();
      if (rErr || !report)
        return res.status(404).json({ message: "Report not found" });
      const scope = areaScopeOf(req.profile!);
      if (scope && report.area !== scope)
        return res.status(404).json({ message: "Report not found" });

      const now = new Date().toISOString();
      const reviewer = req.profile!;

      if (parsed.data.action === "sign_off") {
        const { data, error } = await client
          .from("daily_reports")
          .update({
            status: "Signed off",
            reviewed_by: reviewer.id,
            reviewed_by_name: reviewer.name,
            reviewed_at: now,
            change_notes: null,
          })
          .eq("id", report.id)
          .select()
          .single();
        if (error) return res.status(400).json({ message: error.message });
        await client.from("daily_report_events").insert({
          report_id: report.id,
          actor_id: reviewer.id,
          actor_name: reviewer.name,
          actor_role: reviewer.role,
          action: "signed_off",
          detail: null,
        });
        return res.json(data);
      }

      // request_changes: record notes, queue/send email back to sender
      const delivered = await sendDailyReportChanges({
        to: report.sender_email,
        senderName: report.sender_name,
        subject: report.subject,
        reviewerName: reviewer.name,
        changeNotes: parsed.data.change_notes!.trim(),
        reportDate: report.report_date,
      });
      const emailStatus = delivered ? "Sent" : "Pending send";
      const { data, error } = await client
        .from("daily_reports")
        .update({
          status: "Changes requested",
          reviewed_by: reviewer.id,
          reviewed_by_name: reviewer.name,
          reviewed_at: now,
          change_notes: parsed.data.change_notes!.trim(),
          email_out_status: emailStatus,
          email_out_at: delivered ? now : null,
        })
        .eq("id", report.id)
        .select()
        .single();
      if (error) return res.status(400).json({ message: error.message });
      await client.from("daily_report_events").insert({
        report_id: report.id,
        actor_id: reviewer.id,
        actor_name: reviewer.name,
        actor_role: reviewer.role,
        action: "changes_requested",
        detail: delivered
          ? `Suggested changes emailed to ${report.sender_email}`
          : `Suggested changes recorded; email queued for ${report.sender_email}`,
      });
      res.json(data);
    },
  );

  // Config (admins manage which inbox/query feeds reports)
  app.get(
    "/api/daily-reports-config",
    requireAuth,
    requireRole("admin"),
    async (_req: Request, res: Response) => {
      const { data, error } = await supabaseAnon
        .from("daily_report_config")
        .select("*")
        .eq("id", 1)
        .single();
      if (error) return res.status(500).json({ message: error.message });
      res.json({ ...data, email_out_ready: emailConfigured(), ingest_ready: !!INGEST_TOKEN });
    },
  );

  app.put(
    "/api/daily-reports-config",
    requireAuth,
    requireRole("admin"),
    async (req: Request, res: Response) => {
      const parsed = updateDailyReportConfigSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      const client = supabaseAdmin || supabaseAnon;
      const patch: any = { ...parsed.data, updated_at: new Date().toISOString() };
      if (patch.inbox_email === "") patch.inbox_email = null;
      const { data, error } = await client
        .from("daily_report_config")
        .update(patch)
        .eq("id", 1)
        .select()
        .single();
      if (error) return res.status(400).json({ message: error.message });
      res.json(data);
    },
  );

  // ==== JSA intake ==========================================================
  // JSAs are forwarded to the SAME inbox as daily reports. The scheduled email
  // task sorts them by the subject keyword "JSA" and posts them here. A JSA is
  // acknowledgement-only: we confirm receipt, capture the job (from the subject
  // job number) and date, keep the original file as a downloadable attachment,
  // and require ONE supervisor/area manager in the job's area to sign it off.
  // The attachment bytes never travel in list/detail payloads — they are served
  // from a dedicated download endpoint.
  const JSA_LIST_COLS =
    "id, email_message_id, sender_email, sender_name, subject, received_at, jsa_date, area, customer_id, job_id, job_number_raw, attachment_name, attachment_mime, attachment_size, status, signed_off_by, signed_off_by_name, signed_off_at, created_at";

  // Parse a job number out of an email subject. Job numbers look like
  // "ST-2201", "WT-1042", etc. — letters, dash, digits. Returns the first match.
  const parseJobNumber = (subject: string | null | undefined): string | null => {
    if (!subject) return null;
    const m = subject.match(/\b[A-Za-z]{1,4}[-\s]?\d{2,6}\b/);
    return m ? m[0].replace(/\s+/g, "-").toUpperCase() : null;
  };

  // Ingest a JSA email. Auth via the shared x-ingest-token (same as reports).
  app.post("/api/jsa-intake/ingest", async (req: Request, res: Response) => {
    if (!INGEST_TOKEN)
      return res.status(503).json({ message: "Ingest not configured (set INGEST_TOKEN)." });
    if (req.header("x-ingest-token") !== INGEST_TOKEN)
      return res.status(401).json({ message: "Bad ingest token" });
    const parsed = ingestJsaSchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ message: parsed.error.errors[0].message });
    const client = supabaseAdmin || supabaseAnon;
    const p = parsed.data;

    // Dedupe on the Gmail message id.
    const { data: existing } = await client
      .from("jsa_reports")
      .select(JSA_LIST_COLS)
      .eq("email_message_id", p.email_message_id)
      .maybeSingle();
    if (existing) return res.status(200).json({ ...existing, deduped: true });

    // Match to a job by the job number parsed from the subject (or an explicit
    // override). Unmatched JSAs go to a "Needs job match" queue.
    const jobNumber = (p.job_number && p.job_number.trim()) || parseJobNumber(p.subject);
    let job_id: string | null = null;
    let area: string | null = null;
    let customer_id: string | null = null;
    if (jobNumber) {
      const { data: jobs } = await client
        .from("jobs")
        .select("id, area, customer_id, job_number");
      const target = jobNumber.trim().toLowerCase();
      const match = (jobs || []).find(
        (j: any) => (j.job_number || "").trim().toLowerCase() === target,
      );
      if (match) {
        job_id = match.id;
        area = match.area;
        customer_id = match.customer_id;
      }
    }

    const bytes = Buffer.from(p.attachment_base64, "base64");
    const status = job_id ? "Pending sign-off" : "Needs job match";
    const row: Record<string, any> = {
      email_message_id: p.email_message_id,
      sender_email: p.sender_email,
      sender_name: p.sender_name ?? null,
      subject: p.subject ?? null,
      received_at: p.received_at ?? new Date().toISOString(),
      jsa_date: p.jsa_date ?? null,
      job_number_raw: jobNumber,
      attachment_name: p.attachment_name,
      attachment_mime: p.attachment_mime ?? "application/pdf",
      attachment_size: bytes.length,
      attachment_base64: p.attachment_base64,
      area,
      customer_id,
      job_id,
      status,
    };
    const { data, error } = await client
      .from("jsa_reports")
      .insert(row)
      .select(JSA_LIST_COLS)
      .single();
    if (error) return res.status(400).json({ message: error.message });
    await client.from("jsa_report_events").insert({
      jsa_id: data.id,
      actor_name: p.sender_name || p.sender_email,
      actor_role: "field",
      action: "received",
      detail:
        `Received JSA \"${p.attachment_name}\"` +
        (job_id
          ? ` and matched job ${jobNumber} to this JSA.`
          : jobNumber
            ? ` — job number \"${jobNumber}\" did not match any job; awaiting assignment.`
            : ` — no job number found in the subject; awaiting assignment.`),
    });
    res.status(201).json(data);
  });

  // List JSAs (area-scoped) with customer + job identifiers joined in.
  app.get("/api/jsa-intake", requireAuth, async (req: Request, res: Response) => {
    const scope = areaScopeOf(req.profile!);
    let q = supabaseAnon
      .from("jsa_reports")
      .select(`${JSA_LIST_COLS}, customer:customers(name), job:jobs(job_number)`)
      .order("received_at", { ascending: false });
    if (scope) q = q.eq("area", scope);
    const { data, error } = await q;
    if (error) return res.status(500).json({ message: error.message });
    const rows = (data || []).map((r: any) => ({
      ...r,
      customer_name: r.customer?.name ?? null,
      job_number: r.job?.job_number ?? null,
      customer: undefined,
      job: undefined,
    }));
    res.json(rows);
  });

  // Single JSA + its audit events.
  app.get("/api/jsa-intake/:id", requireAuth, async (req: Request, res: Response) => {
    const { data, error } = await supabaseAnon
      .from("jsa_reports")
      .select(`${JSA_LIST_COLS}, customer:customers(name), job:jobs(job_number)`)
      .eq("id", req.params.id)
      .single();
    if (error || !data) return res.status(404).json({ message: "JSA not found" });
    const scope = areaScopeOf(req.profile!);
    if (scope && data.area !== scope)
      return res.status(404).json({ message: "JSA not found" });
    const { data: events } = await supabaseAnon
      .from("jsa_report_events")
      .select("*")
      .eq("jsa_id", req.params.id)
      .order("occurred_at", { ascending: false });
    const { customer, job, ...rest } = data as any;
    res.json({
      ...rest,
      customer_name: customer?.name ?? null,
      job_number: job?.job_number ?? null,
      events: events || [],
    });
  });

  // Download the original JSA attachment. Streams the stored bytes with the
  // right content type so the browser opens/saves the original file.
  app.get(
    "/api/jsa-intake/:id/attachment",
    requireAuth,
    async (req: Request, res: Response) => {
      const { data, error } = await supabaseAnon
        .from("jsa_reports")
        .select("area, attachment_name, attachment_mime, attachment_base64")
        .eq("id", req.params.id)
        .single();
      if (error || !data) return res.status(404).json({ message: "JSA not found" });
      const scope = areaScopeOf(req.profile!);
      if (scope && data.area !== scope)
        return res.status(404).json({ message: "JSA not found" });
      const buf = Buffer.from(data.attachment_base64, "base64");
      res.setHeader("Content-Type", data.attachment_mime || "application/octet-stream");
      res.setHeader(
        "Content-Disposition",
        `inline; filename=\"${(data.attachment_name || "jsa").replace(/\"/g, "")}\"`,
      );
      res.send(buf);
    },
  );

  // Inline preview of the JSA attachment. Parses the stored spreadsheet
  // server-side (SheetJS) and returns structured per-sheet cell rows so the
  // detail page can render the JSA's contents without a download. Non-spread-
  // sheet files (e.g. a PDF) return { previewable: false } so the UI can fall
  // back to the download link.
  app.get(
    "/api/jsa-intake/:id/preview",
    requireAuth,
    async (req: Request, res: Response) => {
      const { data, error } = await supabaseAnon
        .from("jsa_reports")
        .select("area, attachment_name, attachment_mime, attachment_base64")
        .eq("id", req.params.id)
        .single();
      if (error || !data) return res.status(404).json({ message: "JSA not found" });
      const scope = areaScopeOf(req.profile!);
      if (scope && data.area !== scope)
        return res.status(404).json({ message: "JSA not found" });

      const name = (data.attachment_name || "").toLowerCase();
      const mime = (data.attachment_mime || "").toLowerCase();
      const looksSpreadsheet =
        /\.(xlsx|xlsm|xls|csv)$/.test(name) ||
        mime.includes("spreadsheet") ||
        mime.includes("excel") ||
        mime === "text/csv";
      if (!looksSpreadsheet) {
        return res.json({
          previewable: false,
          reason: "not_spreadsheet",
          attachment_name: data.attachment_name,
          attachment_mime: data.attachment_mime,
        });
      }

      try {
        const buf = Buffer.from(data.attachment_base64, "base64");
        const wb = XLSX.read(buf, { type: "buffer", cellDates: true });
        const fmt = (v: any): string => {
          if (v === null || v === undefined) return "";
          if (v instanceof Date) {
            if (isNaN(v.getTime())) return "";
            return v.toLocaleDateString("en-US");
          }
          // Collapse internal whitespace/newlines and trim.
          return String(v).replace(/\s+/g, " ").trim();
        };

        // The JSA worksheet has a fixed layout: label/value header pairs in the
        // top rows, then an Activity / Hazards / Risk control / Responsible
        // table. We extract only what the sender actually filled in and drop
        // the template boilerplate (title banner, reminder footer, blank rows)
        // and the other reference/checklist sheets.
        //
        // A cell address -> value map keyed like "A2" makes the fixed layout
        // easy to read regardless of merged cells.
        const jsaName = wb.SheetNames.find((n) => /jsa/i.test(n)) || wb.SheetNames[0];
        const ws = wb.Sheets[jsaName];
        const grid: any[][] = XLSX.utils.sheet_to_json(ws, {
          header: 1,
          blankrows: false,
          defval: null,
          raw: false,
        });
        const cell = (r: number, c: number): string =>
          fmt(grid[r - 1] ? grid[r - 1][c - 1] : ""); // 1-based row/col

        // --- Header fields: label in col A / value in col B, and label in
        //     col J / value in col K, across the header rows. Keep only rows
        //     where the sender entered a value.
        const headerRows = [2, 3, 4, 5];
        const header: { label: string; value: string }[] = [];
        for (const r of headerRows) {
          for (const [lc, vc] of [
            [1, 2],
            [10, 11],
          ] as const) {
            const label = cell(r, lc).replace(/:\s*$/, "");
            const value = cell(r, vc);
            if (label && value) header.push({ label, value });
          }
        }

        // --- Activity table: header row where col A reads "Activity", then the
        //     data rows beneath until the reminder/footer boilerplate. Columns
        //     live at A / F / I / K.
        const tableCols = [1, 6, 9, 11];
        let headerRowIdx = -1;
        for (let r = 1; r <= grid.length; r++) {
          // The real table header cell is the long instructional text
          // ("Activity List the tasks required..."), not the short
          // "Activity:" header field near the top. Require both the Activity
          // label and a Hazards column header on the same row.
          const a = cell(r, 1);
          const f = cell(r, 6);
          if (/^activity\b/i.test(a) && /list the tasks/i.test(a) && /^hazards/i.test(f)) {
            headerRowIdx = r;
            break;
          }
        }
        // Clean column titles. The template stuffs a long instruction into each
        // header cell (e.g. "Activity List the tasks required..."); we only want
        // the field name, so trim at the first instruction keyword.
        const colTitle = (raw: string): string => {
          const trimmed = raw
            .replace(/\s*(List the|Against each|Write the).*$/i, "")
            .trim();
          return trimmed || raw;
        };
        let table: { columns: string[]; rows: string[][] } | null = null;
        if (headerRowIdx > 0) {
          const columns = tableCols.map((c) => colTitle(cell(headerRowIdx, c)));
          const rows: string[][] = [];
          for (let r = headerRowIdx + 1; r <= grid.length; r++) {
            const first = cell(r, 1);
            // Stop at the template footer / reminder lines.
            if (/^remember:/i.test(first) || /^e-?mail jsa/i.test(first)) break;
            const vals = tableCols.map((c) => cell(r, c));
            if (vals.some((v) => v !== "")) rows.push(vals);
          }
          if (rows.length) table = { columns, rows };
        }

        if (header.length || table) {
          return res.json({
            previewable: true,
            structured: true,
            attachment_name: data.attachment_name,
            header,
            table,
          });
        }

        // Fallback: JSA layout not detected. Return a compact dump of the first
        // sheet's non-empty cells so the user still sees the sender's content.
        const MAX_ROWS = 200;
        const rows: string[][] = [];
        let maxCol = 0;
        for (const r of grid) {
          const cells = (r || []).map(fmt);
          if (cells.some((c) => c !== "")) {
            maxCol = Math.max(maxCol, cells.length);
            rows.push(cells);
          }
          if (rows.length >= MAX_ROWS) break;
        }
        const padded = rows.map((r) => {
          const c = r.slice(0, maxCol);
          while (c.length < maxCol) c.push("");
          return c;
        });
        const keepCols: number[] = [];
        for (let i = 0; i < maxCol; i++)
          if (padded.some((r) => (r[i] ?? "") !== "")) keepCols.push(i);
        const finalRows = padded.map((r) => keepCols.map((i) => r[i] ?? ""));
        return res.json({
          previewable: true,
          structured: false,
          attachment_name: data.attachment_name,
          sheets: finalRows.length
            ? [{ name: jsaName, rows: finalRows, truncated: grid.length > MAX_ROWS }]
            : [],
        });
      } catch (e: any) {
        return res.json({
          previewable: false,
          reason: "parse_error",
          attachment_name: data.attachment_name,
          attachment_mime: data.attachment_mime,
        });
      }
    },
  );

  // Assign an unmatched JSA to a job (supervisors+). Area-scoped like reports.
  app.post(
    "/api/jsa-intake/:id/assign-job",
    requireAuth,
    requireRole("admin", "area", "super"),
    async (req: Request, res: Response) => {
      const parsed = assignJsaJobSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      const client = supabaseAdmin || supabaseAnon;

      const { data: jsa, error: jErr } = await client
        .from("jsa_reports")
        .select(JSA_LIST_COLS)
        .eq("id", req.params.id)
        .single();
      if (jErr || !jsa) return res.status(404).json({ message: "JSA not found" });

      const { data: job, error: jobErr } = await client
        .from("jobs")
        .select("id, area, customer_id, job_number")
        .eq("id", parsed.data.job_id)
        .single();
      if (jobErr || !job) return res.status(404).json({ message: "Job not found" });

      const scope = areaScopeOf(req.profile!);
      if (scope && job.area !== scope)
        return res
          .status(403)
          .json({ message: "You can only assign JSAs to jobs in your area." });

      const { data, error } = await client
        .from("jsa_reports")
        .update({
          job_id: job.id,
          area: job.area,
          customer_id: job.customer_id,
          status: "Pending sign-off",
        })
        .eq("id", jsa.id)
        .select(JSA_LIST_COLS)
        .single();
      if (error) return res.status(400).json({ message: error.message });
      await client.from("jsa_report_events").insert({
        jsa_id: jsa.id,
        actor_id: req.profile!.id,
        actor_name: req.profile!.name,
        actor_role: req.profile!.role,
        action: "assigned",
        detail: `Assigned to job ${job.job_number} (${job.area}).`,
      });
      res.json(data);
    },
  );

  // Sign off a JSA. Any ONE supervisor/area manager in the job's area suffices.
  app.post(
    "/api/jsa-intake/:id/sign-off",
    requireAuth,
    requireRole("admin", "area", "super"),
    async (req: Request, res: Response) => {
      const client = supabaseAdmin || supabaseAnon;
      const { data: jsa, error: jErr } = await client
        .from("jsa_reports")
        .select(JSA_LIST_COLS)
        .eq("id", req.params.id)
        .single();
      if (jErr || !jsa) return res.status(404).json({ message: "JSA not found" });

      const scope = areaScopeOf(req.profile!);
      if (scope && jsa.area !== scope)
        return res.status(404).json({ message: "JSA not found" });
      if (!jsa.job_id)
        return res
          .status(409)
          .json({ message: "Assign this JSA to a job before signing off." });
      if (jsa.status === "Signed off")
        return res.status(409).json({ message: "This JSA is already signed off." });

      const now = new Date().toISOString();
      const signer = req.profile!;
      const { data, error } = await client
        .from("jsa_reports")
        .update({
          status: "Signed off",
          signed_off_by: signer.id,
          signed_off_by_name: signer.name,
          signed_off_at: now,
        })
        .eq("id", jsa.id)
        .select(JSA_LIST_COLS)
        .single();
      if (error) return res.status(400).json({ message: error.message });
      await client.from("jsa_report_events").insert({
        jsa_id: jsa.id,
        actor_id: signer.id,
        actor_name: signer.name,
        actor_role: signer.role,
        action: "signed_off",
        detail: null,
      });
      res.json(data);
    },
  );

  // ---- Rig-up Reports ------------------------------------------------------
  // Supervisors and area managers upload rig-up report files for a job. Each
  // report is tracked to a status and must be signed off by an AREA MANAGER for
  // the job's area (admins too). Attachment bytes are excluded from list/detail
  // payloads and stream from a dedicated download route.
  const RIG_UP_LIST_COLS =
    "id, job_id, area, customer_id, report_date, title, notes, attachment_name, attachment_mime, attachment_size, status, uploaded_by, uploaded_by_name, signed_off_by, signed_off_by_name, signed_off_at, created_at";

  // List rig-up reports, newest first. Area-scoped: admins see all; area
  // managers, supervisors and field techs see only their own area.
  app.get(
    "/api/rig-up-reports",
    requireAuth,
    async (req: Request, res: Response) => {
      const scope = areaScopeOf(req.profile!);
      let q = supabaseAnon
        .from("rig_up_reports")
        .select(
          `${RIG_UP_LIST_COLS}, jobs:jobs!rig_up_reports_job_id_fkey(job_number), customers:customers!rig_up_reports_customer_id_fkey(name)`,
        )
        .order("created_at", { ascending: false });
      if (scope) q = q.eq("area", scope);
      const { data, error } = await q;
      if (error) return res.status(500).json({ message: error.message });
      const rows = (data || []).map((r: any) => {
        const { jobs, customers, ...rest } = r;
        return {
          ...rest,
          job_number: jobs?.job_number ?? null,
          customer_name: customers?.name ?? null,
        };
      });
      res.json(rows);
    },
  );

  // Upload a rig-up report for a job. Admins, area managers and supervisors
  // only; non-admins may only upload for jobs in their own area.
  app.post(
    "/api/rig-up-reports",
    requireAuth,
    requireRole("admin", "area", "super"),
    async (req: Request, res: Response) => {
      const parsed = createRigUpReportSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      const p = parsed.data;
      const client = supabaseAdmin || supabaseAnon;

      const { data: job, error: jobErr } = await client
        .from("jobs")
        .select("id, area, customer_id, job_number")
        .eq("id", p.job_id)
        .single();
      if (jobErr || !job) return res.status(404).json({ message: "Job not found" });

      const scope = areaScopeOf(req.profile!);
      if (scope && job.area !== scope)
        return res
          .status(403)
          .json({ message: "You can only upload rig-up reports for jobs in your area." });

      const bytes = Buffer.from(p.attachment_base64, "base64");
      const { data, error } = await client
        .from("rig_up_reports")
        .insert({
          job_id: job.id,
          area: job.area,
          customer_id: job.customer_id,
          report_date: p.report_date ?? null,
          title: p.title ?? null,
          notes: p.notes ?? null,
          attachment_base64: p.attachment_base64,
          attachment_name: p.attachment_name,
          attachment_mime: p.attachment_mime ?? "application/octet-stream",
          attachment_size: bytes.length,
          status: "Pending sign-off",
          uploaded_by: req.profile!.id,
          uploaded_by_name: req.profile!.name,
        })
        .select(RIG_UP_LIST_COLS)
        .single();
      if (error) return res.status(400).json({ message: error.message });
      await client.from("rig_up_report_events").insert({
        rig_up_id: data.id,
        actor_id: req.profile!.id,
        actor_name: req.profile!.name,
        actor_role: req.profile!.role,
        action: "uploaded",
        detail: `Uploaded rig-up report for job ${job.job_number} (${job.area}).`,
      });
      res.status(201).json(data);
    },
  );

  // Download a rig-up report's file. Area-scoped like the list.
  app.get(
    "/api/rig-up-reports/:id/attachment",
    requireAuth,
    async (req: Request, res: Response) => {
      const { data, error } = await supabaseAnon
        .from("rig_up_reports")
        .select("area, attachment_name, attachment_mime, attachment_base64")
        .eq("id", req.params.id)
        .single();
      if (error || !data || !(data as any).attachment_base64)
        return res.status(404).json({ message: "Attachment not found" });
      const scope = areaScopeOf(req.profile!);
      if (scope && (data as any).area !== scope)
        return res.status(404).json({ message: "Attachment not found" });
      const buf = Buffer.from((data as any).attachment_base64, "base64");
      res.setHeader(
        "Content-Type",
        (data as any).attachment_mime || "application/octet-stream",
      );
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${((data as any).attachment_name || "rig-up-report").replace(/"/g, "")}"`,
      );
      res.send(buf);
    },
  );

  // Sign off a rig-up report. ONLY an AREA manager whose area matches the job's
  // area may sign off (admins too). Supervisors and field techs cannot.
  app.post(
    "/api/rig-up-reports/:id/sign-off",
    requireAuth,
    requireRole("admin", "area"),
    async (req: Request, res: Response) => {
      const client = supabaseAdmin || supabaseAnon;
      const { data: report, error: rErr } = await client
        .from("rig_up_reports")
        .select(RIG_UP_LIST_COLS)
        .eq("id", req.params.id)
        .single();
      if (rErr || !report)
        return res.status(404).json({ message: "Rig-up report not found" });

      // Area managers may only sign off reports for their own area. (Admins have
      // a null scope and may sign off any area.)
      const scope = areaScopeOf(req.profile!);
      if (scope && report.area !== scope)
        return res.status(403).json({
          message:
            "Only the area manager for this job's area can sign off this rig-up report.",
        });
      if (report.status === "Signed off")
        return res
          .status(409)
          .json({ message: "This rig-up report is already signed off." });

      const now = new Date().toISOString();
      const signer = req.profile!;
      const { data, error } = await client
        .from("rig_up_reports")
        .update({
          status: "Signed off",
          signed_off_by: signer.id,
          signed_off_by_name: signer.name,
          signed_off_at: now,
        })
        .eq("id", report.id)
        .select(RIG_UP_LIST_COLS)
        .single();
      if (error) return res.status(400).json({ message: error.message });
      await client.from("rig_up_report_events").insert({
        rig_up_id: report.id,
        actor_id: signer.id,
        actor_name: signer.name,
        actor_role: signer.role,
        action: "signed_off",
        detail: null,
      });
      res.json(data);
    },
  );

  // Delete a rig-up report. Admin + area (own area only).
  app.delete(
    "/api/rig-up-reports/:id",
    requireAuth,
    requireRole("admin", "area"),
    async (req: Request, res: Response) => {
      const client = supabaseAdmin || supabaseAnon;
      const { data: report, error: rErr } = await client
        .from("rig_up_reports")
        .select("id, area")
        .eq("id", req.params.id)
        .single();
      if (rErr || !report)
        return res.status(404).json({ message: "Rig-up report not found" });
      const scope = areaScopeOf(req.profile!);
      if (scope && report.area !== scope)
        return res.status(404).json({ message: "Rig-up report not found" });
      const { error } = await client
        .from("rig_up_reports")
        .delete()
        .eq("id", report.id);
      if (error) return res.status(400).json({ message: error.message });
      res.status(204).end();
    },
  );

  // ---- Certifications ------------------------------------------------------
  // Columns returned in list/roster payloads. Attachment bytes are deliberately
  // excluded so payloads stay small; they stream from the download endpoint.
  const CERT_LIST_COLS =
    "id, profile_id, cert_type, issuing_org, issue_date, expiry_date, attachment_name, attachment_mime, attachment_size, notes, uploaded_by, created_at";

  // Roster of field employees (area managers, supervisors, field techs) grouped
  // with their certifications. Area-scoped: admins see everyone, area managers &
  // supervisors see only their own area. Field techs see their own area too.
  app.get(
    "/api/certifications",
    requireAuth,
    async (req: Request, res: Response) => {
      const scope = areaScopeOf(req.profile!);

      // Field employees only.
      let pq = supabaseAnon
        .from("profiles")
        .select("id, email, name, role, area, active, created_at")
        .in("role", CERT_ROSTER_ROLES as unknown as string[])
        .eq("active", true)
        .order("name", { ascending: true });
      if (scope) pq = pq.eq("area", scope);
      const { data: people, error: pErr } = await pq;
      if (pErr) return res.status(500).json({ message: pErr.message });

      const ids = (people || []).map((p: any) => p.id);
      let certs: any[] = [];
      if (ids.length) {
        const { data: cdata, error: cErr } = await supabaseAnon
          .from("certifications")
          .select(CERT_LIST_COLS)
          .in("profile_id", ids)
          .order("expiry_date", { ascending: true, nullsFirst: false });
        if (cErr) return res.status(500).json({ message: cErr.message });
        certs = cdata || [];
      }

      // Uploader names for display.
      const uploaderIds = Array.from(
        new Set(certs.map((c) => c.uploaded_by).filter(Boolean)),
      );
      let uploaderNames: Record<string, string> = {};
      if (uploaderIds.length) {
        const { data: us } = await supabaseAnon
          .from("profiles")
          .select("id, name")
          .in("id", uploaderIds);
        for (const u of us || []) uploaderNames[u.id] = u.name;
      }

      const byProfile: Record<string, any[]> = {};
      for (const c of certs) {
        const p = (people || []).find((x: any) => x.id === c.profile_id);
        const enriched = {
          ...c,
          employee_name: p?.name ?? null,
          employee_role: p?.role ?? null,
          employee_area: p?.area ?? null,
          uploaded_by_name: c.uploaded_by
            ? uploaderNames[c.uploaded_by] ?? null
            : null,
        };
        (byProfile[c.profile_id] ||= []).push(enriched);
      }

      const roster = (people || []).map((p: any) => ({
        profile: p,
        certs: byProfile[p.id] || [],
      }));
      res.json(roster);
    },
  );

  // Upload / record a certification for an employee. Admins and area managers
  // only; area managers may only add certs for employees in their own area.
  app.post(
    "/api/certifications",
    requireAuth,
    requireRole("admin", "area"),
    async (req: Request, res: Response) => {
      const parsed = createCertificationSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      const p = parsed.data;
      const client = supabaseAdmin || supabaseAnon;

      // Target employee must exist and be a field-workforce role.
      const { data: emp, error: eErr } = await supabaseAnon
        .from("profiles")
        .select("id, role, area")
        .eq("id", p.profile_id)
        .single();
      if (eErr || !emp)
        return res.status(404).json({ message: "Employee not found" });
      if (!(CERT_ROSTER_ROLES as unknown as string[]).includes(emp.role))
        return res
          .status(400)
          .json({ message: "Certifications apply to field employees only." });

      // Area managers are scoped to their own area.
      const scope = areaScopeOf(req.profile!);
      if (scope && emp.area !== scope)
        return res
          .status(403)
          .json({ message: "You can only manage employees in your area." });

      const row: Record<string, any> = {
        profile_id: p.profile_id,
        cert_type: p.cert_type,
        issuing_org: p.issuing_org ?? null,
        issue_date: p.issue_date ?? null,
        expiry_date: p.expiry_date ?? null,
        notes: p.notes ?? null,
        uploaded_by: req.profile!.id,
      };
      if (p.attachment_base64 && p.attachment_name) {
        const bytes = Buffer.from(p.attachment_base64, "base64");
        row.attachment_base64 = p.attachment_base64;
        row.attachment_name = p.attachment_name;
        row.attachment_mime = p.attachment_mime ?? "application/octet-stream";
        row.attachment_size = bytes.length;
      }

      const { data, error } = await client
        .from("certifications")
        .insert(row)
        .select(CERT_LIST_COLS)
        .single();
      if (error) return res.status(400).json({ message: error.message });
      res.status(201).json(data);
    },
  );

  // Update a certification's metadata (dates, org, notes, type). Admin + area.
  app.patch(
    "/api/certifications/:id",
    requireAuth,
    requireRole("admin", "area"),
    async (req: Request, res: Response) => {
      const parsed = updateCertificationSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      const client = supabaseAdmin || supabaseAnon;

      // Load cert + its employee's area for scoping.
      const { data: existing, error: exErr } = await supabaseAnon
        .from("certifications")
        .select("id, profile_id, profiles:profiles!certifications_profile_id_fkey(area)")
        .eq("id", req.params.id)
        .single();
      if (exErr || !existing)
        return res.status(404).json({ message: "Certification not found" });
      const scope = areaScopeOf(req.profile!);
      const empArea = (existing as any).profiles?.area ?? null;
      if (scope && empArea !== scope)
        return res.status(404).json({ message: "Certification not found" });

      const { data, error } = await client
        .from("certifications")
        .update(parsed.data)
        .eq("id", req.params.id)
        .select(CERT_LIST_COLS)
        .single();
      if (error) return res.status(400).json({ message: error.message });
      res.json(data);
    },
  );

  // Delete a certification. Admin + area (own area only).
  app.delete(
    "/api/certifications/:id",
    requireAuth,
    requireRole("admin", "area"),
    async (req: Request, res: Response) => {
      const client = supabaseAdmin || supabaseAnon;
      const { data: existing, error: exErr } = await supabaseAnon
        .from("certifications")
        .select("id, profiles:profiles!certifications_profile_id_fkey(area)")
        .eq("id", req.params.id)
        .single();
      if (exErr || !existing)
        return res.status(404).json({ message: "Certification not found" });
      const scope = areaScopeOf(req.profile!);
      const empArea = (existing as any).profiles?.area ?? null;
      if (scope && empArea !== scope)
        return res.status(404).json({ message: "Certification not found" });
      const { error } = await client
        .from("certifications")
        .delete()
        .eq("id", req.params.id);
      if (error) return res.status(400).json({ message: error.message });
      res.status(204).end();
    },
  );

  // Download a certification's file. Area-scoped like the roster.
  app.get(
    "/api/certifications/:id/attachment",
    requireAuth,
    async (req: Request, res: Response) => {
      const { data, error } = await supabaseAnon
        .from("certifications")
        .select(
          "attachment_name, attachment_mime, attachment_base64, profiles:profiles!certifications_profile_id_fkey(area)",
        )
        .eq("id", req.params.id)
        .single();
      if (error || !data || !(data as any).attachment_base64)
        return res.status(404).json({ message: "Attachment not found" });
      const scope = areaScopeOf(req.profile!);
      const empArea = (data as any).profiles?.area ?? null;
      if (scope && empArea !== scope)
        return res.status(404).json({ message: "Attachment not found" });
      const buf = Buffer.from((data as any).attachment_base64, "base64");
      res.setHeader(
        "Content-Type",
        (data as any).attachment_mime || "application/octet-stream",
      );
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${((data as any).attachment_name || "certification").replace(/"/g, "")}"`,
      );
      res.send(buf);
    },
  );


  // ====================================================================
  // Pads / Wells / Well stints
  // A job can have multiple pads; each pad has wells; at most one well per
  // pad is Open at a time. Opening a well auto-closes the pad's current open
  // well. Every open/close interval is recorded as a well_stint.
  // Manageable by the whole field workforce plus admins.
  // ====================================================================

  const padClient = () => supabaseAdmin || supabaseAnon;

  // Load a job and enforce area scope; returns the job row or sends 404.
  async function loadScopedJob(req: Request, res: Response, jobId: string | string[]) {
    const jid = Array.isArray(jobId) ? jobId[0] : jobId;
    const { data, error } = await padClient()
      .from("jobs")
      .select("id, area")
      .eq("id", jid)
      .single();
    if (error || !data) {
      res.status(404).json({ message: "Job not found" });
      return null;
    }
    const scope = areaScopeOf(req.profile!);
    if (scope && data.area !== scope) {
      res.status(404).json({ message: "Job not found" });
      return null;
    }
    return data;
  }

  // Is this profile allowed to MANAGE (create/edit/delete) services on a job?
  // Admin and area managers: yes (area already enforced by loadScopedJob).
  // Supervisors: only if assigned to the job. Others: no.
  async function canManageServices(
    req: Request,
    jobId: string,
  ): Promise<boolean> {
    const role = req.profile!.role;
    if (role === "admin" || role === "area") return true;
    if (role !== "super") return false;
    const { data } = await padClient()
      .from("job_assignments")
      .select("id")
      .eq("job_id", jobId)
      .eq("profile_id", req.profile!.id)
      .maybeSingle();
    return !!data;
  }

  // ==== Job services (drive-by / call-out on unmanned jobs) ================

  // Resolve a well selection for a service. Returns { ok, well_name } when the
  // well belongs to this job and is not completed (report-derived status !=
  // "Closed"), or { ok:false, message } to reject. A null/undefined wellId is
  // allowed (service not tied to a specific well) and clears the field.
  async function resolveServiceWell(
    jobId: string,
    wellId: string | null | undefined,
  ): Promise<{ ok: true; well_id: string | null; well_name: string | null } | { ok: false; message: string }> {
    if (wellId === null || wellId === undefined)
      return { ok: true, well_id: null, well_name: null };
    const client = padClient();
    const { data: well } = await client
      .from("wells")
      .select("id, name, job_id")
      .eq("id", wellId)
      .eq("job_id", jobId)
      .maybeSingle();
    if (!well)
      return { ok: false, message: "That well does not belong to this job" };
    // Derived status: a well that already has report activity but is not the
    // current well is "Closed" (completed) and cannot be selected.
    const { byName, currentKey } = await wellReportStats(jobId);
    const key = normWellName(well.name);
    const days = byName.get(key)?.days ?? 0;
    const isCurrent = currentKey != null && key === currentKey;
    if (days > 0 && !isCurrent)
      return { ok: false, message: "That well is already completed" };
    return { ok: true, well_id: well.id, well_name: well.name };
  }

  // List services for a job. Any user who can view the job (area-scoped) can
  // read its services.
  app.get(
    "/api/jobs/:jobId/services",
    requireAuth,
    async (req: Request, res: Response) => {
      const job = await loadScopedJob(req, res, req.params.jobId);
      if (!job) return;
      const { data, error } = await padClient()
        .from("job_services")
        .select("*")
        .eq("job_id", job.id)
        .order("service_date", { ascending: false })
        .order("created_at", { ascending: false });
      if (error) return res.status(500).json({ message: error.message });
      res.json(data || []);
    },
  );

  // Create a service on an UNMANNED job. Only admin/area, or an assigned
  // supervisor, may create. Services are not allowed on manned jobs.
  app.post(
    "/api/jobs/:jobId/services",
    requireAuth,
    requireRole("admin", "area", "super"),
    async (req: Request, res: Response) => {
      const job = await loadScopedJob(req, res, req.params.jobId);
      if (!job) return;
      // Confirm the job is unmanned before allowing service creation.
      const { data: jobRow } = await padClient()
        .from("jobs")
        .select("crewing")
        .eq("id", job.id)
        .single();
      if (!jobRow || jobRow.crewing !== "Unmanned")
        return res.status(400).json({
          message: "Services can only be logged on unmanned jobs",
        });
      if (!(await canManageServices(req, job.id)))
        return res.status(403).json({
          message: "Only an assigned supervisor or a manager can log services",
        });
      const parsed = createJobServiceSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      const wellRes = await resolveServiceWell(job.id, parsed.data.well_id ?? null);
      if (!wellRes.ok)
        return res.status(400).json({ message: wellRes.message });
      const { data, error } = await padClient()
        .from("job_services")
        .insert({
          job_id: job.id,
          area: job.area,
          service_type: parsed.data.service_type,
          service_date: parsed.data.service_date,
          cost: parsed.data.cost ?? null,
          well_id: wellRes.well_id,
          well_name: wellRes.well_name,
          notes: parsed.data.notes?.trim() || null,
          created_by: req.profile!.id,
          created_by_name: req.profile!.name,
        })
        .select()
        .single();
      if (error) return res.status(400).json({ message: error.message });
      res.status(201).json(data);
    },
  );

  // Update a service. Same permissions as create.
  app.patch(
    "/api/jobs/:jobId/services/:serviceId",
    requireAuth,
    requireRole("admin", "area", "super"),
    async (req: Request, res: Response) => {
      const job = await loadScopedJob(req, res, req.params.jobId);
      if (!job) return;
      if (!(await canManageServices(req, job.id)))
        return res.status(403).json({
          message: "Only an assigned supervisor or a manager can edit services",
        });
      const parsed = updateJobServiceSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      const patch: any = {};
      if (parsed.data.service_type !== undefined)
        patch.service_type = parsed.data.service_type;
      if (parsed.data.service_date !== undefined)
        patch.service_date = parsed.data.service_date;
      if (parsed.data.cost !== undefined) patch.cost = parsed.data.cost ?? null;
      if (parsed.data.well_id !== undefined) {
        const wellRes = await resolveServiceWell(job.id, parsed.data.well_id);
        if (!wellRes.ok)
          return res.status(400).json({ message: wellRes.message });
        patch.well_id = wellRes.well_id;
        patch.well_name = wellRes.well_name;
      }
      if (parsed.data.notes !== undefined)
        patch.notes = parsed.data.notes?.trim() || null;
      if (Object.keys(patch).length === 0)
        return res.status(400).json({ message: "Nothing to update" });
      const { data, error } = await padClient()
        .from("job_services")
        .update(patch)
        .eq("id", req.params.serviceId)
        .eq("job_id", job.id)
        .select()
        .single();
      if (error) return res.status(400).json({ message: error.message });
      if (!data) return res.status(404).json({ message: "Service not found" });
      res.json(data);
    },
  );

  // Delete a service. Same permissions as create/edit.
  app.delete(
    "/api/jobs/:jobId/services/:serviceId",
    requireAuth,
    requireRole("admin", "area", "super"),
    async (req: Request, res: Response) => {
      const job = await loadScopedJob(req, res, req.params.jobId);
      if (!job) return;
      if (!(await canManageServices(req, job.id)))
        return res.status(403).json({
          message: "Only an assigned supervisor or a manager can delete services",
        });
      const { error } = await padClient()
        .from("job_services")
        .delete()
        .eq("id", req.params.serviceId)
        .eq("job_id", job.id);
      if (error) return res.status(400).json({ message: error.message });
      res.status(204).end();
    },
  );

  const todayIso = () => new Date().toISOString().slice(0, 10);

  // Normalize a well name for matching (trim + case-insensitive). Report and
  // well-record names should agree, but crews type inconsistently.
  const normWellName = (s: string | null | undefined) =>
    (s ?? "").trim().toLowerCase();
  const reportDay = (r: any): string | null => {
    const d = String(r.report_date || r.received_at || "").slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
  };

  // Summarize a job's daily reports into per-well-name stats used to drive the
  // report-inferred well model (days, first/last report, and which well is the
  // crew's current one = the well on the most recent dated report).
  async function wellReportStats(jobId: string): Promise<{
    byName: Map<string, { days: number; first: string; last: string; display: string }>;
    currentKey: string | null;
  }> {
    const client = padClient();
    const { data: reports } = await client
      .from("daily_reports")
      .select("well_name, report_date, received_at")
      .eq("job_id", jobId);
    const dated: { name: string; day: string }[] = [];
    for (const r of reports ?? []) {
      const day = reportDay(r);
      const name = (r.well_name as string | null) ?? "";
      if (day && name.trim()) dated.push({ name: name.trim(), day });
    }
    dated.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    const byName = new Map<string, { days: number; first: string; last: string; display: string }>();
    for (const { name, day } of dated) {
      const key = normWellName(name);
      const cur = byName.get(key);
      if (cur) {
        cur.days += 1;
        if (day < cur.first) cur.first = day;
        if (day > cur.last) cur.last = day;
      } else {
        byName.set(key, { days: 1, first: day, last: day, display: name!.trim() });
      }
    }
    const last = dated[dated.length - 1];
    return { byName, currentKey: last ? normWellName(last.name) : null };
  }

  // GET all pads for a job, with each pad's wells and their REPORT-DERIVED
  // status/days/revenue. Wells are attached to pads once; their activity is
  // inferred from daily reports (no manual open/close).
  app.get(
    "/api/jobs/:jobId/pads",
    requireAuth,
    async (req: Request, res: Response) => {
      const job = await loadScopedJob(req, res, req.params.jobId);
      if (!job) return;
      const client = padClient();
      const { data: pads, error } = await client
        .from("pads")
        .select("*")
        .eq("job_id", job.id)
        .order("created_at", { ascending: true });
      if (error) return res.status(400).json({ message: error.message });
      const { data: wells } = await client
        .from("wells")
        .select("*")
        .eq("job_id", job.id)
        .order("created_at", { ascending: true });
      // Pull the job's day rate for revenue and the report stats for status.
      const { data: jobRow } = await client
        .from("jobs")
        .select("day_rate")
        .eq("id", job.id)
        .single();
      const dayRate =
        jobRow && jobRow.day_rate != null && !isNaN(Number(jobRow.day_rate))
          ? Number(jobRow.day_rate)
          : null;
      const { byName, currentKey } = await wellReportStats(job.id);
      const wellsByPad = new Map<string, any[]>();
      for (const w of wells ?? []) {
        const key = normWellName(w.name);
        const stat = byName.get(key);
        const days = stat?.days ?? 0;
        const isCurrent = currentKey != null && key === currentKey;
        const status = isCurrent ? "Open" : days > 0 ? "Closed" : "Pending";
        const arr = wellsByPad.get(w.pad_id) ?? [];
        arr.push({
          id: w.id,
          pad_id: w.pad_id,
          job_id: w.job_id,
          name: w.name,
          status,
          report_days: days,
          first_report: stat?.first ?? null,
          last_report: stat?.last ?? null,
          revenue: dayRate != null ? dayRate * days : null,
          is_current: isCurrent,
        });
        wellsByPad.set(w.pad_id, arr);
      }
      const result = (pads ?? []).map((p: any) => ({
        ...p,
        wells: wellsByPad.get(p.id) ?? [],
      }));
      res.json(result);
    },
  );

  // GET well names seen in a job's daily reports that are NOT yet attached to
  // any pad. Drives the "new well detected — start a new pad?" prompt.
  app.get(
    "/api/jobs/:jobId/unassigned-wells",
    requireAuth,
    async (req: Request, res: Response) => {
      const job = await loadScopedJob(req, res, req.params.jobId);
      if (!job) return;
      const client = padClient();
      const { data: wells } = await client
        .from("wells")
        .select("name")
        .eq("job_id", job.id);
      const attached = new Set(
        (wells ?? []).map((w: any) => normWellName(w.name)),
      );
      const { byName, currentKey } = await wellReportStats(job.id);
      const out = Array.from(byName.entries())
        .filter(([key]) => !attached.has(key))
        .map(([key, s]) => ({
          name: s.display,
          report_days: s.days,
          first_report: s.first,
          last_report: s.last,
          is_current: currentKey != null && key === currentKey,
        }))
        .sort((a, b) => (a.last_report! < b.last_report! ? 1 : -1));
      res.json(out);
    },
  );

  // Create a pad (optionally with initial wells) on a job.
  app.post(
    "/api/jobs/:jobId/pads",
    requireAuth,
    requireRole("admin", "area", "super", "field"),
    async (req: Request, res: Response) => {
      const job = await loadScopedJob(req, res, req.params.jobId);
      if (!job) return;
      const parsed = createPadSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      const client = padClient();
      // Pads are generic containers distinguished by the wells inside them, so
      // we assign a plain sequential name ("Pad 1", "Pad 2", ...) rather than a
      // user-typed name. Number from the current pad count on this job.
      const { count: padCount } = await client
        .from("pads")
        .select("id", { count: "exact", head: true })
        .eq("job_id", job.id);
      const padName = `Pad ${(padCount ?? 0) + 1}`;
      const { data: pad, error } = await client
        .from("pads")
        .insert({
          job_id: job.id,
          name: padName,
          status: "Open",
          opened_on: todayIso(),
          created_by: req.profile!.id,
          created_by_name: req.profile!.name,
        })
        .select()
        .single();
      if (error) return res.status(400).json({ message: error.message });
      // Optional initial wells (names only; blanks ignored, de-duplicated).
      const names = Array.from(
        new Set(
          (parsed.data.well_names ?? [])
            .map((n) => n.trim())
            .filter((n) => n.length > 0),
        ),
      );
      let wells: any[] = [];
      if (names.length > 0) {
        const rows = names.map((name) => ({
          pad_id: pad.id,
          job_id: job.id,
          name,
          status: "Pending",
          created_by: req.profile!.id,
          created_by_name: req.profile!.name,
        }));
        const { data: inserted, error: wErr } = await client
          .from("wells")
          .insert(rows)
          .select();
        if (wErr) return res.status(400).json({ message: wErr.message });
        wells = inserted ?? [];
      }
      res.status(201).json({ ...pad, wells: wells.map((w) => ({ ...w, stints: [] })) });
    },
  );

  // Rename a pad. Pads default to auto-numbered labels but can be given a
  // custom name here.
  app.patch(
    "/api/pads/:padId",
    requireAuth,
    requireRole("admin", "area", "super", "field"),
    async (req: Request, res: Response) => {
      const parsed = renamePadSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      const client = padClient();
      // Load the pad to resolve its job, then enforce the caller's scope on it.
      const { data: existing, error: loadErr } = await client
        .from("pads")
        .select("id, job_id")
        .eq("id", req.params.padId)
        .single();
      if (loadErr || !existing)
        return res.status(404).json({ message: "Pad not found" });
      const job = await loadScopedJob(req, res, existing.job_id);
      if (!job) return;
      const { data: pad, error } = await client
        .from("pads")
        .update({ name: parsed.data.name })
        .eq("id", req.params.padId)
        .select()
        .single();
      if (error) return res.status(400).json({ message: error.message });
      res.json(pad);
    },
  );

  // Add a well to a pad.
  app.post(
    "/api/pads/:padId/wells",
    requireAuth,
    requireRole("admin", "area", "super", "field"),
    async (req: Request, res: Response) => {
      const client = padClient();
      const { data: pad, error: pErr } = await client
        .from("pads")
        .select("id, job_id")
        .eq("id", req.params.padId)
        .single();
      if (pErr || !pad)
        return res.status(404).json({ message: "Pad not found" });
      const job = await loadScopedJob(req, res, pad.job_id);
      if (!job) return;
      const parsed = createWellSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      const { data: well, error } = await client
        .from("wells")
        .insert({
          pad_id: pad.id,
          job_id: pad.job_id,
          name: parsed.data.name,
          status: "Pending",
          created_by: req.profile!.id,
          created_by_name: req.profile!.name,
        })
        .select()
        .single();
      if (error) return res.status(400).json({ message: error.message });
      res.status(201).json({ ...well, stints: [] });
    },
  );

  // NOTE: manual well open/close and pad close/reopen routes were removed.
  // Well activity is now inferred from daily reports (see /api/jobs/:jobId/pads
  // and /api/jobs/:jobId/unassigned-wells). Wells are only attached to pads.


  return httpServer;
}
