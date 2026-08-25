// server/app.ts
import express from "express";

// server/routes.ts
import crypto from "node:crypto";

// server/ws-polyfill.ts
import ws from "ws";
var g = globalThis;
if (typeof g.WebSocket === "undefined") {
  g.WebSocket = ws;
}
if (typeof g.WebSocket === "undefined") {
  throw new Error("WebSocket polyfill failed");
}

// server/supabase.ts
import { createClient } from "@supabase/supabase-js";
import { Agent, fetch as undiciFetch } from "undici";
var FALLBACK_SUPABASE_URL = "https://yhrzmxnahkgbqrxfjsyb.supabase.co";
var FALLBACK_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlocnpteG5haGtnYnFyeGZqc3liIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU3Nzk3MTAsImV4cCI6MjEwMTM1NTcxMH0.MOu1wRKZIT-ZX2rcdN7L-a_ycAco-G6R0ltysUUrZpc";
var envUrlRaw = (process.env.SUPABASE_URL || "").trim();
var SUPABASE_URL = envUrlRaw && envUrlRaw.includes(".supabase.co") ? envUrlRaw : FALLBACK_SUPABASE_URL;
var envAnon = (process.env.SUPABASE_ANON_KEY || "").trim();
var ANON_KEY = envAnon.split(".").length === 3 && envAnon.includes("yhrzmxnahkgbqrxfjsyb") ? envAnon : FALLBACK_ANON_KEY;
var SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
if (!SUPABASE_URL || !ANON_KEY) {
  console.warn("[supabase] SUPABASE_URL / SUPABASE_ANON_KEY not set");
}
var hasOutboundProxy = Boolean(
  process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy
);
var directFetch = void 0;
if (hasOutboundProxy) {
  try {
    const agent = new Agent();
    directFetch = ((input, init = {}) => undiciFetch(input, {
      ...init,
      dispatcher: agent
    }));
  } catch {
    directFetch = void 0;
  }
}
var clientOpts = {
  auth: { autoRefreshToken: false, persistSession: false },
  ...directFetch ? { global: { fetch: directFetch } } : {}
};
var supabaseAnon = createClient(SUPABASE_URL, ANON_KEY, clientOpts);
var supabaseAdmin = SERVICE_ROLE_KEY ? createClient(SUPABASE_URL, SERVICE_ROLE_KEY, clientOpts) : null;
var hasAdmin = () => supabaseAdmin !== null;

// server/auth.ts
async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ message: "Not authenticated" });
    const { data, error } = await supabaseAnon.auth.getUser(token);
    if (error || !data.user) {
      return res.status(401).json({ message: "Invalid or expired session" });
    }
    const { data: profile, error: pErr } = await supabaseAnon.from("profiles").select("*").eq("id", data.user.id).single();
    if (pErr || !profile) {
      return res.status(403).json({ message: "No profile found for this account" });
    }
    if (!profile.active) {
      return res.status(403).json({ message: "This account has been deactivated" });
    }
    const mustChange = !!data.user.user_metadata?.must_change_password;
    req.profile = { ...profile, must_change_password: mustChange };
    req.accessToken = token;
    next();
  } catch (e) {
    console.error("[auth] error", e);
    res.status(500).json({ message: "Auth check failed" });
  }
}
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.profile) return res.status(401).json({ message: "Not authenticated" });
    if (!roles.includes(req.profile.role)) {
      return res.status(403).json({ message: "You don't have permission for this action" });
    }
    next();
  };
}
function areaScopeOf(p) {
  if (p.role === "admin") return null;
  return p.area;
}
async function jobScopeOf(p) {
  if (p.role !== "field") return null;
  const { data, error } = await supabaseAnon.from("job_assignments").select("job_id").eq("profile_id", p.id);
  if (error) {
    console.error("[auth] jobScopeOf error", error);
    return [];
  }
  const ids = (data || []).map((r) => r.job_id);
  return ids.length > 0 ? ids : null;
}

// server/email.ts
var RESEND_API_KEY = process.env.RESEND_API_KEY || "";
var FROM = process.env.EMAIL_FROM || "DFS Ops <onboarding@resend.dev>";
async function deliver(to, subject, html) {
  if (!RESEND_API_KEY) {
    console.log(`[email:stub] would send to ${to} \u2014 "${subject}"`);
    return false;
  }
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ from: FROM, to, subject, html })
    });
    if (!r.ok) {
      console.error("[email] send failed", await r.text());
      return false;
    }
    return true;
  } catch (e) {
    console.error("[email] send error", e);
    return false;
  }
}
function emailConfigured() {
  return !!RESEND_API_KEY;
}
async function sendInviteEmail(ctx) {
  const who = ctx.name ? ctx.name : "there";
  const by = ctx.inviterName ? `${ctx.inviterName} has` : "You've been";
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;">
      <h2 style="color:#28251D;margin:0 0 16px;">Welcome to DFS Ops</h2>
      <p style="color:#28251D;font-size:15px;line-height:1.5;">Hi ${who},</p>
      <p style="color:#28251D;font-size:15px;line-height:1.5;">
        ${by} invited to the Drilling Fluid Solutions operations platform.
        Click the button below to set your password and sign in.
      </p>
      <p style="margin:24px 0;">
        <a href="${ctx.link}"
           style="background:#01696F;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:6px;font-size:15px;font-weight:600;display:inline-block;">
          Set your password
        </a>
      </p>
      <p style="color:#7A7974;font-size:13px;line-height:1.5;">
        If the button doesn't work, copy and paste this link into your browser:<br>
        <a href="${ctx.link}" style="color:#01696F;word-break:break-all;">${ctx.link}</a>
      </p>
      <p style="color:#BAB9B4;font-size:12px;margin-top:24px;">Sent by DFS Ops. If you weren't expecting this, you can ignore this email.</p>
    </div>`;
  return deliver(ctx.to, "You're invited to DFS Ops \u2014 set your password", html);
}
async function sendPasswordResetEmail(ctx) {
  const who = ctx.name ? ctx.name : "there";
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;">
      <h2 style="color:#28251D;margin:0 0 16px;">Reset your DFS Ops password</h2>
      <p style="color:#28251D;font-size:15px;line-height:1.5;">Hi ${who},</p>
      <p style="color:#28251D;font-size:15px;line-height:1.5;">
        We received a request to reset the password on your Drilling Fluid
        Solutions operations account. Click the button below to choose a new
        password. This link expires in 1 hour.
      </p>
      <p style="margin:24px 0;">
        <a href="${ctx.link}"
           style="background:#01696F;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:6px;font-size:15px;font-weight:600;display:inline-block;">
          Reset password
        </a>
      </p>
      <p style="color:#7A7974;font-size:13px;line-height:1.5;">
        If the button doesn't work, copy and paste this link into your browser:<br>
        <a href="${ctx.link}" style="color:#01696F;word-break:break-all;">${ctx.link}</a>
      </p>
      <p style="color:#BAB9B4;font-size:12px;margin-top:24px;">If you didn't request this, you can safely ignore this email \u2014 your password won't change.</p>
    </div>`;
  return deliver(ctx.to, "Reset your DFS Ops password", html);
}
async function sendDailyReportChanges(ctx) {
  const who = ctx.senderName ? `${ctx.senderName}` : "there";
  const re = ctx.subject ? `Re: ${ctx.subject}` : "Re: your daily report";
  const dateLine = ctx.reportDate ? ` (${ctx.reportDate})` : "";
  const html = `
    <p>Hi ${who},</p>
    <p><b>${ctx.reviewerName}</b> reviewed your daily report${dateLine} and is requesting some changes:</p>
    <blockquote style="border-left:3px solid #ccc;margin:0;padding:8px 12px;color:#333;white-space:pre-wrap;">${ctx.changeNotes}</blockquote>
    <p>Please update the report and resend. Thanks.</p>
    <p style="color:#888;font-size:12px;">Sent by DFS Ops</p>`;
  return deliver(ctx.to, `Changes requested \u2014 ${re}`, html);
}
async function sendNotificationEmails(kind, ctx) {
  const client = supabaseAdmin || supabaseAnon;
  const { report, asset } = ctx;
  if (kind === "needs_signoff") {
    const { data: mgrs } = await client.from("profiles").select("id,email,name,role,area,active, notification_prefs(on_needs_signoff)").eq("role", "area").eq("area", asset.area).eq("active", true);
    for (const m of mgrs || []) {
      const pref = m.notification_prefs?.[0]?.on_needs_signoff ?? true;
      if (!pref) continue;
      await deliver(
        m.email,
        `Report needs your sign-off \u2014 ${asset.tag}`,
        `<p>A maintenance report on <b>${asset.tag}</b> (${asset.category}, ${asset.area}) needs your sign-off.</p>`
      );
    }
  }
  if (kind === "signed") {
    const { data: sup } = await client.from("profiles").select("id,email,name, notification_prefs(on_signed)").eq("id", report.supervisor_id).single();
    if (sup) {
      const pref = sup.notification_prefs?.[0]?.on_signed ?? true;
      if (pref)
        await deliver(
          sup.email,
          `Your report was signed off \u2014 ${asset.tag}`,
          `<p>Your maintenance report on <b>${asset.tag}</b> was signed off by ${ctx.signerName}.</p>`
        );
    }
  }
}

// server/excelDailyReport.ts
import * as XLSX from "xlsx";
var KPI_CELLS = [
  // Mud properties: label in col B, value in col G.
  { field: "mud_type", cell: "G13", numeric: false },
  { field: "mud_weight_ppg", cell: "G14", numeric: true },
  { field: "lgs_pct", cell: "G15", numeric: true },
  // Retort R.O.C %: labeled row 26 (value cell blank when not run that day).
  { field: "retort_roc_pct", cell: "I26", numeric: true },
  // Fluid recovery & run hours: value in merged cell M (M:P).
  { field: "daily_fluid_recovery_bbl", cell: "M31", numeric: true },
  { field: "total_fluid_recovery_bbl", cell: "M32", numeric: true },
  { field: "daily_run_hours", cell: "M33", numeric: true },
  { field: "total_run_hours", cell: "M34", numeric: true },
  { field: "maintenance_hours", cell: "M35", numeric: true },
  // Additions: value in merged cell H (H:J), Daily column.
  { field: "add_base_diesel_bbl", cell: "H45", numeric: true },
  { field: "add_water_bbl", cell: "H46", numeric: true },
  { field: "add_barite_bbl", cell: "H48", numeric: true },
  { field: "add_chemicals_bbl", cell: "H49", numeric: true },
  // Waste disposal: value in merged cell Q (Q:T).
  { field: "end_dumps_loaded", cell: "Q52", numeric: true },
  { field: "cuttings_volume_bbl", cell: "Q53", numeric: true },
  { field: "vac_trucks", cell: "Q54", numeric: true },
  { field: "liquids_to_disposal_bbl", cell: "Q55", numeric: true }
];
var CONTEXT_CELLS = [
  { field: "operator", cell: "H8" },
  { field: "company_man", cell: "H9" },
  { field: "mud_company", cell: "H10" },
  { field: "mud_engineer", cell: "H11" }
];
var DATE_CELL = "D3";
var WELL_NAME_CELLS = [
  { sheet: "Well Recap", cell: "C4" },
  { sheet: "ROC", cell: "C2" }
];
var RIG_CELL = { sheet: "Well Recap", cell: "C3" };
function rawCell(ws2, addr) {
  if (!ws2) return void 0;
  const c = ws2[addr];
  if (!c) return void 0;
  return c.v;
}
function toNumber(v) {
  if (v === null || v === void 0 || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[, ]/g, ""));
  return Number.isFinite(n) ? n : null;
}
function toText(v) {
  if (v === null || v === void 0) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}
function toDateStr(v) {
  if (v === null || v === void 0 || v === "") return null;
  if (v instanceof Date) {
    return v.toISOString().slice(0, 10);
  }
  if (typeof v === "number") {
    const d = XLSX.SSF ? XLSX.SSF.parse_date_code(v) : null;
    if (d) {
      const mm = String(d.m).padStart(2, "0");
      const dd = String(d.d).padStart(2, "0");
      return `${d.y}-${mm}-${dd}`;
    }
  }
  const s = String(v).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const parsed = new Date(s);
  if (!isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return null;
}
var DEPTH_CELL = "AI9";
function sheetIsCompleted(ws2) {
  if (!ws2) return false;
  return toNumber(rawCell(ws2, DEPTH_CELL)) != null;
}
function reportDaySheets(wb) {
  const out = [];
  let day = 0;
  for (const name of wb.SheetNames) {
    const t = name.trim();
    const isFirst = /^Report Day 1$/i.test(t);
    const isNumbered = /^\d+$/.test(t) && Number(t) >= 2;
    if (!isFirst && !isNumbered) continue;
    day += 1;
    const ws2 = wb.Sheets[name];
    out.push({ day, name, completed: sheetIsCompleted(ws2) });
  }
  return out;
}
var ExcelParseError = class extends Error {
};
function parseDailyReportWorkbook(buf, requestedDay) {
  let wb;
  try {
    wb = XLSX.read(buf, { type: "buffer", cellDates: true });
  } catch (e) {
    throw new ExcelParseError(`Could not read Excel file: ${e?.message ?? e}`);
  }
  const days = reportDaySheets(wb);
  if (days.length === 0)
    throw new ExcelParseError(
      "No daily-report day sheet found in the workbook."
    );
  const completed = days.filter((d) => d.completed);
  let incomplete = false;
  let chosen;
  if (requestedDay) {
    chosen = days.find((d) => d.day === requestedDay);
    if (!chosen)
      throw new ExcelParseError(
        `Report Day ${requestedDay} not found in the workbook.`
      );
    incomplete = !chosen.completed;
  } else if (completed.length > 0) {
    chosen = completed[completed.length - 1];
  } else {
    chosen = days[0];
    incomplete = true;
  }
  const ws2 = wb.Sheets[chosen.name];
  const kpis = {};
  const cellMap = {};
  for (const { field, cell, numeric } of KPI_CELLS) {
    const raw = rawCell(ws2, cell);
    const value = numeric ? toNumber(raw) : toText(raw);
    kpis[field] = value;
    cellMap[field] = { sheet: chosen.name, cell, value: value ?? null };
  }
  const well_context = {};
  for (const { field, cell } of CONTEXT_CELLS) {
    well_context[field] = toText(rawCell(ws2, cell));
  }
  const rigWs = wb.Sheets[RIG_CELL.sheet];
  const rig = toText(rawCell(rigWs, RIG_CELL.cell));
  if (rig) well_context.rig = rig;
  well_context.rig_activity = toText(rawCell(ws2, "AI8"));
  well_context.meas_depth_ft = toNumber(rawCell(ws2, "AI9"));
  well_context.supervisor = toText(rawCell(ws2, "AI11"));
  const report_date = toDateStr(rawCell(ws2, DATE_CELL));
  let well_name = null;
  for (const { sheet, cell } of WELL_NAME_CELLS) {
    const v = toText(rawCell(wb.Sheets[sheet], cell));
    if (v) {
      well_name = v;
      break;
    }
  }
  const dayLabel = `Report Day ${chosen.day}`;
  const summaryBits = [];
  if (kpis.daily_run_hours != null)
    summaryBits.push(`Run hours ${kpis.daily_run_hours}`);
  if (kpis.daily_fluid_recovery_bbl != null)
    summaryBits.push(`Daily fluid recovery ${kpis.daily_fluid_recovery_bbl} bbl`);
  if (kpis.mud_weight_ppg != null)
    summaryBits.push(`Mud wt ${kpis.mud_weight_ppg} ppg`);
  const summary = summaryBits.length > 0 ? `${dayLabel} \u2014 ${summaryBits.join(" \xB7 ")}` : dayLabel;
  return {
    report_date,
    well_name,
    source_sheet: dayLabel,
    report_day: chosen.day,
    incomplete,
    kpis,
    kpi_cell_map: cellMap,
    well_context,
    summary
  };
}

// server/routes.ts
import * as XLSX2 from "xlsx";

// shared/schema.ts
import { z } from "zod";
var ROLES = ["admin", "area", "super", "field"];
var AREAS = ["West Texas", "South Texas", "North Louisiana"];
var CATEGORIES = [
  "Big Bowl Centrifuge",
  "Small Bowl Centrifuge",
  "Excavator",
  "Open Top",
  "Dewatering Unit",
  "Drying Shaker Tank",
  "Pump",
  "VFD",
  "Effluent Tank"
];
var RUN_HOUR_CATEGORIES = [
  "Big Bowl Centrifuge",
  "Small Bowl Centrifuge"
];
var tracksRunHours = (c) => RUN_HOUR_CATEGORIES.includes(c);
var WORK_TYPES = [
  "Preventive",
  "Repair",
  "Inspection",
  "Corrective",
  "General Maintenance"
];
var JOB_STATUS = ["Active", "On Hold", "Completed"];
var CREWING = ["Manned", "Unmanned"];
var SCHEDULE_CADENCE = ["run_hours", "calendar_days"];
var DEFAULT_SERVICE_HOURS_INTERVAL = 250;
var SERVICE_SOON_FRACTION = 0.1;
function serviceStatusFor(a) {
  const interval = a.service_hours_interval ?? DEFAULT_SERVICE_HOURS_INTERVAL;
  if (a.run_hours == null || a.run_hours_at_service == null)
    return { hoursSince: null, interval, state: "No baseline" };
  const hoursSince = Math.max(0, a.run_hours - a.run_hours_at_service);
  let state = "OK";
  if (hoursSince >= interval) state = "Overdue";
  else if (hoursSince >= interval * (1 - SERVICE_SOON_FRACTION)) state = "Soon";
  return { hoursSince, interval, state };
}
var strongPassword = z.string().min(10, "Password must be at least 10 characters").regex(/[A-Za-z]/, "Password must include a letter").regex(/[0-9]/, "Password must include a number");
var createUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  // Default to "password" (admin sets credentials and shares them). Email
  // invites remain supported but are dormant unless an email provider is set up.
  mode: z.enum(["invite", "password"]).default("password"),
  password: strongPassword.optional(),
  // Password mode only: when true, the user must set a new password on first
  // login before they can use the app.
  requirePasswordChange: z.boolean().optional().default(true),
  role: z.enum(ROLES),
  area: z.enum(AREAS).nullable().optional()
});
var changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: strongPassword
});
var updateUserSchema = z.object({
  name: z.string().min(1).optional(),
  role: z.enum(ROLES).optional(),
  area: z.enum(AREAS).nullable().optional(),
  active: z.boolean().optional()
});
var dayRateField = z.union([
  z.null(),
  z.literal("").transform(() => null),
  z.coerce.number().nonnegative()
]).optional();
var createAssetSchema = z.object({
  tag: z.string().min(1),
  category: z.enum(CATEGORIES),
  area: z.enum(AREAS),
  description: z.string().nullable().optional(),
  maintenance_schedule_id: z.string().uuid().nullable().optional(),
  job_or_well: z.string().nullable().optional(),
  status: z.string().optional(),
  run_hours: z.number().int().nonnegative().nullable().optional(),
  service_hours_interval: z.number().int().positive().optional(),
  day_rate: dayRateField
});
var createMaintenanceScheduleSchema = z.object({
  name: z.string().min(1),
  cadence: z.enum(SCHEDULE_CADENCE),
  interval_value: z.number().int().positive(),
  notes: z.string().nullable().optional()
});
var updateMaintenanceScheduleSchema = createMaintenanceScheduleSchema.partial();
var createReportSchema = z.object({
  asset_id: z.string().uuid(),
  work_type: z.enum(WORK_TYPES),
  notes: z.string().nullable().optional(),
  report_date: z.string(),
  run_hours: z.number().int().nonnegative().nullable().optional()
  // updates asset meter
});
var uploadServiceReportSchema = z.object({
  job_id: z.string().uuid(),
  file_name: z.string().min(1, "File name is required"),
  file_mime: z.string().min(1).optional(),
  file_base64: z.string().min(1, "A file is required"),
  notes: z.string().nullable().optional()
});
var uploadMaintenanceFileSchema = z.object({
  file_name: z.string().min(1, "File name is required"),
  file_mime: z.string().min(1).optional(),
  file_base64: z.string().min(1, "A file is required"),
  work_performed: z.string().trim().min(1, "Describe the work performed"),
  notes: z.string().nullable().optional()
});
var createCustomerSchema = z.object({
  name: z.string().min(1),
  primary_contact: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  email: z.string().email().nullable().optional().or(z.literal("")),
  notes: z.string().nullable().optional()
});
var updateCustomerSchema = createCustomerSchema.partial().extend({
  active: z.boolean().optional()
});
var createJobSchema = z.object({
  job_number: z.string().min(1),
  area: z.enum(AREAS),
  customer_id: z.string().uuid(),
  description: z.string().nullable().optional(),
  status: z.enum(JOB_STATUS).optional(),
  crewing: z.enum(CREWING).optional(),
  started_on: z.string().nullable().optional(),
  ended_on: z.string().nullable().optional(),
  day_rate: dayRateField,
  // Well name — used to match emailed Excel daily reports to this job.
  well_name: z.string().nullable().optional(),
  // asset ids to assign to this job on creation
  asset_ids: z.array(z.string().uuid()).optional(),
  // field-tech profile ids assigned to this job on creation. Field techs are
  // scoped to only the jobs they are assigned to (see jobScopeOf on the server).
  field_tech_ids: z.array(z.string().uuid()).optional(),
  // supervisor profile ids assigned to this job on creation. Assigning a
  // supervisor lets them log drive-by / call-out services on unmanned jobs.
  supervisor_ids: z.array(z.string().uuid()).optional()
});
var updateJobSchema = z.object({
  description: z.string().nullable().optional(),
  status: z.enum(JOB_STATUS).optional(),
  crewing: z.enum(CREWING).optional(),
  started_on: z.string().nullable().optional(),
  ended_on: z.string().nullable().optional(),
  day_rate: dayRateField,
  well_name: z.string().nullable().optional(),
  // when present, replaces the full set of field-tech assignments for the job
  field_tech_ids: z.array(z.string().uuid()).optional(),
  // when present, replaces the full set of supervisor assignments for the job
  supervisor_ids: z.array(z.string().uuid()).optional()
});
var SERVICE_TYPES = ["Drive-by Service", "Call-out Service"];
var serviceCostField = z.union([z.number(), z.string()]).nullable().optional().transform((v) => {
  if (v === null || v === void 0 || v === "") return null;
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? n : null;
}).refine((v) => v === null || v >= 0, {
  message: "Cost must be zero or greater"
});
var createJobServiceSchema = z.object({
  service_type: z.enum(SERVICE_TYPES),
  service_date: z.string().min(1, "Service date is required"),
  cost: serviceCostField,
  well_id: z.string().uuid().nullable().optional(),
  notes: z.string().trim().max(2e3).nullable().optional()
});
var updateJobServiceSchema = z.object({
  service_type: z.enum(SERVICE_TYPES).optional(),
  service_date: z.string().min(1).optional(),
  cost: serviceCostField,
  well_id: z.string().uuid().nullable().optional(),
  notes: z.string().trim().max(2e3).nullable().optional()
});
var createPadSchema = z.object({
  // Pad names are auto-assigned server-side as generic sequential labels
  // ("Pad 1", "Pad 2", ...). The wells grouped inside a pad distinguish it, so
  // a caller-supplied name is optional and ignored.
  name: z.string().trim().optional(),
  // Optional wells to create with the pad (names only). Blank entries ignored.
  well_names: z.array(z.string()).optional()
});
var renamePadSchema = z.object({
  name: z.string().trim().min(1, "Pad name is required").max(80)
});
var createWellSchema = z.object({
  name: z.string().trim().min(1, "Well name is required")
});
var openWellSchema = z.object({
  as_of: z.string().nullable().optional()
});
var closeWellSchema = z.object({
  as_of: z.string().nullable().optional()
});
var closePadSchema = z.object({
  as_of: z.string().nullable().optional()
});
var assignDailyReportJobSchema = z.object({
  job_id: z.string().uuid()
});
var updateAssetSchema = z.object({
  tag: z.string().min(1).optional(),
  category: z.enum(CATEGORIES).optional(),
  job_id: z.string().uuid().nullable().optional(),
  status: z.string().optional(),
  job_or_well: z.string().nullable().optional(),
  service_hours_interval: z.number().int().positive().optional(),
  area: z.enum(AREAS).optional(),
  description: z.string().nullable().optional(),
  maintenance_schedule_id: z.string().uuid().nullable().optional(),
  day_rate: dayRateField
});
var amountField = z.union([
  z.null(),
  z.literal("").transform(() => null),
  z.coerce.number().nonnegative()
]).optional();
var lineItemSchema = z.object({
  description: z.string().min(1),
  quantity: z.coerce.number().nonnegative(),
  unit_cost: z.coerce.number().nonnegative()
});
var createFieldTicketSchema = z.object({
  ticket_date: z.string().min(1),
  county: z.string().nullable().optional(),
  well_name: z.string().nullable().optional(),
  po_afe: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  line_items: z.array(lineItemSchema).optional(),
  asset_ids: z.array(z.string().uuid()).optional(),
  amount: amountField,
  comments: z.string().nullable().optional()
});
var updateFieldTicketSchema = createFieldTicketSchema.partial();
var ingestDailyReportSchema = z.object({
  email_message_id: z.string().min(1),
  sender_email: z.string().email(),
  sender_name: z.string().nullable().optional(),
  subject: z.string().nullable().optional(),
  received_at: z.string().optional(),
  // The .xlsx attachment, base64-encoded, exactly as received on the email.
  attachment_base64: z.string().min(1, "Excel attachment (base64) is required"),
  attachment_name: z.string().min(1),
  // Optional: which "Report Day N" sheet to read. Defaults to the latest
  // populated report-day sheet in the workbook.
  report_day: z.number().int().positive().nullable().optional()
});
var reviewDailyReportSchema = z.object({
  action: z.enum(["sign_off", "request_changes"]),
  change_notes: z.string().nullable().optional(),
  // Optional per-centrifuge split of the day's run hours, supplied only when
  // signing off a report whose job has 2+ centrifuges. When omitted, the
  // server auto-applies the full day's hours to a single centrifuge (or none).
  run_hour_allocations: z.array(
    z.object({
      asset_id: z.string().min(1),
      hours: z.number().min(0)
    })
  ).optional()
}).refine(
  (d) => d.action !== "request_changes" || !!(d.change_notes && d.change_notes.trim()),
  { message: "Suggested changes are required when requesting changes.", path: ["change_notes"] }
);
var updateDailyReportConfigSchema = z.object({
  inbox_email: z.string().email().nullable().optional().or(z.literal("")),
  gmail_query: z.string().min(1).optional(),
  active: z.boolean().optional()
});
var ingestJsaSchema = z.object({
  email_message_id: z.string().min(1),
  sender_email: z.string().email(),
  sender_name: z.string().nullable().optional(),
  subject: z.string().nullable().optional(),
  received_at: z.string().optional(),
  jsa_date: z.string().nullable().optional(),
  // The original JSA file (usually a PDF), base64-encoded.
  attachment_base64: z.string().min(1, "JSA attachment (base64) is required"),
  attachment_name: z.string().min(1),
  attachment_mime: z.string().nullable().optional(),
  // Optional override; normally the server parses the job number from subject.
  job_number: z.string().nullable().optional()
});
var assignJsaJobSchema = z.object({
  job_id: z.string().uuid()
});
var CERT_ROSTER_ROLES = ["area", "super", "field"];
var dateOpt = z.union([z.null(), z.literal("").transform(() => null), z.string()]).optional();
var createCertificationSchema = z.object({
  profile_id: z.string().uuid(),
  cert_type: z.string().min(1, "Certification type is required"),
  issuing_org: z.string().nullable().optional(),
  issue_date: dateOpt,
  expiry_date: dateOpt,
  notes: z.string().nullable().optional(),
  attachment_base64: z.string().nullable().optional(),
  attachment_name: z.string().nullable().optional(),
  attachment_mime: z.string().nullable().optional()
});
var updateCertificationSchema = z.object({
  cert_type: z.string().min(1).optional(),
  issuing_org: z.string().nullable().optional(),
  issue_date: dateOpt,
  expiry_date: dateOpt,
  notes: z.string().nullable().optional()
});
var createRigUpReportSchema = z.object({
  job_id: z.string().uuid(),
  report_date: dateOpt,
  title: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  attachment_base64: z.string().min(1, "A rig-up report file is required"),
  attachment_name: z.string().min(1, "A rig-up report file is required"),
  attachment_mime: z.string().nullable().optional()
});
var numOpt = z.union([z.null(), z.literal("").transform(() => null), z.coerce.number()]).optional();
var crewSchema = z.array(
  z.object({
    name: z.string().min(1),
    role: z.string().nullable().optional()
  })
).optional();
var kpisSchema = z.object({
  mud_type: z.string().nullable().optional(),
  mud_weight_ppg: numOpt,
  lgs_pct: numOpt,
  retort_roc_pct: numOpt,
  daily_fluid_recovery_bbl: numOpt,
  total_fluid_recovery_bbl: numOpt,
  daily_run_hours: numOpt,
  total_run_hours: numOpt,
  maintenance_hours: numOpt,
  add_base_diesel_bbl: numOpt,
  add_water_bbl: numOpt,
  add_barite_bbl: numOpt,
  add_chemicals_bbl: numOpt,
  end_dumps_loaded: numOpt,
  cuttings_volume_bbl: numOpt,
  vac_trucks: numOpt,
  liquids_to_disposal_bbl: numOpt
}).partial().optional();
var createFieldDailyReportSchema = z.object({
  report_date: z.string().min(1),
  well_name: z.string().nullable().optional(),
  work_summary: z.string().nullable().optional(),
  crew_hours: numOpt,
  crew: crewSchema,
  asset_ids: z.array(z.string().uuid()).optional(),
  comments: z.string().nullable().optional()
});
var updateFieldDailyReportSchema = createFieldDailyReportSchema.partial();
var jsaStepSchema = z.object({
  step_description: z.string().min(1),
  hazards: z.string().nullable().optional(),
  controls: z.string().nullable().optional()
});
var createJsaSchema = z.object({
  jsa_date: z.string().min(1),
  well_name: z.string().nullable().optional(),
  task_description: z.string().nullable().optional(),
  ppe: z.string().nullable().optional(),
  crew: crewSchema,
  steps: z.array(jsaStepSchema).min(1, "Add at least one job step.")
});
var updateJsaSchema = z.object({
  jsa_date: z.string().min(1).optional(),
  well_name: z.string().nullable().optional(),
  task_description: z.string().nullable().optional(),
  ppe: z.string().nullable().optional(),
  crew: crewSchema,
  steps: z.array(jsaStepSchema).min(1).optional()
});
var signoffSchema = z.object({
  action: z.enum(["sign_off", "request_changes"]),
  change_notes: z.string().nullable().optional()
}).refine(
  (d) => d.action !== "request_changes" || !!(d.change_notes && d.change_notes.trim()),
  { message: "Suggested changes are required when requesting changes.", path: ["change_notes"] }
);
var notifPrefsSchema = z.object({
  on_signed: z.boolean(),
  on_needs_signoff: z.boolean(),
  on_filed: z.boolean()
});
var WORK_ORDER_TYPES = [
  "Preventive",
  "Repair",
  "Inspection",
  "Corrective"
];
var WORK_ORDER_PRIORITIES = ["High", "Medium", "Low"];
var WORK_ORDER_STATUSES = [
  "Scheduled",
  "In Progress",
  "Awaiting Parts",
  "Overdue",
  "Completed"
];
var WORK_ORDER_MANAGE_ROLES = ["admin", "area", "super"];
var createWorkOrderSchema = z.object({
  asset_id: z.string().uuid("Choose an asset"),
  title: z.string().trim().min(1, "A task title is required"),
  wo_type: z.enum(WORK_ORDER_TYPES),
  priority: z.enum(WORK_ORDER_PRIORITIES).default("Medium"),
  status: z.enum(WORK_ORDER_STATUSES).default("Scheduled"),
  assigned_to: z.string().uuid().nullable().optional(),
  due_date: z.string().nullable().optional(),
  est_hours: z.number().nonnegative().nullable().optional(),
  notes: z.string().nullable().optional()
});
var updateWorkOrderSchema = z.object({
  title: z.string().trim().min(1).optional(),
  wo_type: z.enum(WORK_ORDER_TYPES).optional(),
  priority: z.enum(WORK_ORDER_PRIORITIES).optional(),
  status: z.enum(WORK_ORDER_STATUSES).optional(),
  assigned_to: z.string().uuid().nullable().optional(),
  due_date: z.string().nullable().optional(),
  est_hours: z.number().nonnegative().nullable().optional(),
  notes: z.string().nullable().optional()
});

// server/routes.ts
var INGEST_TOKEN = process.env.INGEST_TOKEN || "";
async function registerRoutes(httpServer, app) {
  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      adminReady: hasAdmin(),
      emailReady: emailConfigured(),
      time: (/* @__PURE__ */ new Date()).toISOString()
    });
  });
  app.post("/api/auth/login", async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password)
      return res.status(400).json({ message: "Email and password required" });
    const { data, error } = await supabaseAnon.auth.signInWithPassword({
      email,
      password
    });
    if (error || !data.session) {
      return res.status(401).json({ message: "Invalid email or password" });
    }
    const { data: profile } = await supabaseAnon.from("profiles").select("*").eq("id", data.user.id).single();
    if (!profile)
      return res.status(403).json({ message: "No profile for this account" });
    if (!profile.active)
      return res.status(403).json({ message: "Account deactivated" });
    const mustChange = !!data.user?.user_metadata?.must_change_password;
    res.json({
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      profile: { ...profile, must_change_password: mustChange }
    });
  });
  function genTempPassword() {
    const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
    const lower = "abcdefghijkmnpqrstuvwxyz";
    const digits = "23456789";
    const all = upper + lower + digits;
    const pick = (set) => set[crypto.randomInt(0, set.length)];
    const chars = [pick(upper), pick(lower), pick(digits), pick(digits)];
    while (chars.length < 12) chars.push(pick(all));
    for (let i = chars.length - 1; i > 0; i--) {
      const j = crypto.randomInt(0, i + 1);
      [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    return chars.join("");
  }
  function signInvite(payload) {
    const secret = process.env.SUPABASE_SERVICE_ROLE_KEY || "dfs-invite-fallback-secret";
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const sig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
    return `${body}.${sig}`;
  }
  function verifyInvite(token) {
    const secret = process.env.SUPABASE_SERVICE_ROLE_KEY || "dfs-invite-fallback-secret";
    const parts = (token || "").split(".");
    if (parts.length !== 2) return { error: "This invite link is malformed." };
    const [body, sig] = parts;
    const expected = crypto.createHmac("sha256", secret).update(body).digest("base64url");
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b))
      return { error: "This invite link is invalid." };
    let payload;
    try {
      payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
      return { error: "This invite link is malformed." };
    }
    if (!payload.exp || Date.now() > payload.exp)
      return { error: "This invite link has expired. Ask your admin to resend it." };
    return { uid: payload.uid, email: payload.email };
  }
  app.post("/api/invite/verify", async (req, res) => {
    const v = verifyInvite((req.body || {}).token);
    if ("error" in v) return res.status(400).json({ message: v.error });
    if (!supabaseAdmin)
      return res.status(503).json({ message: "Service unavailable." });
    const { data: profile } = await supabaseAdmin.from("profiles").select("email,name").eq("id", v.uid).single();
    res.json({ email: v.email, name: profile?.name ?? null });
  });
  app.post("/api/invite/complete", async (req, res) => {
    const { token, password } = req.body || {};
    const v = verifyInvite(token);
    if ("error" in v) return res.status(400).json({ message: v.error });
    if (typeof password !== "string" || password.length < 10 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
      return res.status(400).json({
        message: "Password must be at least 10 characters and include a letter and a number."
      });
    }
    if (!supabaseAdmin)
      return res.status(503).json({ message: "Service unavailable." });
    const { error: uErr } = await supabaseAdmin.auth.admin.updateUserById(v.uid, {
      password,
      email_confirm: true
    });
    if (uErr) return res.status(400).json({ message: uErr.message });
    const { data: signIn, error: sErr } = await supabaseAnon.auth.signInWithPassword({
      email: v.email,
      password
    });
    if (sErr || !signIn.session) {
      return res.json({ passwordSet: true, session: null });
    }
    const { data: profile } = await supabaseAnon.from("profiles").select("*").eq("id", v.uid).single();
    res.json({
      passwordSet: true,
      access_token: signIn.session.access_token,
      refresh_token: signIn.session.refresh_token,
      profile
    });
  });
  app.post("/api/auth/forgot-password", async (req, res) => {
    const email = String((req.body || {}).email || "").trim().toLowerCase();
    const emailEnabled = emailConfigured();
    const ok = () => res.json({ ok: true, emailEnabled });
    if (!email || !emailEnabled || !supabaseAdmin) return ok();
    try {
      const { data: profile } = await supabaseAdmin.from("profiles").select("id,email,name,active").eq("email", email).single();
      if (!profile || !profile.active) return ok();
      const appUrl = (process.env.APP_URL || "").trim() || `${req.protocol}://${req.get("host")}` || "https://dfs-ops-platform.vercel.app";
      const token = signInvite({
        uid: profile.id,
        email: profile.email,
        exp: Date.now() + 60 * 60 * 1e3
      });
      const link = `${appUrl.replace(/\/$/, "")}/#/set-password?token=${encodeURIComponent(token)}`;
      await sendPasswordResetEmail({ to: profile.email, name: profile.name, link });
    } catch (e) {
      console.error("[forgot-password] error", e);
    }
    return ok();
  });
  app.get("/api/me", requireAuth, async (req, res) => {
    const { data: prefs } = await supabaseAnon.from("notification_prefs").select("*").eq("user_id", req.profile.id).single();
    res.json({ profile: req.profile, prefs: prefs || null });
  });
  app.post(
    "/api/account/change-password",
    requireAuth,
    async (req, res) => {
      const parsed = changePasswordSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      const { currentPassword, newPassword } = parsed.data;
      const me = req.profile;
      if (currentPassword === newPassword)
        return res.status(400).json({ message: "Your new password must be different from the current one." });
      const { data: signIn, error: sErr } = await supabaseAnon.auth.signInWithPassword({
        email: me.email,
        password: currentPassword
      });
      if (sErr || !signIn.session) {
        return res.status(400).json({ message: "Your current password is incorrect." });
      }
      if (supabaseAdmin) {
        const { error: uErr } = await supabaseAdmin.auth.admin.updateUserById(me.id, {
          password: newPassword,
          user_metadata: {
            name: me.name,
            must_change_password: false
          }
        });
        if (uErr) return res.status(400).json({ message: uErr.message });
      } else {
        const { error: uErr } = await supabaseAnon.auth.updateUser(
          { password: newPassword },
          {
            /* uses the session from signIn above */
          }
        );
        if (uErr) return res.status(400).json({ message: uErr.message });
      }
      res.json({ changed: true });
    }
  );
  app.get(
    "/api/notifications",
    requireAuth,
    async (req, res) => {
      const scope = areaScopeOf(req.profile);
      const role = req.profile.role;
      const canReview = role === "admin" || role === "area" || role === "super";
      const client = supabaseAnon;
      const now = Date.now();
      const DAY = 24 * 60 * 60 * 1e3;
      const SIGNOFF_OVERDUE_DAYS = 2;
      const items = [];
      const myId = req.profile.id;
      const myEmail = (req.profile.email || "").toLowerCase();
      let aq = client.from("assets").select("id, tag, category, area, run_hours, run_hours_at_service, service_hours_interval").in("category", RUN_HOUR_CATEGORIES);
      if (scope) aq = aq.eq("area", scope);
      const { data: assetsData, error: aErr } = await aq;
      if (aErr) console.error("[notifications] assets", aErr.message);
      for (const a of assetsData || []) {
        const { state } = serviceStatusFor(a);
        if (state === "Overdue" || state === "Soon") {
          items.push({
            id: `maint-${a.id}`,
            type: "maintenance_due",
            severity: state === "Overdue" ? "warning" : "info",
            title: state === "Overdue" ? `${a.tag} is overdue for service` : `${a.tag} is due for service soon`,
            detail: `${a.category}${a.area ? ` \xB7 ${a.area}` : ""}`,
            href: `/service`,
            ts: null
          });
        }
      }
      if (canReview) {
        let dq = client.from("daily_reports").select(
          "id, status, area, well_name, sender_name, sender_email, report_date, received_at"
        ).in("status", ["Pending Review", "Needs job match"]);
        if (scope) dq = dq.eq("area", scope);
        const { data: drData, error: dErr } = await dq;
        if (dErr) console.error("[notifications] daily_reports", dErr.message);
        for (const r of drData || []) {
          const who = r.sender_name || r.sender_email || "Unknown sender";
          const well = r.well_name ? ` \xB7 ${r.well_name}` : "";
          if (r.status === "Needs job match") {
            items.push({
              id: `newrep-${r.id}`,
              type: "new_report",
              severity: "info",
              title: `New report needs a job match`,
              detail: `${who}${well}${r.area ? ` \xB7 ${r.area}` : ""}`,
              href: `/daily-reports/${r.id}`,
              ts: r.received_at || r.report_date || null
            });
          } else {
            const basis = r.report_date || r.received_at;
            const ageDays = basis ? (now - new Date(basis).getTime()) / DAY : 0;
            const overdue = ageDays >= SIGNOFF_OVERDUE_DAYS;
            items.push({
              id: `signoff-${r.id}`,
              type: overdue ? "signoff_overdue" : "signoff_pending",
              severity: overdue ? "warning" : "info",
              title: overdue ? `Sign-off overdue (${Math.floor(ageDays)}d)` : `Report awaiting sign-off`,
              detail: `${who}${well}${r.area ? ` \xB7 ${r.area}` : ""}`,
              href: `/daily-reports/${r.id}`,
              ts: basis || null
            });
          }
        }
      }
      {
        const orFilter = myEmail ? `submitted_by.eq.${myId},sender_email.ilike.${myEmail}` : `submitted_by.eq.${myId}`;
        const { data: crReports, error: crErr } = await client.from("daily_reports").select(
          "id, well_name, area, report_date, received_at, change_notes, reviewed_by_name, reviewed_at"
        ).eq("status", "Changes requested").or(orFilter);
        if (crErr) console.error("[notifications] changes_requested reports", crErr.message);
        for (const r of crReports || []) {
          const well = r.well_name ? ` \xB7 ${r.well_name}` : "";
          const by = r.reviewed_by_name ? ` by ${r.reviewed_by_name}` : "";
          const note = (r.change_notes || "").trim();
          items.push({
            id: `cr-report-${r.id}`,
            type: "changes_requested",
            severity: "warning",
            title: `Changes requested on your report${by}`,
            detail: note ? note : `${well ? well.slice(3) : "Daily report"}${r.area ? ` \xB7 ${r.area}` : ""}`,
            href: `/daily-reports/${r.id}`,
            ts: r.reviewed_at || r.received_at || r.report_date || null
          });
        }
        const { data: crJsas, error: crjErr } = await client.from("jsas").select(
          "id, job_id, jsa_number, well_name, change_notes, created_at"
        ).eq("status", "Changes requested").eq("submitted_by", myId);
        if (crjErr) console.error("[notifications] changes_requested jsas", crjErr.message);
        for (const j of crJsas || []) {
          const well = j.well_name ? ` \xB7 ${j.well_name}` : "";
          const note = (j.change_notes || "").trim();
          items.push({
            id: `cr-jsa-${j.id}`,
            type: "changes_requested",
            severity: "warning",
            title: `Changes requested on your JSA #${j.jsa_number}`,
            detail: note ? note : `JSA #${j.jsa_number}${well}`,
            href: `/jobs/${j.job_id}`,
            ts: j.created_at || null
          });
        }
      }
      items.sort((x, y) => {
        if (x.severity !== y.severity) return x.severity === "warning" ? -1 : 1;
        const tx = x.ts ? new Date(x.ts).getTime() : 0;
        const ty = y.ts ? new Date(y.ts).getTime() : 0;
        return ty - tx;
      });
      res.json({
        count: items.length,
        warning_count: items.filter((i) => i.severity === "warning").length,
        items
      });
    }
  );
  app.get(
    "/api/audit-trail",
    requireAuth,
    async (req, res) => {
      const client = supabaseAnon;
      const profile = req.profile;
      const scope = areaScopeOf(profile);
      const role = profile.role;
      const canSeeAll = role === "admin" || role === "area" || role === "super";
      const entries = [];
      const ACTION_LABELS = {
        ingested: "Report ingested",
        matched: "Matched to job",
        signed_off: "Signed off",
        changes_requested: "Changes requested",
        reopened: "Reopened",
        submitted: "Submitted",
        received: "Received",
        Filed: "Service report filed",
        filed: "Service report filed"
      };
      const labelFor = (a) => ACTION_LABELS[a] || a;
      {
        const { data: evs, error } = await client.from("daily_report_events").select("id, report_id, actor_id, actor_name, actor_role, action, detail, occurred_at").order("occurred_at", { ascending: false }).limit(500);
        if (error) console.error("[audit-trail] daily_report_events", error.message);
        const ids = Array.from(new Set((evs || []).map((e) => e.report_id).filter(Boolean)));
        const ctx = {};
        if (ids.length) {
          const { data: reps } = await client.from("daily_reports").select("id, area, well_name, report_date").in("id", ids);
          for (const r of reps || []) {
            ctx[r.id] = {
              area: r.area ?? null,
              label: r.well_name || (r.report_date ? `Report ${r.report_date}` : "Daily report")
            };
          }
        }
        for (const e of evs || []) {
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
            occurred_at: e.occurred_at ?? null
          });
        }
      }
      {
        const { data: evs, error } = await client.from("jsa_report_events").select("id, jsa_id, actor_id, actor_name, actor_role, action, detail, occurred_at").order("occurred_at", { ascending: false }).limit(500);
        if (error) console.error("[audit-trail] jsa_report_events", error.message);
        const ids = Array.from(new Set((evs || []).map((e) => e.jsa_id).filter(Boolean)));
        const ctx = {};
        if (ids.length) {
          const { data: rows } = await client.from("jsa_reports").select("id, area, subject, jsa_date").in("id", ids);
          for (const r of rows || []) {
            ctx[r.id] = {
              area: r.area ?? null,
              label: r.subject || (r.jsa_date ? `JSA ${r.jsa_date}` : "JSA")
            };
          }
        }
        for (const e of evs || []) {
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
            occurred_at: e.occurred_at ?? null
          });
        }
      }
      {
        const { data: evs, error } = await client.from("rig_up_report_events").select("id, rig_up_id, actor_id, actor_name, actor_role, action, detail, occurred_at").order("occurred_at", { ascending: false }).limit(500);
        if (error) console.error("[audit-trail] rig_up_report_events", error.message);
        const ids = Array.from(new Set((evs || []).map((e) => e.rig_up_id).filter(Boolean)));
        const ctx = {};
        if (ids.length) {
          const { data: rows } = await client.from("rig_up_reports").select("id, area, title, report_date").in("id", ids);
          for (const r of rows || []) {
            ctx[r.id] = {
              area: r.area ?? null,
              label: r.title || (r.report_date ? `Rig-up ${r.report_date}` : "Rig-up report")
            };
          }
        }
        for (const e of evs || []) {
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
            occurred_at: e.occurred_at ?? null
          });
        }
      }
      {
        const { data: evs, error } = await client.from("audit_events").select("id, report_id, asset_id, actor_id, actor_name, actor_role, action, occurred_at").order("occurred_at", { ascending: false }).limit(500);
        if (error) console.error("[audit-trail] audit_events", error.message);
        const ids = Array.from(new Set((evs || []).map((e) => e.asset_id).filter(Boolean)));
        const ctx = {};
        if (ids.length) {
          const { data: rows } = await client.from("assets").select("id, area, tag, category").in("id", ids);
          for (const r of rows || []) {
            ctx[r.id] = {
              area: r.area ?? null,
              label: r.tag ? `${r.tag}${r.category ? ` \xB7 ${r.category}` : ""}` : "Asset"
            };
          }
        }
        for (const e of evs || []) {
          const c = e.asset_id && ctx[e.asset_id] || { area: null, label: "Service report" };
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
            occurred_at: e.occurred_at ?? null
          });
        }
      }
      let visible = entries;
      if (!canSeeAll) {
        visible = visible.filter((e) => e.actor_id === profile.id);
      } else if (scope) {
        visible = visible.filter((e) => !e.area || e.area === scope);
      }
      const q = req.query.q?.trim().toLowerCase();
      const entityFilter = req.query.entity;
      const actionFilter = req.query.action;
      const actorFilter = req.query.actor;
      const from = req.query.from;
      const to = req.query.to;
      if (entityFilter && entityFilter !== "all")
        visible = visible.filter((e) => e.entity === entityFilter);
      if (actionFilter && actionFilter !== "all")
        visible = visible.filter((e) => e.action === actionFilter);
      if (actorFilter && actorFilter !== "all")
        visible = visible.filter((e) => (e.actor_name || "") === actorFilter);
      if (from) {
        const t = (/* @__PURE__ */ new Date(from + "T00:00:00")).getTime();
        visible = visible.filter((e) => e.occurred_at && new Date(e.occurred_at).getTime() >= t);
      }
      if (to) {
        const t = (/* @__PURE__ */ new Date(to + "T23:59:59")).getTime();
        visible = visible.filter((e) => e.occurred_at && new Date(e.occurred_at).getTime() <= t);
      }
      if (q) {
        visible = visible.filter(
          (e) => [e.actor_name, e.action, e.detail, e.entity_label, e.area].filter(Boolean).some((f) => String(f).toLowerCase().includes(q))
        );
      }
      visible.sort((a, b) => {
        const ta = a.occurred_at ? new Date(a.occurred_at).getTime() : 0;
        const tb = b.occurred_at ? new Date(b.occurred_at).getTime() : 0;
        return tb - ta;
      });
      const accessScoped = canSeeAll ? scope ? entries.filter((e) => !e.area || e.area === scope) : entries : entries.filter((e) => e.actor_id === profile.id);
      const actions = Array.from(new Set(accessScoped.map((e) => e.action))).sort();
      const actors = Array.from(
        new Set(accessScoped.map((e) => e.actor_name).filter(Boolean))
      ).sort();
      const total = visible.length;
      const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "50"), 10) || 50, 1), 200);
      const offset = Math.max(parseInt(String(req.query.offset ?? "0"), 10) || 0, 0);
      const page = visible.slice(offset, offset + limit);
      res.json({
        total,
        limit,
        offset,
        items: page,
        facets: { actions, actors }
      });
    }
  );
  app.get(
    "/api/users",
    requireAuth,
    requireRole("admin"),
    async (_req, res) => {
      const { data, error } = await supabaseAnon.from("profiles").select("*").order("created_at", { ascending: true });
      if (error) return res.status(500).json({ message: error.message });
      res.json(data);
    }
  );
  app.post(
    "/api/users",
    requireAuth,
    requireRole("admin"),
    async (req, res) => {
      const parsed = createUserSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      if (!hasAdmin() || !supabaseAdmin) {
        return res.status(503).json({
          message: "Account creation is not enabled yet. The service role key must be configured in the deployment environment."
        });
      }
      const { email, name, mode, password, role, area, requirePasswordChange } = parsed.data;
      if (mode === "password" && !password) {
        return res.status(400).json({ message: "A password is required when setting one manually." });
      }
      if (mode === "invite" && !emailConfigured()) {
        return res.status(400).json({
          message: "Email invites aren't enabled yet (no email provider configured). Set a password manually instead, or configure email delivery."
        });
      }
      const mustChange = mode === "password" && requirePasswordChange !== false;
      const { data: created, error: cErr } = await supabaseAdmin.auth.admin.createUser({
        email,
        ...mode === "password" ? { password } : {},
        email_confirm: true,
        user_metadata: { name, ...mustChange ? { must_change_password: true } : {} }
      });
      if (cErr || !created.user)
        return res.status(400).json({ message: cErr?.message || "Could not create user" });
      const { data: profile, error: pErr } = await supabaseAdmin.from("profiles").insert({
        id: created.user.id,
        email,
        name,
        role,
        area: role === "admin" ? null : area ?? null,
        active: true
      }).select().single();
      if (pErr) {
        await supabaseAdmin.auth.admin.deleteUser(created.user.id);
        return res.status(400).json({ message: pErr.message });
      }
      await supabaseAdmin.from("notification_prefs").insert({
        user_id: created.user.id,
        on_signed: true,
        on_needs_signoff: role === "area",
        on_filed: false
      });
      let invited = false;
      if (mode === "invite") {
        const appUrl = (process.env.APP_URL || "").trim() || `${req.protocol}://${req.get("host")}` || "https://dfs-ops-platform.vercel.app";
        const token = signInvite({
          uid: created.user.id,
          email,
          exp: Date.now() + 7 * 24 * 60 * 60 * 1e3
        });
        const link = `${appUrl.replace(/\/$/, "")}/#/set-password?token=${encodeURIComponent(token)}`;
        invited = await sendInviteEmail({
          to: email,
          name,
          inviterName: req.profile?.name ?? null,
          link
        });
      }
      res.status(201).json({ ...profile, invited });
    }
  );
  app.post(
    "/api/users/:id/resend-invite",
    requireAuth,
    requireRole("admin"),
    async (req, res) => {
      if (!hasAdmin() || !supabaseAdmin) {
        return res.status(503).json({
          message: "Account management is not enabled yet. The service role key must be configured in the deployment environment."
        });
      }
      if (!emailConfigured()) {
        return res.status(400).json({
          message: "Email isn't enabled yet (no email provider configured), so invites can't be sent. Set a password for this user instead."
        });
      }
      const { data: profile, error: pErr } = await supabaseAdmin.from("profiles").select("id,email,name").eq("id", req.params.id).single();
      if (pErr || !profile)
        return res.status(404).json({ message: "User not found" });
      const appUrl = (process.env.APP_URL || "").trim() || `${req.protocol}://${req.get("host")}` || "https://dfs-ops-platform.vercel.app";
      const token = signInvite({
        uid: profile.id,
        email: profile.email,
        exp: Date.now() + 7 * 24 * 60 * 60 * 1e3
      });
      const link = `${appUrl.replace(/\/$/, "")}/#/set-password?token=${encodeURIComponent(token)}`;
      const sent = await sendInviteEmail({
        to: profile.email,
        name: profile.name,
        inviterName: req.profile?.name ?? null,
        link
      });
      if (!sent) {
        return res.status(502).json({
          message: "The invite email could not be delivered. Check the email provider configuration."
        });
      }
      res.json({ sent: true, email: profile.email });
    }
  );
  app.post(
    "/api/users/:id/reset-password",
    requireAuth,
    requireRole("admin"),
    async (req, res) => {
      if (!hasAdmin() || !supabaseAdmin) {
        return res.status(503).json({
          message: "Account management is not enabled yet. The service role key must be configured in the deployment environment."
        });
      }
      const { data: profile, error: pErr } = await supabaseAdmin.from("profiles").select("id,email,name").eq("id", req.params.id).single();
      if (pErr || !profile)
        return res.status(404).json({ message: "User not found" });
      const temp = genTempPassword();
      const { error: uErr } = await supabaseAdmin.auth.admin.updateUserById(profile.id, {
        password: temp,
        user_metadata: { name: profile.name, must_change_password: true }
      });
      if (uErr) return res.status(400).json({ message: uErr.message });
      res.json({ reset: true, email: profile.email, temporaryPassword: temp });
    }
  );
  app.patch(
    "/api/users/:id",
    requireAuth,
    requireRole("admin"),
    async (req, res) => {
      const parsed = updateUserSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      const client = supabaseAdmin || supabaseAnon;
      const { data, error } = await client.from("profiles").update(parsed.data).eq("id", req.params.id).select().single();
      if (error) return res.status(400).json({ message: error.message });
      res.json(data);
    }
  );
  app.get("/api/customers", requireAuth, async (_req, res) => {
    const { data, error } = await supabaseAnon.from("customers").select("*").order("name");
    if (error) return res.status(500).json({ message: error.message });
    res.json(data);
  });
  app.get("/api/customers/:id", requireAuth, async (req, res) => {
    const { data, error } = await supabaseAnon.from("customers").select("*").eq("id", req.params.id).single();
    if (error || !data)
      return res.status(404).json({ message: "Customer not found" });
    res.json(data);
  });
  app.post(
    "/api/customers",
    requireAuth,
    requireRole("admin", "area"),
    async (req, res) => {
      const parsed = createCustomerSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      const client = supabaseAdmin || supabaseAnon;
      const payload = {
        ...parsed.data,
        email: parsed.data.email === "" ? null : parsed.data.email
      };
      const { data, error } = await client.from("customers").insert(payload).select().single();
      if (error) return res.status(400).json({ message: error.message });
      res.status(201).json(data);
    }
  );
  app.patch(
    "/api/customers/:id",
    requireAuth,
    requireRole("admin", "area"),
    async (req, res) => {
      const parsed = updateCustomerSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      const client = supabaseAdmin || supabaseAnon;
      const patch = { ...parsed.data };
      if (patch.email === "") patch.email = null;
      const { data, error } = await client.from("customers").update(patch).eq("id", req.params.id).select().single();
      if (error) return res.status(400).json({ message: error.message });
      res.json(data);
    }
  );
  app.get("/api/jobs", requireAuth, async (req, res) => {
    const scope = areaScopeOf(req.profile);
    const jobIds = await jobScopeOf(req.profile);
    const onlyArchived = String(req.query.archived || "") === "true";
    const includeArchived = onlyArchived || String(req.query.include_archived || "") === "true";
    let q = supabaseAnon.from("jobs").select("*, customer:customers(name)").order("created_at", { ascending: false });
    if (scope) q = q.eq("area", scope);
    if (jobIds) q = q.in("id", jobIds);
    if (onlyArchived) q = q.not("archived_at", "is", null);
    else if (!includeArchived) q = q.is("archived_at", null);
    const { data, error } = await q;
    if (error) return res.status(500).json({ message: error.message });
    const rows = (data || []).map((j) => ({
      ...j,
      customer_name: j.customer?.name ?? "",
      customer: void 0
    }));
    res.json(rows);
  });
  app.get("/api/jobs/:id", requireAuth, async (req, res) => {
    const { data, error } = await supabaseAnon.from("jobs").select("*, customer:customers(name)").eq("id", req.params.id).single();
    if (error || !data)
      return res.status(404).json({ message: "Job not found" });
    const scope = areaScopeOf(req.profile);
    if (scope && data.area !== scope)
      return res.status(404).json({ message: "Job not found" });
    const jobIds = await jobScopeOf(req.profile);
    if (jobIds && !jobIds.includes(data.id))
      return res.status(404).json({ message: "Job not found" });
    const { customer, ...rest } = data;
    const { data: assigns } = await supabaseAnon.from("job_assignments").select("profile_id, profile:profiles!job_assignments_profile_id_fkey(name,role)").eq("job_id", data.id);
    const assignments = (assigns || []).map((a) => ({
      profile_id: a.profile_id,
      profile_name: a.profile?.name ?? null,
      profile_role: a.profile?.role ?? null
    }));
    res.json({
      ...rest,
      customer_name: customer?.name ?? "",
      field_tech_ids: assignments.map((a) => a.profile_id),
      assignments
    });
  });
  app.get(
    "/api/field-techs",
    requireAuth,
    requireRole("admin", "area", "super"),
    async (req, res) => {
      const areaParam = String(req.query.area || "").trim();
      const scope = areaScopeOf(req.profile);
      const area = areaParam || scope || null;
      let q = supabaseAnon.from("profiles").select("id, name, role, area").eq("role", "field").eq("active", true).order("name", { ascending: true });
      if (scope) q = q.eq("area", scope);
      else if (area) q = q.eq("area", area);
      const { data, error } = await q;
      if (error) return res.status(500).json({ message: error.message });
      res.json(data || []);
    }
  );
  app.get(
    "/api/supervisors",
    requireAuth,
    requireRole("admin", "area", "super"),
    async (req, res) => {
      const areaParam = String(req.query.area || "").trim();
      const scope = areaScopeOf(req.profile);
      const area = areaParam || scope || null;
      let q = supabaseAnon.from("profiles").select("id, name, role, area").eq("role", "super").eq("active", true).order("name", { ascending: true });
      if (scope) q = q.eq("area", scope);
      else if (area) q = q.eq("area", area);
      const { data, error } = await q;
      if (error) return res.status(500).json({ message: error.message });
      res.json(data || []);
    }
  );
  const syncJobAssignmentsForRole = async (client, jobId, jobArea, role, profileIds, assignedBy) => {
    let eligible = [];
    if (profileIds.length > 0) {
      const { data: people } = await client.from("profiles").select("id").in("id", profileIds).eq("role", role).eq("active", true).eq("area", jobArea);
      eligible = (people || []).map((t) => t.id);
    }
    const { data: existing } = await client.from("job_assignments").select("profile_id, profile:profiles!job_assignments_profile_id_fkey(role)").eq("job_id", jobId);
    const roleRowIds = (existing || []).filter((a) => a.profile?.role === role).map((a) => a.profile_id);
    if (roleRowIds.length > 0) {
      const { error: delErr } = await client.from("job_assignments").delete().eq("job_id", jobId).in("profile_id", roleRowIds);
      if (delErr) return delErr.message;
    }
    if (eligible.length > 0) {
      const rows = eligible.map((pid) => ({
        job_id: jobId,
        profile_id: pid,
        assigned_by: assignedBy
      }));
      const { error: insErr } = await client.from("job_assignments").insert(rows);
      if (insErr) return insErr.message;
    }
    return null;
  };
  const syncJobFieldTechs = async (client, jobId, jobArea, profileIds, assignedBy) => syncJobAssignmentsForRole(client, jobId, jobArea, "field", profileIds, assignedBy);
  const syncJobSupervisors = async (client, jobId, jobArea, profileIds, assignedBy) => syncJobAssignmentsForRole(client, jobId, jobArea, "super", profileIds, assignedBy);
  app.post(
    "/api/jobs",
    requireAuth,
    requireRole("admin", "area", "super"),
    async (req, res) => {
      const parsed = createJobSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      if (req.profile.role !== "admin" && parsed.data.area !== req.profile.area)
        return res.status(403).json({ message: "You can only create jobs in your area" });
      const client = supabaseAdmin || supabaseAnon;
      const { data, error } = await client.from("jobs").insert({
        job_number: parsed.data.job_number,
        area: parsed.data.area,
        customer_id: parsed.data.customer_id,
        description: parsed.data.description ?? null,
        status: parsed.data.status ?? "Active",
        crewing: parsed.data.crewing ?? "Manned",
        started_on: parsed.data.started_on || null,
        ended_on: parsed.data.ended_on || null,
        day_rate: parsed.data.day_rate ?? null,
        well_name: parsed.data.well_name?.trim() || null
      }).select().single();
      if (error) {
        if (error.code === "23505")
          return res.status(409).json({
            message: `Job ${parsed.data.job_number} already exists in ${parsed.data.area}`
          });
        return res.status(400).json({ message: error.message });
      }
      const assetIds = parsed.data.asset_ids ?? [];
      if (assetIds.length > 0) {
        const { error: assignErr } = await client.from("assets").update({ job_id: data.id, status: "On Job" }).in("id", assetIds).eq("area", data.area);
        if (assignErr)
          return res.status(201).json({ ...data, asset_assign_warning: assignErr.message });
      }
      const techIds = parsed.data.field_tech_ids ?? [];
      if (techIds.length > 0) {
        const warn = await syncJobFieldTechs(
          client,
          data.id,
          data.area,
          techIds,
          req.profile.id
        );
        if (warn)
          return res.status(201).json({ ...data, tech_assign_warning: warn });
      }
      const supIds = parsed.data.supervisor_ids ?? [];
      if (supIds.length > 0) {
        const warn = await syncJobSupervisors(
          client,
          data.id,
          data.area,
          supIds,
          req.profile.id
        );
        if (warn)
          return res.status(201).json({ ...data, supervisor_assign_warning: warn });
      }
      res.status(201).json(data);
    }
  );
  app.patch(
    "/api/jobs/:id",
    requireAuth,
    requireRole("admin", "area", "super"),
    async (req, res) => {
      const parsed = updateJobSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      const client = supabaseAdmin || supabaseAnon;
      const { data: job } = await client.from("jobs").select("area").eq("id", req.params.id).single();
      if (!job) return res.status(404).json({ message: "Job not found" });
      if (req.profile.role !== "admin" && job.area !== req.profile.area)
        return res.status(403).json({ message: "Outside your area" });
      const patch = { ...parsed.data };
      if (patch.started_on === "") patch.started_on = null;
      if (patch.ended_on === "") patch.ended_on = null;
      const fieldTechIds = patch.field_tech_ids;
      delete patch.field_tech_ids;
      const supervisorIds = patch.supervisor_ids;
      delete patch.supervisor_ids;
      let data;
      if (Object.keys(patch).length === 0) {
        const { data: current, error: readErr } = await client.from("jobs").select().eq("id", req.params.id).single();
        if (readErr)
          return res.status(400).json({ message: readErr.message });
        data = current;
      } else {
        const { data: updated, error } = await client.from("jobs").update(patch).eq("id", req.params.id).select().single();
        if (error) return res.status(400).json({ message: error.message });
        data = updated;
      }
      if (fieldTechIds !== void 0) {
        const warn = await syncJobFieldTechs(
          client,
          data.id,
          data.area,
          fieldTechIds,
          req.profile.id
        );
        if (warn) return res.json({ ...data, tech_assign_warning: warn });
      }
      if (supervisorIds !== void 0) {
        const warn = await syncJobSupervisors(
          client,
          data.id,
          data.area,
          supervisorIds,
          req.profile.id
        );
        if (warn) return res.json({ ...data, supervisor_assign_warning: warn });
      }
      res.json(data);
    }
  );
  app.post(
    "/api/jobs/:id/archive",
    requireAuth,
    requireRole("admin", "area", "super"),
    async (req, res) => {
      const client = supabaseAdmin || supabaseAnon;
      const { data: job } = await client.from("jobs").select("area, archived_at").eq("id", req.params.id).single();
      if (!job) return res.status(404).json({ message: "Job not found" });
      if (req.profile.role !== "admin" && job.area !== req.profile.area)
        return res.status(403).json({ message: "Outside your area" });
      if (job.archived_at)
        return res.status(409).json({ message: "Job is already archived" });
      const { data, error } = await client.from("jobs").update({ archived_at: (/* @__PURE__ */ new Date()).toISOString() }).eq("id", req.params.id).select().single();
      if (error) return res.status(400).json({ message: error.message });
      const { error: relErr } = await client.from("assets").update({ job_id: null, status: "Available" }).eq("job_id", req.params.id);
      if (relErr)
        return res.json({ ...data, asset_release_warning: relErr.message });
      res.json(data);
    }
  );
  app.post(
    "/api/jobs/:id/unarchive",
    requireAuth,
    requireRole("admin", "area", "super"),
    async (req, res) => {
      const client = supabaseAdmin || supabaseAnon;
      const { data: job } = await client.from("jobs").select("area, archived_at").eq("id", req.params.id).single();
      if (!job) return res.status(404).json({ message: "Job not found" });
      if (req.profile.role !== "admin" && job.area !== req.profile.area)
        return res.status(403).json({ message: "Outside your area" });
      if (!job.archived_at)
        return res.status(409).json({ message: "Job is not archived" });
      const { data, error } = await client.from("jobs").update({ archived_at: null }).eq("id", req.params.id).select().single();
      if (error) return res.status(400).json({ message: error.message });
      res.json(data);
    }
  );
  const flattenTicket = (t) => {
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
      created_by_name: creator?.name ?? null
    };
  };
  const TICKET_SELECT = "*, job:jobs!field_tickets_job_id_fkey(job_number,area,status,customer_id,customer:customers(name,primary_contact,phone,email)), creator:profiles!field_tickets_created_by_fkey(name)";
  app.get("/api/field-tickets", requireAuth, async (req, res) => {
    const scope = areaScopeOf(req.profile);
    const jobIds = await jobScopeOf(req.profile);
    const { data, error } = await supabaseAnon.from("field_tickets").select(TICKET_SELECT).order("ticket_date", { ascending: false }).order("ticket_number", { ascending: false });
    if (error) return res.status(500).json({ message: error.message });
    let rows = (data || []).map(flattenTicket);
    if (scope) rows = rows.filter((r) => r.area === scope);
    if (jobIds) rows = rows.filter((r) => jobIds.includes(r.job_id));
    const status = String(req.query.status || "").toLowerCase();
    if (status === "active") rows = rows.filter((r) => r.job_status === "Active");
    else if (status === "past") rows = rows.filter((r) => r.job_status !== "Active");
    res.json(rows);
  });
  app.get(
    "/api/jobs/:id/field-tickets",
    requireAuth,
    async (req, res) => {
      const scope = areaScopeOf(req.profile);
      const { data: job } = await supabaseAnon.from("jobs").select("area").eq("id", req.params.id).single();
      if (!job) return res.status(404).json({ message: "Job not found" });
      if (scope && job.area !== scope)
        return res.status(404).json({ message: "Job not found" });
      const jobIds = await jobScopeOf(req.profile);
      if (jobIds && !jobIds.includes(String(req.params.id)))
        return res.status(404).json({ message: "Job not found" });
      const { data, error } = await supabaseAnon.from("field_tickets").select(TICKET_SELECT).eq("job_id", req.params.id).order("ticket_date", { ascending: false }).order("ticket_number", { ascending: false });
      if (error) return res.status(500).json({ message: error.message });
      res.json((data || []).map(flattenTicket));
    }
  );
  app.post(
    "/api/jobs/:id/field-tickets",
    requireAuth,
    requireRole("admin", "area", "super"),
    async (req, res) => {
      const parsed = createFieldTicketSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      const client = supabaseAdmin || supabaseAnon;
      const { data: job } = await client.from("jobs").select("area,status").eq("id", req.params.id).single();
      if (!job) return res.status(404).json({ message: "Job not found" });
      if (req.profile.role !== "admin" && job.area !== req.profile.area)
        return res.status(403).json({ message: "Outside your area" });
      if (job.status !== "Active")
        return res.status(400).json({ message: "Field tickets can only be created for active jobs." });
      const lineItems = (parsed.data.line_items ?? []).map((li) => ({
        description: li.description,
        quantity: li.quantity,
        unit_cost: li.unit_cost,
        total: Math.round(li.quantity * li.unit_cost * 100) / 100
      }));
      const lineTotal = lineItems.reduce((s, li) => s + li.total, 0);
      const amount = parsed.data.amount != null ? parsed.data.amount : lineItems.length > 0 ? Math.round(lineTotal * 100) / 100 : null;
      const { data, error } = await client.from("field_tickets").insert({
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
        created_by: req.profile.id
      }).select().single();
      if (error) return res.status(400).json({ message: error.message });
      res.status(201).json(data);
    }
  );
  const loadTicketForWrite = async (req, res) => {
    const client = supabaseAdmin || supabaseAnon;
    const { data: ticket } = await client.from("field_tickets").select("*").eq("id", req.params.id).single();
    if (!ticket) {
      res.status(404).json({ message: "Field ticket not found" });
      return null;
    }
    const { data: job } = await client.from("jobs").select("area,status").eq("id", ticket.job_id).single();
    if (!job) {
      res.status(404).json({ message: "Job not found" });
      return null;
    }
    if (req.profile.role !== "admin" && job.area !== req.profile.area) {
      res.status(403).json({ message: "Outside your area" });
      return null;
    }
    if (job.status !== "Active") {
      res.status(400).json({
        message: "Field tickets can only be changed while the job is active."
      });
      return null;
    }
    return { ticket, job, client };
  };
  app.patch(
    "/api/field-tickets/:id",
    requireAuth,
    requireRole("admin", "area", "super"),
    async (req, res) => {
      const parsed = updateFieldTicketSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      const loaded = await loadTicketForWrite(req, res);
      if (!loaded) return;
      const p = parsed.data;
      const patch = {};
      if (p.ticket_date !== void 0) patch.ticket_date = p.ticket_date;
      if (p.county !== void 0) patch.county = p.county || null;
      if (p.well_name !== void 0) patch.well_name = p.well_name || null;
      if (p.po_afe !== void 0) patch.po_afe = p.po_afe || null;
      if (p.description !== void 0) patch.description = p.description || null;
      if (p.comments !== void 0) patch.comments = p.comments || null;
      if (p.asset_ids !== void 0) patch.asset_ids = p.asset_ids ?? [];
      let newLineTotal = null;
      if (p.line_items !== void 0) {
        const lineItems = (p.line_items ?? []).map((li) => ({
          description: li.description,
          quantity: li.quantity,
          unit_cost: li.unit_cost,
          total: Math.round(li.quantity * li.unit_cost * 100) / 100
        }));
        patch.line_items = lineItems;
        newLineTotal = lineItems.length > 0 ? Math.round(lineItems.reduce((s, li) => s + li.total, 0) * 100) / 100 : null;
      }
      if (p.amount !== void 0) patch.amount = p.amount ?? null;
      else if (newLineTotal !== null) patch.amount = newLineTotal;
      const { data, error } = await loaded.client.from("field_tickets").update(patch).eq("id", req.params.id).select().single();
      if (error) return res.status(400).json({ message: error.message });
      res.json(data);
    }
  );
  app.delete(
    "/api/field-tickets/:id",
    requireAuth,
    requireRole("admin", "area", "super"),
    async (req, res) => {
      const loaded = await loadTicketForWrite(req, res);
      if (!loaded) return;
      const { error } = await loaded.client.from("field_tickets").delete().eq("id", req.params.id);
      if (error) return res.status(400).json({ message: error.message });
      res.status(204).end();
    }
  );
  const FDR_TABLE = "daily_reports";
  const flattenFdr = (r) => {
    const { job, submitter, signer, ...rest } = r;
    return {
      ...rest,
      job_number: job?.job_number ?? "",
      area: rest.area ?? job?.area ?? null,
      job_status: job?.status ?? null,
      customer_id: rest.customer_id ?? job?.customer_id ?? null,
      customer_name: job?.customer?.name ?? "",
      submitted_by_name: submitter?.name ?? null,
      signed_by_name: signer?.name ?? null
    };
  };
  const FDR_SELECT = "*, job:jobs!daily_reports_job_id_fkey(job_number,area,status,customer_id,customer:customers(name)), submitter:profiles!daily_reports_submitted_by_fkey(name), signer:profiles!daily_reports_signed_by_fkey(name)";
  app.get("/api/field-daily-reports", requireAuth, async (req, res) => {
    const scope = areaScopeOf(req.profile);
    const jobIds = await jobScopeOf(req.profile);
    const { data, error } = await supabaseAnon.from(FDR_TABLE).select(FDR_SELECT).eq("source", "field").order("report_date", { ascending: false }).order("report_number", { ascending: false });
    if (error) return res.status(500).json({ message: error.message });
    let rows = (data || []).map(flattenFdr);
    if (scope) rows = rows.filter((r) => r.area === scope);
    if (jobIds) rows = rows.filter((r) => jobIds.includes(r.job_id));
    const status = String(req.query.status || "").toLowerCase();
    if (status === "pending") rows = rows.filter((r) => r.status !== "Signed off");
    else if (status === "signed") rows = rows.filter((r) => r.status === "Signed off");
    res.json(rows);
  });
  app.get(
    "/api/jobs/:id/field-daily-reports",
    requireAuth,
    async (req, res) => {
      const scope = areaScopeOf(req.profile);
      const { data: job } = await supabaseAnon.from("jobs").select("area").eq("id", req.params.id).single();
      if (!job) return res.status(404).json({ message: "Job not found" });
      if (scope && job.area !== scope)
        return res.status(404).json({ message: "Job not found" });
      const jobIds = await jobScopeOf(req.profile);
      if (jobIds && !jobIds.includes(String(req.params.id)))
        return res.status(404).json({ message: "Job not found" });
      const { data, error } = await supabaseAnon.from(FDR_TABLE).select(FDR_SELECT).eq("job_id", req.params.id).eq("source", "field").order("report_date", { ascending: false }).order("report_number", { ascending: false });
      if (error) return res.status(500).json({ message: error.message });
      res.json((data || []).map(flattenFdr));
    }
  );
  app.post(
    "/api/jobs/:id/field-daily-reports",
    requireAuth,
    async (_req, res) => {
      return res.status(410).json({
        message: "Field daily-report entry has been retired. Email daily reports to the intake inbox instead."
      });
    }
  );
  const loadFdrForWrite = async (req, res, opts) => {
    const client = supabaseAdmin || supabaseAnon;
    const { data: report } = await client.from(FDR_TABLE).select("*").eq("id", req.params.id).single();
    if (!report) {
      res.status(404).json({ message: "Daily report not found" });
      return null;
    }
    const { data: job } = await client.from("jobs").select("area,status").eq("id", report.job_id).single();
    if (!job) {
      res.status(404).json({ message: "Job not found" });
      return null;
    }
    if (req.profile.role !== "admin" && job.area !== req.profile.area) {
      res.status(403).json({ message: "Outside your area" });
      return null;
    }
    if (opts.requireActive && job.status !== "Active") {
      res.status(400).json({
        message: "Daily reports can only be changed while the job is active."
      });
      return null;
    }
    return { report, job, client };
  };
  app.patch(
    "/api/field-daily-reports/:id",
    requireAuth,
    async (req, res) => {
      const parsed = updateFieldDailyReportSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      const loaded = await loadFdrForWrite(req, res, { requireActive: true });
      if (!loaded) return;
      const isSupervisor = ["admin", "area", "super"].includes(req.profile.role);
      if (!isSupervisor && loaded.report.submitted_by !== req.profile.id)
        return res.status(403).json({ message: "You can only edit your own reports." });
      if (loaded.report.status === "Signed off")
        return res.status(400).json({ message: "This report is signed off and locked." });
      const p = parsed.data;
      const patch = {};
      if (p.report_date !== void 0) patch.report_date = p.report_date;
      if (p.well_name !== void 0) patch.well_name = p.well_name || null;
      if (p.work_summary !== void 0) patch.work_summary = p.work_summary || null;
      if (p.crew_hours !== void 0) patch.crew_hours = p.crew_hours ?? null;
      if (p.crew !== void 0) patch.crew = p.crew ?? [];
      if (p.asset_ids !== void 0) patch.asset_ids = p.asset_ids ?? [];
      if (p.comments !== void 0) patch.comments = p.comments || null;
      if (loaded.report.status === "Changes requested") {
        patch.status = "Pending Review";
        patch.change_notes = null;
      }
      const { data, error } = await loaded.client.from(FDR_TABLE).update(patch).eq("id", req.params.id).select().single();
      if (error) return res.status(400).json({ message: error.message });
      res.json(data);
    }
  );
  app.post(
    "/api/field-daily-reports/:id/signoff",
    requireAuth,
    requireRole("admin", "area", "super"),
    async (req, res) => {
      const parsed = signoffSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      const loaded = await loadFdrForWrite(req, res, { requireActive: false });
      if (!loaded) return;
      const nowIso = (/* @__PURE__ */ new Date()).toISOString();
      const signOff = parsed.data.action === "sign_off";
      const patch = signOff ? {
        status: "Signed off",
        signed_by: req.profile.id,
        signed_at: nowIso,
        reviewed_by: req.profile.id,
        reviewed_by_name: req.profile.name,
        reviewed_at: nowIso,
        change_notes: null
      } : {
        status: "Changes requested",
        signed_by: null,
        signed_at: null,
        reviewed_by: req.profile.id,
        reviewed_by_name: req.profile.name,
        reviewed_at: nowIso,
        change_notes: parsed.data.change_notes || null
      };
      const { data, error } = await loaded.client.from(FDR_TABLE).update(patch).eq("id", req.params.id).select().single();
      if (error) return res.status(400).json({ message: error.message });
      await loaded.client.from("daily_report_events").insert({
        report_id: req.params.id,
        actor_id: req.profile.id,
        actor_name: req.profile.name,
        actor_role: req.profile.role,
        action: signOff ? "signed_off" : "changes_requested",
        detail: signOff ? null : parsed.data.change_notes || null
      });
      res.json(data);
    }
  );
  app.delete(
    "/api/field-daily-reports/:id",
    requireAuth,
    async (req, res) => {
      const loaded = await loadFdrForWrite(req, res, { requireActive: true });
      if (!loaded) return;
      const isSupervisor = ["admin", "area", "super"].includes(req.profile.role);
      if (!isSupervisor && loaded.report.submitted_by !== req.profile.id)
        return res.status(403).json({ message: "You can only delete your own reports." });
      const { error } = await loaded.client.from(FDR_TABLE).delete().eq("id", req.params.id);
      if (error) return res.status(400).json({ message: error.message });
      res.status(204).end();
    }
  );
  const flattenJsa = (r) => {
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
      steps: (steps || []).sort((a, b) => a.step_order - b.step_order)
    };
  };
  const JSA_SELECT = "*, job:jobs!jsas_job_id_fkey(job_number,area,status,customer_id,customer:customers(name)), submitter:profiles!jsas_submitted_by_fkey(name), signer:profiles!jsas_signed_by_fkey(name), steps:jsa_steps(*)";
  app.get("/api/jsas", requireAuth, async (req, res) => {
    const scope = areaScopeOf(req.profile);
    const jobIds = await jobScopeOf(req.profile);
    const { data, error } = await supabaseAnon.from("jsas").select(JSA_SELECT).order("jsa_date", { ascending: false }).order("jsa_number", { ascending: false });
    if (error) return res.status(500).json({ message: error.message });
    let rows = (data || []).map(flattenJsa);
    if (scope) rows = rows.filter((r) => r.area === scope);
    if (jobIds) rows = rows.filter((r) => jobIds.includes(r.job_id));
    const status = String(req.query.status || "").toLowerCase();
    if (status === "pending") rows = rows.filter((r) => r.status !== "Signed off");
    else if (status === "signed") rows = rows.filter((r) => r.status === "Signed off");
    res.json(rows);
  });
  app.get(
    "/api/jobs/:id/jsas",
    requireAuth,
    async (req, res) => {
      const scope = areaScopeOf(req.profile);
      const { data: job } = await supabaseAnon.from("jobs").select("area").eq("id", req.params.id).single();
      if (!job) return res.status(404).json({ message: "Job not found" });
      if (scope && job.area !== scope)
        return res.status(404).json({ message: "Job not found" });
      const jobIds = await jobScopeOf(req.profile);
      if (jobIds && !jobIds.includes(String(req.params.id)))
        return res.status(404).json({ message: "Job not found" });
      const { data, error } = await supabaseAnon.from("jsas").select(JSA_SELECT).eq("job_id", req.params.id).order("jsa_date", { ascending: false }).order("jsa_number", { ascending: false });
      if (error) return res.status(500).json({ message: error.message });
      res.json((data || []).map(flattenJsa));
    }
  );
  const insertJsaSteps = async (client, jsaId, steps) => {
    const rows = steps.map((s, i) => ({
      jsa_id: jsaId,
      step_order: i,
      step_description: s.step_description,
      hazards: s.hazards || null,
      controls: s.controls || null
    }));
    return client.from("jsa_steps").insert(rows);
  };
  app.post(
    "/api/jobs/:id/jsas",
    requireAuth,
    async (req, res) => {
      const parsed = createJsaSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      const client = supabaseAdmin || supabaseAnon;
      const { data: job } = await client.from("jobs").select("area,status").eq("id", req.params.id).single();
      if (!job) return res.status(404).json({ message: "Job not found" });
      if (req.profile.role !== "admin" && job.area !== req.profile.area)
        return res.status(403).json({ message: "Outside your area" });
      if (job.status !== "Active")
        return res.status(400).json({ message: "JSAs can only be created for active jobs." });
      const p = parsed.data;
      const { data: jsa, error } = await client.from("jsas").insert({
        job_id: req.params.id,
        jsa_date: p.jsa_date,
        well_name: p.well_name || null,
        task_description: p.task_description || null,
        ppe: p.ppe || null,
        crew: p.crew ?? [],
        submitted_by: req.profile.id
      }).select().single();
      if (error) return res.status(400).json({ message: error.message });
      const { error: stepErr } = await insertJsaSteps(client, jsa.id, p.steps);
      if (stepErr) {
        await client.from("jsas").delete().eq("id", jsa.id);
        return res.status(400).json({ message: stepErr.message });
      }
      const { data: full } = await client.from("jsas").select(JSA_SELECT).eq("id", jsa.id).single();
      res.status(201).json(full ? flattenJsa(full) : jsa);
    }
  );
  const loadJsaForWrite = async (req, res, opts) => {
    const client = supabaseAdmin || supabaseAnon;
    const { data: jsa } = await client.from("jsas").select("*").eq("id", req.params.id).single();
    if (!jsa) {
      res.status(404).json({ message: "JSA not found" });
      return null;
    }
    const { data: job } = await client.from("jobs").select("area,status").eq("id", jsa.job_id).single();
    if (!job) {
      res.status(404).json({ message: "Job not found" });
      return null;
    }
    if (req.profile.role !== "admin" && job.area !== req.profile.area) {
      res.status(403).json({ message: "Outside your area" });
      return null;
    }
    if (opts.requireActive && job.status !== "Active") {
      res.status(400).json({
        message: "JSAs can only be changed while the job is active."
      });
      return null;
    }
    return { jsa, job, client };
  };
  app.patch(
    "/api/jsas/:id",
    requireAuth,
    async (req, res) => {
      const parsed = updateJsaSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      const loaded = await loadJsaForWrite(req, res, { requireActive: true });
      if (!loaded) return;
      const isSupervisor = ["admin", "area", "super"].includes(req.profile.role);
      if (!isSupervisor && loaded.jsa.submitted_by !== req.profile.id)
        return res.status(403).json({ message: "You can only edit your own JSAs." });
      if (loaded.jsa.status === "Signed off")
        return res.status(400).json({ message: "This JSA is signed off and locked." });
      const p = parsed.data;
      const patch = {};
      if (p.jsa_date !== void 0) patch.jsa_date = p.jsa_date;
      if (p.well_name !== void 0) patch.well_name = p.well_name || null;
      if (p.task_description !== void 0) patch.task_description = p.task_description || null;
      if (p.ppe !== void 0) patch.ppe = p.ppe || null;
      if (p.crew !== void 0) patch.crew = p.crew ?? [];
      if (loaded.jsa.status === "Changes requested") {
        patch.status = "Pending sign-off";
        patch.change_notes = null;
      }
      const { error } = await loaded.client.from("jsas").update(patch).eq("id", req.params.id);
      if (error) return res.status(400).json({ message: error.message });
      if (p.steps !== void 0) {
        await loaded.client.from("jsa_steps").delete().eq("jsa_id", req.params.id);
        const { error: stepErr } = await insertJsaSteps(loaded.client, String(req.params.id), p.steps);
        if (stepErr) return res.status(400).json({ message: stepErr.message });
      }
      const { data: full } = await loaded.client.from("jsas").select(JSA_SELECT).eq("id", req.params.id).single();
      res.json(full ? flattenJsa(full) : { id: req.params.id });
    }
  );
  app.post(
    "/api/jsas/:id/signoff",
    requireAuth,
    requireRole("admin", "area", "super"),
    async (req, res) => {
      const parsed = signoffSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      const loaded = await loadJsaForWrite(req, res, { requireActive: false });
      if (!loaded) return;
      const patch = parsed.data.action === "sign_off" ? {
        status: "Signed off",
        signed_by: req.profile.id,
        signed_at: (/* @__PURE__ */ new Date()).toISOString(),
        change_notes: null
      } : {
        status: "Changes requested",
        signed_by: null,
        signed_at: null,
        change_notes: parsed.data.change_notes || null
      };
      const { data, error } = await loaded.client.from("jsas").update(patch).eq("id", req.params.id).select().single();
      if (error) return res.status(400).json({ message: error.message });
      res.json(data);
    }
  );
  app.delete(
    "/api/jsas/:id",
    requireAuth,
    async (req, res) => {
      const loaded = await loadJsaForWrite(req, res, { requireActive: true });
      if (!loaded) return;
      const isSupervisor = ["admin", "area", "super"].includes(req.profile.role);
      if (!isSupervisor && loaded.jsa.submitted_by !== req.profile.id)
        return res.status(403).json({ message: "You can only delete your own JSAs." });
      const { error } = await loaded.client.from("jsas").delete().eq("id", req.params.id);
      if (error) return res.status(400).json({ message: error.message });
      res.status(204).end();
    }
  );
  app.get(
    "/api/maintenance-schedules",
    requireAuth,
    async (_req, res) => {
      const { data, error } = await supabaseAnon.from("maintenance_schedules").select("*").order("name");
      if (error) return res.status(500).json({ message: error.message });
      res.json(data);
    }
  );
  app.post(
    "/api/maintenance-schedules",
    requireAuth,
    requireRole("admin", "area"),
    async (req, res) => {
      const parsed = createMaintenanceScheduleSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      const client = supabaseAdmin || supabaseAnon;
      const { data, error } = await client.from("maintenance_schedules").insert(parsed.data).select().single();
      if (error) return res.status(400).json({ message: error.message });
      res.status(201).json(data);
    }
  );
  app.patch(
    "/api/maintenance-schedules/:id",
    requireAuth,
    requireRole("admin", "area"),
    async (req, res) => {
      const parsed = updateMaintenanceScheduleSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      const client = supabaseAdmin || supabaseAnon;
      const { data, error } = await client.from("maintenance_schedules").update(parsed.data).eq("id", req.params.id).select().single();
      if (error) return res.status(400).json({ message: error.message });
      if (!data) return res.status(404).json({ message: "Schedule not found" });
      res.json(data);
    }
  );
  app.delete(
    "/api/maintenance-schedules/:id",
    requireAuth,
    requireRole("admin", "area"),
    async (req, res) => {
      const client = supabaseAdmin || supabaseAnon;
      const { error } = await client.from("maintenance_schedules").delete().eq("id", req.params.id);
      if (error) return res.status(400).json({ message: error.message });
      res.status(204).end();
    }
  );
  app.get(
    "/api/maintenance-reports/export.json",
    requireAuth,
    async (req, res) => {
      const scope = areaScopeOf(req.profile);
      const client = supabaseAdmin || supabaseAnon;
      const start = String(req.query.start || "");
      const end = String(req.query.end || "");
      const startD = /* @__PURE__ */ new Date(start + "T00:00:00Z");
      const endD = /* @__PURE__ */ new Date(end + "T00:00:00Z");
      if (isNaN(startD.getTime()) || isNaN(endD.getTime()) || endD < startD)
        return res.status(400).json({ message: "Provide a valid start and end date (start <= end)" });
      const MS_DAY = 864e5;
      const windowDays = Math.round((endD.getTime() - startD.getTime()) / MS_DAY) + 1;
      const { data, error } = await client.from("maintenance_reports").select(
        "id, work_type, status, report_date, filed_at, notes, asset:assets!maintenance_reports_asset_id_fkey(tag,category,area), supervisor:profiles!maintenance_reports_supervisor_id_fkey(name)"
      ).gte("report_date", start).lte("report_date", end).order("report_date", { ascending: false }).order("filed_at", { ascending: false });
      if (error) return res.status(500).json({ message: error.message });
      let raw = data || [];
      if (scope) raw = raw.filter((r) => r.asset?.area === scope);
      const byWorkType = {};
      const byStatus = {};
      const assetsTouched = /* @__PURE__ */ new Set();
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
          by_status: byStatus
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
          notes: r.notes
        }))
      });
    }
  );
  app.get("/api/assets", requireAuth, async (req, res) => {
    const scope = areaScopeOf(req.profile);
    let fieldJobIds = null;
    if (req.profile.role === "field") {
      fieldJobIds = await jobScopeOf(req.profile) ?? [];
      if (fieldJobIds.length === 0) return res.json([]);
    }
    let q = supabaseAnon.from("assets").select(
      "*, maintenance_schedule:maintenance_schedules(*), job:jobs(id,job_number,well_name,area,status)"
    ).order("tag");
    if (scope) q = q.eq("area", scope);
    if (fieldJobIds) q = q.in("job_id", fieldJobIds);
    const { data, error } = await q;
    if (error) return res.status(500).json({ message: error.message });
    res.json(data);
  });
  app.get(
    "/api/assets/utilization.csv",
    requireAuth,
    requireRole("admin", "area", "super"),
    async (req, res) => {
      const scope = areaScopeOf(req.profile);
      const client = supabaseAdmin || supabaseAnon;
      const start = String(req.query.start || "");
      const end = String(req.query.end || "");
      const startD = /* @__PURE__ */ new Date(start + "T00:00:00Z");
      const endD = /* @__PURE__ */ new Date(end + "T00:00:00Z");
      if (isNaN(startD.getTime()) || isNaN(endD.getTime()) || endD < startD)
        return res.status(400).json({ message: "Provide a valid start and end date (start <= end)" });
      const MS_DAY = 864e5;
      const windowDays = Math.round((endD.getTime() - startD.getTime()) / MS_DAY) + 1;
      let aq = client.from("assets").select(
        "*, job:jobs(id,job_number,well_name,area,status,started_on,ended_on)"
      ).order("tag");
      if (scope) aq = aq.eq("area", scope);
      const { data: assetsData, error: aErr } = await aq;
      if (aErr) return res.status(500).json({ message: aErr.message });
      const assets = assetsData || [];
      const assetIds = assets.map((a) => a.id);
      const mCount = /* @__PURE__ */ new Map();
      if (assetIds.length) {
        const { data: reps } = await client.from("maintenance_reports").select("asset_id, report_date").in("asset_id", assetIds).gte("report_date", start).lte("report_date", end);
        for (const r of reps || [])
          mCount.set(r.asset_id, (mCount.get(r.asset_id) || 0) + 1);
      }
      const clampOverlapDays = (s, e) => {
        if (!s) return null;
        const js = /* @__PURE__ */ new Date(s + "T00:00:00Z");
        const je = e ? /* @__PURE__ */ new Date(e + "T00:00:00Z") : endD;
        const lo = Math.max(js.getTime(), startD.getTime());
        const hi = Math.min(je.getTime(), endD.getTime());
        if (hi < lo) return 0;
        return Math.round((hi - lo) / MS_DAY) + 1;
      };
      const esc = (v) => {
        if (v === null || v === void 0) return "";
        const s = String(v);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      };
      const header = [
        "Asset #",
        "Type",
        "Area",
        "Status",
        "Location",
        "Day rate ($/day)",
        "Run hours",
        "Days deployed",
        "Window days",
        "Utilization %",
        "Est. revenue ($)",
        "Maintenance events"
      ];
      const lines = [header.join(",")];
      for (const a of assets) {
        const job = a.job;
        const location = job ? `${job.well_name || job.job_number} \xB7 ${job.area}` : a.job_or_well || "Yard / unassigned";
        const daysDeployed = job ? clampOverlapDays(job.started_on, job.ended_on) : null;
        const utilPct = daysDeployed === null ? null : Math.round(daysDeployed / windowDays * 1e3) / 10;
        const estRevenue = daysDeployed === null || a.day_rate === null || a.day_rate === void 0 ? null : Math.round(Number(a.day_rate) * daysDeployed * 100) / 100;
        lines.push([
          esc(a.tag),
          esc(a.category),
          esc(a.area),
          esc(a.status),
          esc(location),
          esc(a.day_rate),
          esc(a.run_hours),
          esc(daysDeployed),
          esc(windowDays),
          esc(utilPct),
          esc(estRevenue),
          esc(mCount.get(a.id) || 0)
        ].join(","));
      }
      const csv = lines.join("\n");
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="asset-utilization_${start}_to_${end}.csv"`
      );
      res.send(csv);
    }
  );
  app.get(
    "/api/assets/utilization.json",
    requireAuth,
    requireRole("admin", "area", "super"),
    async (req, res) => {
      const scope = areaScopeOf(req.profile);
      const client = supabaseAdmin || supabaseAnon;
      const start = String(req.query.start || "");
      const end = String(req.query.end || "");
      const startD = /* @__PURE__ */ new Date(start + "T00:00:00Z");
      const endD = /* @__PURE__ */ new Date(end + "T00:00:00Z");
      if (isNaN(startD.getTime()) || isNaN(endD.getTime()) || endD < startD)
        return res.status(400).json({ message: "Provide a valid start and end date (start <= end)" });
      const MS_DAY = 864e5;
      const windowDays = Math.round((endD.getTime() - startD.getTime()) / MS_DAY) + 1;
      let aq = client.from("assets").select(
        "*, job:jobs(id,job_number,well_name,area,status,started_on,ended_on)"
      ).order("tag");
      if (scope) aq = aq.eq("area", scope);
      const { data: assetsData, error: aErr } = await aq;
      if (aErr) return res.status(500).json({ message: aErr.message });
      const assets = assetsData || [];
      const assetIds = assets.map((a) => a.id);
      const mCount = /* @__PURE__ */ new Map();
      if (assetIds.length) {
        const { data: reps } = await client.from("maintenance_reports").select("asset_id, report_date").in("asset_id", assetIds).gte("report_date", start).lte("report_date", end);
        for (const r of reps || [])
          mCount.set(r.asset_id, (mCount.get(r.asset_id) || 0) + 1);
      }
      const clampOverlapDays = (s, e) => {
        if (!s) return null;
        const js = /* @__PURE__ */ new Date(s + "T00:00:00Z");
        const je = e ? /* @__PURE__ */ new Date(e + "T00:00:00Z") : endD;
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
        const location = job ? `${job.well_name || job.job_number} \xB7 ${job.area}` : a.job_or_well || "Yard / unassigned";
        const daysDeployed = job ? clampOverlapDays(job.started_on, job.ended_on) : null;
        const utilPct = daysDeployed === null ? null : Math.round(daysDeployed / windowDays * 1e3) / 10;
        const estRevenue = daysDeployed === null || a.day_rate === null || a.day_rate === void 0 ? null : Math.round(Number(a.day_rate) * daysDeployed * 100) / 100;
        if (estRevenue !== null) totalEstRevenue += estRevenue;
        if (daysDeployed !== null && daysDeployed > 0) deployedCount += 1;
        if (utilPct !== null) {
          utilSum += utilPct;
          utilN += 1;
        }
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
          maintenance_events: mCount.get(a.id) || 0
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
          avg_utilization_pct: utilN ? Math.round(utilSum / utilN * 10) / 10 : null,
          total_est_revenue: Math.round(totalEstRevenue * 100) / 100
        },
        rows
      });
    }
  );
  app.get(
    "/api/assets/:id",
    requireAuth,
    async (req, res) => {
      const scope = areaScopeOf(req.profile);
      const client = supabaseAdmin || supabaseAnon;
      const { data: asset, error } = await client.from("assets").select(
        "*, maintenance_schedule:maintenance_schedules(*), job:jobs(id,job_number,well_name,area,status)"
      ).eq("id", req.params.id).single();
      if (error || !asset)
        return res.status(404).json({ message: "Asset not found" });
      if (scope && asset.area !== scope)
        return res.status(403).json({ message: "Outside your area" });
      if (req.profile.role === "field") {
        const fieldJobIds = await jobScopeOf(req.profile) ?? [];
        const assetJobId = asset.job_id;
        if (!assetJobId || !fieldJobIds.includes(assetJobId))
          return res.status(404).json({ message: "Asset not found" });
      }
      const { data: reps } = await client.from("maintenance_reports").select(
        "id, work_type, status, report_date, filed_at, notes, supervisor:profiles!maintenance_reports_supervisor_id_fkey(name)"
      ).eq("asset_id", req.params.id).order("report_date", { ascending: false }).order("filed_at", { ascending: false });
      const history = (reps || []).map((r) => ({
        id: r.id,
        work_type: r.work_type,
        status: r.status,
        report_date: r.report_date,
        filed_at: r.filed_at,
        notes: r.notes,
        supervisor_name: r.supervisor?.name ?? null
      }));
      const { hoursSince, interval, state } = serviceStatusFor(asset);
      res.json({
        ...asset,
        run_hours_since_service: hoursSince,
        service_hours_interval: interval,
        service_state: state,
        history
      });
    }
  );
  app.post(
    "/api/assets",
    requireAuth,
    requireRole("admin", "area"),
    async (req, res) => {
      const parsed = createAssetSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      if (req.profile.role === "area" && parsed.data.area !== req.profile.area) {
        return res.status(403).json({ message: "You can only add assets in your area" });
      }
      const runHours = tracksRunHours(parsed.data.category) ? parsed.data.run_hours ?? 0 : null;
      const client = supabaseAdmin || supabaseAnon;
      const insert = { ...parsed.data, run_hours: runHours };
      if (!tracksRunHours(parsed.data.category)) delete insert.service_hours_interval;
      const { data, error } = await client.from("assets").insert(insert).select().single();
      if (error) return res.status(400).json({ message: error.message });
      res.status(201).json(data);
    }
  );
  app.patch(
    "/api/assets/:id",
    requireAuth,
    requireRole("admin", "area"),
    async (req, res) => {
      const parsed = updateAssetSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      const client = supabaseAdmin || supabaseAnon;
      const { data: asset } = await client.from("assets").select("area, job_id, category").eq("id", req.params.id).single();
      if (!asset) return res.status(404).json({ message: "Asset not found" });
      if (req.profile.role === "area" && asset.area !== req.profile.area)
        return res.status(403).json({ message: "Outside your area" });
      const patch = { ...parsed.data };
      const nextArea = patch.area ?? asset.area;
      if (req.profile.role === "area" && patch.area && patch.area !== req.profile.area)
        return res.status(403).json({ message: "You can only keep assets within your own area" });
      if (patch.area && patch.area !== asset.area && asset.job_id)
        return res.status(400).json({
          message: "This asset is on a job. Unassign it from the job before changing its area."
        });
      if (patch.job_id) {
        const { data: job } = await client.from("jobs").select("area").eq("id", patch.job_id).single();
        if (!job) return res.status(404).json({ message: "Job not found" });
        if (job.area !== nextArea)
          return res.status(400).json({ message: "Asset and job must be in the same operating area" });
      }
      const effectiveCategory = patch.category ?? asset.category;
      if (!tracksRunHours(effectiveCategory)) delete patch.service_hours_interval;
      const { data, error } = await client.from("assets").update(patch).eq("id", req.params.id).select().single();
      if (error) {
        const dup = /duplicate|unique/i.test(error.message) && /tag/i.test(error.message);
        return res.status(400).json({
          message: dup ? "That asset number is already in use. Choose a different one." : error.message
        });
      }
      res.json(data);
    }
  );
  app.get(
    "/api/service/dashboard",
    requireAuth,
    async (req, res) => {
      const scope = areaScopeOf(req.profile);
      const client = supabaseAdmin || supabaseAnon;
      let aq = client.from("assets").select("*, job:jobs(id,job_number,area)").in("category", RUN_HOUR_CATEGORIES).order("tag");
      if (scope) aq = aq.eq("area", scope);
      const { data: assetsData, error: aErr } = await aq;
      if (aErr) return res.status(500).json({ message: aErr.message });
      const assets = assetsData || [];
      const assetIds = assets.map((a) => a.id);
      const techByAsset = /* @__PURE__ */ new Map();
      if (assetIds.length) {
        const { data: reps } = await client.from("maintenance_reports").select("asset_id, filed_at, supervisor:profiles!maintenance_reports_supervisor_id_fkey(name)").in("asset_id", assetIds).order("filed_at", { ascending: false });
        for (const r of reps || []) {
          if (!techByAsset.has(r.asset_id) && r.supervisor?.name)
            techByAsset.set(r.asset_id, r.supervisor.name);
        }
      }
      const { data: repRows } = await client.from("maintenance_reports").select("status, asset:assets(area)");
      let reports = repRows || [];
      if (scope) reports = reports.filter((r) => r.asset?.area === scope);
      const reportsFiled = reports.length;
      const reportsPending = reports.filter(
        (r) => r.status !== "Signed off"
      ).length;
      const rows = assets.map(
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
            _deployed: deployed
          };
        }
      );
      const metrics = {
        active_centrifuges: rows.filter((r) => r._deployed).length,
        total_centrifuges: rows.length,
        due_soon: rows.filter((r) => r.service_state === "Soon").length,
        overdue: rows.filter((r) => r.service_state === "Overdue").length,
        reports_filed: reportsFiled,
        reports_pending_signoff: reportsPending
      };
      const rank = {
        Overdue: 0,
        Soon: 1,
        "No baseline": 2,
        OK: 3
      };
      const centrifuges = rows.filter((r) => r._deployed).sort(
        (x, y) => (rank[x.service_state] ?? 9) - (rank[y.service_state] ?? 9) || x.tag.localeCompare(y.tag)
      ).map(({ _deployed, ...r }) => r);
      const payload = { metrics, centrifuges };
      res.json(payload);
    }
  );
  app.get("/api/reports", requireAuth, async (req, res) => {
    const scope = areaScopeOf(req.profile);
    const jobIds = await jobScopeOf(req.profile);
    let q = supabaseAnon.from("maintenance_reports").select(
      "*, asset:assets(*), supervisor:profiles!maintenance_reports_supervisor_id_fkey(id,name,area)"
    ).order("filed_at", { ascending: false });
    const { data, error } = await q;
    if (error) return res.status(500).json({ message: error.message });
    let rows = data || [];
    if (scope) rows = rows.filter((r) => r.asset?.area === scope);
    if (jobIds) rows = rows.filter((r) => jobIds.includes(r.asset?.job_id));
    if (req.profile.role === "field")
      rows = rows.filter((r) => r.supervisor_id === req.profile.id);
    res.json(rows);
  });
  app.post(
    "/api/reports",
    requireAuth,
    requireRole("admin", "area", "super"),
    async (req, res) => {
      const parsed = createReportSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      const client = supabaseAdmin || supabaseAnon;
      const { data: asset } = await client.from("assets").select("*").eq("id", parsed.data.asset_id).single();
      if (!asset) return res.status(404).json({ message: "Asset not found" });
      if (req.profile.role !== "admin" && asset.area !== req.profile.area)
        return res.status(403).json({ message: "Asset is outside your area" });
      const { data: report, error } = await client.from("maintenance_reports").insert({
        asset_id: parsed.data.asset_id,
        supervisor_id: req.profile.id,
        work_type: parsed.data.work_type,
        notes: parsed.data.notes ?? null,
        report_date: parsed.data.report_date,
        status: "Pending Sign-off"
      }).select().single();
      if (error) return res.status(400).json({ message: error.message });
      const patch = { last_maintained: parsed.data.report_date };
      if (tracksRunHours(asset.category)) {
        const meterAtService = parsed.data.run_hours != null ? parsed.data.run_hours : asset.run_hours;
        if (parsed.data.run_hours != null) patch.run_hours = parsed.data.run_hours;
        if (meterAtService != null) patch.run_hours_at_service = meterAtService;
      }
      await client.from("assets").update(patch).eq("id", asset.id);
      await client.from("audit_events").insert({
        report_id: report.id,
        asset_id: asset.id,
        actor_id: req.profile.id,
        actor_name: req.profile.name,
        actor_role: req.profile.role,
        action: "Filed"
      });
      sendNotificationEmails("needs_signoff", { report, asset }).catch(
        (e) => console.error("[email] needs_signoff", e)
      );
      res.status(201).json(report);
    }
  );
  const SERVICE_REPORT_SELECT = "id, job_id, file_name, file_mime, file_size, notes, uploaded_by, created_at, job:jobs!service_reports_job_id_fkey(job_number,well_name,area,customer:customers(name)), uploader:profiles!service_reports_uploaded_by_fkey(name)";
  function flattenServiceReport(row) {
    const { job, uploader, ...rest } = row;
    return {
      ...rest,
      job_number: job?.job_number ?? null,
      well_name: job?.well_name ?? null,
      area: job?.area ?? null,
      customer_name: job?.customer?.name ?? null,
      uploaded_by_name: uploader?.name ?? null
    };
  }
  app.get(
    "/api/service-reports",
    requireAuth,
    async (req, res) => {
      const scope = areaScopeOf(req.profile);
      const { data, error } = await supabaseAnon.from("service_reports").select(SERVICE_REPORT_SELECT).order("created_at", { ascending: false });
      if (error) return res.status(500).json({ message: error.message });
      let rows = (data || []).map(flattenServiceReport);
      if (scope) rows = rows.filter((r) => r.area === scope);
      res.json(rows);
    }
  );
  app.get(
    "/api/service-reports/export.json",
    requireAuth,
    async (req, res) => {
      const scope = areaScopeOf(req.profile);
      const start = String(req.query.start || "");
      const end = String(req.query.end || "");
      const startD = /* @__PURE__ */ new Date(start + "T00:00:00Z");
      const endD = /* @__PURE__ */ new Date(end + "T23:59:59Z");
      if (isNaN(startD.getTime()) || isNaN(endD.getTime()) || endD < startD)
        return res.status(400).json({ message: "Provide a valid start and end date (start <= end)" });
      const MS_DAY = 864e5;
      const windowDays = Math.round((endD.getTime() - startD.getTime()) / MS_DAY) + 1;
      const { data, error } = await supabaseAnon.from("service_reports").select(SERVICE_REPORT_SELECT).gte("created_at", startD.toISOString()).lte("created_at", endD.toISOString()).order("created_at", { ascending: false });
      if (error) return res.status(500).json({ message: error.message });
      let rows = (data || []).map(flattenServiceReport);
      if (scope) rows = rows.filter((r) => r.area === scope);
      const byArea = {};
      const byCustomer = {};
      for (const r of rows) {
        const a = r.area || "\u2014";
        byArea[a] = (byArea[a] || 0) + 1;
        const c = r.customer_name || "\u2014";
        byCustomer[c] = (byCustomer[c] || 0) + 1;
      }
      res.json({
        start,
        end,
        window_days: windowDays,
        area_scope: scope || "All areas",
        summary: {
          report_count: rows.length,
          area_count: Object.keys(byArea).filter((k) => k !== "\u2014").length,
          customer_count: Object.keys(byCustomer).filter((k) => k !== "\u2014").length,
          by_area: byArea
        },
        rows: rows.map((r) => ({
          created_at: r.created_at,
          job_number: r.job_number,
          well_name: r.well_name,
          area: r.area,
          customer_name: r.customer_name,
          file_name: r.file_name,
          file_size: r.file_size,
          uploaded_by_name: r.uploaded_by_name,
          notes: r.notes
        }))
      });
    }
  );
  app.post(
    "/api/service-reports",
    requireAuth,
    requireRole("admin", "area", "super"),
    async (req, res) => {
      const parsed = uploadServiceReportSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      const client = supabaseAdmin || supabaseAnon;
      const { data: job } = await client.from("jobs").select("id, area").eq("id", parsed.data.job_id).single();
      if (!job) return res.status(404).json({ message: "Job not found" });
      const scope = areaScopeOf(req.profile);
      if (scope && job.area !== scope)
        return res.status(403).json({ message: "Job is outside your area" });
      const bytes = Buffer.from(parsed.data.file_base64, "base64");
      if (bytes.length === 0)
        return res.status(400).json({ message: "Uploaded file is empty" });
      const { data: created, error } = await client.from("service_reports").insert({
        job_id: parsed.data.job_id,
        file_name: parsed.data.file_name,
        file_mime: parsed.data.file_mime ?? "application/pdf",
        file_size: bytes.length,
        file_base64: parsed.data.file_base64,
        notes: parsed.data.notes ?? null,
        uploaded_by: req.profile.id
      }).select(SERVICE_REPORT_SELECT).single();
      if (error) return res.status(400).json({ message: error.message });
      res.status(201).json(flattenServiceReport(created));
    }
  );
  app.get(
    "/api/service-reports/:id/file",
    requireAuth,
    async (req, res) => {
      const { data, error } = await supabaseAnon.from("service_reports").select(
        "file_name, file_mime, file_base64, job:jobs!service_reports_job_id_fkey(area)"
      ).eq("id", req.params.id).single();
      if (error || !data || !data.file_base64)
        return res.status(404).json({ message: "File not found" });
      const scope = areaScopeOf(req.profile);
      const jobArea = data.job?.area ?? null;
      if (scope && jobArea !== scope)
        return res.status(404).json({ message: "File not found" });
      const buf = Buffer.from(data.file_base64, "base64");
      res.setHeader(
        "Content-Type",
        data.file_mime || "application/octet-stream"
      );
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${(data.file_name || "service-report").replace(/"/g, "")}"`
      );
      res.send(buf);
    }
  );
  app.delete(
    "/api/service-reports/:id",
    requireAuth,
    requireRole("admin", "area", "super"),
    async (req, res) => {
      const client = supabaseAdmin || supabaseAnon;
      const { data: existing } = await supabaseAnon.from("service_reports").select("id, job:jobs!service_reports_job_id_fkey(area)").eq("id", req.params.id).single();
      if (!existing)
        return res.status(404).json({ message: "Service report not found" });
      const scope = areaScopeOf(req.profile);
      const jobArea = existing.job?.area ?? null;
      if (scope && jobArea !== scope)
        return res.status(404).json({ message: "Service report not found" });
      const { error } = await client.from("service_reports").delete().eq("id", req.params.id);
      if (error) return res.status(400).json({ message: error.message });
      res.status(204).end();
    }
  );
  app.get(
    "/api/maintenance-matrix",
    requireAuth,
    async (req, res) => {
      const scope = areaScopeOf(req.profile);
      let q = supabaseAnon.from("assets").select(
        "id, tag, category, area, status, description, run_hours, run_hours_at_service, service_hours_interval, last_maintained"
      ).is("job_id", null).order("tag", { ascending: true });
      if (scope) q = q.eq("area", scope);
      const { data: assets, error } = await q;
      if (error) return res.status(500).json({ message: error.message });
      const rows = assets || [];
      const ids = rows.map((a) => a.id);
      const entryCount = {};
      const entryLast = {};
      const fileCount = {};
      const fileLast = {};
      if (ids.length) {
        const { data: entries } = await supabaseAnon.from("maintenance_reports").select("asset_id, filed_at").in("asset_id", ids);
        for (const e of entries || []) {
          entryCount[e.asset_id] = (entryCount[e.asset_id] || 0) + 1;
          if (!entryLast[e.asset_id] || e.filed_at > entryLast[e.asset_id])
            entryLast[e.asset_id] = e.filed_at;
        }
        const { data: files } = await supabaseAnon.from("maintenance_report_files").select("asset_id, created_at").in("asset_id", ids);
        for (const f of files || []) {
          fileCount[f.asset_id] = (fileCount[f.asset_id] || 0) + 1;
          if (!fileLast[f.asset_id] || f.created_at > fileLast[f.asset_id])
            fileLast[f.asset_id] = f.created_at;
        }
      }
      const matrix = rows.map((a) => {
        const eLast = entryLast[a.id] ?? null;
        const fLast = fileLast[a.id] ?? null;
        const last = eLast && fLast ? eLast > fLast ? eLast : fLast : eLast || fLast;
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
          last_activity: last
        };
      });
      res.json(matrix);
    }
  );
  const MAINTENANCE_FILE_SELECT = "id, asset_id, file_name, file_mime, file_size, work_performed, notes, uploaded_by, created_at, asset:assets(tag, area), uploader:profiles!maintenance_report_files_uploaded_by_fkey(name)";
  function flattenMaintenanceFile(row) {
    const { asset, uploader, ...rest } = row;
    return {
      ...rest,
      asset_tag: asset?.tag ?? null,
      area: asset?.area ?? null,
      uploaded_by_name: uploader?.name ?? null
    };
  }
  async function assetAreaOf(client, assetId) {
    const { data } = await client.from("assets").select("id, area").eq("id", assetId).single();
    return data ? data.area : null;
  }
  app.get(
    "/api/assets/:id/maintenance-files",
    requireAuth,
    async (req, res) => {
      const scope = areaScopeOf(req.profile);
      const area = await assetAreaOf(supabaseAnon, req.params.id);
      if (area == null)
        return res.status(404).json({ message: "Asset not found" });
      if (scope && area !== scope)
        return res.status(404).json({ message: "Asset not found" });
      const { data, error } = await supabaseAnon.from("maintenance_report_files").select(MAINTENANCE_FILE_SELECT).eq("asset_id", req.params.id).order("created_at", { ascending: false });
      if (error) return res.status(500).json({ message: error.message });
      res.json((data || []).map(flattenMaintenanceFile));
    }
  );
  app.post(
    "/api/assets/:id/maintenance-files",
    requireAuth,
    requireRole("admin", "area", "super"),
    async (req, res) => {
      const parsed = uploadMaintenanceFileSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      const client = supabaseAdmin || supabaseAnon;
      const area = await assetAreaOf(client, req.params.id);
      if (area == null)
        return res.status(404).json({ message: "Asset not found" });
      const scope = areaScopeOf(req.profile);
      if (scope && area !== scope)
        return res.status(403).json({ message: "Asset is outside your area" });
      const bytes = Buffer.from(parsed.data.file_base64, "base64");
      if (bytes.length === 0)
        return res.status(400).json({ message: "Uploaded file is empty" });
      const { data: created, error } = await client.from("maintenance_report_files").insert({
        asset_id: req.params.id,
        file_name: parsed.data.file_name,
        file_mime: parsed.data.file_mime ?? "application/pdf",
        file_size: bytes.length,
        file_base64: parsed.data.file_base64,
        work_performed: parsed.data.work_performed,
        notes: parsed.data.notes ?? null,
        uploaded_by: req.profile.id
      }).select(MAINTENANCE_FILE_SELECT).single();
      if (error) return res.status(400).json({ message: error.message });
      res.status(201).json(flattenMaintenanceFile(created));
    }
  );
  app.get(
    "/api/maintenance-files/:fileId/file",
    requireAuth,
    async (req, res) => {
      const { data, error } = await supabaseAnon.from("maintenance_report_files").select("file_name, file_mime, file_base64, asset:assets(area)").eq("id", req.params.fileId).single();
      if (error || !data || !data.file_base64)
        return res.status(404).json({ message: "File not found" });
      const scope = areaScopeOf(req.profile);
      const area = data.asset?.area ?? null;
      if (scope && area !== scope)
        return res.status(404).json({ message: "File not found" });
      const buf = Buffer.from(data.file_base64, "base64");
      res.setHeader(
        "Content-Type",
        data.file_mime || "application/octet-stream"
      );
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${(data.file_name || "maintenance-report").replace(/"/g, "")}"`
      );
      res.send(buf);
    }
  );
  app.delete(
    "/api/maintenance-files/:fileId",
    requireAuth,
    requireRole("admin", "area", "super"),
    async (req, res) => {
      const client = supabaseAdmin || supabaseAnon;
      const { data: existing } = await supabaseAnon.from("maintenance_report_files").select("id, asset:assets(area)").eq("id", req.params.fileId).single();
      if (!existing)
        return res.status(404).json({ message: "File not found" });
      const scope = areaScopeOf(req.profile);
      const area = existing.asset?.area ?? null;
      if (scope && area !== scope)
        return res.status(404).json({ message: "File not found" });
      const { error } = await client.from("maintenance_report_files").delete().eq("id", req.params.fileId);
      if (error) return res.status(400).json({ message: error.message });
      res.status(204).end();
    }
  );
  const WORK_ORDER_SELECT = "id, wo_number, asset_id, area, title, wo_type, priority, status, assigned_to, due_date, est_hours, notes, created_by, completed_at, created_at, asset:assets(tag, category), assigned:profiles!work_orders_assigned_to_fkey(name), creator:profiles!work_orders_created_by_fkey(name)";
  function flattenWorkOrder(row) {
    const { asset, assigned, creator, ...rest } = row;
    return {
      ...rest,
      asset_tag: asset?.tag ?? null,
      asset_category: asset?.category ?? null,
      assigned_to_name: assigned?.name ?? null,
      created_by_name: creator?.name ?? null
    };
  }
  app.get(
    "/api/work-orders/assignees",
    requireAuth,
    requireRole(...WORK_ORDER_MANAGE_ROLES),
    async (req, res) => {
      const scope = areaScopeOf(req.profile);
      let query = supabaseAnon.from("profiles").select("id, name, role, area").eq("active", true).order("name", { ascending: true });
      if (scope) query = query.or(`area.eq.${scope},area.is.null`);
      const { data, error } = await query;
      if (error) return res.status(500).json({ message: error.message });
      res.json(data || []);
    }
  );
  app.get(
    "/api/work-orders",
    requireAuth,
    async (req, res) => {
      const scope = areaScopeOf(req.profile);
      let query = supabaseAnon.from("work_orders").select(WORK_ORDER_SELECT).order("created_at", { ascending: false });
      if (scope) query = query.eq("area", scope);
      const { data, error } = await query;
      if (error) return res.status(500).json({ message: error.message });
      res.json((data || []).map(flattenWorkOrder));
    }
  );
  app.post(
    "/api/work-orders",
    requireAuth,
    requireRole(...WORK_ORDER_MANAGE_ROLES),
    async (req, res) => {
      const parsed = createWorkOrderSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0]?.message || "Invalid input" });
      const input = parsed.data;
      const area = await assetAreaOf(supabaseAnon, input.asset_id);
      if (area == null)
        return res.status(404).json({ message: "Asset not found" });
      const scope = areaScopeOf(req.profile);
      if (scope && area !== scope)
        return res.status(404).json({ message: "Asset not found" });
      const client = supabaseAdmin || supabaseAnon;
      const { data: seqData, error: seqErr } = await client.rpc("nextval", {
        seq: "work_order_seq"
      });
      let woNumber;
      if (seqErr || seqData == null) {
        const { count } = await client.from("work_orders").select("id", { count: "exact", head: true });
        woNumber = `WO-${5001 + (count || 0)}`;
      } else {
        woNumber = `WO-${seqData}`;
      }
      const isCompleted = input.status === "Completed";
      const { data, error } = await client.from("work_orders").insert({
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
        created_by: req.profile.id,
        completed_at: isCompleted ? (/* @__PURE__ */ new Date()).toISOString() : null
      }).select(WORK_ORDER_SELECT).single();
      if (error) return res.status(400).json({ message: error.message });
      res.status(201).json(flattenWorkOrder(data));
    }
  );
  app.patch(
    "/api/work-orders/:id",
    requireAuth,
    requireRole(...WORK_ORDER_MANAGE_ROLES),
    async (req, res) => {
      const parsed = updateWorkOrderSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0]?.message || "Invalid input" });
      const client = supabaseAdmin || supabaseAnon;
      const { data: existing } = await supabaseAnon.from("work_orders").select("id, area, status, completed_at").eq("id", req.params.id).single();
      if (!existing)
        return res.status(404).json({ message: "Work order not found" });
      const scope = areaScopeOf(req.profile);
      if (scope && existing.area !== scope)
        return res.status(404).json({ message: "Work order not found" });
      const patch = {};
      const input = parsed.data;
      if (input.title !== void 0) patch.title = input.title;
      if (input.wo_type !== void 0) patch.wo_type = input.wo_type;
      if (input.priority !== void 0) patch.priority = input.priority;
      if (input.assigned_to !== void 0) patch.assigned_to = input.assigned_to;
      if (input.due_date !== void 0) patch.due_date = input.due_date || null;
      if (input.est_hours !== void 0) patch.est_hours = input.est_hours;
      if (input.notes !== void 0) patch.notes = input.notes || null;
      if (input.status !== void 0) {
        patch.status = input.status;
        if (input.status === "Completed" && !existing.completed_at) {
          patch.completed_at = (/* @__PURE__ */ new Date()).toISOString();
        } else if (input.status !== "Completed") {
          patch.completed_at = null;
        }
      }
      if (Object.keys(patch).length === 0)
        return res.status(400).json({ message: "No changes provided" });
      const { data, error } = await client.from("work_orders").update(patch).eq("id", req.params.id).select(WORK_ORDER_SELECT).single();
      if (error) return res.status(400).json({ message: error.message });
      res.json(flattenWorkOrder(data));
    }
  );
  app.delete(
    "/api/work-orders/:id",
    requireAuth,
    requireRole(...WORK_ORDER_MANAGE_ROLES),
    async (req, res) => {
      const client = supabaseAdmin || supabaseAnon;
      const { data: existing } = await supabaseAnon.from("work_orders").select("id, area").eq("id", req.params.id).single();
      if (!existing)
        return res.status(404).json({ message: "Work order not found" });
      const scope = areaScopeOf(req.profile);
      if (scope && existing.area !== scope)
        return res.status(404).json({ message: "Work order not found" });
      const { error } = await client.from("work_orders").delete().eq("id", req.params.id);
      if (error) return res.status(400).json({ message: error.message });
      res.status(204).end();
    }
  );
  app.post(
    "/api/reports/:id/signoff",
    requireAuth,
    requireRole("area", "admin"),
    async (req, res) => {
      const client = supabaseAdmin || supabaseAnon;
      const { data: report } = await client.from("maintenance_reports").select("*, asset:assets(*)").eq("id", req.params.id).single();
      if (!report) return res.status(404).json({ message: "Report not found" });
      if (report.status === "Signed off")
        return res.status(400).json({ message: "Already signed off" });
      if (req.profile.role === "area" && report.asset?.area !== req.profile.area)
        return res.status(403).json({ message: "Outside your area" });
      const { error: sErr } = await client.from("sign_offs").insert({
        report_id: report.id,
        area_mgr_id: req.profile.id
      });
      if (sErr) return res.status(400).json({ message: sErr.message });
      await client.from("maintenance_reports").update({ status: "Signed off" }).eq("id", report.id);
      await client.from("audit_events").insert({
        report_id: report.id,
        asset_id: report.asset_id,
        actor_id: req.profile.id,
        actor_name: req.profile.name,
        actor_role: req.profile.role,
        action: "Signed off"
      });
      sendNotificationEmails("signed", {
        report,
        asset: report.asset,
        signerName: req.profile.name
      }).catch((e) => console.error("[email] signed", e));
      res.json({ ok: true });
    }
  );
  app.get(
    "/api/assets/:id/audit",
    requireAuth,
    async (req, res) => {
      const { data, error } = await supabaseAnon.from("audit_events").select("*").eq("asset_id", req.params.id).order("occurred_at", { ascending: false });
      if (error) return res.status(500).json({ message: error.message });
      res.json(data);
    }
  );
  app.put(
    "/api/notification-prefs",
    requireAuth,
    async (req, res) => {
      const parsed = notifPrefsSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      const client = supabaseAdmin || supabaseAnon;
      const { data, error } = await client.from("notification_prefs").upsert({ user_id: req.profile.id, ...parsed.data }).select().single();
      if (error) return res.status(400).json({ message: error.message });
      res.json(data);
    }
  );
  app.post("/api/daily-reports/ingest", async (req, res) => {
    if (!INGEST_TOKEN)
      return res.status(503).json({ message: "Ingest not configured (set INGEST_TOKEN)." });
    if (req.header("x-ingest-token") !== INGEST_TOKEN)
      return res.status(401).json({ message: "Bad ingest token" });
    const parsed = ingestDailyReportSchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ message: parsed.error.errors[0].message });
    const client = supabaseAdmin || supabaseAnon;
    const p = parsed.data;
    const { data: existing } = await client.from("daily_reports").select("*").eq("email_message_id", p.email_message_id).maybeSingle();
    if (existing) return res.status(200).json({ ...existing, deduped: true });
    let excel;
    try {
      const buf = Buffer.from(p.attachment_base64, "base64");
      excel = parseDailyReportWorkbook(buf, p.report_day ?? void 0);
    } catch (e) {
      if (e instanceof ExcelParseError)
        return res.status(422).json({ message: e.message });
      return res.status(422).json({ message: `Failed to parse Excel attachment: ${e?.message ?? e}` });
    }
    let job_id = null;
    let area = null;
    let customer_id = null;
    if (excel.well_name) {
      const { data: jobs } = await client.from("jobs").select("id, area, customer_id, well_name").not("well_name", "is", null);
      const target = excel.well_name.trim().toLowerCase();
      const match = (jobs || []).find(
        (j) => (j.well_name || "").trim().toLowerCase() === target
      );
      if (match) {
        job_id = match.id;
        area = match.area;
        customer_id = match.customer_id;
      }
    }
    const status = job_id ? "Pending Review" : "Needs job match";
    const row = {
      email_message_id: p.email_message_id,
      sender_email: p.sender_email,
      sender_name: p.sender_name ?? null,
      subject: p.subject ?? null,
      received_at: p.received_at ?? (/* @__PURE__ */ new Date()).toISOString(),
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
      status
    };
    const { data, error } = await client.from("daily_reports").insert(row).select().single();
    if (error) return res.status(400).json({ message: error.message });
    await client.from("daily_report_events").insert({
      report_id: data.id,
      actor_name: p.sender_name || p.sender_email,
      actor_role: "field",
      action: "ingested",
      detail: `Imported ${excel.source_sheet} from "${p.attachment_name}"` + (job_id ? ` and matched well "${excel.well_name}" to a job.` : ` \u2014 well "${excel.well_name ?? "(none)"}" did not match any job; awaiting assignment.`)
    });
    if (excel.incomplete) {
      await client.from("daily_report_events").insert({
        report_id: data.id,
        actor_name: "System",
        actor_role: "field",
        action: "needs_review",
        detail: `No completed day sheet was found in "${p.attachment_name}" \u2014 imported ${excel.source_sheet} with the values present. A supervisor or area manager should review and sign off.`
      });
    }
    res.status(201).json(data);
  });
  app.post(
    "/api/daily-reports/:id/assign-job",
    requireAuth,
    requireRole("admin", "area", "super"),
    async (req, res) => {
      const parsed = assignDailyReportJobSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      const client = supabaseAdmin || supabaseAnon;
      const { data: report, error: rErr } = await client.from("daily_reports").select("*").eq("id", req.params.id).single();
      if (rErr || !report)
        return res.status(404).json({ message: "Report not found" });
      const { data: job, error: jErr } = await client.from("jobs").select("id, area, customer_id, job_number").eq("id", parsed.data.job_id).single();
      if (jErr || !job)
        return res.status(404).json({ message: "Job not found" });
      const scope = areaScopeOf(req.profile);
      if (scope && job.area !== scope)
        return res.status(403).json({ message: "You can only assign reports to jobs in your area." });
      const { data, error } = await client.from("daily_reports").update({
        job_id: job.id,
        area: job.area,
        customer_id: job.customer_id,
        status: "Pending Review"
      }).eq("id", report.id).select().single();
      if (error) return res.status(400).json({ message: error.message });
      await client.from("daily_report_events").insert({
        report_id: report.id,
        actor_id: req.profile.id,
        actor_name: req.profile.name,
        actor_role: req.profile.role,
        action: "assigned",
        detail: `Assigned to job ${job.job_number} (${job.area}).`
      });
      res.json(data);
    }
  );
  app.get("/api/daily-reports", requireAuth, async (req, res) => {
    const scope = areaScopeOf(req.profile);
    const jobIds = await jobScopeOf(req.profile);
    let q = supabaseAnon.from("daily_reports").select(
      "*, customer:customers(name), job:jobs(job_number), submitter:profiles!daily_reports_submitted_by_fkey(name), signer:profiles!daily_reports_signed_by_fkey(name)"
    ).order("received_at", { ascending: false });
    if (scope) q = q.eq("area", scope);
    const srcFilter = String(req.query.source || "").toLowerCase();
    if (srcFilter === "email" || srcFilter === "field") q = q.eq("source", srcFilter);
    const { data, error } = await q;
    if (error) return res.status(500).json({ message: error.message });
    let rows = (data || []).map((r) => ({
      ...r,
      customer_name: r.customer?.name ?? null,
      job_number: r.job?.job_number ?? null,
      submitted_by_name: r.submitter?.name ?? null,
      signed_by_name: r.signer?.name ?? null,
      customer: void 0,
      job: void 0,
      submitter: void 0,
      signer: void 0
    }));
    if (jobIds) rows = rows.filter((r) => jobIds.includes(r.job_id));
    const statusFilter = String(req.query.status || "").toLowerCase();
    if (statusFilter === "pending")
      rows = rows.filter((r) => r.status !== "Signed off");
    else if (statusFilter === "signed")
      rows = rows.filter((r) => r.status === "Signed off");
    res.json(rows);
  });
  app.get("/api/daily-reports/:id", requireAuth, async (req, res) => {
    const { data, error } = await supabaseAnon.from("daily_reports").select(
      "*, customer:customers(name), job:jobs(job_number), submitter:profiles!daily_reports_submitted_by_fkey(name), signer:profiles!daily_reports_signed_by_fkey(name)"
    ).eq("id", req.params.id).single();
    if (error || !data)
      return res.status(404).json({ message: "Report not found" });
    const scope = areaScopeOf(req.profile);
    if (scope && data.area !== scope)
      return res.status(404).json({ message: "Report not found" });
    const jobIds = await jobScopeOf(req.profile);
    if (jobIds && !jobIds.includes(data.job_id))
      return res.status(404).json({ message: "Report not found" });
    const { data: events } = await supabaseAnon.from("daily_report_events").select("*").eq("report_id", req.params.id).order("occurred_at", { ascending: false });
    const { customer, job, submitter, signer, ...rest } = data;
    res.json({
      ...rest,
      customer_name: customer?.name ?? null,
      job_number: job?.job_number ?? null,
      submitted_by_name: submitter?.name ?? null,
      signed_by_name: signer?.name ?? null,
      events: events || []
    });
  });
  app.get(
    "/api/daily-reports/:id/centrifuges",
    requireAuth,
    requireRole("admin", "area", "super"),
    async (req, res) => {
      const client = supabaseAdmin || supabaseAnon;
      const { data: report, error: rErr } = await client.from("daily_reports").select("id, area, job_id, kpis, run_hours_applied").eq("id", req.params.id).single();
      if (rErr || !report)
        return res.status(404).json({ message: "Report not found" });
      const scope = areaScopeOf(req.profile);
      if (scope && report.area !== scope)
        return res.status(404).json({ message: "Report not found" });
      const dailyRaw = report.kpis?.daily_run_hours;
      const daily_run_hours = dailyRaw == null || dailyRaw === "" ? null : Number(dailyRaw);
      let centrifuges = [];
      if (report.job_id) {
        const { data: assets } = await client.from("assets").select("id, tag, category, run_hours").eq("job_id", report.job_id).in("category", RUN_HOUR_CATEGORIES);
        centrifuges = (assets || []).map((a) => ({
          id: a.id,
          tag: a.tag,
          category: a.category,
          run_hours: a.run_hours
        }));
      }
      res.json({
        daily_run_hours: daily_run_hours != null && Number.isFinite(daily_run_hours) ? daily_run_hours : null,
        already_applied: !!report.run_hours_applied,
        centrifuges
      });
    }
  );
  app.post(
    "/api/daily-reports/:id/review",
    requireAuth,
    requireRole("admin", "area", "super"),
    async (req, res) => {
      const parsed = reviewDailyReportSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      const client = supabaseAdmin || supabaseAnon;
      const { data: report, error: rErr } = await client.from("daily_reports").select("*").eq("id", req.params.id).single();
      if (rErr || !report)
        return res.status(404).json({ message: "Report not found" });
      const scope = areaScopeOf(req.profile);
      if (scope && report.area !== scope)
        return res.status(404).json({ message: "Report not found" });
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const reviewer = req.profile;
      if (parsed.data.action === "sign_off") {
        let runHourDetail = null;
        const dailyRaw = report.kpis?.daily_run_hours;
        const dailyHours = dailyRaw == null || dailyRaw === "" ? null : Number(dailyRaw);
        if (!report.run_hours_applied && report.job_id && dailyHours != null && Number.isFinite(dailyHours) && dailyHours > 0) {
          const { data: centAssets } = await client.from("assets").select("id, tag, category, run_hours").eq("job_id", report.job_id).in("category", RUN_HOUR_CATEGORIES);
          const centrifuges = centAssets || [];
          let allocation = [];
          if (centrifuges.length === 1) {
            const c = centrifuges[0];
            allocation = [{ asset_id: c.id, tag: c.tag, add: dailyHours }];
          } else if (centrifuges.length >= 2) {
            const provided = parsed.data.run_hour_allocations;
            if (!provided || provided.length === 0) {
              return res.status(400).json({
                message: "This job has multiple centrifuges. Allocate the day's run hours to each before signing off."
              });
            }
            const validIds = new Set(centrifuges.map((c) => c.id));
            for (const a of provided) {
              if (!validIds.has(a.asset_id))
                return res.status(400).json({
                  message: "Allocation references an asset that isn't a centrifuge on this job."
                });
            }
            const sum = provided.reduce((s, a) => s + a.hours, 0);
            if (Math.abs(sum - dailyHours) > 0.01) {
              return res.status(400).json({
                message: `Allocated hours (${sum}) must add up to the day's run hours (${dailyHours}).`
              });
            }
            allocation = provided.filter((a) => a.hours > 0).map((a) => {
              const c = centrifuges.find((x) => x.id === a.asset_id);
              return { asset_id: a.asset_id, tag: c?.tag ?? a.asset_id, add: a.hours };
            });
          }
          const applied = [];
          for (const a of allocation) {
            const cur = centrifuges.find((x) => x.id === a.asset_id);
            const base = Number(cur?.run_hours ?? 0) || 0;
            const next = base + a.add;
            const { error: uErr } = await client.from("assets").update({ run_hours: next }).eq("id", a.asset_id);
            if (uErr)
              return res.status(400).json({
                message: `Could not update run hours for ${a.tag}: ${uErr.message}`
              });
            applied.push(`${a.tag} +${a.add} hrs`);
          }
          if (applied.length > 0)
            runHourDetail = `Run hours applied: ${applied.join(", ")}`;
        }
        const { data: data2, error: error2 } = await client.from("daily_reports").update({
          status: "Signed off",
          reviewed_by: reviewer.id,
          reviewed_by_name: reviewer.name,
          reviewed_at: now,
          change_notes: null,
          run_hours_applied: runHourDetail ? true : report.run_hours_applied
        }).eq("id", report.id).select().single();
        if (error2) return res.status(400).json({ message: error2.message });
        await client.from("daily_report_events").insert({
          report_id: report.id,
          actor_id: reviewer.id,
          actor_name: reviewer.name,
          actor_role: reviewer.role,
          action: "signed_off",
          detail: runHourDetail
        });
        return res.json(data2);
      }
      const delivered = await sendDailyReportChanges({
        to: report.sender_email,
        senderName: report.sender_name,
        subject: report.subject,
        reviewerName: reviewer.name,
        changeNotes: parsed.data.change_notes.trim(),
        reportDate: report.report_date
      });
      const emailStatus = delivered ? "Sent" : "Pending send";
      const { data, error } = await client.from("daily_reports").update({
        status: "Changes requested",
        reviewed_by: reviewer.id,
        reviewed_by_name: reviewer.name,
        reviewed_at: now,
        change_notes: parsed.data.change_notes.trim(),
        email_out_status: emailStatus,
        email_out_at: delivered ? now : null
      }).eq("id", report.id).select().single();
      if (error) return res.status(400).json({ message: error.message });
      await client.from("daily_report_events").insert({
        report_id: report.id,
        actor_id: reviewer.id,
        actor_name: reviewer.name,
        actor_role: reviewer.role,
        action: "changes_requested",
        detail: delivered ? `Suggested changes emailed to ${report.sender_email}` : `Suggested changes recorded; email queued for ${report.sender_email}`
      });
      res.json(data);
    }
  );
  app.get(
    "/api/daily-reports-config",
    requireAuth,
    requireRole("admin"),
    async (_req, res) => {
      const { data, error } = await supabaseAnon.from("daily_report_config").select("*").eq("id", 1).single();
      if (error) return res.status(500).json({ message: error.message });
      res.json({ ...data, email_out_ready: emailConfigured(), ingest_ready: !!INGEST_TOKEN });
    }
  );
  app.put(
    "/api/daily-reports-config",
    requireAuth,
    requireRole("admin"),
    async (req, res) => {
      const parsed = updateDailyReportConfigSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      const client = supabaseAdmin || supabaseAnon;
      const patch = { ...parsed.data, updated_at: (/* @__PURE__ */ new Date()).toISOString() };
      if (patch.inbox_email === "") patch.inbox_email = null;
      const { data, error } = await client.from("daily_report_config").update(patch).eq("id", 1).select().single();
      if (error) return res.status(400).json({ message: error.message });
      res.json(data);
    }
  );
  const JSA_LIST_COLS = "id, email_message_id, sender_email, sender_name, subject, received_at, jsa_date, area, customer_id, job_id, job_number_raw, attachment_name, attachment_mime, attachment_size, status, signed_off_by, signed_off_by_name, signed_off_at, created_at";
  const parseJobNumber = (subject) => {
    if (!subject) return null;
    const m = subject.match(/\b[A-Za-z]{1,4}[-\s]?\d{2,6}\b/);
    return m ? m[0].replace(/\s+/g, "-").toUpperCase() : null;
  };
  app.post("/api/jsa-intake/ingest", async (req, res) => {
    if (!INGEST_TOKEN)
      return res.status(503).json({ message: "Ingest not configured (set INGEST_TOKEN)." });
    if (req.header("x-ingest-token") !== INGEST_TOKEN)
      return res.status(401).json({ message: "Bad ingest token" });
    const parsed = ingestJsaSchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ message: parsed.error.errors[0].message });
    const client = supabaseAdmin || supabaseAnon;
    const p = parsed.data;
    const { data: existing } = await client.from("jsa_reports").select(JSA_LIST_COLS).eq("email_message_id", p.email_message_id).maybeSingle();
    if (existing) return res.status(200).json({ ...existing, deduped: true });
    const jobNumber = p.job_number && p.job_number.trim() || parseJobNumber(p.subject);
    let job_id = null;
    let area = null;
    let customer_id = null;
    if (jobNumber) {
      const { data: jobs } = await client.from("jobs").select("id, area, customer_id, job_number");
      const target = jobNumber.trim().toLowerCase();
      const match = (jobs || []).find(
        (j) => (j.job_number || "").trim().toLowerCase() === target
      );
      if (match) {
        job_id = match.id;
        area = match.area;
        customer_id = match.customer_id;
      }
    }
    const bytes = Buffer.from(p.attachment_base64, "base64");
    const status = job_id ? "Pending sign-off" : "Needs job match";
    const row = {
      email_message_id: p.email_message_id,
      sender_email: p.sender_email,
      sender_name: p.sender_name ?? null,
      subject: p.subject ?? null,
      received_at: p.received_at ?? (/* @__PURE__ */ new Date()).toISOString(),
      jsa_date: p.jsa_date ?? null,
      job_number_raw: jobNumber,
      attachment_name: p.attachment_name,
      attachment_mime: p.attachment_mime ?? "application/pdf",
      attachment_size: bytes.length,
      attachment_base64: p.attachment_base64,
      area,
      customer_id,
      job_id,
      status
    };
    const { data, error } = await client.from("jsa_reports").insert(row).select(JSA_LIST_COLS).single();
    if (error) return res.status(400).json({ message: error.message });
    await client.from("jsa_report_events").insert({
      jsa_id: data.id,
      actor_name: p.sender_name || p.sender_email,
      actor_role: "field",
      action: "received",
      detail: `Received JSA "${p.attachment_name}"` + (job_id ? ` and matched job ${jobNumber} to this JSA.` : jobNumber ? ` \u2014 job number "${jobNumber}" did not match any job; awaiting assignment.` : ` \u2014 no job number found in the subject; awaiting assignment.`)
    });
    res.status(201).json(data);
  });
  app.get("/api/jsa-intake", requireAuth, async (req, res) => {
    const scope = areaScopeOf(req.profile);
    let q = supabaseAnon.from("jsa_reports").select(`${JSA_LIST_COLS}, customer:customers(name), job:jobs(job_number)`).order("received_at", { ascending: false });
    if (scope) q = q.eq("area", scope);
    const { data, error } = await q;
    if (error) return res.status(500).json({ message: error.message });
    const rows = (data || []).map((r) => ({
      ...r,
      customer_name: r.customer?.name ?? null,
      job_number: r.job?.job_number ?? null,
      customer: void 0,
      job: void 0
    }));
    res.json(rows);
  });
  app.get("/api/jsa-intake/:id", requireAuth, async (req, res) => {
    const { data, error } = await supabaseAnon.from("jsa_reports").select(`${JSA_LIST_COLS}, customer:customers(name), job:jobs(job_number)`).eq("id", req.params.id).single();
    if (error || !data) return res.status(404).json({ message: "JSA not found" });
    const scope = areaScopeOf(req.profile);
    if (scope && data.area !== scope)
      return res.status(404).json({ message: "JSA not found" });
    const { data: events } = await supabaseAnon.from("jsa_report_events").select("*").eq("jsa_id", req.params.id).order("occurred_at", { ascending: false });
    const { customer, job, ...rest } = data;
    res.json({
      ...rest,
      customer_name: customer?.name ?? null,
      job_number: job?.job_number ?? null,
      events: events || []
    });
  });
  app.get(
    "/api/jsa-intake/:id/attachment",
    requireAuth,
    async (req, res) => {
      const { data, error } = await supabaseAnon.from("jsa_reports").select("area, attachment_name, attachment_mime, attachment_base64").eq("id", req.params.id).single();
      if (error || !data) return res.status(404).json({ message: "JSA not found" });
      const scope = areaScopeOf(req.profile);
      if (scope && data.area !== scope)
        return res.status(404).json({ message: "JSA not found" });
      const buf = Buffer.from(data.attachment_base64, "base64");
      res.setHeader("Content-Type", data.attachment_mime || "application/octet-stream");
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${(data.attachment_name || "jsa").replace(/\"/g, "")}"`
      );
      res.send(buf);
    }
  );
  app.get(
    "/api/jsa-intake/:id/preview",
    requireAuth,
    async (req, res) => {
      const { data, error } = await supabaseAnon.from("jsa_reports").select("area, attachment_name, attachment_mime, attachment_base64").eq("id", req.params.id).single();
      if (error || !data) return res.status(404).json({ message: "JSA not found" });
      const scope = areaScopeOf(req.profile);
      if (scope && data.area !== scope)
        return res.status(404).json({ message: "JSA not found" });
      const name = (data.attachment_name || "").toLowerCase();
      const mime = (data.attachment_mime || "").toLowerCase();
      const looksSpreadsheet = /\.(xlsx|xlsm|xls|csv)$/.test(name) || mime.includes("spreadsheet") || mime.includes("excel") || mime === "text/csv";
      if (!looksSpreadsheet) {
        return res.json({
          previewable: false,
          reason: "not_spreadsheet",
          attachment_name: data.attachment_name,
          attachment_mime: data.attachment_mime
        });
      }
      try {
        const buf = Buffer.from(data.attachment_base64, "base64");
        const wb = XLSX2.read(buf, { type: "buffer", cellDates: true });
        const fmt = (v) => {
          if (v === null || v === void 0) return "";
          if (v instanceof Date) {
            if (isNaN(v.getTime())) return "";
            return v.toLocaleDateString("en-US");
          }
          return String(v).replace(/\s+/g, " ").trim();
        };
        const jsaName = wb.SheetNames.find((n) => /jsa/i.test(n)) || wb.SheetNames[0];
        const ws2 = wb.Sheets[jsaName];
        const grid = XLSX2.utils.sheet_to_json(ws2, {
          header: 1,
          blankrows: false,
          defval: null,
          raw: false
        });
        const cell = (r, c) => fmt(grid[r - 1] ? grid[r - 1][c - 1] : "");
        const headerRows = [2, 3, 4, 5];
        const header = [];
        for (const r of headerRows) {
          for (const [lc, vc] of [
            [1, 2],
            [10, 11]
          ]) {
            const label = cell(r, lc).replace(/:\s*$/, "");
            const value = cell(r, vc);
            if (label && value) header.push({ label, value });
          }
        }
        const tableCols = [1, 6, 9, 11];
        let headerRowIdx = -1;
        for (let r = 1; r <= grid.length; r++) {
          const a = cell(r, 1);
          const f = cell(r, 6);
          if (/^activity\b/i.test(a) && /list the tasks/i.test(a) && /^hazards/i.test(f)) {
            headerRowIdx = r;
            break;
          }
        }
        const colTitle = (raw) => {
          const trimmed = raw.replace(/\s*(List the|Against each|Write the).*$/i, "").trim();
          return trimmed || raw;
        };
        let table = null;
        if (headerRowIdx > 0) {
          const columns = tableCols.map((c) => colTitle(cell(headerRowIdx, c)));
          const rows2 = [];
          for (let r = headerRowIdx + 1; r <= grid.length; r++) {
            const first = cell(r, 1);
            if (/^remember:/i.test(first) || /^e-?mail jsa/i.test(first)) break;
            const vals = tableCols.map((c) => cell(r, c));
            if (vals.some((v) => v !== "")) rows2.push(vals);
          }
          if (rows2.length) table = { columns, rows: rows2 };
        }
        if (header.length || table) {
          return res.json({
            previewable: true,
            structured: true,
            attachment_name: data.attachment_name,
            header,
            table
          });
        }
        const MAX_ROWS = 200;
        const rows = [];
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
        const keepCols = [];
        for (let i = 0; i < maxCol; i++)
          if (padded.some((r) => (r[i] ?? "") !== "")) keepCols.push(i);
        const finalRows = padded.map((r) => keepCols.map((i) => r[i] ?? ""));
        return res.json({
          previewable: true,
          structured: false,
          attachment_name: data.attachment_name,
          sheets: finalRows.length ? [{ name: jsaName, rows: finalRows, truncated: grid.length > MAX_ROWS }] : []
        });
      } catch (e) {
        return res.json({
          previewable: false,
          reason: "parse_error",
          attachment_name: data.attachment_name,
          attachment_mime: data.attachment_mime
        });
      }
    }
  );
  app.post(
    "/api/jsa-intake/:id/assign-job",
    requireAuth,
    requireRole("admin", "area", "super"),
    async (req, res) => {
      const parsed = assignJsaJobSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      const client = supabaseAdmin || supabaseAnon;
      const { data: jsa, error: jErr } = await client.from("jsa_reports").select(JSA_LIST_COLS).eq("id", req.params.id).single();
      if (jErr || !jsa) return res.status(404).json({ message: "JSA not found" });
      const { data: job, error: jobErr } = await client.from("jobs").select("id, area, customer_id, job_number").eq("id", parsed.data.job_id).single();
      if (jobErr || !job) return res.status(404).json({ message: "Job not found" });
      const scope = areaScopeOf(req.profile);
      if (scope && job.area !== scope)
        return res.status(403).json({ message: "You can only assign JSAs to jobs in your area." });
      const { data, error } = await client.from("jsa_reports").update({
        job_id: job.id,
        area: job.area,
        customer_id: job.customer_id,
        status: "Pending sign-off"
      }).eq("id", jsa.id).select(JSA_LIST_COLS).single();
      if (error) return res.status(400).json({ message: error.message });
      await client.from("jsa_report_events").insert({
        jsa_id: jsa.id,
        actor_id: req.profile.id,
        actor_name: req.profile.name,
        actor_role: req.profile.role,
        action: "assigned",
        detail: `Assigned to job ${job.job_number} (${job.area}).`
      });
      res.json(data);
    }
  );
  app.post(
    "/api/jsa-intake/:id/sign-off",
    requireAuth,
    requireRole("admin", "area", "super"),
    async (req, res) => {
      const client = supabaseAdmin || supabaseAnon;
      const { data: jsa, error: jErr } = await client.from("jsa_reports").select(JSA_LIST_COLS).eq("id", req.params.id).single();
      if (jErr || !jsa) return res.status(404).json({ message: "JSA not found" });
      const scope = areaScopeOf(req.profile);
      if (scope && jsa.area !== scope)
        return res.status(404).json({ message: "JSA not found" });
      if (!jsa.job_id)
        return res.status(409).json({ message: "Assign this JSA to a job before signing off." });
      if (jsa.status === "Signed off")
        return res.status(409).json({ message: "This JSA is already signed off." });
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const signer = req.profile;
      const { data, error } = await client.from("jsa_reports").update({
        status: "Signed off",
        signed_off_by: signer.id,
        signed_off_by_name: signer.name,
        signed_off_at: now
      }).eq("id", jsa.id).select(JSA_LIST_COLS).single();
      if (error) return res.status(400).json({ message: error.message });
      await client.from("jsa_report_events").insert({
        jsa_id: jsa.id,
        actor_id: signer.id,
        actor_name: signer.name,
        actor_role: signer.role,
        action: "signed_off",
        detail: null
      });
      res.json(data);
    }
  );
  const RIG_UP_LIST_COLS = "id, job_id, area, customer_id, report_date, title, notes, attachment_name, attachment_mime, attachment_size, status, uploaded_by, uploaded_by_name, signed_off_by, signed_off_by_name, signed_off_at, created_at";
  app.get(
    "/api/rig-up-reports",
    requireAuth,
    async (req, res) => {
      const scope = areaScopeOf(req.profile);
      let q = supabaseAnon.from("rig_up_reports").select(
        `${RIG_UP_LIST_COLS}, jobs:jobs!rig_up_reports_job_id_fkey(job_number), customers:customers!rig_up_reports_customer_id_fkey(name)`
      ).order("created_at", { ascending: false });
      if (scope) q = q.eq("area", scope);
      const { data, error } = await q;
      if (error) return res.status(500).json({ message: error.message });
      const rows = (data || []).map((r) => {
        const { jobs, customers, ...rest } = r;
        return {
          ...rest,
          job_number: jobs?.job_number ?? null,
          customer_name: customers?.name ?? null
        };
      });
      res.json(rows);
    }
  );
  app.post(
    "/api/rig-up-reports",
    requireAuth,
    requireRole("admin", "area", "super"),
    async (req, res) => {
      const parsed = createRigUpReportSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      const p = parsed.data;
      const client = supabaseAdmin || supabaseAnon;
      const { data: job, error: jobErr } = await client.from("jobs").select("id, area, customer_id, job_number").eq("id", p.job_id).single();
      if (jobErr || !job) return res.status(404).json({ message: "Job not found" });
      const scope = areaScopeOf(req.profile);
      if (scope && job.area !== scope)
        return res.status(403).json({ message: "You can only upload rig-up reports for jobs in your area." });
      const bytes = Buffer.from(p.attachment_base64, "base64");
      const { data, error } = await client.from("rig_up_reports").insert({
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
        uploaded_by: req.profile.id,
        uploaded_by_name: req.profile.name
      }).select(RIG_UP_LIST_COLS).single();
      if (error) return res.status(400).json({ message: error.message });
      await client.from("rig_up_report_events").insert({
        rig_up_id: data.id,
        actor_id: req.profile.id,
        actor_name: req.profile.name,
        actor_role: req.profile.role,
        action: "uploaded",
        detail: `Uploaded rig-up report for job ${job.job_number} (${job.area}).`
      });
      res.status(201).json(data);
    }
  );
  app.get(
    "/api/rig-up-reports/:id/attachment",
    requireAuth,
    async (req, res) => {
      const { data, error } = await supabaseAnon.from("rig_up_reports").select("area, attachment_name, attachment_mime, attachment_base64").eq("id", req.params.id).single();
      if (error || !data || !data.attachment_base64)
        return res.status(404).json({ message: "Attachment not found" });
      const scope = areaScopeOf(req.profile);
      if (scope && data.area !== scope)
        return res.status(404).json({ message: "Attachment not found" });
      const buf = Buffer.from(data.attachment_base64, "base64");
      res.setHeader(
        "Content-Type",
        data.attachment_mime || "application/octet-stream"
      );
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${(data.attachment_name || "rig-up-report").replace(/"/g, "")}"`
      );
      res.send(buf);
    }
  );
  app.post(
    "/api/rig-up-reports/:id/sign-off",
    requireAuth,
    requireRole("admin", "area"),
    async (req, res) => {
      const client = supabaseAdmin || supabaseAnon;
      const { data: report, error: rErr } = await client.from("rig_up_reports").select(RIG_UP_LIST_COLS).eq("id", req.params.id).single();
      if (rErr || !report)
        return res.status(404).json({ message: "Rig-up report not found" });
      const scope = areaScopeOf(req.profile);
      if (scope && report.area !== scope)
        return res.status(403).json({
          message: "Only the area manager for this job's area can sign off this rig-up report."
        });
      if (report.status === "Signed off")
        return res.status(409).json({ message: "This rig-up report is already signed off." });
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const signer = req.profile;
      const { data, error } = await client.from("rig_up_reports").update({
        status: "Signed off",
        signed_off_by: signer.id,
        signed_off_by_name: signer.name,
        signed_off_at: now
      }).eq("id", report.id).select(RIG_UP_LIST_COLS).single();
      if (error) return res.status(400).json({ message: error.message });
      await client.from("rig_up_report_events").insert({
        rig_up_id: report.id,
        actor_id: signer.id,
        actor_name: signer.name,
        actor_role: signer.role,
        action: "signed_off",
        detail: null
      });
      res.json(data);
    }
  );
  app.delete(
    "/api/rig-up-reports/:id",
    requireAuth,
    requireRole("admin", "area"),
    async (req, res) => {
      const client = supabaseAdmin || supabaseAnon;
      const { data: report, error: rErr } = await client.from("rig_up_reports").select("id, area").eq("id", req.params.id).single();
      if (rErr || !report)
        return res.status(404).json({ message: "Rig-up report not found" });
      const scope = areaScopeOf(req.profile);
      if (scope && report.area !== scope)
        return res.status(404).json({ message: "Rig-up report not found" });
      const { error } = await client.from("rig_up_reports").delete().eq("id", report.id);
      if (error) return res.status(400).json({ message: error.message });
      res.status(204).end();
    }
  );
  const CERT_LIST_COLS = "id, profile_id, cert_type, issuing_org, issue_date, expiry_date, attachment_name, attachment_mime, attachment_size, notes, uploaded_by, created_at";
  app.get(
    "/api/certifications",
    requireAuth,
    async (req, res) => {
      const scope = areaScopeOf(req.profile);
      let pq = supabaseAnon.from("profiles").select("id, email, name, role, area, active, created_at").in("role", CERT_ROSTER_ROLES).eq("active", true).order("name", { ascending: true });
      if (scope) pq = pq.eq("area", scope);
      const { data: people, error: pErr } = await pq;
      if (pErr) return res.status(500).json({ message: pErr.message });
      const ids = (people || []).map((p) => p.id);
      let certs = [];
      if (ids.length) {
        const { data: cdata, error: cErr } = await supabaseAnon.from("certifications").select(CERT_LIST_COLS).in("profile_id", ids).order("expiry_date", { ascending: true, nullsFirst: false });
        if (cErr) return res.status(500).json({ message: cErr.message });
        certs = cdata || [];
      }
      const uploaderIds = Array.from(
        new Set(certs.map((c) => c.uploaded_by).filter(Boolean))
      );
      let uploaderNames = {};
      if (uploaderIds.length) {
        const { data: us } = await supabaseAnon.from("profiles").select("id, name").in("id", uploaderIds);
        for (const u of us || []) uploaderNames[u.id] = u.name;
      }
      const byProfile = {};
      for (const c of certs) {
        const p = (people || []).find((x) => x.id === c.profile_id);
        const enriched = {
          ...c,
          employee_name: p?.name ?? null,
          employee_role: p?.role ?? null,
          employee_area: p?.area ?? null,
          uploaded_by_name: c.uploaded_by ? uploaderNames[c.uploaded_by] ?? null : null
        };
        (byProfile[c.profile_id] ||= []).push(enriched);
      }
      const roster = (people || []).map((p) => ({
        profile: p,
        certs: byProfile[p.id] || []
      }));
      res.json(roster);
    }
  );
  app.post(
    "/api/certifications",
    requireAuth,
    requireRole("admin", "area"),
    async (req, res) => {
      const parsed = createCertificationSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      const p = parsed.data;
      const client = supabaseAdmin || supabaseAnon;
      const { data: emp, error: eErr } = await supabaseAnon.from("profiles").select("id, role, area").eq("id", p.profile_id).single();
      if (eErr || !emp)
        return res.status(404).json({ message: "Employee not found" });
      if (!CERT_ROSTER_ROLES.includes(emp.role))
        return res.status(400).json({ message: "Certifications apply to field employees only." });
      const scope = areaScopeOf(req.profile);
      if (scope && emp.area !== scope)
        return res.status(403).json({ message: "You can only manage employees in your area." });
      const row = {
        profile_id: p.profile_id,
        cert_type: p.cert_type,
        issuing_org: p.issuing_org ?? null,
        issue_date: p.issue_date ?? null,
        expiry_date: p.expiry_date ?? null,
        notes: p.notes ?? null,
        uploaded_by: req.profile.id
      };
      if (p.attachment_base64 && p.attachment_name) {
        const bytes = Buffer.from(p.attachment_base64, "base64");
        row.attachment_base64 = p.attachment_base64;
        row.attachment_name = p.attachment_name;
        row.attachment_mime = p.attachment_mime ?? "application/octet-stream";
        row.attachment_size = bytes.length;
      }
      const { data, error } = await client.from("certifications").insert(row).select(CERT_LIST_COLS).single();
      if (error) return res.status(400).json({ message: error.message });
      res.status(201).json(data);
    }
  );
  app.patch(
    "/api/certifications/:id",
    requireAuth,
    requireRole("admin", "area"),
    async (req, res) => {
      const parsed = updateCertificationSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      const client = supabaseAdmin || supabaseAnon;
      const { data: existing, error: exErr } = await supabaseAnon.from("certifications").select("id, profile_id, profiles:profiles!certifications_profile_id_fkey(area)").eq("id", req.params.id).single();
      if (exErr || !existing)
        return res.status(404).json({ message: "Certification not found" });
      const scope = areaScopeOf(req.profile);
      const empArea = existing.profiles?.area ?? null;
      if (scope && empArea !== scope)
        return res.status(404).json({ message: "Certification not found" });
      const { data, error } = await client.from("certifications").update(parsed.data).eq("id", req.params.id).select(CERT_LIST_COLS).single();
      if (error) return res.status(400).json({ message: error.message });
      res.json(data);
    }
  );
  app.delete(
    "/api/certifications/:id",
    requireAuth,
    requireRole("admin", "area"),
    async (req, res) => {
      const client = supabaseAdmin || supabaseAnon;
      const { data: existing, error: exErr } = await supabaseAnon.from("certifications").select("id, profiles:profiles!certifications_profile_id_fkey(area)").eq("id", req.params.id).single();
      if (exErr || !existing)
        return res.status(404).json({ message: "Certification not found" });
      const scope = areaScopeOf(req.profile);
      const empArea = existing.profiles?.area ?? null;
      if (scope && empArea !== scope)
        return res.status(404).json({ message: "Certification not found" });
      const { error } = await client.from("certifications").delete().eq("id", req.params.id);
      if (error) return res.status(400).json({ message: error.message });
      res.status(204).end();
    }
  );
  app.get(
    "/api/certifications/:id/attachment",
    requireAuth,
    async (req, res) => {
      const { data, error } = await supabaseAnon.from("certifications").select(
        "attachment_name, attachment_mime, attachment_base64, profiles:profiles!certifications_profile_id_fkey(area)"
      ).eq("id", req.params.id).single();
      if (error || !data || !data.attachment_base64)
        return res.status(404).json({ message: "Attachment not found" });
      const scope = areaScopeOf(req.profile);
      const empArea = data.profiles?.area ?? null;
      if (scope && empArea !== scope)
        return res.status(404).json({ message: "Attachment not found" });
      const buf = Buffer.from(data.attachment_base64, "base64");
      res.setHeader(
        "Content-Type",
        data.attachment_mime || "application/octet-stream"
      );
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${(data.attachment_name || "certification").replace(/"/g, "")}"`
      );
      res.send(buf);
    }
  );
  const padClient = () => supabaseAdmin || supabaseAnon;
  async function loadScopedJob(req, res, jobId) {
    const jid = Array.isArray(jobId) ? jobId[0] : jobId;
    const { data, error } = await padClient().from("jobs").select("id, area").eq("id", jid).single();
    if (error || !data) {
      res.status(404).json({ message: "Job not found" });
      return null;
    }
    const scope = areaScopeOf(req.profile);
    if (scope && data.area !== scope) {
      res.status(404).json({ message: "Job not found" });
      return null;
    }
    return data;
  }
  async function canManageServices(req, jobId) {
    const role = req.profile.role;
    if (role === "admin" || role === "area") return true;
    if (role !== "super") return false;
    const { data } = await padClient().from("job_assignments").select("id").eq("job_id", jobId).eq("profile_id", req.profile.id).maybeSingle();
    return !!data;
  }
  async function resolveServiceWell(jobId, wellId) {
    if (wellId === null || wellId === void 0)
      return { ok: true, well_id: null, well_name: null };
    const client = padClient();
    const { data: well } = await client.from("wells").select("id, name, job_id").eq("id", wellId).eq("job_id", jobId).maybeSingle();
    if (!well)
      return { ok: false, message: "That well does not belong to this job" };
    const { byName, currentKey } = await wellReportStats(jobId);
    const key = normWellName(well.name);
    const days = byName.get(key)?.days ?? 0;
    const isCurrent = currentKey != null && key === currentKey;
    if (days > 0 && !isCurrent)
      return { ok: false, message: "That well is already completed" };
    return { ok: true, well_id: well.id, well_name: well.name };
  }
  app.get(
    "/api/jobs/:jobId/services",
    requireAuth,
    async (req, res) => {
      const job = await loadScopedJob(req, res, req.params.jobId);
      if (!job) return;
      const { data, error } = await padClient().from("job_services").select("*").eq("job_id", job.id).order("service_date", { ascending: false }).order("created_at", { ascending: false });
      if (error) return res.status(500).json({ message: error.message });
      res.json(data || []);
    }
  );
  app.post(
    "/api/jobs/:jobId/services",
    requireAuth,
    requireRole("admin", "area", "super"),
    async (req, res) => {
      const job = await loadScopedJob(req, res, req.params.jobId);
      if (!job) return;
      const { data: jobRow } = await padClient().from("jobs").select("crewing").eq("id", job.id).single();
      if (!jobRow || jobRow.crewing !== "Unmanned")
        return res.status(400).json({
          message: "Services can only be logged on unmanned jobs"
        });
      if (!await canManageServices(req, job.id))
        return res.status(403).json({
          message: "Only an assigned supervisor or a manager can log services"
        });
      const parsed = createJobServiceSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      const wellRes = await resolveServiceWell(job.id, parsed.data.well_id ?? null);
      if (!wellRes.ok)
        return res.status(400).json({ message: wellRes.message });
      const { data, error } = await padClient().from("job_services").insert({
        job_id: job.id,
        area: job.area,
        service_type: parsed.data.service_type,
        service_date: parsed.data.service_date,
        cost: parsed.data.cost ?? null,
        well_id: wellRes.well_id,
        well_name: wellRes.well_name,
        notes: parsed.data.notes?.trim() || null,
        created_by: req.profile.id,
        created_by_name: req.profile.name
      }).select().single();
      if (error) return res.status(400).json({ message: error.message });
      res.status(201).json(data);
    }
  );
  app.patch(
    "/api/jobs/:jobId/services/:serviceId",
    requireAuth,
    requireRole("admin", "area", "super"),
    async (req, res) => {
      const job = await loadScopedJob(req, res, req.params.jobId);
      if (!job) return;
      if (!await canManageServices(req, job.id))
        return res.status(403).json({
          message: "Only an assigned supervisor or a manager can edit services"
        });
      const parsed = updateJobServiceSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      const patch = {};
      if (parsed.data.service_type !== void 0)
        patch.service_type = parsed.data.service_type;
      if (parsed.data.service_date !== void 0)
        patch.service_date = parsed.data.service_date;
      if (parsed.data.cost !== void 0) patch.cost = parsed.data.cost ?? null;
      if (parsed.data.well_id !== void 0) {
        const wellRes = await resolveServiceWell(job.id, parsed.data.well_id);
        if (!wellRes.ok)
          return res.status(400).json({ message: wellRes.message });
        patch.well_id = wellRes.well_id;
        patch.well_name = wellRes.well_name;
      }
      if (parsed.data.notes !== void 0)
        patch.notes = parsed.data.notes?.trim() || null;
      if (Object.keys(patch).length === 0)
        return res.status(400).json({ message: "Nothing to update" });
      const { data, error } = await padClient().from("job_services").update(patch).eq("id", req.params.serviceId).eq("job_id", job.id).select().single();
      if (error) return res.status(400).json({ message: error.message });
      if (!data) return res.status(404).json({ message: "Service not found" });
      res.json(data);
    }
  );
  app.delete(
    "/api/jobs/:jobId/services/:serviceId",
    requireAuth,
    requireRole("admin", "area", "super"),
    async (req, res) => {
      const job = await loadScopedJob(req, res, req.params.jobId);
      if (!job) return;
      if (!await canManageServices(req, job.id))
        return res.status(403).json({
          message: "Only an assigned supervisor or a manager can delete services"
        });
      const { error } = await padClient().from("job_services").delete().eq("id", req.params.serviceId).eq("job_id", job.id);
      if (error) return res.status(400).json({ message: error.message });
      res.status(204).end();
    }
  );
  const todayIso = () => (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  const normWellName = (s) => (s ?? "").trim().toLowerCase();
  const reportDay = (r) => {
    const d = String(r.report_date || r.received_at || "").slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
  };
  async function wellReportStats(jobId) {
    const client = padClient();
    const { data: reports } = await client.from("daily_reports").select("well_name, report_date, received_at").eq("job_id", jobId);
    const dated = [];
    for (const r of reports ?? []) {
      const day = reportDay(r);
      const name = r.well_name ?? "";
      if (day && name.trim()) dated.push({ name: name.trim(), day });
    }
    dated.sort((a, b) => a.day < b.day ? -1 : a.day > b.day ? 1 : 0);
    const byName = /* @__PURE__ */ new Map();
    for (const { name, day } of dated) {
      const key = normWellName(name);
      const cur = byName.get(key);
      if (cur) {
        cur.days += 1;
        if (day < cur.first) cur.first = day;
        if (day > cur.last) cur.last = day;
      } else {
        byName.set(key, { days: 1, first: day, last: day, display: name.trim() });
      }
    }
    const last = dated[dated.length - 1];
    return { byName, currentKey: last ? normWellName(last.name) : null };
  }
  app.get(
    "/api/jobs/:jobId/pads",
    requireAuth,
    async (req, res) => {
      const job = await loadScopedJob(req, res, req.params.jobId);
      if (!job) return;
      const client = padClient();
      const { data: pads, error } = await client.from("pads").select("*").eq("job_id", job.id).order("created_at", { ascending: true });
      if (error) return res.status(400).json({ message: error.message });
      const { data: wells } = await client.from("wells").select("*").eq("job_id", job.id).order("created_at", { ascending: true });
      const { data: jobRow } = await client.from("jobs").select("day_rate").eq("id", job.id).single();
      const dayRate = jobRow && jobRow.day_rate != null && !isNaN(Number(jobRow.day_rate)) ? Number(jobRow.day_rate) : null;
      const { byName, currentKey } = await wellReportStats(job.id);
      const wellsByPad = /* @__PURE__ */ new Map();
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
          is_current: isCurrent
        });
        wellsByPad.set(w.pad_id, arr);
      }
      const result = (pads ?? []).map((p) => ({
        ...p,
        wells: wellsByPad.get(p.id) ?? []
      }));
      res.json(result);
    }
  );
  app.get(
    "/api/jobs/:jobId/unassigned-wells",
    requireAuth,
    async (req, res) => {
      const job = await loadScopedJob(req, res, req.params.jobId);
      if (!job) return;
      const client = padClient();
      const { data: wells } = await client.from("wells").select("name").eq("job_id", job.id);
      const attached = new Set(
        (wells ?? []).map((w) => normWellName(w.name))
      );
      const { byName, currentKey } = await wellReportStats(job.id);
      const out = Array.from(byName.entries()).filter(([key]) => !attached.has(key)).map(([key, s]) => ({
        name: s.display,
        report_days: s.days,
        first_report: s.first,
        last_report: s.last,
        is_current: currentKey != null && key === currentKey
      })).sort((a, b) => a.last_report < b.last_report ? 1 : -1);
      res.json(out);
    }
  );
  app.post(
    "/api/jobs/:jobId/pads",
    requireAuth,
    requireRole("admin", "area", "super", "field"),
    async (req, res) => {
      const job = await loadScopedJob(req, res, req.params.jobId);
      if (!job) return;
      const parsed = createPadSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      const client = padClient();
      const { count: padCount } = await client.from("pads").select("id", { count: "exact", head: true }).eq("job_id", job.id);
      const padName = `Pad ${(padCount ?? 0) + 1}`;
      const { data: pad, error } = await client.from("pads").insert({
        job_id: job.id,
        name: padName,
        status: "Open",
        opened_on: todayIso(),
        created_by: req.profile.id,
        created_by_name: req.profile.name
      }).select().single();
      if (error) return res.status(400).json({ message: error.message });
      const names = Array.from(
        new Set(
          (parsed.data.well_names ?? []).map((n) => n.trim()).filter((n) => n.length > 0)
        )
      );
      let wells = [];
      if (names.length > 0) {
        const rows = names.map((name) => ({
          pad_id: pad.id,
          job_id: job.id,
          name,
          status: "Pending",
          created_by: req.profile.id,
          created_by_name: req.profile.name
        }));
        const { data: inserted, error: wErr } = await client.from("wells").insert(rows).select();
        if (wErr) return res.status(400).json({ message: wErr.message });
        wells = inserted ?? [];
      }
      res.status(201).json({ ...pad, wells: wells.map((w) => ({ ...w, stints: [] })) });
    }
  );
  app.patch(
    "/api/pads/:padId",
    requireAuth,
    requireRole("admin", "area", "super", "field"),
    async (req, res) => {
      const parsed = renamePadSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      const client = padClient();
      const { data: existing, error: loadErr } = await client.from("pads").select("id, job_id").eq("id", req.params.padId).single();
      if (loadErr || !existing)
        return res.status(404).json({ message: "Pad not found" });
      const job = await loadScopedJob(req, res, existing.job_id);
      if (!job) return;
      const { data: pad, error } = await client.from("pads").update({ name: parsed.data.name }).eq("id", req.params.padId).select().single();
      if (error) return res.status(400).json({ message: error.message });
      res.json(pad);
    }
  );
  app.post(
    "/api/pads/:padId/wells",
    requireAuth,
    requireRole("admin", "area", "super", "field"),
    async (req, res) => {
      const client = padClient();
      const { data: pad, error: pErr } = await client.from("pads").select("id, job_id").eq("id", req.params.padId).single();
      if (pErr || !pad)
        return res.status(404).json({ message: "Pad not found" });
      const job = await loadScopedJob(req, res, pad.job_id);
      if (!job) return;
      const parsed = createWellSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      const { data: well, error } = await client.from("wells").insert({
        pad_id: pad.id,
        job_id: pad.job_id,
        name: parsed.data.name,
        status: "Pending",
        created_by: req.profile.id,
        created_by_name: req.profile.name
      }).select().single();
      if (error) return res.status(400).json({ message: error.message });
      res.status(201).json({ ...well, stints: [] });
    }
  );
  return httpServer;
}

// server/app.ts
import { createServer } from "node:http";
function log(message, source = "express") {
  const formattedTime = (/* @__PURE__ */ new Date()).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true
  });
  console.log(`${formattedTime} [${source}] ${message}`);
}
async function createApp() {
  const app = express();
  const throwawayServer = createServer(app);
  app.use(
    express.json({
      // Daily-report ingestion posts the emailed .xlsx as base64, so allow a
      // generous body size for the attachment payload.
      limit: "25mb",
      verify: (req, _res, buf) => {
        req.rawBody = buf;
      }
    })
  );
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => {
    const start = Date.now();
    const path = req.path;
    let capturedJsonResponse = void 0;
    const originalResJson = res.json;
    res.json = function(bodyJson, ...args) {
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
  app.all(/^\/api\//, (req, res) => {
    res.status(404).json({ message: `No API route for ${req.method} ${req.path}` });
  });
  app.use((err, _req, res, next) => {
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

// script/api-entry.ts
var appPromise = null;
function getApp() {
  if (!appPromise) {
    appPromise = createApp();
  }
  return appPromise;
}
async function handler(req, res) {
  const app = await getApp();
  app(
    req,
    res
  );
}
export {
  handler as default
};
