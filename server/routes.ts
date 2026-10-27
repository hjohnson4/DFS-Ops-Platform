import type { Express, Request, Response } from "express";
import { z } from "zod";
import type { Server } from "node:http";
import crypto from "node:crypto";
import { supabaseAnon, supabaseAdmin, hasAdmin } from "./supabase";
import { requireAuth, requireRole, areaScopeOf, jobScopeOf } from "./auth";
import { sendNotificationEmails, sendDailyReportChanges, emailConfigured, gmailConfigured, sendInviteEmail, sendPasswordResetEmail } from "./email";
import {
  parseDailyReportWorkbook,
  parseAllCompletedDays,
  readDayRemarks,
  ExcelParseError,
} from "./excelDailyReport";
import * as XLSX from "xlsx";
import { registerForecastRoutes } from "./forecast";
import { registerFieldTicketRoutes } from "./fieldTickets";
import { registerRentalRoutes, stripRentalMoney } from "./rentals";
import { AREAS, isLiveJobStatus, assetStatusFor } from "@shared/schema";
import { computeManualBilling, publicBilling, recordRateChange, todayCentral } from "./manualBilling";
import {
  createUserSchema,
  updateUserSchema,
  changePasswordSchema,
  createAssetSchema,
  updateAssetSchema,
  createReportSchema,
  createServiceReportSchema,
  CENTRIFUGE_SERVICE_CHECKLIST,
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
  createFieldDailyReportSchema,
  updateFieldDailyReportSchema,
  createJsaSchema,
  updateJsaSchema,
  signoffSchema,
  notifPrefsSchema,
  ingestDailyReportSchema,
  backfillDailyReportSchema,
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
  hoursServiceStatusFor,
  SERVICE_INTERVAL_HOURS,
  createMaintenanceScheduleSchema,
  updateMaintenanceScheduleSchema,
  uploadMaintenanceFileSchema,
  createWorkOrderSchema,
  updateWorkOrderSchema,
  closeWorkOrderSchema,
  WORK_ORDER_INVOICE_MAX_BYTES,
  WORK_ORDER_MANAGE_ROLES,
  createJobServiceSchema,
  updateJobServiceSchema,
} from "@shared/schema";
import type {
  ServiceAssetRow,
  ServiceDashboard,
  ServiceAssetDetail,
  JobHours,
} from "@shared/schema";

// ---- Run-hours log (asset_run_hours) ---------------------------------------
// Every time a signed-off daily report adds run hours to a centrifuge we also
// write one row here (asset, report, job, well, date, hours). The asset's
// run_hours meter stays as before; this log is what lets the Service module
// count hours since the last service and total hours per job and per well.
// Writes are best-effort: if the table hasn't been created yet (SQL not run)
// sign-off still works exactly as before.
async function logRunHours(
  client: any,
  report: { id: string; job_id: string | null; well_name: string | null; report_date: string | null },
  alloc: { asset_id: string; add: number }[],
): Promise<void> {
  if (!alloc.length) return;
  try {
    const rows = alloc.map((a) => ({
      asset_id: a.asset_id,
      daily_report_id: report.id,
      job_id: report.job_id,
      well_name: report.well_name,
      report_date: report.report_date,
      hours: a.add,
    }));
    const { error } = await client
      .from("asset_run_hours")
      .upsert(rows, { onConflict: "asset_id,daily_report_id" });
    if (error) console.warn("[run-hours log] skipped:", error.message);
  } catch (e: any) {
    console.warn("[run-hours log] skipped:", e?.message ?? e);
  }
}

// Read the run-hours log for a set of assets (paged past the 1000-row cap).
// `ready` is false when the table doesn't exist yet.
async function loadRunHoursLog(
  client: any,
  assetIds: string[],
): Promise<{ ready: boolean; rows: any[] }> {
  if (!assetIds.length) return { ready: true, rows: [] };
  const out: any[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client
      .from("asset_run_hours")
      .select("asset_id, daily_report_id, job_id, well_name, report_date, hours, job:jobs(job_number)")
      .in("asset_id", assetIds)
      .order("report_date", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) return { ready: false, rows: [] };
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return { ready: true, rows: out };
}

// Hours logged on reports dated strictly after `afterDate` (all when null).
function hoursAfter(rows: any[], afterDate: string | null): number {
  let t = 0;
  for (const r of rows) {
    if (afterDate && r.report_date && String(r.report_date) <= afterDate) continue;
    if (afterDate && !r.report_date) continue;
    t += Number(r.hours) || 0;
  }
  return Math.round(t * 100) / 100;
}
const round2 = (n: number) => Math.round(n * 100) / 100;

// Hours-since-service for a set of centrifuges (assets need id, run_hours,
// run_hours_at_service). Same rule as the Service dashboard.
async function hoursSinceServiceFor(
  client: any,
  assets: any[],
): Promise<Map<string, { hoursSince: number | null; state: any; lastService: string | null }>> {
  const ids = assets.map((a) => a.id);
  const out = new Map<string, { hoursSince: number | null; state: any; lastService: string | null }>();
  if (!ids.length) return out;
  const last = new Map<string, string>();
  const { data: reps } = await client
    .from("maintenance_reports")
    .select("asset_id, report_date")
    .in("asset_id", ids)
    .order("report_date", { ascending: false });
  for (const r of (reps || []) as any[])
    if (!last.has(r.asset_id) && r.report_date) last.set(r.asset_id, String(r.report_date));
  const log = await loadRunHoursLog(client, ids);
  for (const a of assets) {
    const lastService = last.get(a.id) ?? null;
    let since: number;
    if (log.ready) since = hoursAfter(log.rows.filter((r) => r.asset_id === a.id), lastService);
    else {
      const meter = Number(a.run_hours ?? 0) || 0;
      const base = lastService && a.run_hours_at_service != null ? Number(a.run_hours_at_service) : 0;
      since = round2(Math.max(0, meter - base));
    }
    const st = hoursServiceStatusFor(since, !!lastService);
    out.set(a.id, { hoursSince: st.hoursSince, state: st.state, lastService });
  }
  return out;
}

// ---- Billing-calendar months (Mud Plant pad rows) --------------------------
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function calendarMonthRows(
  jobId: string,
  padId: string,
  start: string | null,
  today: string,
  daily: Map<string, number>,
  namedWells: string[],
): any[] {
  if (!start) return [];
  const ymOf = (iso: string) => iso.slice(0, 7);
  const startYm = ymOf(start);
  const curYm = ymOf(today);
  const nextYm = (ym: string) => {
    const [y, m] = ym.split("-").map(Number);
    return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  };
  // Months typed in as "wells" (e.g. November, December) show as Pending.
  let lastYm = curYm < startYm ? startYm : curYm;
  for (const n of namedWells) {
    const m = n.trim().match(/^([a-z]+)\s*(\d{4})?$/i);
    if (!m) continue;
    const idx = MONTH_NAMES.findIndex((x) => x.toLowerCase().startsWith(m[1].toLowerCase()) && m[1].length >= 3);
    if (idx < 0) continue;
    const mm = String(idx + 1).padStart(2, "0");
    let ym = m[2] ? `${m[2]}-${mm}` : `${startYm.slice(0, 4)}-${mm}`;
    if (!m[2] && ym < startYm) ym = `${Number(startYm.slice(0, 4)) + 1}-${mm}`;
    if (ym > lastYm && ym <= `${Number(curYm.slice(0, 4)) + 2}-12`) lastYm = ym;
  }
  const rows: any[] = [];
  for (let ym = startYm, guard = 0; ym <= lastYm && guard < 60; ym = nextYm(ym), guard++) {
    const [y, m] = ym.split("-").map(Number);
    const monthEnd = `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
    const from: string = ym === startYm ? start : `${ym}-01`;
    const to = monthEnd < today ? monthEnd : today;
    let billed = 0;
    let revenue = 0;
    let spanDays = 0;
    if (from <= to) {
      const d: Date = new Date(from + "T12:00:00Z");
      for (let s = from; s <= to; d.setUTCDate(d.getUTCDate() + 1), s = d.toISOString().slice(0, 10)) {
        spanDays++;
        const v = daily.get(s);
        if (v != null && v > 0) {
          billed++;
          revenue += v;
        }
      }
    }
    const status = ym === curYm ? "Open" : ym < curYm ? "Closed" : "Pending";
    rows.push({
      id: `month-${ym}`,
      pad_id: padId,
      job_id: jobId,
      name: `${MONTH_NAMES[m - 1]} ${y}`,
      status,
      report_days: billed,
      not_billed_days: Math.max(0, spanDays - billed),
      first_report: from <= to ? from : null,
      last_report: from <= to ? to : null,
      revenue: from <= to ? Math.round(revenue * 100) / 100 : null,
      is_current: ym === curYm,
      is_month: true,
    });
  }
  return rows;
}

// Shared secret the scheduled email-analysis task uses to POST reports.
// Set INGEST_TOKEN at deploy (M7); blank means ingest is closed.
const INGEST_TOKEN = process.env.INGEST_TOKEN || "";

// Set day rate (Verdun) jobs: the day rate is entered on the job profile, so a
// blank AL57 on the workbook is expected and is NOT missing critical data.
// Prefix match so both workbook layouts ("Day rate (AL57)" on the original
// workbook, "Day rate (AL59)" on the updated 4-centrifuge workbook) are covered.
const MANUAL_RATE_MISSING = "Day rate (";

// Centrifuge slots on the daily report. The updated workbook has four
// centrifuge columns (Centrifuge 1-4); the original has two.
const CENTRIFUGE_SLOT_NUMBERS = [1, 2, 3, 4] as const;
function isMappedSlot(slot: any): boolean {
  return CENTRIFUGE_SLOT_NUMBERS.includes(Number(slot) as any) && slot != null;
}
// Daily hours per slot from a report's KPIs. Slot 1 falls back to the legacy
// combined field when the report predates per-centrifuge parsing.
function slotDailyHours(kp: any): Record<number, number | null> {
  const n = (v: any) =>
    v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);
  const k = kp || {};
  return {
    1: n(k.daily_run_hours_cent1) ?? n(k.daily_run_hours),
    2: n(k.daily_run_hours_cent2),
    3: n(k.daily_run_hours_cent3),
    4: n(k.daily_run_hours_cent4),
  };
}
// Hours for a job with exactly ONE centrifuge. Uses the column that unit is
// mapped to (Centrifuge 1-4) when that column has hours; otherwise Centrifuge
// 1's cell; otherwise, if exactly one centrifuge column on the report has
// hours (e.g. the crew filled in Centrifuge 3), that column. 0 = nothing.
function soloCentrifugeHours(kp: any, slot: any): number {
  const by = slotDailyHours(kp);
  if (isMappedSlot(slot)) {
    const own = by[Number(slot)];
    if (own != null && own > 0) return own;
  }
  const d = kp?.daily_run_hours;
  const daily = d == null || d === "" || !Number.isFinite(Number(d)) ? null : Number(d);
  if (daily != null && daily > 0) return daily;
  const filled = CENTRIFUGE_SLOT_NUMBERS.filter((s) => (by[s] ?? 0) > 0);
  return filled.length === 1 ? (by[filled[0]] as number) : 0;
}
async function manualRateJobIds(client: any): Promise<Set<string>> {
  const { data } = await client.from("jobs").select("id").eq("manual_day_rate", true);
  return new Set(((data || []) as any[]).map((j) => String(j.id)));
}
function dropManualRateField(fields: string[], jobId: string | null | undefined, manual: Set<string>): string[] {
  if (!jobId || !manual.has(String(jobId))) return fields;
  return fields.filter((f) => !String(f).startsWith(MANUAL_RATE_MISSING));
}
// Strip the AL57 flag from a report row's analysis for set-day-rate jobs
// (covers reports imported before this rule existed).
function withoutManualRateFlag<T extends { job_id?: string | null; analysis?: any }>(r: T, manual: Set<string>): T {
  const mf = r?.analysis?.missing_fields;
  if (!Array.isArray(mf) || !r.job_id || !manual.has(String(r.job_id))) return r;
  const kept = dropManualRateField(mf, r.job_id, manual);
  if (kept.length === mf.length) return r;
  const analysis = { ...r.analysis };
  if (kept.length) analysis.missing_fields = kept;
  else delete analysis.missing_fields;
  return { ...r, analysis };
}

// Normalize a job identifier / rig name for comparison: uppercase, collapse
// runs of whitespace, and treat spaces and dashes as equivalent, so that
// "H&P 266", "H&P-266", and "h&p  266" all compare equal. (Shared with the
// JSA intake matcher.)
function normJobId(v: string | null | undefined): string {
  return (v || "")
    .toUpperCase()
    .replace(/[\s-]+/g, " ")
    .trim();
}

// Resolve which job a daily/JSA report should attach to.
//
// Three signals, in priority order:
//   0. The job number read from the report itself (daily report cell V8 =
//      rig name / job number). When present, an exact normalized match to a
//      job's `job_number` wins outright — this is the value the crew typed on
//      the sheet, so it is the most authoritative link.
//   1. A job whose own `well_name` equals the report's well (exact, case- and
//      whitespace-insensitive). This is the explicit well link.
//   2. LEARNED FROM HISTORY: the most recent PRIOR daily report for the same
//      well that is already attached to a job. Once a well has been assigned to
//      a job on any report, every later report for that same well auto-attaches
//      to that same job. This is what makes repeated wells stop needing manual
//      assignment even when jobs don't carry a well_name.
//
// Returns nulls when nothing matches, so the caller still routes the report to
// the "Needs job match" queue (never guesses).
async function resolveJobForWell(
  client: any,
  wellName: string | null | undefined,
  jobNumber?: string | null,
  operator?: string | null,
): Promise<{ job_id: string | null; area: string | null; customer_id: string | null }> {
  const empty = { job_id: null, area: null, customer_id: null };

  // ARCHIVED JOBS NEVER RECEIVE REPORTS. Every match below only considers
  // jobs that are not archived; a report whose only match is an archived job
  // goes to "Needs job match" instead.
  const { data: liveJobs } = await client
    .from("jobs")
    .select("id, area, customer_id, job_number, well_name, created_at, customer:customers(name)")
    .is("archived_at", null);
  const live = (liveJobs || []) as any[];
  const pick = (j: any) => ({ job_id: j.id, area: j.area, customer_id: j.customer_id });
  const normName = (v: any) => String(v || "").toLowerCase().replace(/[^a-z0-9]/g, "");

  // (0) Job number from the report (V8). Highest priority when present. If
  // more than one live job has that number (e.g. same rig in two areas),
  // prefer the one whose customer matches the workbook's operator (H8).
  const jobTarget = normJobId(jobNumber);
  if (jobTarget) {
    const byNumber = live.filter((j) => normJobId(j.job_number) === jobTarget);
    if (byNumber.length === 1) return pick(byNumber[0]);
    if (byNumber.length > 1) {
      const op = normName(operator);
      const byCustomer = op
        ? byNumber.find((j) => {
            const c = normName(j.customer?.name);
            return !!c && (c === op || c.includes(op) || op.includes(c));
          })
        : null;
      if (byCustomer) return pick(byCustomer);
      // Still ambiguous: newest live job with that number.
      byNumber.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      return pick(byNumber[0]);
    }
  }

  const target = (wellName || "").trim().toLowerCase();
  if (!target) return empty;

  // (1) Explicit job.well_name match (live jobs only).
  const jobMatch = live.find((j) => (j.well_name || "").trim().toLowerCase() === target);
  if (jobMatch) return pick(jobMatch);

  // (2) Learn from a prior assigned report on the same well. We compare on the
  // trimmed/lowered well name in JS (not SQL) so it matches the same way the
  // explicit path does, tolerating case/spacing differences between workbooks.
  // A prior report on an archived (or deleted) job is ignored.
  const { data: priorReports } = await client
    .from("daily_reports")
    .select("well_name, job_id, created_at, received_at, report_date")
    .not("job_id", "is", null)
    .not("well_name", "is", null)
    .order("created_at", { ascending: false })
    .limit(500);
  const liveById = new Map(live.map((j) => [j.id, j]));
  const prior = (priorReports || []).find(
    (r: any) => (r.well_name || "").trim().toLowerCase() === target && liveById.has(r.job_id),
  );
  if (prior?.job_id) return pick(liveById.get(prior.job_id));

  return empty;
}

// True when the job exists and is archived. Archived jobs can't receive
// reports, JSAs, assets or any other new records.
async function jobIsArchived(client: any, jobId: string | null | undefined): Promise<boolean> {
  if (!jobId) return false;
  const { data } = await client.from("jobs").select("archived_at").eq("id", jobId).maybeSingle();
  return !!data?.archived_at;
}
const ARCHIVED_JOB_MSG = "This job is archived. Nothing can be assigned to an archived job. Restore it first, or pick an active job.";

// ---- Corrected re-send helpers (daily reports) ------------------------------
// Data columns that come from the workbook / email. A correction replaces
// exactly these on the original report; ids, job links and history stay.
const CORRECTION_COLUMNS = [
  "email_message_id",
  "sender_email",
  "sender_name",
  "subject",
  "received_at",
  "attachment_name",
  "attachment_base64",
  "attachment_mime",
  "attachment_size",
  "source_sheet",
  "report_day",
  "report_date",
  "well_name",
  "well_context",
  "kpis",
  "kpi_cell_map",
  "summary",
] as const;

function correctionFields(row: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const k of CORRECTION_COLUMNS) if (k in row) out[k] = row[k];
  return out;
}

// The emailed report already on file for the same job + well + Report Day.
async function findPriorSameDay(
  client: any,
  job_id: string | null,
  report_day: number | null | undefined,
  well_name: string | null | undefined,
): Promise<any | null> {
  if (!job_id || report_day == null || !well_name) return null;
  const { data } = await client
    .from("daily_reports")
    .select(
      "id, status, email_message_id, received_at, report_date, report_day, well_name, kpis, well_context, analysis, run_hours_applied, attachment_name, area, job_id",
    )
    .eq("job_id", job_id)
    .eq("report_day", report_day)
    .eq("source", "email")
    .ilike("well_name", well_name.trim())
    .order("received_at", { ascending: false })
    .limit(1);
  return data && data.length ? data[0] : null;
}

// Gmail message ids carry the send time in their upper bits (id >> 20 is the
// time in ms), which is more reliable than when the intake check happened to
// pick the email up.
function gmailIdMs(id: string | null | undefined): number | null {
  if (!id || !/^[0-9a-f]{15,16}$/i.test(id)) return null;
  try {
    const ms = Number(BigInt("0x" + id) >> BigInt(20));
    return ms > 1.4e12 && ms < 4e12 ? ms : null;
  } catch {
    return null;
  }
}

// True only when we can tell the incoming email is OLDER than the report on
// file. When the order can't be determined, treat it as newer (surface it).
function isOlderEmail(
  incomingId: string,
  incomingAt: string | null | undefined,
  priorId: string | null | undefined,
  priorAt: string | null | undefined,
): boolean {
  const a = gmailIdMs(incomingId);
  const b = gmailIdMs(priorId);
  if (a != null && b != null) return a < b;
  if (a != null && b == null) return false;
  const ta = incomingAt ? Date.parse(incomingAt) : NaN;
  const tb = priorAt ? Date.parse(priorAt) : NaN;
  if (Number.isFinite(ta) && Number.isFinite(tb)) return ta < tb;
  return false;
}

async function addSupersededEmail(client: any, report: any, emailId: string) {
  const analysis = { ...((report.analysis as any) || {}) };
  const list: string[] = Array.isArray(analysis.superseded_email_ids)
    ? analysis.superseded_email_ids
    : [];
  if (!list.includes(emailId)) list.push(emailId);
  analysis.superseded_email_ids = list;
  await client.from("daily_reports").update({ analysis }).eq("id", report.id);
}

// New analysis for a report that was just replaced by a correction: current
// missing-field alerts, plus history of replaced email ids and what changed.
function correctedAnalysis(
  prior: any,
  incomingAnalysis: any,
  changes: string[],
  replacedEmailId: string | null,
): Record<string, any> {
  const old = (prior.analysis as any) || {};
  const ids: string[] = Array.isArray(old.superseded_email_ids)
    ? [...old.superseded_email_ids]
    : [];
  if (replacedEmailId && !ids.includes(replacedEmailId)) ids.push(replacedEmailId);
  const out: Record<string, any> = {
    ...(incomingAnalysis || {}),
    superseded_email_ids: ids,
    corrections: (Number(old.corrections) || 0) + 1,
    last_correction_changes: changes,
  };
  delete out.correction_of;
  delete out.correction_job_id;
  delete out.correction_changes;
  return out;
}

const CHANGE_LABELS: Record<string, string> = {
  report_date: "Report date (D3)",
  well_name: "Well name (V9)",
  rig_activity: "Rig activity (AI8)",
  meas_depth_ft: "Measured depth (AI9)",
  supervisor: "Supervisor (AI11)",
  remarks: "Notes",
  day_rate: "Day rate",
  accrued_current_well: "Accrued, current well",
  mud_weight_ppg: "Mud weight (G14)",
  daily_run_hours: "Run hours, centrifuge 1",
  daily_run_hours_cent2: "Run hours, centrifuge 2",
  daily_run_hours_cent3: "Run hours, centrifuge 3",
  daily_run_hours_cent4: "Run hours, centrifuge 4",
};
// Centrifuge parameter labels per centrifuge (Centrifuge 1 = unsuffixed).
{
  const params: [string, string][] = [
    ["centrifuge_feed_rate_gpm", "Feed rate (gpm)"],
    ["centrifuge_feed_pump_speed_rpm", "Feed pump speed (rpm)"],
    ["centrifuge_bowl_speed_rpm", "Bowl speed (rpm)"],
    ["centrifuge_backdrive_rpm", "Backdrive (rpm)"],
    ["centrifuge_feed_weight_ppg", "Feed weight (ppg)"],
    ["centrifuge_effluent_weight_ppg", "Effluent weight (ppg)"],
  ];
  for (const [key, label] of params) {
    CHANGE_LABELS[key] = `${label}, centrifuge 1`;
    for (const n of [2, 3, 4]) CHANGE_LABELS[`${key}_cent${n}`] = `${label}, centrifuge ${n}`;
  }
}
const SKIP_CHANGE_KEYS = new Set(["daily_run_hours_cent1", "total_run_hours_cent1"]);

function fmtChangeVal(v: any): string {
  if (v == null || v === "") return "—";
  const s = typeof v === "number" ? v.toLocaleString("en-US") : String(v);
  return s.length > 60 ? s.slice(0, 57) + "…" : s;
}

// Plain-English list of what changed between the report on file and the
// corrected workbook (top-level date/well, well context, and every KPI).
function describeReportChanges(prior: any, next: any): string[] {
  const out: string[] = [];
  const cmp = (key: string, a: any, b: any, cellMap?: any) => {
    if (SKIP_CHANGE_KEYS.has(key)) return;
    const na = a == null || a === "" ? null : a;
    const nb = b == null || b === "" ? null : b;
    if (JSON.stringify(na) === JSON.stringify(nb)) return;
    const cell = cellMap?.[key]?.cell;
    const label =
      CHANGE_LABELS[key] ||
      `${key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())}${cell ? ` (${cell})` : ""}`;
    out.push(`${label}: ${fmtChangeVal(na)} → ${fmtChangeVal(nb)}`);
  };
  cmp("report_date", prior.report_date, next.report_date);
  cmp("well_name", prior.well_name, next.well_name);
  const pc = prior.well_context || {};
  const nc = next.well_context || {};
  for (const k of Array.from(new Set([...Object.keys(pc), ...Object.keys(nc)])))
    cmp(k, pc[k], nc[k]);
  const pk = prior.kpis || {};
  const nk = next.kpis || {};
  for (const k of Array.from(new Set([...Object.keys(pk), ...Object.keys(nk)])))
    cmp(k, pk[k], nk[k], next.kpi_cell_map);
  return out;
}

// Rental centrifuge rules shared by create + edit. Mutates the patch; returns
// an error message or null.
function applyRentalRules(patch: any, current: any | null): string | null {
  const isRental = patch.is_rental ?? current?.is_rental ?? false;
  if (patch.is_rental === false) {
    // Turning rental off keeps the details on file but stops treating it as one.
    return null;
  }
  if (!isRental) return null;
  const start = patch.rental_start !== undefined ? patch.rental_start : current?.rental_start ?? null;
  const end = patch.rental_end !== undefined ? patch.rental_end : current?.rental_end ?? null;
  if (end && !start) return "Enter the date the rental was received before the return date";
  if (start && end && end < start) return "The return date must be on or after the date received";
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  if (patch.rental_end === undefined && patch.job_id && end && end <= today)
    return "This rental unit has been returned. Clear its return date before putting it on a job.";
  if (patch.rental_end !== undefined && end && end <= today) {
    // Sent back: off any job and out of the active fleet.
    patch.job_id = null;
    patch.status = "Returned";
  } else if (patch.rental_end !== undefined && !end && current?.status === "Returned") {
    patch.status = "Available";
  }
  return null;
}

export async function registerRoutes(
  httpServer: Server,
  app: Express,
): Promise<Server> {
  // ---- Archived jobs are read-only -------------------------------------------
  // Any create/update under /api/jobs/<id>/... (field tickets, field reports,
  // JSAs, services, pads, wells, ...) is refused while the job is archived.
  // Archive / restore / delete themselves stay allowed.
  app.use(async (req, res, next) => {
    if (!["POST", "PUT", "PATCH"].includes(req.method)) return next();
    const m = /^\/api\/jobs\/([0-9a-f-]{36})\/([^?]+)/i.exec(req.path);
    if (!m) return next();
    const sub = m[2].replace(/\/+$/, "");
    if (sub === "archive" || sub === "unarchive" || sub === "delete") return next();
    try {
      if (await jobIsArchived(supabaseAdmin || supabaseAnon, m[1]))
        return res.status(409).json({ message: ARCHIVED_JOB_MSG });
    } catch {
      /* fall through: the route itself will handle a missing job */
    }
    next();
  });

  // ---- Health / config ----------------------------------------------------
  app.get("/api/health", (_req, res) => {
    // adminReady reflects whether SUPABASE_SERVICE_ROLE_KEY is configured — when
    // true, self-service account creation is enabled. `time` helps confirm a
    // fresh deploy is serving (e.g. after setting the key in the env).
    res.json({
      ok: true,
      adminReady: hasAdmin(),
      emailReady: emailConfigured(),
      changeEmailReady: gmailConfigured(),
      time: new Date().toISOString(),
    });
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

    const mustChange = !!(data.user?.user_metadata as any)?.must_change_password;

    res.json({
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      profile: { ...profile, must_change_password: mustChange },
    });
  });

  // ---- Invite tokens --------------------------------------------------------
  // Invites use a stateless, signed token (HMAC-SHA256 over the payload using
  // the service-role key as the secret). No DB column needed. The token encodes
  // the user id, email, and an expiry; the set-password page posts it back to
  // verify identity and set the password. Tokens are single-window (expiry) and
  // tamper-evident (any change invalidates the signature).
  // Generate a strong, readable temporary password: 12 chars, guaranteed to
  // contain upper/lower letters and digits, avoiding easily-confused glyphs
  // (no O/0, I/1/l). Satisfies the strongPassword rule (>=10, letter+digit).
  function genTempPassword(): string {
    const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
    const lower = "abcdefghijkmnpqrstuvwxyz";
    const digits = "23456789";
    const all = upper + lower + digits;
    const pick = (set: string) =>
      set[crypto.randomInt(0, set.length)];
    const chars = [pick(upper), pick(lower), pick(digits), pick(digits)];
    while (chars.length < 12) chars.push(pick(all));
    // Fisher-Yates shuffle with a CSPRNG.
    for (let i = chars.length - 1; i > 0; i--) {
      const j = crypto.randomInt(0, i + 1);
      [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    return chars.join("");
  }

  function signInvite(payload: { uid: string; email: string; exp: number }): string {
    const secret = process.env.SUPABASE_SERVICE_ROLE_KEY || "dfs-invite-fallback-secret";
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const sig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
    return `${body}.${sig}`;
  }
  function verifyInvite(
    token: string,
  ): { uid: string; email: string } | { error: string } {
    const secret = process.env.SUPABASE_SERVICE_ROLE_KEY || "dfs-invite-fallback-secret";
    const parts = (token || "").split(".");
    if (parts.length !== 2) return { error: "This invite link is malformed." };
    const [body, sig] = parts;
    const expected = crypto.createHmac("sha256", secret).update(body).digest("base64url");
    // constant-time compare
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b))
      return { error: "This invite link is invalid." };
    let payload: { uid: string; email: string; exp: number };
    try {
      payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
      return { error: "This invite link is malformed." };
    }
    if (!payload.exp || Date.now() > payload.exp)
      return { error: "This invite link has expired. Ask your admin to resend it." };
    return { uid: payload.uid, email: payload.email };
  }

  // Verify an invite token and return whom it's for (to greet on the page).
  app.post("/api/invite/verify", async (req: Request, res: Response) => {
    const v = verifyInvite((req.body || {}).token);
    if ("error" in v) return res.status(400).json({ message: v.error });
    if (!supabaseAdmin)
      return res.status(503).json({ message: "Service unavailable." });
    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("email,name")
      .eq("id", v.uid)
      .single();
    res.json({ email: v.email, name: profile?.name ?? null });
  });

  // Complete an invite: set the password, then sign the user in.
  app.post("/api/invite/complete", async (req: Request, res: Response) => {
    const { token, password } = req.body || {};
    const v = verifyInvite(token);
    if ("error" in v) return res.status(400).json({ message: v.error });
    if (
      typeof password !== "string" ||
      password.length < 10 ||
      !/[A-Za-z]/.test(password) ||
      !/[0-9]/.test(password)
    ) {
      return res.status(400).json({
        message: "Password must be at least 10 characters and include a letter and a number.",
      });
    }
    if (!supabaseAdmin)
      return res.status(503).json({ message: "Service unavailable." });
    // Set the password (and make sure the email is confirmed).
    const { error: uErr } = await supabaseAdmin.auth.admin.updateUserById(v.uid, {
      password,
      email_confirm: true,
    });
    if (uErr) return res.status(400).json({ message: uErr.message });
    // Sign them in so they land in the app already authenticated.
    const { data: signIn, error: sErr } = await supabaseAnon.auth.signInWithPassword({
      email: v.email,
      password,
    });
    if (sErr || !signIn.session) {
      // Password was set but auto-login failed — tell them to sign in normally.
      return res.json({ passwordSet: true, session: null });
    }
    const { data: profile } = await supabaseAnon
      .from("profiles")
      .select("*")
      .eq("id", v.uid)
      .single();
    res.json({
      passwordSet: true,
      access_token: signIn.session.access_token,
      refresh_token: signIn.session.refresh_token,
      profile,
    });
  });

  // Self-serve "forgot password": a logged-out user requests a reset link by
  // email. If (and only if) an email provider is configured AND the email
  // matches an active account, we email a signed set-password link (reusing the
  // invite/complete flow). Always responds the same way so it never reveals
  // whether an email is registered. When email is dormant, `emailEnabled:false`
  // lets the UI tell the user to contact their admin instead.
  app.post("/api/auth/forgot-password", async (req: Request, res: Response) => {
    const email = String((req.body || {}).email || "").trim().toLowerCase();
    const emailEnabled = emailConfigured();
    // Uniform response regardless of outcome (no account enumeration).
    const ok = () => res.json({ ok: true, emailEnabled });

    if (!email || !emailEnabled || !supabaseAdmin) return ok();

    try {
      const { data: profile } = await supabaseAdmin
        .from("profiles")
        .select("id,email,name,active")
        .eq("email", email)
        .single();
      if (!profile || !profile.active) return ok();

      const appUrl =
        (process.env.APP_URL || "").trim() ||
        `${req.protocol}://${req.get("host")}` ||
        "https://dfs-ops-platform.vercel.app";
      // Reset links are short-lived (1 hour).
      const token = signInvite({
        uid: profile.id,
        email: profile.email,
        exp: Date.now() + 60 * 60 * 1000,
      });
      const link = `${appUrl.replace(/\/$/, "")}/#/set-password?token=${encodeURIComponent(token)}`;
      await sendPasswordResetEmail({ to: profile.email, name: profile.name, link });
    } catch (e) {
      console.error("[forgot-password] error", e);
    }
    return ok();
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

  // Change my own password. Any signed-in user can do this at any time; it's
  // also how a user completes a forced first-login password change. We
  // re-authenticate with the current password (so a stolen session can't
  // silently change it), set the new password, and clear the
  // must_change_password flag in auth metadata.
  app.post(
    "/api/account/change-password",
    requireAuth,
    async (req: Request, res: Response) => {
      const parsed = changePasswordSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      const { currentPassword, newPassword } = parsed.data;
      const me = req.profile!;
      if (currentPassword === newPassword)
        return res
          .status(400)
          .json({ message: "Your new password must be different from the current one." });

      // 1. Verify the current password by attempting a sign-in.
      const { data: signIn, error: sErr } =
        await supabaseAnon.auth.signInWithPassword({
          email: me.email,
          password: currentPassword,
        });
      if (sErr || !signIn.session) {
        return res.status(400).json({ message: "Your current password is incorrect." });
      }

      // 2. Set the new password. Prefer the admin API (also lets us clear the
      //    metadata flag); fall back to updating via the user's own session.
      if (supabaseAdmin) {
        const { error: uErr } = await supabaseAdmin.auth.admin.updateUserById(me.id, {
          password: newPassword,
          user_metadata: {
            name: me.name,
            must_change_password: false,
          },
        });
        if (uErr) return res.status(400).json({ message: uErr.message });
      } else {
        // No service role key: update through the just-established session.
        const { error: uErr } = await supabaseAnon.auth.updateUser(
          { password: newPassword },
          { /* uses the session from signIn above */ } as any,
        );
        if (uErr) return res.status(400).json({ message: uErr.message });
      }

      res.json({ changed: true });
    },
  );

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
        type:
          | "maintenance_due"
          | "signoff_overdue"
          | "signoff_pending"
          | "new_report"
          | "changes_requested"
          | "missing_data"
          | "service_charge";
        severity: "warning" | "info";
        title: string;
        detail: string;
        href: string;
        ts: string | null;
      };
      const items: Notification[] = [];

      const myId = req.profile!.id;
      const myEmail = (req.profile!.email || "").toLowerCase();

      // 1) Assets due / overdue for service (run-hour centrifuges).
      let aq = client
        .from("assets")
        .select("id, tag, category, area, run_hours, run_hours_at_service, service_hours_interval")
        .in("category", RUN_HOUR_CATEGORIES as unknown as string[]);
      if (scope) aq = aq.eq("area", scope);
      const { data: assetsData, error: aErr } = await aq;
      if (aErr) console.error("[notifications] assets", aErr.message);
      const svc = await hoursSinceServiceFor(client, (assetsData || []) as any[]);
      for (const a of (assetsData || []) as any[]) {
        const state = svc.get(a.id)?.state;
        const hrs = svc.get(a.id)?.hoursSince;
        if (state === "Overdue" || state === "Soon") {
          items.push({
            id: `maint-${a.id}`,
            type: "maintenance_due",
            severity: state === "Overdue" ? "warning" : "info",
            title:
              state === "Overdue"
                ? `${a.tag} is overdue for service`
                : `${a.tag} is due for service soon`,
            detail: `${a.category}${a.area ? ` · ${a.area}` : ""}${hrs != null ? ` · ${hrs} of ${SERVICE_INTERVAL_HOURS} hrs since service` : ""}`,
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
            "id, status, area, well_name, sender_name, sender_email, report_date, received_at, report_day, analysis, job_id",
          )
          .in("status", ["Pending Review", "Needs job match", "Correction pending"]);
        if (scope) dq = dq.eq("area", scope);
        const { data: drData, error: dErr } = await dq;
        if (dErr) console.error("[notifications] daily_reports", dErr.message);
        const manualJobs = await manualRateJobIds(client);
        for (const r0 of (drData || []) as any[]) {
          const r = withoutManualRateFlag(r0, manualJobs);
          const who = r.sender_name || r.sender_email || "Unknown sender";
          const well = r.well_name ? ` · ${r.well_name}` : "";
          // Missing critical data: a dedicated warning so whoever signs off
          // knows to check with the crew first (shown alongside the normal
          // sign-off / job-match alert).
          const missing: string[] = Array.isArray(r.analysis?.missing_fields)
            ? r.analysis.missing_fields
            : [];
          if (missing.length) {
            const short = missing.map((m: string) => m.split(" (")[0]).join(", ");
            items.push({
              id: `missing-${r.id}`,
              type: "missing_data",
              severity: "warning",
              title: `Report missing critical data`,
              detail: `${r.well_name || who}${r.report_day != null ? ` · Day ${r.report_day}` : ""} · ${short}`,
              href: `/daily-reports/${r.id}`,
              ts: r.received_at || r.report_date || null,
            });
          }
          if (r.status === "Correction pending") {
            // A corrected workbook arrived for a day that was already signed
            // off. An Admin or Area Manager has to apply (or discard) it.
            items.push({
              id: `correction-${r.id}`,
              type: "new_report",
              severity: "warning",
              title: `Corrected report waiting for approval`,
              detail: `${r.well_name || who}${r.report_day != null ? ` · Day ${r.report_day}` : ""}${r.area ? ` · ${r.area}` : ""}`,
              href: `/daily-reports/${r.id}`,
              ts: r.received_at || r.report_date || null,
            });
          } else if (r.status === "Needs job match") {
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

      // 4) Changes requested on MY reports/JSAs. This is the field-tech loop:
      //    when a reviewer bounces a report or JSA back, the person who filed it
      //    (or, for emailed reports, whose address it came from) sees it here so
      //    they know to fix and resubmit. Runs for every role — anyone can file.
      {
        // Daily reports I submitted (field reports) OR that were emailed from my
        // address (emailed reports), currently in "Changes requested".
        const orFilter = myEmail
          ? `submitted_by.eq.${myId},sender_email.ilike.${myEmail}`
          : `submitted_by.eq.${myId}`;
        const { data: crReports, error: crErr } = await client
          .from("daily_reports")
          .select(
            "id, well_name, area, report_date, received_at, change_notes, reviewed_by_name, reviewed_at",
          )
          .eq("status", "Changes requested")
          .or(orFilter);
        if (crErr) console.error("[notifications] changes_requested reports", crErr.message);
        for (const r of (crReports || []) as any[]) {
          const well = r.well_name ? ` · ${r.well_name}` : "";
          const by = r.reviewed_by_name ? ` by ${r.reviewed_by_name}` : "";
          const note = (r.change_notes || "").trim();
          items.push({
            id: `cr-report-${r.id}`,
            type: "changes_requested",
            severity: "warning",
            title: `Changes requested on your report${by}`,
            detail: note
              ? note
              : `${well ? well.slice(3) : "Daily report"}${r.area ? ` · ${r.area}` : ""}`,
            href: `/daily-reports/${r.id}`,
            ts: r.reviewed_at || r.received_at || r.report_date || null,
          });
        }

        // JSAs I submitted, currently in "Changes requested".
        const { data: crJsas, error: crjErr } = await client
          .from("jsas")
          .select(
            "id, job_id, jsa_number, well_name, change_notes, created_at",
          )
          .eq("status", "Changes requested")
          .eq("submitted_by", myId);
        if (crjErr) console.error("[notifications] changes_requested jsas", crjErr.message);
        for (const j of (crJsas || []) as any[]) {
          const well = j.well_name ? ` · ${j.well_name}` : "";
          const note = (j.change_notes || "").trim();
          items.push({
            id: `cr-jsa-${j.id}`,
            type: "changes_requested",
            severity: "warning",
            title: `Changes requested on your JSA #${j.jsa_number}`,
            detail: note ? note : `JSA #${j.jsa_number}${well}`,
            href: `/jobs/${j.job_id}`,
            ts: j.created_at || null,
          });
        }
      }

      // Service charges logged in the last 7 days (in this user's area) by
      // someone else — so supervisors / area managers see that a service was
      // made, what happened, and what it bills.
      if (canReview) {
        const since = new Date(now - 7 * DAY).toISOString();
        let sq = padClient()
          .from("job_services")
          .select("id, job_id, area, service_type, service_date, cost, notes, created_by, created_by_name, created_at, job:jobs(job_number)")
          .gte("created_at", since)
          .order("created_at", { ascending: false })
          .limit(50);
        if (scope) sq = sq.eq("area", scope);
        const { data: svcs, error: sErr } = await sq;
        if (sErr) console.error("[notifications] job_services", sErr.message);
        for (const v of (svcs || []) as any[]) {
          if (v.created_by && v.created_by === myId) continue;
          const jobNo = v.job?.job_number ?? "a job";
          const amt =
            v.cost != null && Number.isFinite(Number(v.cost))
              ? ` · $${Number(v.cost).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
              : "";
          const desc = String(v.notes ?? "").trim();
          items.push({
            id: `svc-${v.id}`,
            type: "service_charge",
            severity: "info",
            title: `${v.service_type} on ${jobNo}${amt}`,
            detail: `${desc ? (desc.length > 120 ? desc.slice(0, 117) + "…" : desc) : "No description"}${v.created_by_name ? ` · logged by ${v.created_by_name}` : ""}`,
            href: `/jobs/${v.job_id}`,
            ts: v.created_at || null,
          });
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
        corrected: "Replaced with corrected workbook",
        correction_received: "Corrected workbook received",
        correction_applied: "Correction applied",
        correction_discarded: "Correction discarded",
        workbook_replaced: "Workbook replaced by reviewer",
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

      const { email, name, mode, password, role, area, requirePasswordChange } = parsed.data;

      // In "password" mode the admin must supply a password. In "invite" mode we
      // create the account WITHOUT a password and email a set-password link.
      if (mode === "password" && !password) {
        return res
          .status(400)
          .json({ message: "A password is required when setting one manually." });
      }
      if (mode === "invite" && !emailConfigured()) {
        return res.status(400).json({
          message:
            "Email invites aren't enabled yet (no email provider configured). Set a password manually instead, or configure email delivery.",
        });
      }

      // 1. Create the auth user. Password mode: confirmed + password so they can
      //    log in immediately. Invite mode: no password; confirm the email so the
      //    recovery link works, and they set their password via the emailed link.
      // In password mode, optionally flag the account so the user is forced to
      // set their own password on first login (recommended when the admin picks
      // a temporary password to share). Stored in auth user_metadata — no DB
      // column. Invite users always choose their own password, so no flag.
      const mustChange = mode === "password" && requirePasswordChange !== false;
      const { data: created, error: cErr } =
        await supabaseAdmin.auth.admin.createUser({
          email,
          ...(mode === "password" ? { password } : {}),
          email_confirm: true,
          user_metadata: { name, ...(mustChange ? { must_change_password: true } : {}) },
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

      // 4. Invite mode: generate a Supabase recovery link and email it so the
      //    new user can set their own password. The redirect returns them to the
      //    app's set-password page. APP_URL lets you pin the canonical URL; we
      //    fall back to the request's own origin, then the known production URL.
      let invited = false;
      if (mode === "invite") {
        const appUrl =
          (process.env.APP_URL || "").trim() ||
          `${req.protocol}://${req.get("host")}` ||
          "https://dfs-ops-platform.vercel.app";
        // Signed, self-contained invite token valid for 7 days. The link lands
        // on the app's own set-password page, which posts the token back.
        const token = signInvite({
          uid: created.user.id,
          email,
          exp: Date.now() + 7 * 24 * 60 * 60 * 1000,
        });
        const link = `${appUrl.replace(/\/$/, "")}/#/set-password?token=${encodeURIComponent(token)}`;
        invited = await sendInviteEmail({
          to: email,
          name,
          inviterName: req.profile?.name ?? null,
          link,
        });
      }

      res.status(201).json({ ...profile, invited });
    },
  );

  // Resend an invite: regenerate a fresh 7-day set-password link and email it.
  // Works for any existing user (e.g. their first link expired, or they lost it).
  app.post(
    "/api/users/:id/resend-invite",
    requireAuth,
    requireRole("admin"),
    async (req: Request, res: Response) => {
      if (!hasAdmin() || !supabaseAdmin) {
        return res.status(503).json({
          message:
            "Account management is not enabled yet. The service role key must be configured in the deployment environment.",
        });
      }
      if (!emailConfigured()) {
        return res.status(400).json({
          message:
            "Email isn't enabled yet (no email provider configured), so invites can't be sent. Set a password for this user instead.",
        });
      }
      // Look up the user to invite.
      const { data: profile, error: pErr } = await supabaseAdmin
        .from("profiles")
        .select("id,email,name")
        .eq("id", req.params.id)
        .single();
      if (pErr || !profile)
        return res.status(404).json({ message: "User not found" });

      const appUrl =
        (process.env.APP_URL || "").trim() ||
        `${req.protocol}://${req.get("host")}` ||
        "https://dfs-ops-platform.vercel.app";
      const token = signInvite({
        uid: profile.id,
        email: profile.email,
        exp: Date.now() + 7 * 24 * 60 * 60 * 1000,
      });
      const link = `${appUrl.replace(/\/$/, "")}/#/set-password?token=${encodeURIComponent(token)}`;
      const sent = await sendInviteEmail({
        to: profile.email,
        name: profile.name,
        inviterName: req.profile?.name ?? null,
        link,
      });
      if (!sent) {
        return res.status(502).json({
          message:
            "The invite email could not be delivered. Check the email provider configuration.",
        });
      }
      res.json({ sent: true, email: profile.email });
    },
  );

  // Admin resets a user's password to a fresh temporary one (no email needed).
  // Returns the temporary password so the admin can share it; the user is
  // flagged to set their own password on next login.
  app.post(
    "/api/users/:id/reset-password",
    requireAuth,
    requireRole("admin"),
    async (req: Request, res: Response) => {
      if (!hasAdmin() || !supabaseAdmin) {
        return res.status(503).json({
          message:
            "Account management is not enabled yet. The service role key must be configured in the deployment environment.",
        });
      }
      const { data: profile, error: pErr } = await supabaseAdmin
        .from("profiles")
        .select("id,email,name")
        .eq("id", req.params.id)
        .single();
      if (pErr || !profile)
        return res.status(404).json({ message: "User not found" });

      // Generate a strong, readable 12-char temporary password (letters+digits,
      // no easily-confused characters).
      const temp = genTempPassword();
      const { error: uErr } = await supabaseAdmin.auth.admin.updateUserById(profile.id, {
        password: temp,
        user_metadata: { name: profile.name, must_change_password: true },
      });
      if (uErr) return res.status(400).json({ message: uErr.message });
      res.json({ reset: true, email: profile.email, temporaryPassword: temp });
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
    requireRole("admin"),
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
    requireRole("admin"),
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

  // Delete a customer (admin only). Blocked when the customer still has jobs so
  // job history is never orphaned — the admin must reassign/remove those jobs
  // first. Returns 409 with a count when jobs exist.
  app.delete(
    "/api/customers/:id",
    requireAuth,
    requireRole("admin"),
    async (req: Request, res: Response) => {
      const client = supabaseAdmin || supabaseAnon;
      const { count, error: countErr } = await client
        .from("jobs")
        .select("id", { count: "exact", head: true })
        .eq("customer_id", req.params.id);
      if (countErr) return res.status(500).json({ message: countErr.message });
      if ((count ?? 0) > 0)
        return res.status(409).json({
          message: `This customer has ${count} job${count === 1 ? "" : "s"}. Remove or reassign those jobs before deleting the customer.`,
        });
      const { error } = await client
        .from("customers")
        .delete()
        .eq("id", req.params.id);
      if (error) return res.status(400).json({ message: error.message });
      res.status(204).end();
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
    if (jobIds) q = q.in("id", jobIds.length ? jobIds : ["00000000-0000-0000-0000-000000000000"]);
    if (onlyArchived) q = q.not("archived_at", "is", null);
    else if (!includeArchived) q = q.is("archived_at", null);
    const { data, error } = await q;
    if (error) return res.status(500).json({ message: error.message });
    // flatten the joined customer name
    const billing = await computeManualBilling(data || []);
    const rows = (data || []).map((j: any) => ({
      ...j,
      customer_name: j.customer?.name ?? "",
      customer: undefined,
      manual_billing: j.manual_day_rate ? publicBilling(billing.get(j.id)) : null,
    }));
    res.json(rows);
  });

  // Run hours per asset per well on one job, from the run-hours log (one row
  // per asset per signed-off daily report). Also reports, per well, the day
  // hours on this job's reports that have NOT been credited to any asset yet
  // (awaiting sign-off, or signed off without being applied).
  app.get("/api/jobs/:id/well-run-hours", requireAuth, async (req: Request, res: Response) => {
    const client = supabaseAdmin || supabaseAnon;
    const { data: job } = await client.from("jobs").select("id, area").eq("id", req.params.id).single();
    if (!job) return res.status(404).json({ message: "Job not found" });
    const scope = areaScopeOf(req.profile!);
    if (scope && job.area !== scope) return res.status(404).json({ message: "Job not found" });
    const jobIds = await jobScopeOf(req.profile!);
    if (jobIds && !jobIds.includes(job.id)) return res.status(404).json({ message: "Job not found" });

    const num = (v: any) => (v == null || v === "" || !Number.isFinite(Number(v)) ? 0 : Number(v));
    const wellKey = (w: any) => String(w ?? "").trim().replace(/\s+/g, " ").toLowerCase();

    // 1) Credited hours from the log.
    const log: any[] = [];
    let ready = true;
    for (let from = 0; ; from += 1000) {
      const { data, error } = await client
        .from("asset_run_hours")
        .select("asset_id, daily_report_id, well_name, report_date, hours")
        .eq("job_id", job.id)
        .range(from, from + 999);
      if (error) { ready = false; break; }
      log.push(...(data || []));
      if (!data || data.length < 1000) break;
    }

    // 2) This job's daily reports (for not-yet-credited hours and dates).
    const reports: any[] = [];
    for (let from = 0; ; from += 1000) {
      const { data } = await client
        .from("daily_reports")
        .select("id, well_name, report_date, status, run_hours_applied, kpis")
        .eq("job_id", job.id)
        .range(from, from + 999);
      reports.push(...(data || []));
      if (!data || data.length < 1000) break;
    }

    // 3) Assets: everything that logged hours here plus centrifuges on the job now.
    const assetIds = Array.from(new Set(log.map((r) => r.asset_id)));
    const { data: onJob } = await client
      .from("assets")
      .select("id, tag, category, is_rental, rental_vendor, centrifuge_slot, job_id")
      .eq("job_id", job.id)
      .in("category", RUN_HOUR_CATEGORIES as unknown as string[]);
    const missing = assetIds.filter((id) => !(onJob || []).some((a: any) => a.id === id));
    const { data: past } = missing.length
      ? await client
          .from("assets")
          .select("id, tag, category, is_rental, rental_vendor, centrifuge_slot, job_id")
          .in("id", missing)
      : { data: [] as any[] };
    const assets = [...(onJob || []), ...(past || [])].map((a: any) => ({
      id: a.id,
      tag: a.tag,
      category: a.category,
      is_rental: !!a.is_rental,
      rental_vendor: a.rental_vendor ?? null,
      centrifuge_slot: a.job_id === job.id ? a.centrifuge_slot ?? null : null,
      on_job_now: a.job_id === job.id,
    }));

    type W = {
      well_name: string;
      first_date: string | null;
      last_date: string | null;
      by_asset: Record<string, number>;
      total: number;
      awaiting_hours: number;
      uncredited_hours: number;
    };
    const wells = new Map<string, W>();
    const getW = (name: any): W => {
      const k = wellKey(name) || "(no well name)";
      let w = wells.get(k);
      if (!w) {
        w = { well_name: String(name ?? "").trim() || "(no well name)", first_date: null, last_date: null, by_asset: {}, total: 0, awaiting_hours: 0, uncredited_hours: 0 };
        wells.set(k, w);
      }
      return w;
    };
    const touch = (w: W, d: string | null) => {
      if (!d) return;
      if (!w.first_date || d < w.first_date) w.first_date = d;
      if (!w.last_date || d > w.last_date) w.last_date = d;
    };
    for (const r of log) {
      const w = getW(r.well_name);
      const h = num(r.hours);
      w.by_asset[r.asset_id] = (w.by_asset[r.asset_id] || 0) + h;
      w.total += h;
      touch(w, r.report_date);
    }
    // A second copy of a day that's already counted isn't "not credited".
    const dayKey = (r: any) => `${r.report_date ?? ""}|${wellKey(r.well_name)}`;
    const countedDays = new Set(reports.filter((r) => r.run_hours_applied).map(dayKey));
    const pendingSeen = new Set<string>();
    for (const r of reports) {
      const w = getW(r.well_name);
      touch(w, r.report_date);
      if (r.run_hours_applied) continue;
      const by = slotDailyHours(r.kpis);
      const h = num(by[1]) + num(by[2]) + num(by[3]) + num(by[4]);
      if (h <= 0) continue;
      if (r.status === "Signed off") {
        const k = dayKey(r);
        if (countedDays.has(k) || pendingSeen.has(k)) continue;
        pendingSeen.add(k);
      }
      if (r.status === "Signed off") w.uncredited_hours += h;
      else w.awaiting_hours += h;
    }
    const round = (n: number) => Math.round(n * 100) / 100;
    const list = Array.from(wells.values())
      .map((w) => ({
        ...w,
        total: round(w.total),
        awaiting_hours: round(w.awaiting_hours),
        uncredited_hours: round(w.uncredited_hours),
        by_asset: Object.fromEntries(Object.entries(w.by_asset).map(([k, v]) => [k, round(v)])),
      }))
      .filter((w) => w.total > 0 || w.awaiting_hours > 0 || w.uncredited_hours > 0 || assets.length > 0)
      // Most recent well first.
      .sort((a, b) => String(b.last_date ?? "").localeCompare(String(a.last_date ?? "")));
    res.json({ ready, assets, wells: list });
  });

  // ---- Credit not-credited run hours (job page button) -----------------------
  // Signed-off reports on this job whose run hours were never added to a
  // centrifuge (e.g. a workbook import while a slot wasn't mapped yet). Uses the
  // same routing as sign-off, onto the centrifuges on the job NOW: one unit ->
  // the whole day; 2+ units -> each unit's own Centrifuge 1-4 column (every
  // unit must be mapped). Duplicate copies of a day that's already credited are
  // skipped. GET = preview, POST = apply. Admins + Area Managers.
  async function planJobCredit(client: any, jobId: string) {
    const { data: cents } = await client
      .from("assets")
      .select("id, tag, run_hours, centrifuge_slot")
      .eq("job_id", jobId)
      .in("category", RUN_HOUR_CATEGORIES as unknown as string[])
      .order("tag");
    const centrifuges: any[] = cents || [];
    const reports: any[] = [];
    for (let from = 0; ; from += 1000) {
      const { data } = await client
        .from("daily_reports")
        .select("id, well_name, report_date, status, run_hours_applied, kpis")
        .eq("job_id", jobId)
        .eq("status", "Signed off")
        .order("report_date", { ascending: true })
        .order("id", { ascending: true })
        .range(from, from + 999);
      reports.push(...(data || []));
      if (!data || data.length < 1000) break;
    }
    const wk = (r: any) => `${r.report_date ?? ""}|${String(r.well_name ?? "").trim().replace(/\s+/g, " ").toLowerCase()}`;
    const creditedDays = new Set(reports.filter((r) => r.run_hours_applied).map(wk));
    const seen = new Set<string>();
    const unmapped = centrifuges.length >= 2 ? centrifuges.filter((c) => !isMappedSlot(c.centrifuge_slot)) : [];
    let problem: string | null = null;
    if (!centrifuges.length) problem = "There are no centrifuges on this job right now, so there's nothing to credit the hours to.";
    else if (unmapped.length)
      problem = `Set each centrifuge to its column (Centrifuge 1, 2, 3 or 4) first so hours go to the right unit. Needs a slot: ${unmapped
        .map((c) => c.tag)
        .join(", ")}`;

    const plan: { report: any; alloc: { asset_id: string; tag: string; add: number }[] }[] = [];
    let duplicates = 0;
    let unrouted = 0; // reports with hours in a column no unit is set to
    for (const r of reports) {
      if (r.run_hours_applied) continue;
      const by = slotDailyHours(r.kpis);
      const d = Number((r.kpis as any)?.daily_run_hours);
      const any = Object.values(by).some((h) => h != null && h > 0) || (Number.isFinite(d) && d > 0);
      if (!any) continue;
      const k = wk(r);
      if (creditedDays.has(k) || seen.has(k)) {
        duplicates++;
        continue;
      }
      seen.add(k);
      if (problem) continue;
      let alloc: { asset_id: string; tag: string; add: number }[] = [];
      if (centrifuges.length === 1) {
        const c = centrifuges[0];
        const h = soloCentrifugeHours(r.kpis, c.centrifuge_slot);
        if (h > 0) alloc = [{ asset_id: c.id, tag: c.tag, add: h }];
      } else {
        alloc = centrifuges
          .map((c) => ({ asset_id: c.id, tag: c.tag, add: Number(by[Number(c.centrifuge_slot)] ?? 0) || 0 }))
          .filter((a) => a.add > 0);
      }
      if (alloc.length) plan.push({ report: r, alloc });
      else unrouted++;
    }
    const perAsset = centrifuges.map((c) => {
      const rows = plan.flatMap((p) => p.alloc.filter((a) => a.asset_id === c.id).map((a) => ({ a, d: p.report.report_date })));
      const dates = rows.map((x) => x.d).filter(Boolean).sort();
      return {
        asset_id: c.id,
        tag: c.tag,
        centrifuge_slot: c.centrifuge_slot ?? null,
        hours: Math.round(rows.reduce((t, x) => t + x.a.add, 0) * 100) / 100,
        days: rows.length,
        first_date: dates[0] ?? null,
        last_date: dates[dates.length - 1] ?? null,
        meter_now: Number(c.run_hours ?? 0) || 0,
      };
    });
    return { centrifuges, plan, perAsset, problem, duplicates, unrouted };
  }

  async function creditJobGuard(req: Request, res: Response) {
    const client = supabaseAdmin || supabaseAnon;
    const { data: job } = await client.from("jobs").select("id, area, job_number").eq("id", req.params.id).single();
    if (!job) {
      res.status(404).json({ message: "Job not found" });
      return null;
    }
    const scope = areaScopeOf(req.profile!);
    if (scope && job.area !== scope) {
      res.status(403).json({ message: "Outside your area" });
      return null;
    }
    return { client, job };
  }

  // ---- Mud Plant: billing calendar + hand-entered centrifuge hours ----------
  // Only for jobs with manual_billing_mode = 'calendar' (no daily reports).
  const ISO = /^\d{4}-\d{2}-\d{2}$/;
  async function calendarJobGuard(req: Request, res: Response) {
    const client = supabaseAdmin || supabaseAnon;
    const { data: job, error } = await client
      .from("jobs")
      .select("id, area, job_number, day_rate, status, manual_day_rate, manual_billing_mode, billing_start_date, started_on")
      .eq("id", req.params.id)
      .single();
    if (error || !job) {
      res.status(404).json({ message: "Job not found" });
      return null;
    }
    const scope = areaScopeOf(req.profile!);
    if (scope && (job as any).area !== scope) {
      res.status(404).json({ message: "Job not found" });
      return null;
    }
    const jobIds = await jobScopeOf(req.profile!);
    if (jobIds && !jobIds.includes((job as any).id)) {
      res.status(404).json({ message: "Job not found" });
      return null;
    }
    if ((job as any).manual_billing_mode !== "calendar") {
      res.status(400).json({ message: "This job isn't on a billing calendar." });
      return null;
    }
    return { client, job: job as any };
  }
  const canEditCalendar = (req: Request) => ["admin", "area"].includes(String(req.profile!.role));

  app.get("/api/jobs/:id/billing-calendar", requireAuth, async (req: Request, res: Response) => {
    const g = await calendarJobGuard(req, res);
    if (!g) return;
    const { client, job } = g;
    const { data: days } = await client
      .from("job_billing_days")
      .select("day, billing, note, changed_by_name, changed_at")
      .eq("job_id", job.id)
      .order("day", { ascending: true });
    const { data: events } = await client
      .from("job_billing_events")
      .select("kind, day, billing, start_date, note, changed_by_name, created_at")
      .eq("job_id", job.id)
      .order("created_at", { ascending: false })
      .limit(15);
    const billing = (await computeManualBilling([job])).get(job.id);
    // Service / drive-by / call-out charges are added on top of the day rate
    // for the day they occurred (they're billed to the customer).
    const { data: svcRows } = await client
      .from("job_services")
      .select("id, service_type, service_date, cost, notes")
      .eq("job_id", job.id)
      .order("service_date", { ascending: true });
    const services: Record<string, { total: number; items: { type: string; cost: number; notes: string | null }[] }> = {};
    let serviceTotal = 0;
    for (const v of (svcRows || []) as any[]) {
      const amt = Number(v.cost);
      const day = String(v.service_date ?? "").slice(0, 10);
      if (!Number.isFinite(amt) || amt <= 0 || !ISO.test(day)) continue;
      const cur = services[day] ?? { total: 0, items: [] };
      cur.total = Math.round((cur.total + amt) * 100) / 100;
      cur.items.push({ type: v.service_type, cost: amt, notes: v.notes ?? null });
      services[day] = cur;
      serviceTotal = Math.round((serviceTotal + amt) * 100) / 100;
    }
    res.json({
      start_date: job.billing_start_date ?? job.started_on ?? null,
      day_rate: job.day_rate != null ? Number(job.day_rate) : null,
      today: todayCentral(),
      days: (days || []).map((d: any) => ({ ...d, day: String(d.day).slice(0, 10) })),
      events: events || [],
      summary: publicBilling(billing),
      daily: billing ? Object.fromEntries(billing.daily) : {},
      services,
      service_total: serviceTotal,
      can_edit: canEditCalendar(req),
    });
  });

  app.put("/api/jobs/:id/billing-calendar/day", requireAuth, requireRole("admin", "area"), async (req: Request, res: Response) => {
    const g = await calendarJobGuard(req, res);
    if (!g) return;
    const { client, job } = g;
    const day = String(req.body?.day ?? "");
    const billing = req.body?.billing;
    const note = req.body?.note ? String(req.body.note).slice(0, 500) : null;
    if (!ISO.test(day)) return res.status(400).json({ message: "Pick a valid day." });
    if (typeof billing !== "boolean") return res.status(400).json({ message: "Choose Billing or Not billing." });
    const actor = req.profile!;
    const { error } = await client.from("job_billing_days").upsert(
      { job_id: job.id, day, billing, note, changed_by: actor.id, changed_by_name: actor.name, changed_at: new Date().toISOString() },
      { onConflict: "job_id,day" },
    );
    if (error) return res.status(400).json({ message: `Could not save: ${error.message}` });
    await client.from("job_billing_events").insert({
      job_id: job.id, kind: "day", day, billing, note, changed_by: actor.id, changed_by_name: actor.name,
    });
    res.json({ ok: true });
  });

  app.put("/api/jobs/:id/billing-calendar/start", requireAuth, requireRole("admin", "area"), async (req: Request, res: Response) => {
    const g = await calendarJobGuard(req, res);
    if (!g) return;
    const { client, job } = g;
    const start = String(req.body?.start_date ?? "");
    if (!ISO.test(start)) return res.status(400).json({ message: "Pick a valid start date." });
    if (start > todayCentral()) return res.status(400).json({ message: "The billing start date can't be in the future." });
    const { error } = await client.from("jobs").update({ billing_start_date: start }).eq("id", job.id);
    if (error) return res.status(400).json({ message: `Could not save: ${error.message}` });
    const actor = req.profile!;
    await client.from("job_billing_events").insert({
      job_id: job.id, kind: "start", start_date: start, changed_by: actor.id, changed_by_name: actor.name,
    });
    res.json({ ok: true });
  });

  // Centrifuges on the job + hand-entered hours for a date range.
  app.get("/api/jobs/:id/manual-hours", requireAuth, async (req: Request, res: Response) => {
    const g = await calendarJobGuard(req, res);
    if (!g) return;
    const { client, job } = g;
    const today = todayCentral();
    const to = ISO.test(String(req.query.to ?? "")) ? String(req.query.to) : today;
    const from = ISO.test(String(req.query.from ?? "")) ? String(req.query.from) : (() => {
      const d = new Date(to + "T12:00:00Z");
      d.setUTCDate(d.getUTCDate() - 6);
      return d.toISOString().slice(0, 10);
    })();
    const { data: assets } = await client
      .from("assets")
      .select("id, tag, category, run_hours, run_hours_at_service, service_hours_interval")
      .eq("job_id", job.id)
      .in("category", RUN_HOUR_CATEGORIES as unknown as string[])
      .order("tag", { ascending: true });
    const list = (assets || []) as any[];
    const { data: rows } = await client
      .from("asset_run_hours")
      .select("asset_id, report_date, hours, entered_by_name, created_at")
      .eq("job_id", job.id)
      .is("daily_report_id", null)
      .gte("report_date", from)
      .lte("report_date", to)
      .order("report_date", { ascending: false });
    // Month-to-date totals per centrifuge (hand-entered on this job).
    const monthStart = to.slice(0, 8) + "01";
    const { data: mtdRows } = await client
      .from("asset_run_hours")
      .select("asset_id, hours")
      .eq("job_id", job.id)
      .is("daily_report_id", null)
      .gte("report_date", monthStart)
      .lte("report_date", to);
    const mtd: Record<string, number> = {};
    for (const r of (mtdRows || []) as any[]) mtd[r.asset_id] = round2((mtd[r.asset_id] ?? 0) + (Number(r.hours) || 0));
    // Days (from the billing start, max 31 back) with no hours for any centrifuge.
    const start = String(job.billing_start_date ?? job.started_on ?? "").slice(0, 10);
    const lookFrom = (() => {
      const d = new Date(today + "T12:00:00Z");
      d.setUTCDate(d.getUTCDate() - 30);
      const s = d.toISOString().slice(0, 10);
      return ISO.test(start) && start > s ? start : s;
    })();
    const { data: seen } = await client
      .from("asset_run_hours")
      .select("report_date")
      .eq("job_id", job.id)
      .is("daily_report_id", null)
      .gte("report_date", lookFrom)
      .lte("report_date", today);
    const have = new Set(((seen || []) as any[]).map((r) => String(r.report_date).slice(0, 10)));
    const missing: string[] = [];
    if (list.length) {
      const d = new Date(lookFrom + "T12:00:00Z");
      // today isn't "missing" yet — hours are usually entered at day end
      while (d.toISOString().slice(0, 10) < today) {
        const s = d.toISOString().slice(0, 10);
        if (!have.has(s)) missing.push(s);
        d.setUTCDate(d.getUTCDate() + 1);
      }
    }
    const svc = await hoursSinceServiceFor(client, list);
    res.json({
      from,
      to,
      today,
      assets: list.map((a) => ({
        id: a.id,
        tag: a.tag,
        category: a.category,
        hours_since_service: svc.get(a.id)?.hoursSince ?? null,
        service_state: svc.get(a.id)?.state ?? null,
        month_hours: mtd[a.id] ?? 0,
      })),
      entries: ((rows || []) as any[]).map((r) => ({ ...r, report_date: String(r.report_date).slice(0, 10) })),
      missing_days: missing,
      can_edit: canEditCalendar(req),
    });
  });

  // Save one day's hours. entries: [{ asset_id, hours }] — hours null clears it.
  app.put("/api/jobs/:id/manual-hours", requireAuth, requireRole("admin", "area"), async (req: Request, res: Response) => {
    const g = await calendarJobGuard(req, res);
    if (!g) return;
    const { client, job } = g;
    const date = String(req.body?.date ?? "");
    const entries = Array.isArray(req.body?.entries) ? req.body.entries : [];
    if (!ISO.test(date)) return res.status(400).json({ message: "Pick a valid date." });
    if (date > todayCentral()) return res.status(400).json({ message: "You can't enter hours for a future day." });
    if (!entries.length) return res.status(400).json({ message: "Enter hours for at least one centrifuge." });
    const { data: assets } = await client
      .from("assets")
      .select("id, tag, run_hours")
      .eq("job_id", job.id)
      .in("category", RUN_HOUR_CATEGORIES as unknown as string[]);
    const byId = new Map(((assets || []) as any[]).map((a) => [a.id, a]));
    const clean: { asset_id: string; hours: number | null; tag: string }[] = [];
    for (const e of entries) {
      const a = byId.get(String(e?.asset_id ?? ""));
      if (!a) return res.status(400).json({ message: "One of those centrifuges isn't on this job." });
      const raw = e?.hours;
      if (raw === null || raw === "" || raw === undefined) {
        clean.push({ asset_id: a.id, hours: null, tag: a.tag });
        continue;
      }
      const h = Number(raw);
      if (!Number.isFinite(h) || h < 0 || h > 24)
        return res.status(400).json({ message: `${a.tag}: hours must be between 0 and 24.` });
      clean.push({ asset_id: a.id, hours: round2(h), tag: a.tag });
    }
    const actor = req.profile!;
    for (const e of clean) {
      const { data: prev } = await client
        .from("asset_run_hours")
        .select("id, hours")
        .eq("asset_id", e.asset_id)
        .eq("job_id", job.id)
        .eq("report_date", date)
        .is("daily_report_id", null)
        .maybeSingle();
      const old = prev ? Number((prev as any).hours) || 0 : 0;
      const next = e.hours ?? 0;
      if (prev && e.hours == null) {
        const { error } = await client.from("asset_run_hours").delete().eq("id", (prev as any).id);
        if (error) return res.status(400).json({ message: `${e.tag}: ${error.message}` });
      } else if (prev) {
        const { error } = await client
          .from("asset_run_hours")
          .update({ hours: next, entered_by: actor.id, entered_by_name: actor.name })
          .eq("id", (prev as any).id);
        if (error) return res.status(400).json({ message: `${e.tag}: ${error.message}` });
      } else if (e.hours != null) {
        const { error } = await client.from("asset_run_hours").insert({
          asset_id: e.asset_id,
          daily_report_id: null,
          job_id: job.id,
          well_name: `${MONTH_NAMES[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`,
          report_date: date,
          hours: next,
          source: "manual",
          entered_by: actor.id,
          entered_by_name: actor.name,
        });
        if (error) return res.status(400).json({ message: `${e.tag}: ${error.message}` });
      }
      // Keep the centrifuge's hour meter in step with the change.
      const delta = round2(next - old);
      if (delta !== 0) {
        const { data: cur } = await client.from("assets").select("run_hours").eq("id", e.asset_id).single();
        const meter = round2(Math.max(0, (Number((cur as any)?.run_hours ?? 0) || 0) + delta));
        await client.from("assets").update({ run_hours: meter }).eq("id", e.asset_id);
      }
    }
    res.json({ ok: true, saved: clean.length });
  });

  app.get("/api/jobs/:id/credit-run-hours", requireAuth, requireRole("admin", "area"), async (req: Request, res: Response) => {
    const g = await creditJobGuard(req, res);
    if (!g) return;
    const p = await planJobCredit(g.client, g.job.id);
    res.json({
      problem: p.problem,
      reports: p.plan.length,
      hours: Math.round(p.perAsset.reduce((t, a) => t + a.hours, 0) * 100) / 100,
      per_asset: p.perAsset,
      duplicates: p.duplicates,
      unrouted: p.unrouted,
    });
  });

  app.post("/api/jobs/:id/credit-run-hours", requireAuth, requireRole("admin", "area"), async (req: Request, res: Response) => {
    const g = await creditJobGuard(req, res);
    if (!g) return;
    const { client, job } = g;
    const p = await planJobCredit(client, job.id);
    if (p.problem) return res.status(400).json({ message: p.problem });
    if (!p.plan.length) return res.status(400).json({ message: "There are no run hours left to credit on this job." });
    // 1) Meters: one update per centrifuge (fresh read so nothing is lost).
    for (const a of p.perAsset.filter((x) => x.hours > 0)) {
      const { data: cur } = await client.from("assets").select("run_hours").eq("id", a.asset_id).single();
      const next = Math.round(((Number((cur as any)?.run_hours ?? 0) || 0) + a.hours) * 100) / 100;
      const { error } = await client.from("assets").update({ run_hours: next }).eq("id", a.asset_id);
      if (error) return res.status(400).json({ message: `Could not update run hours for ${a.tag}: ${error.message}` });
    }
    // 2) Log + 3) mark each report credited (never added twice).
    const actor = req.profile!;
    for (const { report, alloc } of p.plan) {
      await logRunHours(
        client,
        { id: report.id, job_id: job.id, well_name: report.well_name ?? null, report_date: report.report_date ?? null },
        alloc.map((x) => ({ asset_id: x.asset_id, add: x.add })),
      );
      await client.from("daily_reports").update({ run_hours_applied: true }).eq("id", report.id);
      await client.from("daily_report_events").insert({
        report_id: report.id,
        actor_id: actor.id,
        actor_name: actor.name,
        actor_role: actor.role,
        action: "run_hours_credited",
        detail: `Run hours credited from the job page: ${alloc.map((x) => `${x.tag} +${x.add} hrs`).join(", ")}`,
      });
    }
    res.json({
      reports: p.plan.length,
      hours: Math.round(p.perAsset.reduce((t, a) => t + a.hours, 0) * 100) / 100,
      per_asset: p.perAsset.filter((a) => a.hours > 0),
    });
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
    const billing = rest.manual_day_rate
      ? publicBilling((await computeManualBilling([rest as any])).get(rest.id))
      : null;
    res.json({
      ...rest,
      customer_name: customer?.name ?? "",
      field_tech_ids: assignments.map((a: any) => a.profile_id),
      assignments,
      manual_billing: billing,
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
        // Partial unique index (job_number, area) WHERE archived_at IS NULL:
        // only an ACTIVE job blocks the number. Archived jobs free it for reuse.
        if (error.code === "23505")
          return res.status(409).json({
            message: `Job ${parsed.data.job_number} is already active in ${parsed.data.area}. Archive that job first, or use a different number.`,
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
        .select("*")
        .eq("id", req.params.id)
        .single();
      if (!job) return res.status(404).json({ message: "Job not found" });
      if (req.profile!.role !== "admin" && job.area !== req.profile!.area)
        return res.status(403).json({ message: "Outside your area" });
      const patch: any = { ...parsed.data };
      // Only Admins and Area Managers can switch set day rate billing.
      if (
        patch.manual_day_rate !== undefined &&
        patch.manual_day_rate !== !!job.manual_day_rate &&
        !["admin", "area"].includes(req.profile!.role)
      )
        return res.status(403).json({
          message: "Only an Admin or Area Manager can change set day rate billing",
        });
      if (patch.manual_day_rate === !!job.manual_day_rate) delete patch.manual_day_rate;
      // Billing mode: Admin / Area Manager only; drop it when unchanged so an
      // edit still works before the manual_billing_mode column exists.
      if (patch.manual_billing_mode !== undefined) {
        const cur = job.manual_billing_mode === "spud_to_latest" ? "spud_to_latest" : "report_days";
        if (patch.manual_billing_mode === cur) delete patch.manual_billing_mode;
        else if (!["admin", "area"].includes(req.profile!.role))
          return res.status(403).json({
            message: "Only an Admin or Area Manager can change set day rate billing",
          });
      }
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
        // Set day rate jobs: log the rate/status change (applies from today).
        await recordRateChange(job as any, data as any, {
          id: req.profile!.id,
          name: (req.profile as any)?.name ?? null,
        });
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
  // the default jobs list, and sets its status to Completed. Assigned assets
  // are released back to Available so they can be used on other jobs.
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
        .update({ archived_at: new Date().toISOString(), status: "Completed" })
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

  // ---- Delete an archived job (admin only) ------------------------------
  // Only archived jobs can be deleted. Its email-imported daily reports and
  // intake JSAs are kept: they move to the active job you pick, or go back to
  // "Needs job match". Everything else that belongs only to the job (pads,
  // wells, field tickets, field reports, crew JSAs, services, rate history,
  // assignments) is deleted with it. Assets, run-hour history and forecasts
  // keep their rows and just lose the link.
  const DELETE_COUNT_TABLES: [string, string][] = [
    ["daily_reports", "Daily reports"],
    ["jsa_reports", "Intake JSAs"],
    ["pads", "Pads"],
    ["wells", "Wells"],
    ["field_tickets", "Field tickets"],
    ["field_daily_reports", "Field daily reports"],
    ["jsas", "Crew JSAs"],
    ["service_reports", "Service reports"],
    ["rig_up_reports", "Rig-up reports"],
    ["job_services", "Job services"],
  ];
  async function jobDeleteCounts(client: any, jobId: string) {
    const out: Record<string, number> = {};
    for (const [t] of DELETE_COUNT_TABLES) {
      const { count } = await client.from(t).select("id", { count: "exact", head: true }).eq("job_id", jobId);
      out[t] = count ?? 0;
    }
    return out;
  }
  app.get(
    "/api/jobs/:id/delete-preview",
    requireAuth,
    requireRole("admin"),
    async (req: Request, res: Response) => {
      const client = supabaseAdmin || supabaseAnon;
      const { data: job } = await client
        .from("jobs")
        .select("id, job_number, area, archived_at, customer_id")
        .eq("id", req.params.id)
        .maybeSingle();
      if (!job) return res.status(404).json({ message: "Job not found" });
      if (!job.archived_at) return res.status(409).json({ message: "Only archived jobs can be deleted. Archive it first." });
      const counts = await jobDeleteCounts(client, job.id);
      // Live jobs with the same number (likely where its reports belong).
      const { data: live } = await client
        .from("jobs")
        .select("id, job_number, area, customer:customers(name)")
        .is("archived_at", null)
        .order("job_number");
      res.json({
        job,
        counts: DELETE_COUNT_TABLES.map(([t, label]) => ({ table: t, label, count: counts[t] })),
        move_targets: (live || []).map((j: any) => ({
          id: j.id,
          job_number: j.job_number,
          area: j.area,
          customer_name: j.customer?.name ?? null,
          same_number: normJobId(j.job_number) === normJobId(job.job_number),
        })),
      });
    },
  );
  app.post(
    "/api/jobs/:id/delete",
    requireAuth,
    requireRole("admin"),
    async (req: Request, res: Response) => {
      const client = supabaseAdmin || supabaseAnon;
      const confirm = String(req.body?.confirm_job_number ?? "").trim();
      const moveTo: string | null = req.body?.move_to_job_id ? String(req.body.move_to_job_id) : null;
      const { data: job } = await client
        .from("jobs")
        .select("id, job_number, area, archived_at")
        .eq("id", req.params.id)
        .maybeSingle();
      if (!job) return res.status(404).json({ message: "Job not found" });
      if (!job.archived_at)
        return res.status(409).json({ message: "Only archived jobs can be deleted. Archive it first." });
      if (normJobId(confirm) !== normJobId(job.job_number))
        return res.status(400).json({ message: `Type the job number (${job.job_number}) to confirm.` });
      let target: any = null;
      if (moveTo) {
        if (moveTo === job.id) return res.status(400).json({ message: "Pick a different job to move the reports to." });
        const { data: t } = await client
          .from("jobs")
          .select("id, job_number, area, customer_id, archived_at")
          .eq("id", moveTo)
          .maybeSingle();
        if (!t) return res.status(404).json({ message: "The job to move reports to wasn't found" });
        if (t.archived_at) return res.status(409).json({ message: ARCHIVED_JOB_MSG });
        target = t;
      }
      const who = req.profile!;
      const actor = { actor_id: who.id, actor_name: who.name ?? null, actor_role: who.role };

      // 1) Daily reports: move (keep status) or unlink (back to Needs job match).
      const { data: reps } = await client.from("daily_reports").select("id").eq("job_id", job.id);
      const repIds = (reps || []).map((r: any) => r.id);
      if (repIds.length) {
        const patch = target
          ? { job_id: target.id, area: target.area, customer_id: target.customer_id }
          : { job_id: null, customer_id: null, status: "Needs job match" };
        const { error } = await client.from("daily_reports").update(patch).in("id", repIds);
        if (error) return res.status(400).json({ message: `Couldn't move the daily reports: ${error.message}` });
        await client.from("daily_report_events").insert(
          repIds.map((id: string) => ({
            report_id: id,
            ...actor,
            action: "job_changed",
            detail: target
              ? `Moved from archived job ${job.job_number} (deleted) to ${target.job_number}.`
              : `Archived job ${job.job_number} was deleted; report unlinked and back to Needs job match.`,
          })),
        );
      }
      // 2) Intake JSAs: same.
      const { data: jsas } = await client.from("jsa_reports").select("id").eq("job_id", job.id);
      const jsaIds = (jsas || []).map((r: any) => r.id);
      if (jsaIds.length) {
        const patch = target
          ? { job_id: target.id, area: target.area, customer_id: target.customer_id }
          : { job_id: null, customer_id: null, status: "Needs job match" };
        const { error } = await client.from("jsa_reports").update(patch).in("id", jsaIds);
        if (error) return res.status(400).json({ message: `Couldn't move the intake JSAs: ${error.message}` });
      }
      // 3) Delete the job (cascades its own records; others are unlinked).
      const { error: dErr } = await client.from("jobs").delete().eq("id", job.id);
      if (dErr) return res.status(400).json({ message: `Couldn't delete the job: ${dErr.message}` });
      res.json({ ok: true, moved_reports: repIds.length, moved_jsas: jsaIds.length, moved_to: target?.job_number ?? null });
    },
  );

  // Restore an archived job. A Completed job comes back as Active (it was
  // completed by archiving); any other status is kept. Does not re-assign the
  // assets that were released when it was archived — those are picked again
  // from the job page.
  app.post(
    "/api/jobs/:id/unarchive",
    requireAuth,
    requireRole("admin", "area", "super"),
    async (req: Request, res: Response) => {
      const client = supabaseAdmin || supabaseAnon;
      const { data: job } = await client
        .from("jobs")
        .select("area, archived_at, status")
        .eq("id", req.params.id)
        .single();
      if (!job) return res.status(404).json({ message: "Job not found" });
      if (req.profile!.role !== "admin" && job.area !== req.profile!.area)
        return res.status(403).json({ message: "Outside your area" });
      if (!job.archived_at)
        return res.status(409).json({ message: "Job is not archived" });
      const { data, error } = await client
        .from("jobs")
        .update({
          archived_at: null,
          status: (job as any).status === "Completed" ? "Active" : (job as any).status,
        })
        .eq("id", req.params.id)
        .select()
        .single();
      if (error) {
        // A job number can be reused while the original is archived, so
        // restoring can now collide with a newer active job of the same
        // number/area. The partial unique index rejects that (23505).
        if (error.code === "23505")
          return res.status(409).json({
            message:
              "Can't restore this job — its number is already in use by an active job in this area. Archive or renumber that job first.",
          });
        return res.status(400).json({ message: error.message });
      }
      res.json(data);
    },
  );

  // ---- Field tickets: see server/fieldTickets.ts ------------------------
  registerFieldTicketRoutes(app);

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
    if (opts.requireActive && !isLiveJobStatus(job.status)) {
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
      if (!isLiveJobStatus(job.status))
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
    if (opts.requireActive && !isLiveJobStatus(job.status)) {
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

  // ---- Assets -------------------------------------------------------------
  app.get("/api/assets", requireAuth, async (req: Request, res: Response) => {
    const scope = areaScopeOf(req.profile!);
    // Field techs see ONLY assets currently deployed on a job they are assigned
    // to — never the wider area view. A field tech with no assignments therefore
    // sees no assets (fieldJobIds = []), rather than falling back to area scope.
    // Other roles keep their normal (area or unrestricted) visibility.
    let fieldJobIds: string[] | null = null;
    if (req.profile!.role === "field") {
      fieldJobIds = (await jobScopeOf(req.profile!)) ?? [];
      if (fieldJobIds.length === 0) return res.json([]);
    }
    let q = supabaseAnon
      .from("assets")
      .select(
        "*, maintenance_schedule:maintenance_schedules(*), job:jobs(id,job_number,well_name,area,status)",
      )
      .order("tag");
    if (scope) q = q.eq("area", scope);
    if (fieldJobIds) q = q.in("job_id", fieldJobIds);
    const { data, error } = await q;
    if (error) return res.status(500).json({ message: error.message });
    res.json((data || []).map((a: any) => stripRentalMoney(a, req.profile!.role)));
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
    requireRole("admin", "area", "super"),
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
          : a.area
            ? `${a.area}/unassigned`
            : "Unassigned";
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
    requireRole("admin", "area", "super"),
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
          : a.area
            ? `${a.area}/unassigned`
            : "Unassigned";
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
      // Field techs may only open an asset that is on one of their assigned
      // jobs — matches the list view's job-only scope so an off-job asset can't
      // be reached directly by ID. No assignments => no asset access.
      if (req.profile!.role === "field") {
        const fieldJobIds = (await jobScopeOf(req.profile!)) ?? [];
        const assetJobId = (asset as any).job_id;
        if (!assetJobId || !fieldJobIds.includes(assetJobId))
          return res.status(404).json({ message: "Asset not found" });
      }

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
      // Derive the run-hours-since-service view for centrifuges so the asset
      // detail can show "X hrs since last service" alongside the raw meter.
      let { hoursSince, interval, state } = serviceStatusFor(asset as any);
      if (tracksRunHours((asset as any).category)) {
        const svc = (await hoursSinceServiceFor(client, [asset])).get((asset as any).id);
        hoursSince = svc?.hoursSince ?? null;
        state = svc?.state ?? state;
        interval = SERVICE_INTERVAL_HOURS;
      }
      res.json(
        stripRentalMoney(
          {
            ...asset,
            run_hours_since_service: hoursSince,
            service_hours_interval: interval,
            service_state: state,
            history,
          },
          req.profile!.role,
        ),
      );
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
      const rentalErr = applyRentalRules(insert, null);
      if (rentalErr) return res.status(400).json({ message: rentalErr });
      // Only "On Job" / "Available" (new assets aren't on a job yet).
      insert.status = assetStatusFor(insert.job_id ?? null, insert.status);
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
      // load the asset for area-scope check (plus job_id/category for edit guards)
      const { data: asset } = await client
        .from("assets")
        .select("*")
        .eq("id", req.params.id)
        .single();
      if (!asset) return res.status(404).json({ message: "Asset not found" });
      if (req.profile!.role === "area" && asset.area !== req.profile!.area)
        return res.status(403).json({ message: "Outside your area" });

      // The edit form may change core fields (tag/name, category, area). Build a
      // patch we can adjust before writing.
      const patch: any = { ...parsed.data };

      // The effective area after this update (may be edited).
      const nextArea = patch.area ?? asset.area;

      // Area managers can never move an asset out of their own area.
      if (
        req.profile!.role === "area" &&
        patch.area &&
        patch.area !== req.profile!.area
      )
        return res
          .status(403)
          .json({ message: "You can only keep assets within your own area" });

      // Changing the area of an asset that is currently on a job would break the
      // asset-and-job same-area rule. Require it be taken off the job first.
      if (patch.area && patch.area !== asset.area && asset.job_id)
        return res.status(400).json({
          message:
            "This asset is on a job. Unassign it from the job before changing its area.",
        });

      // if assigning to a job, verify the job exists and is in the same area
      if (patch.job_id) {
        const { data: job } = await client
          .from("jobs")
          .select("area")
          .eq("id", patch.job_id)
          .single();
        if (!job) return res.status(404).json({ message: "Job not found" });
        if (await jobIsArchived(client, patch.job_id))
          return res.status(409).json({ message: ARCHIVED_JOB_MSG });
        if (job.area !== nextArea)
          return res
            .status(400)
            .json({ message: "Asset and job must be in the same operating area" });
      }

      // Service interval only applies to run-hour assets. If the category is
      // being changed to one that doesn't track run hours, drop the interval so
      // stale values don't linger.
      const effectiveCategory = patch.category ?? asset.category;
      if (!tracksRunHours(effectiveCategory)) delete patch.service_hours_interval;

      // Rental rules (return date releases the unit and marks it Returned).
      const rentalErr = applyRentalRules(patch, asset);
      if (rentalErr) return res.status(400).json({ message: rentalErr });

      // Status always follows the job link: "On Job" or "Available"
      // (or "Returned" for a rental sent back to its vendor).
      const nextJobId = "job_id" in patch ? patch.job_id : asset.job_id;
      const statusBase = patch.status !== undefined ? patch.status : asset.status;
      if ("job_id" in patch || patch.status !== undefined || asset.status !== assetStatusFor(nextJobId, statusBase))
        patch.status = assetStatusFor(nextJobId, statusBase);

      const { data, error } = await client
        .from("assets")
        .update(patch)
        .eq("id", req.params.id)
        .select()
        .single();
      if (error) {
        // Surface a friendly message for a duplicate asset number.
        const dup =
          /duplicate|unique/i.test(error.message) &&
          /tag/i.test(error.message);
        return res.status(400).json({
          message: dup
            ? "That asset number is already in use. Choose a different one."
            : error.message,
        });
      }
      res.json(data);
    },
  );

  // Delete an asset entirely ("wipe from the list"). Admin + area managers only;
  // area managers can only delete assets within their own area. Child rows in
  // audit_events, maintenance_report_files, maintenance_reports, and work_orders
  // are removed automatically by ON DELETE CASCADE, so this is a clean delete.
  app.delete(
    "/api/assets/:id",
    requireAuth,
    requireRole("admin", "area"),
    async (req: Request, res: Response) => {
      const client = supabaseAdmin || supabaseAnon;
      // Load the asset for the area-scope check.
      const { data: asset } = await client
        .from("assets")
        .select("area")
        .eq("id", req.params.id)
        .single();
      if (!asset) return res.status(404).json({ message: "Asset not found" });
      if (req.profile!.role === "area" && asset.area !== req.profile!.area)
        return res.status(403).json({ message: "Outside your area" });

      const { error } = await client
        .from("assets")
        .delete()
        .eq("id", req.params.id);
      if (error) return res.status(400).json({ message: error.message });
      res.status(204).end();
    },
  );

  // ---- Service dashboard --------------------------------------------------
  // Aggregates centrifuge fleet health for the Service module: active count,
  // machines needing service soon, overdue machines, and reports filed — plus
  // the active-centrifuge list (job/area, technician, run-hrs since service,
  // interval, status). Area-scoped for non-admins.
  // Field techs only see service data for assets currently on their assigned
  // job(s). Returns null for every other role (no asset restriction).
  async function fieldAssetIdsOf(req: Request): Promise<Set<string> | null> {
    if (req.profile!.role !== "field") return null;
    const jobIds = (await jobScopeOf(req.profile!)) ?? [];
    if (jobIds.length === 0) return new Set();
    const { data } = await (supabaseAdmin || supabaseAnon)
      .from("assets")
      .select("id")
      .in("job_id", jobIds);
    return new Set((data || []).map((a: any) => a.id));
  }

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
      const fieldJobIds = req.profile!.role === "field"
        ? ((await jobScopeOf(req.profile!)) ?? [])
        : null;
      const assets = ((assetsData || []) as any[]).filter(
        (a) => !fieldJobIds || (a.job_id && fieldJobIds.includes(a.job_id)),
      );

      // Last service technician per asset = supervisor on that asset's most
      // recent maintenance report. One query, reduced client-side.
      const assetIds = assets.map((a) => a.id);
      const techByAsset = new Map<string, string>();
      // Last service report date per asset (latest report_date on file).
      const lastServiceByAsset = new Map<string, string>();
      if (assetIds.length) {
        const { data: reps } = await client
          .from("maintenance_reports")
          .select("asset_id, report_date, filed_at, supervisor:profiles!maintenance_reports_supervisor_id_fkey(name)")
          .in("asset_id", assetIds)
          .order("report_date", { ascending: false })
          .order("filed_at", { ascending: false });
        for (const r of (reps || []) as any[]) {
          if (!lastServiceByAsset.has(r.asset_id) && r.report_date)
            lastServiceByAsset.set(r.asset_id, String(r.report_date));
          if (!techByAsset.has(r.asset_id) && r.supervisor?.name)
            techByAsset.set(r.asset_id, r.supervisor.name);
        }
      }
      // Logged run hours per asset (falls back to the meter if the log table
      // hasn't been created yet).
      const log = await loadRunHoursLog(client, assetIds);
      const logByAsset = new Map<string, any[]>();
      for (const r of log.rows) {
        if (!logByAsset.has(r.asset_id)) logByAsset.set(r.asset_id, []);
        logByAsset.get(r.asset_id)!.push(r);
      }

      // Reports filed (scope-aware). Count total + pending sign-off.
      const { data: repRows } = await client
        .from("maintenance_reports")
        .select("status, asset:assets(area, job_id)");
      let reports = (repRows || []) as any[];
      if (scope) reports = reports.filter((r) => r.asset?.area === scope);
      if (fieldJobIds)
        reports = reports.filter(
          (r) => r.asset?.job_id && fieldJobIds.includes(r.asset.job_id),
        );
      const reportsFiled = reports.length;
      const reportsPending = reports.filter(
        (r) => r.status !== "Signed off",
      ).length;

      // Build per-asset service status from RUN HOURS: hours logged on daily
      // reports dated after the asset's last service report, against a
      // 150-hour service interval. Every centrifuge gets a status (an
      // unassigned unit still carries the hours it came off its last job with);
      // the due/overdue counts below only count job-assigned units.
      const rows: (ServiceAssetRow & { _deployed: boolean })[] = assets.map(
        (a) => {
          const assigned = a.job_id != null;
          const lastService = lastServiceByAsset.get(a.id) ?? null;
          const entries = logByAsset.get(a.id) ?? [];
          let since: number;
          if (log.ready) {
            since = hoursAfter(entries, lastService);
          } else {
            // Log not set up yet: use the meter (hours since the meter
            // baseline captured at the last service, or the whole meter).
            const meter = Number(a.run_hours ?? 0) || 0;
            const base = lastService && a.run_hours_at_service != null ? Number(a.run_hours_at_service) : 0;
            since = round2(Math.max(0, meter - base));
          }
          const st = hoursServiceStatusFor(since, !!lastService);
          const currentJobHours = assigned && log.ready
            ? round2(entries.filter((e) => e.job_id === a.job_id).reduce((t, e) => t + (Number(e.hours) || 0), 0))
            : null;
          const deployed = (a.status || "").toLowerCase() !== "available";
          return {
            id: a.id,
            tag: a.tag,
            is_rental: !!a.is_rental,
            rental_vendor: a.rental_vendor ?? null,
            category: a.category,
            area: a.area,
            status: a.status,
            job_id: a.job_id,
            assigned,
            job_number: a.job?.job_number ?? null,
            job_or_well: a.job_or_well,
            technician: techByAsset.get(a.id) ?? null,
            run_hours: a.run_hours,
            run_hours_since_service: st.hoursSince,
            service_hours_interval: SERVICE_INTERVAL_HOURS,
            hours_since_service: st.hoursSince,
            service_interval_hours: SERVICE_INTERVAL_HOURS,
            never_serviced: !lastService,
            current_job_hours: currentJobHours,
            last_service_date: lastService,
            last_maintained: a.last_maintained,
            service_state: st.state,
            _deployed: deployed,
          };
        },
      );

      // Metrics count only job-assigned (tracked) centrifuges for due/overdue.
      const assignedRows = rows.filter((r) => r.assigned);
      const metrics: ServiceDashboard["metrics"] = {
        active_centrifuges: assignedRows.length,
        total_centrifuges: rows.length,
        due_soon: assignedRows.filter((r) => r.service_state === "Soon").length,
        overdue: assignedRows.filter((r) => r.service_state === "Overdue")
          .length,
        reports_filed: reportsFiled,
        reports_pending_signoff: reportsPending,
      };

      // List shows ALL in-scope centrifuges. Job-assigned units come first, then
      // unassigned; within each group, overdue/soon first, then by tag. The
      // client uses the `assigned` flag to default to job-assigned only and
      // toggle unassigned in.
      const rank: Record<string, number> = {
        Overdue: 0,
        Soon: 1,
        "No baseline": 2,
        OK: 3,
        "Not tracked": 4,
      };
      const centrifuges: ServiceAssetRow[] = rows
        .sort(
          (x, y) =>
            Number(y.assigned) - Number(x.assigned) ||
            (rank[x.service_state] ?? 9) - (rank[y.service_state] ?? 9) ||
            x.tag.localeCompare(y.tag),
        )
        .map(({ _deployed, ...r }) => r);

      const payload: ServiceDashboard = { metrics, centrifuges };
      res.json(payload);
    },
  );

  // ---- Service module: one centrifuge's service history + run hours -------
  // Service history (date, supervisor, open the report) plus hours since the
  // last service and run-hour totals per job and per well, from the log.
  app.get(
    "/api/service/assets/:id",
    requireAuth,
    async (req: Request, res: Response) => {
      const client = supabaseAdmin || supabaseAnon;
      const { data: asset } = await client
        .from("assets")
        .select("*, job:jobs(id,job_number)")
        .eq("id", req.params.id)
        .maybeSingle();
      if (!asset || !tracksRunHours((asset as any).category))
        return res.status(404).json({ message: "Centrifuge not found" });
      const a: any = asset;
      const scope = areaScopeOf(req.profile!);
      if (scope && a.area !== scope)
        return res.status(404).json({ message: "Centrifuge not found" });
      if (req.profile!.role === "field") {
        const fieldJobIds = (await jobScopeOf(req.profile!)) ?? [];
        if (!a.job_id || !fieldJobIds.includes(a.job_id))
          return res.status(404).json({ message: "Centrifuge not found" });
      }

      const { data: reps } = await client
        .from("maintenance_reports")
        .select("id, report_date, filed_at, status, score_pass, score_total, flagged_count, checklist, supervisor:profiles!maintenance_reports_supervisor_id_fkey(name)")
        .eq("asset_id", a.id)
        .order("report_date", { ascending: false })
        .order("filed_at", { ascending: false });
      const history = ((reps || []) as any[]).map((r) => ({
        id: r.id,
        report_date: r.report_date,
        filed_at: r.filed_at,
        supervisor_name: r.supervisor?.name ?? null,
        status: r.status,
        score_pass: r.score_pass ?? null,
        score_total: r.score_total ?? null,
        flagged_count: r.flagged_count ?? null,
        has_form: r.checklist != null,
      }));
      const lastService = history[0]?.report_date ? String(history[0].report_date) : null;

      const log = await loadRunHoursLog(client, [a.id]);
      let since: number;
      if (log.ready) since = hoursAfter(log.rows, lastService);
      else {
        const meter = Number(a.run_hours ?? 0) || 0;
        const base = lastService && a.run_hours_at_service != null ? Number(a.run_hours_at_service) : 0;
        since = round2(Math.max(0, meter - base));
      }
      const st = hoursServiceStatusFor(since, !!lastService);

      // Group the log by job, then by well.
      const jobsMap = new Map<string, JobHours & { _wells: Map<string, any> }>();
      for (const r of log.rows) {
        const key = r.job_id ?? "none";
        if (!jobsMap.has(key))
          jobsMap.set(key, {
            job_id: r.job_id ?? null,
            job_number: r.job?.job_number ?? null,
            is_current: !!a.job_id && r.job_id === a.job_id,
            hours: 0,
            report_days: 0,
            wells: [],
            _wells: new Map(),
          });
        const j = jobsMap.get(key)!;
        const h = Number(r.hours) || 0;
        j.hours += h;
        j.report_days += 1;
        const wname = (r.well_name || "").trim() || "(no well name)";
        const wkey = wname.toUpperCase();
        if (!j._wells.has(wkey))
          j._wells.set(wkey, { well_name: wname, hours: 0, report_days: 0, first_date: null, last_date: null });
        const w = j._wells.get(wkey);
        w.hours += h;
        w.report_days += 1;
        const d = r.report_date ? String(r.report_date) : null;
        if (d && (!w.first_date || d < w.first_date)) w.first_date = d;
        if (d && (!w.last_date || d > w.last_date)) w.last_date = d;
      }
      const jobs: JobHours[] = Array.from(jobsMap.values())
        .map(({ _wells, ...j }) => ({
          ...j,
          hours: round2(j.hours),
          wells: Array.from(_wells.values())
            .map((w) => ({ ...w, hours: round2(w.hours) }))
            .sort((x, y) => String(y.last_date ?? "").localeCompare(String(x.last_date ?? ""))),
        }))
        .sort((x, y) =>
          Number(y.is_current) - Number(x.is_current) ||
          String(y.wells[0]?.last_date ?? "").localeCompare(String(x.wells[0]?.last_date ?? "")),
        );
      const current = jobs.find((j) => j.is_current);
      const payload: ServiceAssetDetail = {
        id: a.id,
        tag: a.tag,
        is_rental: !!a.is_rental,
        rental_vendor: a.rental_vendor ?? null,
        category: a.category,
        area: a.area,
        job_id: a.job_id,
        job_number: a.job?.job_number ?? null,
        hours_since_service: st.hoursSince,
        service_interval_hours: SERVICE_INTERVAL_HOURS,
        service_state: st.state,
        never_serviced: !lastService,
        last_service_date: lastService,
        last_service_supervisor: history[0]?.supervisor_name ?? null,
        current_job_hours: a.job_id ? (log.ready ? current?.hours ?? 0 : null) : null,
        total_logged_hours: round2(log.rows.reduce((t, r) => t + (Number(r.hours) || 0), 0)),
        history,
        jobs,
        ledger_ready: log.ready,
      };
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
      // Field techs: only reports on their assigned job(s).
      const srJobIds = await jobScopeOf(req.profile!);
      if (srJobIds) rows = rows.filter((r: any) => srJobIds.includes(r.job_id));
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
      const srJobIds = await jobScopeOf(req.profile!);
      if (srJobIds) rows = rows.filter((r: any) => srJobIds.includes(r.job_id));

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
          "job_id, file_name, file_mime, file_base64, job:jobs!service_reports_job_id_fkey(area)",
        )
        .eq("id", req.params.id)
        .single();
      if (error || !data || !(data as any).file_base64)
        return res.status(404).json({ message: "File not found" });
      const scope = areaScopeOf(req.profile!);
      const jobArea = (data as any).job?.area ?? null;
      if (scope && jobArea !== scope)
        return res.status(404).json({ message: "File not found" });
      const srJobIds = await jobScopeOf(req.profile!);
      if (srJobIds && !srJobIds.includes((data as any).job_id))
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

  // ---- Structured centrifuge service reports (in-app form) ----------------
  // Digital replacement for the Mitti/SafetyCulture centrifuge report. The
  // supervisor fills the 13-item checklist in-app; we store it on a
  // maintenance_reports row (checklist jsonb + score) so it drives the same
  // sign-off flow and service-baseline reset as a maintenance report, and any
  // flagged item can spawn a work order. Photos are stored as linked
  // maintenance_report_files rows (report_id FK).

  const SERVICE_FORM_SELECT =
    "id, asset_id, supervisor_id, report_date, filed_at, status, notes, work_performed, run_hours, score_pass, score_total, flagged_count, checklist, " +
    "asset:assets!maintenance_reports_asset_id_fkey(tag,category,area), " +
    "supervisor:profiles!maintenance_reports_supervisor_id_fkey(name)";

  function flattenServiceForm(row: any) {
    const { asset, supervisor, ...rest } = row;
    const checklist = Array.isArray(rest.checklist) ? rest.checklist : [];
    return {
      ...rest,
      asset_tag: asset?.tag ?? null,
      asset_category: asset?.category ?? null,
      area: asset?.area ?? null,
      supervisor_name: supervisor?.name ?? null,
      checklist,
      photo_count: 0, // filled in by detail route
    };
  }

  // List filed structured service reports. Area-scoped on the asset's area.
  // Only rows that carry a checklist (the structured form) are returned, so
  // legacy maintenance-log rows are excluded.
  app.get(
    "/api/service-forms",
    requireAuth,
    async (req: Request, res: Response) => {
      const client = supabaseAdmin || supabaseAnon;
      const { data, error } = await client
        .from("maintenance_reports")
        .select(SERVICE_FORM_SELECT)
        .not("checklist", "is", null)
        .order("filed_at", { ascending: false });
      if (error) return res.status(500).json({ message: error.message });
      let rows = (data || []).map(flattenServiceForm);
      const scope = areaScopeOf(req.profile!);
      if (scope) rows = rows.filter((r: any) => r.area === scope);
      // Field techs: only reports for assets on their assigned job(s).
      const fieldAssets = await fieldAssetIdsOf(req);
      if (fieldAssets) rows = rows.filter((r: any) => fieldAssets.has(r.asset_id));
      res.json(rows);
    },
  );

  // Detail for one structured service report, including its photos (as data
  // URLs so the client can render them inline). Area-scoped.
  app.get(
    "/api/service-forms/:id",
    requireAuth,
    async (req: Request, res: Response) => {
      const client = supabaseAdmin || supabaseAnon;
      const { data, error } = await client
        .from("maintenance_reports")
        .select(SERVICE_FORM_SELECT)
        .eq("id", req.params.id)
        .not("checklist", "is", null)
        .single();
      if (error || !data)
        return res.status(404).json({ message: "Service report not found" });
      const row = flattenServiceForm(data);
      const scope = areaScopeOf(req.profile!);
      if (scope && row.area !== scope)
        return res.status(404).json({ message: "Service report not found" });
      const fieldAssets = await fieldAssetIdsOf(req);
      if (fieldAssets && !fieldAssets.has((row as any).asset_id))
        return res.status(404).json({ message: "Service report not found" });

      // Photos linked to this report.
      const { data: files } = await client
        .from("maintenance_report_files")
        .select("id, file_name, file_mime, file_base64, notes")
        .eq("report_id", req.params.id)
        .order("created_at", { ascending: true });
      const photos = (files || []).map((f: any) => ({
        id: f.id,
        file_name: f.file_name,
        caption: f.notes ?? null,
        data_url: `data:${f.file_mime};base64,${f.file_base64}`,
      }));
      res.json({ ...row, photo_count: photos.length, photos });
    },
  );

  // Delete a structured service report. admin + area + super, area-scoped on
  // the asset. Child rows (photos, sign-offs, audit events) are removed by
  // ON DELETE CASCADE. Work orders opened from flagged items reference the
  // asset, not the report, so they intentionally remain.
  app.delete(
    "/api/service-forms/:id",
    requireAuth,
    requireRole("admin", "area", "super"),
    async (req: Request, res: Response) => {
      const client = supabaseAdmin || supabaseAnon;
      const { data: existing } = await supabaseAnon
        .from("maintenance_reports")
        .select("id, asset:assets!maintenance_reports_asset_id_fkey(area)")
        .eq("id", req.params.id)
        .not("checklist", "is", null)
        .single();
      if (!existing)
        return res.status(404).json({ message: "Service report not found" });
      const scope = areaScopeOf(req.profile!);
      const area = (existing as any).asset?.area ?? null;
      if (scope && area !== scope)
        return res.status(404).json({ message: "Service report not found" });
      const { error } = await client
        .from("maintenance_reports")
        .delete()
        .eq("id", req.params.id);
      if (error) return res.status(400).json({ message: error.message });
      res.status(204).end();
    },
  );

  // File a structured service report. admin + area + super. The asset must be
  // in the filer's area scope. Sets the service baseline (run_hours_at_service)
  // like a maintenance report. Flagged items are recorded on the report.
  app.post(
    "/api/service-forms",
    requireAuth,
    requireRole("admin", "area", "super"),
    async (req: Request, res: Response) => {
      const parsed = createServiceReportSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      const input = parsed.data;
      const client = supabaseAdmin || supabaseAnon;

      const { data: asset } = await client
        .from("assets")
        .select("*")
        .eq("id", input.asset_id)
        .single();
      if (!asset) return res.status(404).json({ message: "Asset not found" });
      const scope = areaScopeOf(req.profile!);
      if (scope && asset.area !== scope)
        return res.status(403).json({ message: "Asset is outside your area" });

      // Resolve each answer against the canonical checklist so labels + flags
      // are trustworthy (never taken from the client).
      const byKey = new Map(input.checklist.map((c) => [c.key, c]));
      const answered: any[] = [];
      let pass = 0;
      let total = 0;
      const flaggedItems: { key: string; label: string; note: string | null }[] = [];
      for (const def of CENTRIFUGE_SERVICE_CHECKLIST) {
        const a = byKey.get(def.key);
        if (!a) continue;
        const flagged = a.answer === def.flagOn;
        if (a.answer !== "N/A") {
          total += 1;
          if (!flagged) pass += 1;
        }
        const note = a.note?.trim() ? a.note.trim() : null;
        answered.push({ key: def.key, label: def.label, answer: a.answer, flagged, note });
        if (flagged) flaggedItems.push({ key: def.key, label: def.label, note });
      }
      if (answered.length === 0)
        return res.status(400).json({ message: "Answer at least one checklist item" });

      const { data: report, error } = await client
        .from("maintenance_reports")
        .insert({
          asset_id: asset.id,
          supervisor_id: req.profile!.id,
          work_type: "Inspection",
          notes: input.notes ?? null,
          work_performed: input.work_performed ?? null,
          report_date: input.report_date,
          status: "Pending Sign-off",
          checklist: answered,
          run_hours: input.run_hours ?? null,
          score_pass: pass,
          score_total: total,
          flagged_count: flaggedItems.length,
        })
        .select()
        .single();
      if (error) return res.status(400).json({ message: error.message });

      // Reset the service baseline off the meter reading, exactly like a
      // maintenance report, so the Service dashboard status recomputes.
      const patch: any = { last_maintained: input.report_date };
      if (tracksRunHours(asset.category)) {
        const meterAtService =
          input.run_hours != null ? input.run_hours : asset.run_hours;
        if (input.run_hours != null) patch.run_hours = input.run_hours;
        if (meterAtService != null) patch.run_hours_at_service = meterAtService;
      }
      await client.from("assets").update(patch).eq("id", asset.id);

      // Store photos as linked files.
      if (input.photos && input.photos.length) {
        const rows = input.photos.map((p) => {
          const bytes = Buffer.from(p.file_base64, "base64");
          return {
            asset_id: asset.id,
            report_id: report.id,
            file_name: p.file_name,
            file_mime: p.file_mime,
            file_size: bytes.length,
            file_base64: p.file_base64,
            notes: p.caption ?? null,
            uploaded_by: req.profile!.id,
          };
        });
        await client.from("maintenance_report_files").insert(rows);
      }

      // Audit: Filed.
      await client.from("audit_events").insert({
        report_id: report.id,
        asset_id: asset.id,
        actor_id: req.profile!.id,
        actor_name: req.profile!.name,
        actor_role: req.profile!.role,
        action: "Filed",
      });

      // Flagged items stay on the service report itself. Work orders are now
      // only for machines sent to a third party for refurbishment, so a flag
      // no longer opens one automatically.
      const createdWorkOrders: string[] = [];

      // Notify area managers who want sign-off alerts (best effort).
      sendNotificationEmails("needs_signoff", { report, asset }).catch((e) =>
        console.error("[email] needs_signoff", e),
      );

      res.status(201).json({
        ...flattenServiceForm({ ...report, asset, supervisor: { name: req.profile!.name } }),
        work_orders_created: createdWorkOrders.length,
      });
    },
  );

  // Helper: load an asset's area for scope checks. Returns null if not found.
  // (Retained for the Work Orders create handler below.)
  async function assetAreaOf(client: any, assetId: string | string[]) {
    const { data } = await client
      .from("assets")
      .select("id, area")
      .eq("id", assetId)
      .single();
    return data ? (data.area as string) : null;
  }

  // -------------------------------------------------------------------------
  // Work Orders (moved to the Service module; endpoints unchanged)
  // -------------------------------------------------------------------------
  // Third-party refurbishment: where the machine went, when, and the vendor
  // invoice at close-out. The invoice file itself (invoice_base64) is never
  // selected for lists — only streamed by the /invoice endpoint.
  const WORK_ORDER_SELECT =
    "id, wo_number, asset_id, area, title, wo_type, priority, status, vendor, sent_on, due_date, est_hours, notes, created_by, completed_at, created_at, returned_on, work_performed, invoice_number, invoice_total, invoice_file_name, invoice_mime, invoice_size, asset:assets(tag, category), creator:profiles!work_orders_created_by_fkey(name), closer:profiles!work_orders_closed_by_fkey(name)";
  const WO_SETUP_MSG =
    "Work orders need a one-time database update. Run \"Work order refurbishment setup.sql\" in the Supabase SQL editor, then try again.";
  const woSetupError = (msg: string | undefined) =>
    !!msg && /(vendor|sent_on|returned_on|work_performed|invoice_|closed_by)/i.test(msg) &&
    /(does not exist|could not find|relationship)/i.test(msg);
  const woErr = (res: Response, status: number, msg: string | undefined) =>
    res.status(woSetupError(msg) ? 500 : status).json({ message: woSetupError(msg) ? WO_SETUP_MSG : msg });

  function flattenWorkOrder(row: any) {
    const { asset, creator, closer, ...rest } = row;
    return {
      ...rest,
      invoice_total: rest.invoice_total != null ? Number(rest.invoice_total) : null,
      asset_tag: asset?.tag ?? null,
      asset_category: asset?.category ?? null,
      created_by_name: creator?.name ?? null,
      closed_by_name: closer?.name ?? null,
    };
  }
  // Field techs never see refurbishment money.
  function woForViewer(req: Request, row: any) {
    if (WORK_ORDER_MANAGE_ROLES.includes(req.profile!.role)) return row;
    return { ...row, invoice_total: null, invoice_number: null };
  }

  async function nextWorkOrderNumber(client: any): Promise<string> {
    const { data: seqData, error: seqErr } = await client.rpc("nextval", {
      seq: "work_order_seq",
    });
    if (!seqErr && seqData != null) return `WO-${seqData}`;
    // Fallback: derive from count if the RPC helper isn't present.
    const { count } = await client
      .from("work_orders")
      .select("id", { count: "exact", head: true });
    return `WO-${5001 + (count || 0)}`;
  }

  async function loadWorkOrderForWrite(req: Request) {
    const { data: existing } = await supabaseAnon
      .from("work_orders")
      .select("id, area, status, completed_at")
      .eq("id", req.params.id)
      .single();
    if (!existing) return null;
    const scope = areaScopeOf(req.profile!);
    if (scope && (existing as any).area !== scope) return null;
    return existing as any;
  }

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
      if (error) return woErr(res, 500, error.message);
      let rows = (data || []).map(flattenWorkOrder);
      // Field techs: only work orders for assets on their assigned job(s).
      const fieldAssets = await fieldAssetIdsOf(req);
      if (fieldAssets) rows = rows.filter((r: any) => fieldAssets.has(r.asset_id));
      res.json(rows.map((r: any) => woForViewer(req, r)));
    },
  );

  // Create a work order (machine sent out). Admin + area + super; asset must be
  // in the creator's area scope. Area is derived from the asset.
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
      if (input.due_date && input.due_date < input.sent_on)
        return res.status(400).json({ message: "Expected back can't be before the date sent" });

      const client = supabaseAdmin || supabaseAnon;
      const woNumber = await nextWorkOrderNumber(client);
      const { data, error } = await client
        .from("work_orders")
        .insert({
          wo_number: woNumber,
          asset_id: input.asset_id,
          area,
          title: input.title,
          vendor: input.vendor,
          sent_on: input.sent_on,
          wo_type: input.wo_type ?? "Refurbishment",
          priority: input.priority ?? "Medium",
          status: input.status ?? "In Progress",
          due_date: input.due_date || null,
          notes: input.notes || null,
          created_by: req.profile!.id,
        })
        .select(WORK_ORDER_SELECT)
        .single();
      if (error) return woErr(res, 400, error.message);
      res.status(201).json(flattenWorkOrder(data));
    },
  );

  // Edit a work order. Admin + area + super, within area scope. Completing
  // goes through /close (needs the invoice + work performed).
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
      const existing = await loadWorkOrderForWrite(req);
      if (!existing)
        return res.status(404).json({ message: "Work order not found" });
      const isClosed = existing.status === "Completed";

      const patch: Record<string, any> = {};
      const input = parsed.data;
      if (input.title !== undefined) patch.title = input.title;
      if (input.vendor !== undefined) patch.vendor = input.vendor;
      if (input.sent_on !== undefined) patch.sent_on = input.sent_on;
      if (input.wo_type !== undefined) patch.wo_type = input.wo_type;
      if (input.priority !== undefined) patch.priority = input.priority;
      if (input.due_date !== undefined) patch.due_date = input.due_date || null;
      if (input.notes !== undefined) patch.notes = input.notes || null;
      if (input.status !== undefined && !isClosed) patch.status = input.status;
      if (isClosed) {
        if (input.returned_on !== undefined) patch.returned_on = input.returned_on;
        if (input.work_performed !== undefined) patch.work_performed = input.work_performed;
        if (input.invoice_number !== undefined) patch.invoice_number = input.invoice_number?.trim() || null;
        if (input.invoice_total !== undefined) patch.invoice_total = input.invoice_total;
      }
      if (Object.keys(patch).length === 0)
        return res.status(400).json({ message: "No changes provided" });

      const client = supabaseAdmin || supabaseAnon;
      const { data, error } = await client
        .from("work_orders")
        .update(patch)
        .eq("id", req.params.id)
        .select(WORK_ORDER_SELECT)
        .single();
      if (error) return woErr(res, 400, error.message);
      res.json(flattenWorkOrder(data));
    },
  );

  // Close out: the machine is back. Records the return date, what was done,
  // the invoice total/number and (optionally) the invoice file, and marks the
  // work order Completed. This feeds the asset's refurbishment history.
  app.post(
    "/api/work-orders/:id/close",
    requireAuth,
    requireRole(...WORK_ORDER_MANAGE_ROLES),
    async (req: Request, res: Response) => {
      const parsed = closeWorkOrderSchema.safeParse(req.body);
      if (!parsed.success)
        return res
          .status(400)
          .json({ message: parsed.error.errors[0]?.message || "Invalid input" });
      const existing = await loadWorkOrderForWrite(req);
      if (!existing)
        return res.status(404).json({ message: "Work order not found" });
      if (existing.status === "Completed")
        return res.status(400).json({ message: "This work order is already closed out" });
      const input = parsed.data;
      const { data: wo } = await supabaseAnon
        .from("work_orders")
        .select("sent_on")
        .eq("id", req.params.id)
        .single();
      const sentOn = (wo as any)?.sent_on as string | null;
      if (sentOn && input.returned_on < sentOn)
        return res.status(400).json({ message: "Date returned can't be before the date sent" });

      const patch: Record<string, any> = {
        status: "Completed",
        completed_at: new Date().toISOString(),
        closed_by: req.profile!.id,
        returned_on: input.returned_on,
        work_performed: input.work_performed,
        invoice_number: input.invoice_number?.trim() || null,
        invoice_total: input.invoice_total,
      };
      if (input.invoice_file) {
        const bytes = Buffer.from(input.invoice_file.base64, "base64");
        if (!bytes.length)
          return res.status(400).json({ message: "The invoice file is empty" });
        if (bytes.length > WORK_ORDER_INVOICE_MAX_BYTES)
          return res.status(400).json({ message: "The invoice file is over 3 MB. Save a smaller PDF or photo and try again." });
        patch.invoice_file_name = input.invoice_file.name.slice(0, 200);
        patch.invoice_mime = input.invoice_file.mime.slice(0, 100);
        patch.invoice_size = bytes.length;
        patch.invoice_base64 = input.invoice_file.base64;
      }
      const client = supabaseAdmin || supabaseAnon;
      const { data, error } = await client
        .from("work_orders")
        .update(patch)
        .eq("id", req.params.id)
        .select(WORK_ORDER_SELECT)
        .single();
      if (error) return woErr(res, 400, error.message);
      res.json(flattenWorkOrder(data));
    },
  );

  // Replace (or add) the invoice file on a closed work order.
  app.put(
    "/api/work-orders/:id/invoice",
    requireAuth,
    requireRole(...WORK_ORDER_MANAGE_ROLES),
    async (req: Request, res: Response) => {
      const f = closeWorkOrderSchema.shape.invoice_file.unwrap().unwrap().safeParse(req.body);
      if (!f.success) return res.status(400).json({ message: "Choose an invoice file" });
      const existing = await loadWorkOrderForWrite(req);
      if (!existing)
        return res.status(404).json({ message: "Work order not found" });
      const bytes = Buffer.from(f.data.base64, "base64");
      if (!bytes.length) return res.status(400).json({ message: "The invoice file is empty" });
      if (bytes.length > WORK_ORDER_INVOICE_MAX_BYTES)
        return res.status(400).json({ message: "The invoice file is over 3 MB. Save a smaller PDF or photo and try again." });
      const client = supabaseAdmin || supabaseAnon;
      const { data, error } = await client
        .from("work_orders")
        .update({
          invoice_file_name: f.data.name.slice(0, 200),
          invoice_mime: f.data.mime.slice(0, 100),
          invoice_size: bytes.length,
          invoice_base64: f.data.base64,
        })
        .eq("id", req.params.id)
        .select(WORK_ORDER_SELECT)
        .single();
      if (error) return woErr(res, 400, error.message);
      res.json(flattenWorkOrder(data));
    },
  );

  // Stream the vendor invoice file. Manage roles only (it carries cost).
  app.get(
    "/api/work-orders/:id/invoice",
    requireAuth,
    requireRole(...WORK_ORDER_MANAGE_ROLES),
    async (req: Request, res: Response) => {
      const { data, error } = await supabaseAnon
        .from("work_orders")
        .select("area, invoice_file_name, invoice_mime, invoice_base64")
        .eq("id", req.params.id)
        .maybeSingle();
      if (error) return woErr(res, 500, error.message);
      const scope = areaScopeOf(req.profile!);
      const d: any = data;
      if (!d || (scope && d.area !== scope) || !d.invoice_base64)
        return res.status(404).json({ message: "No invoice on file" });
      res.setHeader("Content-Type", d.invoice_mime || "application/octet-stream");
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${String(d.invoice_file_name || "invoice").replace(/"/g, "")}"`,
      );
      res.send(Buffer.from(d.invoice_base64, "base64"));
    },
  );

  // Refurbishment history + total cost for one asset (closed work orders,
  // newest return first) and anything currently out at a vendor.
  app.get(
    "/api/assets/:id/refurbishments",
    requireAuth,
    requireRole(...WORK_ORDER_MANAGE_ROLES),
    async (req: Request, res: Response) => {
      const area = await assetAreaOf(supabaseAnon, req.params.id);
      if (area == null) return res.status(404).json({ message: "Asset not found" });
      const scope = areaScopeOf(req.profile!);
      if (scope && area !== scope) return res.status(404).json({ message: "Asset not found" });
      const { data, error } = await supabaseAnon
        .from("work_orders")
        .select(
          "id, wo_number, title, wo_type, status, vendor, sent_on, due_date, returned_on, work_performed, invoice_number, invoice_total, invoice_file_name, invoice_size, completed_at",
        )
        .eq("asset_id", req.params.id)
        .order("created_at", { ascending: false });
      if (error) return woErr(res, 500, error.message);
      const rows = (data || []) as any[];
      const dayMs = 86400000;
      const history = rows
        .filter((r) => r.status === "Completed")
        .map((r) => ({
          id: r.id,
          wo_number: r.wo_number,
          title: r.title,
          wo_type: r.wo_type,
          vendor: r.vendor,
          sent_on: r.sent_on,
          returned_on: r.returned_on,
          work_performed: r.work_performed,
          invoice_number: r.invoice_number,
          invoice_total: r.invoice_total != null ? Number(r.invoice_total) : null,
          has_invoice: !!r.invoice_size,
          invoice_file_name: r.invoice_file_name,
          days_out:
            r.sent_on && r.returned_on
              ? Math.round((Date.parse(r.returned_on) - Date.parse(r.sent_on)) / dayMs)
              : null,
        }))
        .sort((a, b) => String(b.returned_on || "").localeCompare(String(a.returned_on || "")));
      const open = rows
        .filter((r) => r.status !== "Completed")
        .map((r) => ({ id: r.id, wo_number: r.wo_number, vendor: r.vendor, sent_on: r.sent_on, due_date: r.due_date, status: r.status }));
      res.json({
        total_cost: history.reduce((s, h) => s + (h.invoice_total || 0), 0),
        count: history.length,
        open,
        history,
      });
    },
  );

  // Delete a work order. Admin + area + super, within area scope.
  app.delete(
    "/api/work-orders/:id",
    requireAuth,
    requireRole(...WORK_ORDER_MANAGE_ROLES),
    async (req: Request, res: Response) => {
      const client = supabaseAdmin || supabaseAnon;
      const existing = await loadWorkOrderForWrite(req);
      if (!existing)
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
      const fieldAssets = await fieldAssetIdsOf(req);
      if (fieldAssets && !fieldAssets.has(String(req.params.id)))
        return res.status(404).json({ message: "Asset not found" });
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
    // Also dedupe emails whose workbook was already replaced by a later
    // correction (or discarded), so re-posting an old email never brings the
    // old values back.
    const { data: supersededBy } = await client
      .from("daily_reports")
      .select("id, status, report_day, well_name")
      .contains("analysis", { superseded_email_ids: [p.email_message_id] })
      .limit(1);
    if (supersededBy && supersededBy.length)
      return res
        .status(200)
        .json({ ...supersededBy[0], deduped: true, superseded: true });

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

    // Resolve the job for this report. Priority: the job number read from the
    // workbook (cell V8 on the Report Day sheet) first, then the well name
    // (explicit job.well_name match, then learned from a prior assigned report
    // for the same well). Unmatched reports go to the "Needs job match" queue
    // rather than being silently dropped.
    const resolved = await resolveJobForWell(
      client,
      excel.well_name,
      excel.job_number,
      excel.well_context?.operator ?? null,
    );
    let job_id: string | null = resolved.job_id;
    let area: string | null = resolved.area;
    let customer_id: string | null = resolved.customer_id;
    const matchedByJobNumber =
      !!job_id &&
      !!excel.job_number &&
      normJobId(excel.job_number).length > 0;

    const status = job_id ? "Pending Review" : "Needs job match";
    // Critical blank fields on the imported day tab. When the date was blank
    // but inferred from the prior day, say so, so the reviewer can confirm it.
    const missingFields = dropManualRateField(excel.missing_fields || [], job_id, await manualRateJobIds(client)).map((f) =>
      f === "Report date (D3)" && excel.report_date
        ? `Report date (D3) — filled in as ${excel.report_date} from the prior day`
        : f,
    );
    const row: Record<string, any> = {
      email_message_id: p.email_message_id,
      sender_email: p.sender_email,
      sender_name: p.sender_name ?? null,
      subject: p.subject ?? null,
      received_at: p.received_at ?? new Date().toISOString(),
      raw_body: null,
      source: "email",
      attachment_name: p.attachment_name,
      // Keep the original workbook so the report detail page can link to the
      // actual submitted document (viewable/downloadable).
      attachment_base64: p.attachment_base64,
      attachment_mime:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      attachment_size: Buffer.from(p.attachment_base64, "base64").length,
      source_sheet: excel.source_sheet,
      report_day: excel.report_day,
      report_date: excel.report_date,
      well_name: excel.well_name,
      well_context: excel.well_context,
      kpis: excel.kpis,
      kpi_cell_map: excel.kpi_cell_map,
      summary: excel.summary,
      analysis: missingFields.length ? { missing_fields: missingFields } : {},
      area,
      customer_id,
      job_id,
      status,
    };

    // ---- Corrected re-sends ------------------------------------------------
    // If this job already has an emailed report for the same well + Report
    // Day, this workbook is a corrected re-send. Instead of adding a
    // duplicate:
    //   - older than what we have  -> ignore it (remember its email id)
    //   - original Signed off       -> hold as "Correction pending" for an
    //                                  Admin / Area Manager to apply
    //   - otherwise (same date, or changes were requested) -> replace the
    //                                  original in place, back to Pending Review
    // A same-day match with a DIFFERENT date that nobody asked to change is
    // imported normally (could be a mis-numbered tab; keep it visible).
    const prior = await findPriorSameDay(client, job_id, excel.report_day, excel.well_name);
    if (prior) {
      const incomingAt = row.received_at as string;
      if (isOlderEmail(p.email_message_id, incomingAt, prior.email_message_id, prior.received_at)) {
        await addSupersededEmail(client, prior, p.email_message_id);
        return res.status(200).json({ id: prior.id, deduped: true, superseded: true });
      }
      const changes = describeReportChanges(prior, row);
      const who = p.sender_name || p.sender_email;
      const sameDate = (prior.report_date || null) === (excel.report_date || null);

      if (prior.status === "Signed off") {
        // Only one pending correction per report: a newer re-send replaces an
        // older one that nobody has applied yet.
        const prevPendingId = (prior.analysis as any)?.pending_correction_id;
        if (prevPendingId) {
          const { data: prev } = await client
            .from("daily_reports")
            .select("id, email_message_id, status")
            .eq("id", prevPendingId)
            .maybeSingle();
          if (prev && prev.status === "Correction pending") {
            const ids: string[] = Array.isArray((prior.analysis as any)?.superseded_email_ids)
              ? [...(prior.analysis as any).superseded_email_ids]
              : [];
            if (!ids.includes(prev.email_message_id)) ids.push(prev.email_message_id);
            prior.analysis = { ...(prior.analysis || {}), superseded_email_ids: ids };
            await client.from("daily_reports").delete().eq("id", prev.id);
          }
        }
        const held: Record<string, any> = {
          ...row,
          job_id: null,
          status: "Correction pending",
          analysis: {
            ...(row.analysis || {}),
            correction_of: prior.id,
            correction_job_id: job_id,
            correction_changes: changes,
          },
        };
        const { data: c, error: cErr } = await client
          .from("daily_reports")
          .insert(held)
          .select()
          .single();
        if (cErr) return res.status(400).json({ message: cErr.message });
        await client
          .from("daily_reports")
          .update({ analysis: { ...(prior.analysis || {}), pending_correction_id: c.id } })
          .eq("id", prior.id);
        const changeText = changes.length ? ` Changes: ${changes.join("; ")}.` : " No values changed.";
        await client.from("daily_report_events").insert([
          {
            report_id: c.id,
            actor_name: who,
            actor_role: "field",
            action: "correction_received",
            detail: `Corrected workbook "${p.attachment_name}" for ${excel.source_sheet}, which was already signed off. Waiting for an Admin or Area Manager to apply it.${changeText}`,
          },
          {
            report_id: prior.id,
            actor_name: who,
            actor_role: "field",
            action: "correction_received",
            detail: `A corrected workbook arrived for this signed-off report and is waiting for an Admin or Area Manager to apply it.${changeText}`,
          },
        ]);
        return res.status(201).json({ ...c, correction_pending: true });
      }

      if (sameDate || prior.status === "Changes requested") {
        const { data: upd, error: uErr } = await client
          .from("daily_reports")
          .update({
            ...correctionFields(row),
            status: "Pending Review",
            reviewed_by: null,
            reviewed_by_name: null,
            reviewed_at: null,
            change_notes: null,
            email_out_status: null,
            email_out_at: null,
            analysis: correctedAnalysis(prior, row.analysis, changes, prior.email_message_id),
          })
          .eq("id", prior.id)
          .select()
          .single();
        if (uErr) return res.status(400).json({ message: uErr.message });
        await client.from("daily_report_events").insert({
          report_id: prior.id,
          actor_name: who,
          actor_role: "field",
          action: "corrected",
          detail:
            `Replaced with corrected workbook "${p.attachment_name}" (${excel.source_sheet})` +
            (prior.status === "Changes requested" ? " after changes were requested" : "") +
            `. ${changes.length ? `Changes: ${changes.join("; ")}.` : "No values changed."}` +
            ` Back to Pending Review.`,
        });
        if (missingFields.length) {
          await client.from("daily_report_events").insert({
            report_id: prior.id,
            actor_name: "System",
            actor_role: "field",
            action: "needs_review",
            detail:
              `${excel.source_sheet} in "${p.attachment_name}" is still missing critical ` +
              `data: ${missingFields.join("; ")}. Check with the crew before signing off.`,
          });
        }
        return res.status(201).json({ ...upd, corrected: true });
      }
    }

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
          ? matchedByJobNumber
            ? ` and matched job \"${excel.job_number}\" (from workbook cell V8) to this report.`
            : ` and matched well \"${excel.well_name}\" to a job.`
          : ` — ${
              excel.job_number
                ? `job number \"${excel.job_number}\" (V8) and `
                : ""
            }well \"${excel.well_name ?? "(none)"}\" did not match any job; awaiting assignment.`),
    });
    // Incomplete workbook (no day tab had hand-entered activity): still imported,
    // but log a distinct alert so a supervisor / area manager knows to review
    // and sign off. Per policy we never drop the email or fabricate values.
    if (missingFields.length) {
      await client.from("daily_report_events").insert({
        report_id: data.id,
        actor_name: "System",
        actor_role: "field",
        action: "needs_review",
        detail:
          `${excel.source_sheet} in \"${p.attachment_name}\" is missing critical ` +
          `data: ${missingFields.join("; ")}. Imported with the values present — ` +
          `check with the crew before signing off.`,
      });
    }
    res.status(201).json(data);
  });

  // ---- Daily-report backfill (manual rollout import) ----------------------
  // Admin / area manager uploads a workbook that ALREADY has several completed
  // day tabs and we load EVERY completed day (day 1 .. latest) in one upload.
  // Backfilled days are imported already signed off (historical) and their
  // centrifuge run hours are accrued. For a job with 2+ centrifuges the day's
  // hours are split EVENLY across them (no per-asset prompt during bulk import).
  // Re-uploading the same file is safe: each day dedupes on a stable synthetic
  // key ("backfill:<well>:<day>:<attachment>").
  app.post(
    "/api/daily-reports/backfill",
    requireAuth,
    requireRole("admin", "area"),
    async (req: Request, res: Response) => {
      const parsed = backfillDailyReportSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: parsed.error.errors[0].message });
      const client = supabaseAdmin || supabaseAnon;
      const p = parsed.data;
      const scope = areaScopeOf(req.profile!);

      // Parse every completed day tab in the workbook.
      let days;
      try {
        const buf = Buffer.from(p.attachment_base64, "base64");
        days = parseAllCompletedDays(buf);
      } catch (e: any) {
        if (e instanceof ExcelParseError)
          return res.status(422).json({ message: e.message });
        return res.status(422).json({
          message: `Failed to parse Excel workbook: ${e?.message ?? e}`,
        });
      }

      // Match the job (same precedence as the email intake) ONCE for the whole
      // file: the workbook job number (cell V8) first, then the well name
      // (explicit job.well_name match, then learned from a prior assigned
      // report for this well).
      const wellName = days.find((d) => d.well_name)?.well_name ?? null;
      const jobNumber = days.find((d) => d.job_number)?.job_number ?? null;
      const operator = days.find((d) => d.well_context?.operator)?.well_context?.operator ?? null;
      const resolved = await resolveJobForWell(client, wellName, jobNumber, operator);
      let job_id: string | null = resolved.job_id;
      let area: string | null = resolved.area;
      let customer_id: string | null = resolved.customer_id;

      // Area managers can only backfill into their own area's job. If the well
      // matched a job outside their area, refuse the whole import.
      if (scope && job_id && area && area !== scope) {
        return res.status(403).json({
          message: `This well belongs to a job in ${area}. You can only import reports for jobs in your area (${scope}).`,
        });
      }

      // Pull the job's centrifuges once so we can accrue hours per day.
      let centrifuges: {
        id: string;
        tag: string;
        centrifuge_slot: number | null;
      }[] = [];
      if (job_id) {
        const { data: centAssets } = await client
          .from("assets")
          .select("id, tag, category, run_hours, centrifuge_slot")
          .eq("job_id", job_id)
          .in("category", RUN_HOUR_CATEGORIES as unknown as string[]);
        centrifuges = (centAssets || []) as any;
      }
      // When a job has 2+ centrifuges, run hours are routed by each unit's
      // centrifuge_slot. If any centrifuge is unmapped we skip run-hour accrual
      // for the whole import (never split evenly / apply to the wrong unit) and
      // report it so the user can map the slots and re-run.
      const backfillNeedsMapping =
        !!job_id &&
        centrifuges.length >= 2 &&
        centrifuges.some((c) => !isMappedSlot(c.centrifuge_slot));
      // Track a running in-memory tally so multiple days accrue correctly within
      // one import without re-reading each asset every loop.
      const runHourTally = new Map<string, number>();

      const results: any[] = [];
      const reviewer = req.profile!;
      const now = new Date().toISOString();

      for (const excel of days) {
        const dedupeKey = `backfill:${(wellName || "unknown").toLowerCase()}:${excel.report_day}:${p.attachment_name}`;
        try {
          // Per-day dedupe on the synthetic key.
          const { data: existing } = await client
            .from("daily_reports")
            .select("id, status")
            .eq("email_message_id", dedupeKey)
            .maybeSingle();
          if (existing) {
            results.push({
              report_day: excel.report_day,
              source_sheet: excel.source_sheet,
              report_date: excel.report_date,
              well_name: excel.well_name,
              status: "duplicate",
              daily_report_status: existing.status,
              matched_job: !!job_id,
              run_hours_applied: null,
              message: "Already imported — skipped.",
            });
            continue;
          }

          // Skip a day the job ALREADY has for this well — whether it came in
          // by email or from an earlier upload of a differently named file.
          // Matches job + well name (any case) + report day (or report date
          // when the tab has no day number).
          const dayWell = String(excel.well_name ?? wellName ?? "").trim();
          if (dayWell && (excel.report_day != null || excel.report_date)) {
            const likeWell = dayWell.replace(/[\\%_]/g, (c) => `\\${c}`);
            let q = client
              .from("daily_reports")
              .select("id, status, sender_name, email_message_id")
              .ilike("well_name", likeWell);
            q = excel.report_day != null ? q.eq("report_day", excel.report_day) : q.eq("report_date", excel.report_date as string);
            q = job_id ? q.eq("job_id", job_id) : q.is("job_id", null);
            const { data: same } = await q.limit(1);
            const hit = (same || [])[0] as any;
            if (hit) {
              const via = String(hit.email_message_id ?? "").startsWith("backfill:") ? "an earlier upload" : "email";
              results.push({
                report_day: excel.report_day,
                source_sheet: excel.source_sheet,
                report_date: excel.report_date,
                well_name: excel.well_name,
                status: "duplicate",
                daily_report_status: hit.status,
                matched_job: !!job_id,
                run_hours_applied: null,
                message: `Already on this job (from ${via}${hit.sender_name ? `, ${hit.sender_name}` : ""}) — skipped.`,
              });
              continue;
            }
          }

          // Accrue this day's run hours onto the job's centrifuges, routed by
          // each unit's centrifuge_slot (Centrifuge 1-4 on the report). Single
          // centrifuge → whole day. 2+ → route each slot's own hours; if any
          // centrifuge is unmapped, skip accrual entirely (never apply to the
          // wrong unit).
          let runHourDetail: string | null = null;
          const numOrNull = (v: any) =>
            v == null || v === "" || !Number.isFinite(Number(v))
              ? null
              : Number(v);
          const dk = (excel.kpis as any) || {};
          const dailyHours = numOrNull(dk.daily_run_hours);
          const bySlot = slotDailyHours(dk);
          const slot1Hours = bySlot[1];
          const anyHours =
            (dailyHours != null && dailyHours > 0) ||
            Object.values(bySlot).some((h) => h != null && h > 0);

          // Build the per-asset additions for this day.
          let dayAlloc: { id: string; tag: string; add: number }[] = [];
          if (
            !!job_id &&
            centrifuges.length > 0 &&
            anyHours &&
            !backfillNeedsMapping
          ) {
            if (centrifuges.length === 1) {
              const c = centrifuges[0];
              const hrs = soloCentrifugeHours(dk, c.centrifuge_slot);
              if (hrs > 0) dayAlloc = [{ id: c.id, tag: c.tag, add: hrs }];
            } else {
              const hoursForSlot = (slot: number | null) =>
                slot != null ? bySlot[slot] ?? null : null;
              dayAlloc = centrifuges
                .map((c) => {
                  const hrs = hoursForSlot(c.centrifuge_slot);
                  return {
                    id: c.id,
                    tag: c.tag,
                    add: hrs != null && hrs > 0 ? hrs : 0,
                  };
                })
                .filter((a) => a.add > 0);
            }
          }
          const willAccrue = dayAlloc.length > 0;
          if (willAccrue) {
            const applied: string[] = [];
            for (const a of dayAlloc) {
              // Read the current DB value once, then track subsequent adds in memory.
              let base = runHourTally.get(a.id);
              if (base == null) {
                const { data: cur } = await client
                  .from("assets")
                  .select("run_hours")
                  .eq("id", a.id)
                  .single();
                base = Number((cur as any)?.run_hours ?? 0) || 0;
              }
              const next = base + a.add;
              const { error: uErr } = await client
                .from("assets")
                .update({ run_hours: next })
                .eq("id", a.id);
              if (uErr) throw new Error(`run hours for ${a.tag}: ${uErr.message}`);
              runHourTally.set(a.id, next);
              applied.push(`${a.tag} +${Math.round(a.add * 100) / 100} hrs`);
            }
            runHourDetail = `Run hours applied: ${applied.join(", ")}`;
          }

          const status = job_id ? "Signed off" : "Needs job match";
          const row: Record<string, any> = {
            email_message_id: dedupeKey,
            sender_email: reviewer.email ?? "backfill@dfsops",
            sender_name: reviewer.name,
            subject: `Backfill import — ${excel.source_sheet}`,
            received_at: excel.report_date
              ? new Date(excel.report_date).toISOString()
              : now,
            raw_body: null,
            source: "email",
            attachment_name: p.attachment_name,
            // Keep the original workbook so the report links to the real file.
            attachment_base64: p.attachment_base64,
            attachment_mime:
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            attachment_size: Buffer.from(p.attachment_base64, "base64").length,
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
            // Historical import: mark reviewed by the importer so it lands as
            // already signed off, and flag run hours as applied so a later
            // sign-off can never double-count them.
            reviewed_by: job_id ? reviewer.id : null,
            reviewed_by_name: job_id ? reviewer.name : null,
            reviewed_at: job_id ? now : null,
            run_hours_applied: willAccrue,
          };
          const { data: inserted, error } = await client
            .from("daily_reports")
            .insert(row)
            .select()
            .single();
          if (error) throw new Error(error.message);
          if (willAccrue)
            await logRunHours(
              client,
              {
                id: inserted.id,
                job_id,
                well_name: excel.well_name ?? null,
                report_date: excel.report_date ?? null,
              },
              dayAlloc.map((x) => ({ asset_id: x.id, add: x.add })),
            );

          await client.from("daily_report_events").insert({
            report_id: inserted.id,
            actor_id: reviewer.id,
            actor_name: reviewer.name,
            actor_role: reviewer.role,
            action: "ingested",
            detail:
              `Historical backfill of ${excel.source_sheet} from "${p.attachment_name}"` +
              (job_id
                ? ` — matched well "${excel.well_name}" and imported as signed off.`
                : ` — well "${excel.well_name ?? "(none)"}" did not match any job; awaiting assignment.`),
          });
          if (job_id) {
            await client.from("daily_report_events").insert({
              report_id: inserted.id,
              actor_id: reviewer.id,
              actor_name: reviewer.name,
              actor_role: reviewer.role,
              action: "signed_off",
              detail: runHourDetail
                ? `Historical import (signed off). ${runHourDetail}`
                : `Historical import (signed off).`,
            });
          }

          results.push({
            report_day: excel.report_day,
            source_sheet: excel.source_sheet,
            report_date: excel.report_date,
            well_name: excel.well_name,
            status: "imported",
            daily_report_status: status,
            matched_job: !!job_id,
            run_hours_applied: runHourDetail,
            message: null,
          });
        } catch (e: any) {
          results.push({
            report_day: excel.report_day,
            source_sheet: excel.source_sheet,
            report_date: excel.report_date,
            well_name: excel.well_name,
            status: "error",
            daily_report_status: null,
            matched_job: !!job_id,
            run_hours_applied: null,
            message: e?.message ?? String(e),
          });
        }
      }

      const summary = {
        well_name: wellName,
        matched_job: !!job_id,
        days_found: days.length,
        days_imported: results.filter((r) => r.status === "imported").length,
        days_duplicate: results.filter((r) => r.status === "duplicate").length,
        days_error: results.filter((r) => r.status === "error").length,
        // Set when the job has 2+ centrifuges but not all are mapped to a
        // centrifuge slot: reports imported but run hours were NOT accrued.
        // Map each centrifuge to a slot (1-4) on its asset, then re-run.
        run_hours_needs_slot_mapping: backfillNeedsMapping,
        run_hours_note: backfillNeedsMapping
          ? "Reports were imported, but run hours were not accrued because this job has two or more centrifuges and at least one is not mapped to a centrifuge slot (Centrifuge 1-4). Map each centrifuge's slot on its asset, then re-import to accrue run hours."
          : null,
        results,
      };
      res.status(201).json(summary);
    },
  );

  // ---- Recompute KPIs from stored workbooks (admin) ----------------------
  // Re-parse the workbook that is already stored on each daily report and
  // refresh its `kpis` + `kpi_cell_map` in place. This backfills KPI fields
  // that were added to the parser AFTER a report was first imported — most
  // importantly `accrued_current_well` (workbook cell AS57) — without asking
  // the user to re-import anything by hand.
  //
  // Only rows that still have their original workbook (attachment_base64) can
  // be recomputed; rows without a stored file are skipped and reported. The
  // operation is idempotent: re-parsing the same bytes yields the same KPIs.
  //
  // BATCHED / RESUMABLE. Each stored workbook is ~1.7 MB, so re-parsing the
  // whole fleet (60+ reports) in one request overruns the serverless
  // function's time limit and dies mid-run — leaving the newest reports never
  // recomputed. Instead this processes a bounded batch per call and returns
  // `next_offset` + `done` so the client can loop until finished.
  //
  // Optional body:
  //   { job_id }  limit the pass to a single job (small set — usually 1 call).
  //   { limit }   how many reports to process this call (default 12, max 25).
  //   { offset }  where to resume from (the previous response's next_offset).
  app.post(
    "/api/daily-reports/recompute-kpis",
    requireAuth,
    requireRole("admin"),
    async (req: Request, res: Response) => {
      const client = supabaseAdmin || supabaseAnon;
      const jobId =
        typeof req.body?.job_id === "string" && req.body.job_id.trim()
          ? req.body.job_id.trim()
          : null;
      // Bound the per-call batch so a single request stays well under the
      // serverless time limit even with ~1.7 MB workbooks.
      const rawLimit = Number(req.body?.limit);
      const batchLimit =
        Number.isFinite(rawLimit) && rawLimit > 0
          ? Math.min(Math.floor(rawLimit), 25)
          : 12;
      const rawOffset = Number(req.body?.offset);
      const offset =
        Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;

      // Fetch only the lightweight columns first (NO attachment_base64), and
      // only this batch's slice via range(). Each workbook's bytes are pulled
      // one row at a time below, keeping every round-trip small.
      let listQ = client
        .from("daily_reports")
        .select("id, report_day, kpis, well_context", { count: "exact" })
        .not("attachment_base64", "is", null)
        .order("created_at", { ascending: true })
        .range(offset, offset + batchLimit - 1);
      if (jobId) listQ = listQ.eq("job_id", jobId);
      const { data: rows, error, count } = await listQ;
      if (error) return res.status(400).json({ message: error.message });

      let updated = 0;
      let unchanged = 0;
      let skipped_no_file = 0;
      let errors = 0;
      const problems: Array<{ id: string; message: string }> = [];

      for (const r of rows || []) {
        try {
          // Pull just this one report's workbook bytes.
          const { data: full, error: fErr } = await client
            .from("daily_reports")
            .select("attachment_base64")
            .eq("id", r.id)
            .single();
          if (fErr) {
            errors += 1;
            problems.push({ id: r.id, message: fErr.message });
            continue;
          }
          if (!full?.attachment_base64) {
            skipped_no_file += 1;
            continue;
          }
          const buf = Buffer.from(full.attachment_base64, "base64");
          const excel = parseDailyReportWorkbook(buf, r.report_day ?? undefined);
          // Merge freshly parsed KPIs over whatever was stored so no existing
          // KPI is lost if the parser ever drops a field.
          const mergedKpis = { ...(r.kpis || {}), ...(excel.kpis || {}) };
          // Also refresh the spud date (AU6) without touching other context.
          const oldCtx: any = (r as any).well_context || {};
          const newSpud = excel.well_context?.spud_date ?? null;
          const ctxChanged = (oldCtx.spud_date ?? null) !== newSpud;
          const before = JSON.stringify(r.kpis || {});
          const after = JSON.stringify(mergedKpis);
          if (before === after && !ctxChanged) {
            unchanged += 1;
            continue;
          }
          const patch: any = { kpis: mergedKpis, kpi_cell_map: excel.kpi_cell_map };
          if (ctxChanged) patch.well_context = { ...oldCtx, spud_date: newSpud };
          const { error: upErr } = await client
            .from("daily_reports")
            .update(patch)
            .eq("id", r.id);
          if (upErr) {
            errors += 1;
            problems.push({ id: r.id, message: upErr.message });
          } else {
            updated += 1;
          }
        } catch (e: any) {
          errors += 1;
          problems.push({ id: r.id, message: e?.message ?? String(e) });
        }
      }

      // How many matched reports exist in total (across all batches).
      const total = typeof count === "number" ? count : (rows || []).length;
      const processed = (rows || []).length;
      const nextOffset = offset + processed;
      const done = nextOffset >= total || processed === 0;

      res.status(200).json({
        // This batch
        scanned: processed,
        updated,
        unchanged,
        skipped_no_file,
        errors,
        problems: problems.slice(0, 25),
        // Progress across the whole run so the client can loop.
        total,
        offset,
        next_offset: nextOffset,
        done,
      });
    },
  );

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
      if (await jobIsArchived(client, job.id))
        return res.status(409).json({ message: ARCHIVED_JOB_MSG });

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
    // IMPORTANT: never select attachment_base64 (or raw_body) in the LIST — the
    // workbook bytes average ~1.7 MB per row, so `select *` pulls tens of MB per
    // page load only to throw the bytes away below. On the free-tier connection
    // that large transfer is what intermittently timed out and made the list
    // look empty. We select an explicit column set (all list-relevant fields
    // minus the heavy blobs) and derive `has_attachment` from attachment_size,
    // which is set for exactly the rows that have stored bytes. The detail page
    // and /attachment route still load the bytes on demand.
    const LIST_COLUMNS = [
      "id", "email_message_id", "sender_email", "sender_name", "subject",
      "received_at", "area", "customer_id", "job_id", "report_date", "summary",
      "analysis", "status", "reviewed_by", "reviewed_by_name", "reviewed_at",
      "change_notes", "email_out_status", "email_out_at", "created_at",
      "well_name", "kpis", "source", "attachment_name", "source_sheet",
      "report_day", "kpi_cell_map", "well_context", "report_number",
      "work_summary", "crew_hours", "crew", "asset_ids", "comments",
      "submitted_by", "signed_by", "signed_at", "run_hours_applied",
      "attachment_mime", "attachment_size",
    ].join(", ");
    let q = supabaseAnon
      .from("daily_reports")
      .select(
        `${LIST_COLUMNS}, customer:customers(name), job:jobs(job_number), submitter:profiles!daily_reports_submitted_by_fkey(name), signer:profiles!daily_reports_signed_by_fkey(name)`,
      )
      // Sort by the report's OWN date (the day the work happened), newest first,
      // so every day of a well sits in date order regardless of when the row was
      // imported or emailed in. received_at is only a tiebreak. nullsFirst:false
      // keeps any date-less rows at the bottom instead of jumping to the top.
      .order("report_date", { ascending: false, nullsFirst: false })
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
      // The workbook bytes are no longer fetched in the list query (see
      // LIST_COLUMNS above). attachment_size is set for exactly the rows that
      // have stored bytes, so it's the correct signal for whether to show the
      // "View document" link — the detail/attachment routes load the bytes.
      has_attachment: !!r.attachment_size,
      customer: undefined,
      job: undefined,
      submitter: undefined,
      signer: undefined,
    }));
    {
      const manualJobs = await manualRateJobIds(supabaseAnon);
      if (manualJobs.size) rows = rows.map((r: any) => withoutManualRateFlag(r, manualJobs));
    }
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
    const { customer, job, submitter, signer, attachment_base64, ...rest } =
      data as any;
    // Reports imported before crew notes (B57) were saved don't have
    // well_context.remarks yet. Read it once from the stored workbook and save
    // it back, so the detail page can show the notes for older reports too.
    if (
      rest.source === "email" &&
      attachment_base64 &&
      rest.report_day != null &&
      !(rest.well_context && "remarks" in rest.well_context)
    ) {
      try {
        const remarks = readDayRemarks(
          Buffer.from(attachment_base64, "base64"),
          Number(rest.report_day),
        );
        rest.well_context = { ...(rest.well_context || {}), remarks };
        const writer = supabaseAdmin || supabaseAnon;
        await writer
          .from("daily_reports")
          .update({ well_context: rest.well_context })
          .eq("id", rest.id);
      } catch (e: any) {
        console.error("[daily-report] remarks backfill", e?.message ?? e);
      }
    }
    if (rest.job_id && Array.isArray(rest.analysis?.missing_fields)) {
      const stripped = withoutManualRateFlag(rest, await manualRateJobIds(supabaseAnon));
      rest.analysis = stripped.analysis;
    }
    res.json({
      ...rest,
      customer_name: customer?.name ?? null,
      job_number: job?.job_number ?? null,
      submitted_by_name: submitter?.name ?? null,
      signed_by_name: signer?.name ?? null,
      // Expose only a flag here; the bytes stream from /attachment on demand.
      has_attachment: !!attachment_base64,
      events: events || [],
    });
  });

  // Stream the original submitted daily-report workbook. Content-Disposition is
  // inline so browsers that can preview it (or the download-fallback link on
  // the detail page) open the real file. Area-scoped like the report itself.
  app.get(
    "/api/daily-reports/:id/attachment",
    requireAuth,
    async (req: Request, res: Response) => {
      const { data, error } = await supabaseAnon
        .from("daily_reports")
        .select("area, job_id, attachment_name, attachment_mime, attachment_base64")
        .eq("id", req.params.id)
        .single();
      if (error || !data || !data.attachment_base64)
        return res.status(404).json({ message: "No document on file for this report" });
      const scope = areaScopeOf(req.profile!);
      if (scope && data.area !== scope)
        return res.status(404).json({ message: "Report not found" });
      const jobIds = await jobScopeOf(req.profile!);
      if (jobIds && !jobIds.includes(data.job_id))
        return res.status(404).json({ message: "Report not found" });
      const buf = Buffer.from(data.attachment_base64, "base64");
      res.setHeader(
        "Content-Type",
        data.attachment_mime || "application/octet-stream",
      );
      res.setHeader(
        "Content-Disposition",
        `inline; filename=\"${(data.attachment_name || "daily-report.xlsx").replace(/\"/g, "")}\"`,
      );
      res.send(buf);
    },
  );

  // Run-hours context for the sign-off UI: the day's hours (M33) plus the
  // centrifuges on the report's matched job. The frontend uses this to decide
  // whether to auto-apply (0 or 1 centrifuge) or prompt for a per-asset split.
  app.get(
    "/api/daily-reports/:id/centrifuges",
    requireAuth,
    requireRole("admin", "area", "super"),
    async (req: Request, res: Response) => {
      const client = supabaseAdmin || supabaseAnon;
      const { data: report, error: rErr } = await client
        .from("daily_reports")
        .select("id, area, job_id, kpis, run_hours_applied")
        .eq("id", req.params.id)
        .single();
      if (rErr || !report)
        return res.status(404).json({ message: "Report not found" });
      const scope = areaScopeOf(req.profile!);
      if (scope && report.area !== scope)
        return res.status(404).json({ message: "Report not found" });

      // Combined + per-centrifuge daily hours from the workbook.
      const numOrNull = (v: any) =>
        v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);
      const kp = (report.kpis as any) || {};
      const daily_run_hours = numOrNull(kp.daily_run_hours);
      // Slot 1 falls back to the legacy combined field when the report
      // predates per-centrifuge parsing; slots 2-4 have no legacy fallback.
      const bySlot = slotDailyHours(kp);
      const daily_run_hours_cent1 = bySlot[1];
      const daily_run_hours_cent2 = bySlot[2];
      const daily_run_hours_cent3 = bySlot[3];
      const daily_run_hours_cent4 = bySlot[4];

      let centrifuges: any[] = [];
      if (report.job_id) {
        const { data: assets } = await client
          .from("assets")
          .select("id, tag, category, run_hours, centrifuge_slot, is_rental, rental_vendor")
          .eq("job_id", report.job_id)
          .in("category", RUN_HOUR_CATEGORIES as unknown as string[]);
        centrifuges = (assets || []).map((a: any) => ({
          id: a.id,
          tag: a.tag,
          is_rental: !!a.is_rental,
          rental_vendor: a.rental_vendor ?? null,
          category: a.category,
          run_hours: a.run_hours,
          centrifuge_slot: a.centrifuge_slot ?? null,
        }));
      }

      // With 2+ centrifuges on the job, every one must be mapped to a slot
      // before hours can be routed; otherwise accrual is blocked.
      const needs_slot_mapping =
        centrifuges.length >= 2 &&
        centrifuges.some((c) => !isMappedSlot(c.centrifuge_slot));

      // Sum of every centrifuge column's day hours (Centrifuge 1-4), and the
      // hours a lone centrifuge would receive.
      const slotVals = [bySlot[1], bySlot[2], bySlot[3], bySlot[4]].filter(
        (h): h is number => h != null && h > 0,
      );
      const day_total_hours = slotVals.length
        ? slotVals.reduce((a, b) => a + b, 0)
        : daily_run_hours != null && daily_run_hours > 0
          ? daily_run_hours
          : null;
      const solo_hours =
        centrifuges.length === 1 ? soloCentrifugeHours(kp, centrifuges[0].centrifuge_slot) : null;

      res.json({
        day_total_hours,
        solo_hours,
        daily_run_hours,
        daily_run_hours_cent1,
        daily_run_hours_cent2,
        daily_run_hours_cent3,
        daily_run_hours_cent4,
        already_applied: !!report.run_hours_applied,
        centrifuges,
        needs_slot_mapping,
      });
    },
  );

  // Email a change request back to whoever sent the report, from the reports
  // inbox. Looks up the job number so the crew knows exactly which report.
  async function emailChangeRequest(client: any, report: any, reviewerName: string, notes: string) {
    let jobNumber: string | null = null;
    if (report.job_id) {
      const { data: job } = await client.from("jobs").select("job_number").eq("id", report.job_id).maybeSingle();
      jobNumber = job?.job_number ?? null;
    }
    return sendDailyReportChanges({
      to: report.sender_email,
      senderName: report.sender_name,
      subject: report.subject,
      reviewerName,
      changeNotes: notes,
      reportDate: report.report_date,
      sheet: report.source_sheet,
      wellName: report.well_name,
      jobNumber,
    });
  }

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
        // A supervisor who replaced the workbook can't also sign it off;
        // another reviewer (or an Admin / Area Manager) has to.
        if (
          reviewer.role === "super" &&
          (report.analysis as any)?.workbook_replaced_by === reviewer.id
        ) {
          return res.status(400).json({
            message:
              "You replaced this report's workbook, so someone else needs to sign it off (another supervisor, an Area Manager or an Admin).",
          });
        }
        // ---- Roll the day's run hours (M33) onto the job's centrifuges -------
        // Only centrifuges accumulate run hours, only at sign-off, and only
        // once per report (run_hours_applied guards against double-counting).
        let runHourDetail: string | null = null;
        const kp = (report.kpis as any) || {};
        const numOrNull = (v: any) =>
          v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);
        // Combined day hours and per-slot hours (Centrifuge 1-4).
        const dailyHours = numOrNull(kp.daily_run_hours);
        const bySlot = slotDailyHours(kp);
        const slot1Hours = bySlot[1];

        // We accrue when there is at least one centrifuge on the job and any
        // slot has positive hours to apply.
        const anyHours =
          (dailyHours != null && dailyHours > 0) ||
          Object.values(bySlot).some((h) => h != null && h > 0);

        if (!report.run_hours_applied && report.job_id && anyHours) {
          const { data: centAssets } = await client
            .from("assets")
            .select("id, tag, category, run_hours, centrifuge_slot")
            .eq("job_id", report.job_id)
            .in("category", RUN_HOUR_CATEGORIES as unknown as string[]);
          const centrifuges = centAssets || [];

          // Decide per-asset hours.
          let allocation: { asset_id: string; tag: string; add: number }[] = [];
          if (centrifuges.length === 1) {
            // Single centrifuge: the whole day's hours go to it automatically.
            // Prefer the combined day total (matches historic behavior); fall
            // back to slot 1 if only per-slot values were parsed.
            const c = centrifuges[0] as any;
            const hrs = soloCentrifugeHours(kp, c.centrifuge_slot);
            if (hrs > 0)
              allocation = [{ asset_id: c.id, tag: c.tag, add: hrs }];
          } else if (centrifuges.length >= 2) {
            // Multiple centrifuges: route each centrifuge's OWN slot hours to it.
            // Every centrifuge on the job must be mapped to a slot (1-4) first;
            // if any is unmapped we do NOT accrue (never apply hours to the
            // wrong asset) and tell the reviewer to map the centrifuge slots.
            const unmapped = centrifuges.filter(
              (c: any) => !isMappedSlot(c.centrifuge_slot),
            );
            if (unmapped.length > 0) {
              return res.status(400).json({
                message:
                  "This job has two or more centrifuges. Map each one to its centrifuge slot (Centrifuge 1, 2, 3, or 4 on the asset) before signing off so run hours go to the right unit. Needs mapping: " +
                  unmapped.map((c: any) => c.tag).join(", "),
              });
            }
            const hoursForSlot = (slot: number) => bySlot[slot] ?? null;
            allocation = centrifuges
              .map((c: any) => {
                const hrs = hoursForSlot(c.centrifuge_slot);
                return {
                  asset_id: c.id,
                  tag: c.tag,
                  add: hrs != null && hrs > 0 ? hrs : 0,
                };
              })
              .filter((a) => a.add > 0);
          }

          // Apply the deltas (running sum on asset.run_hours).
          const applied: string[] = [];
          for (const a of allocation) {
            const cur = centrifuges.find((x: any) => x.id === a.asset_id) as any;
            const base = Number(cur?.run_hours ?? 0) || 0;
            const next = base + a.add;
            const { error: uErr } = await client
              .from("assets")
              .update({ run_hours: next })
              .eq("id", a.asset_id);
            if (uErr)
              return res.status(400).json({
                message: `Could not update run hours for ${a.tag}: ${uErr.message}`,
              });
            applied.push(`${a.tag} +${a.add} hrs`);
          }
          if (applied.length > 0)
            runHourDetail = `Run hours applied: ${applied.join(", ")}`;
          // Log each centrifuge's hours for this report (job + well + date).
          await logRunHours(
            client,
            {
              id: report.id,
              job_id: report.job_id,
              well_name: (report as any).well_name ?? null,
              report_date: (report as any).report_date ?? null,
            },
            allocation.map((x) => ({ asset_id: x.asset_id, add: x.add })),
          );
        }

        const { data, error } = await client
          .from("daily_reports")
          .update({
            status: "Signed off",
            reviewed_by: reviewer.id,
            reviewed_by_name: reviewer.name,
            reviewed_at: now,
            change_notes: null,
            run_hours_applied: runHourDetail ? true : report.run_hours_applied,
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
          detail: runHourDetail,
        });
        return res.json(data);
      }

      // request_changes: record notes, queue/send email back to sender.
      // The reviewer can tick the exact fields/cells to fix; those are listed
      // first so the crew knows exactly what to change in the workbook.
      const fields = (parsed.data.change_fields || []).map((f) => f.trim()).filter(Boolean);
      const typed = (parsed.data.change_notes || "").trim();
      const fullNotes = [
        fields.length ? `Please fix:\n${fields.map((f) => `• ${f}`).join("\n")}` : "",
        typed,
      ]
        .filter(Boolean)
        .join("\n\n");
      const sent = await emailChangeRequest(client, report, reviewer.name, fullNotes);
      const { data, error } = await client
        .from("daily_reports")
        .update({
          status: "Changes requested",
          reviewed_by: reviewer.id,
          reviewed_by_name: reviewer.name,
          reviewed_at: now,
          change_notes: fullNotes,
          analysis: {
            ...((report.analysis as any) || {}),
            requested_fields: fields,
            email_out_error: sent.ok ? null : sent.error ?? null,
          },
          email_out_status: sent.ok ? "Sent" : "Not sent",
          email_out_at: sent.ok ? now : null,
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
        detail: sent.ok
          ? `Suggested changes emailed to ${report.sender_email}`
          : `Suggested changes recorded, but the email to ${report.sender_email} was NOT sent (${sent.error ?? "unknown error"})`,
      });
      res.json({ ...data, email_sent: sent.ok, email_error: sent.ok ? null : sent.error ?? null });
    },
  );

  // Re-send the change-request email for a report that's still in
  // "Changes requested" (e.g. the first send failed, or the crew lost it).
  app.post(
    "/api/daily-reports/:id/resend-changes",
    requireAuth,
    requireRole("admin", "area", "super"),
    async (req: Request, res: Response) => {
      const client = supabaseAdmin || supabaseAnon;
      const { data: report, error: rErr } = await client
        .from("daily_reports")
        .select("*")
        .eq("id", req.params.id)
        .single();
      if (rErr || !report) return res.status(404).json({ message: "Report not found" });
      const scope = areaScopeOf(req.profile!);
      if (scope && report.area !== scope) return res.status(404).json({ message: "Report not found" });
      if (report.status !== "Changes requested" || !report.change_notes)
        return res.status(400).json({ message: "Only reports with changes requested can be re-sent." });
      const reviewerName = report.reviewed_by_name || req.profile!.name;
      const sent = await emailChangeRequest(client, report, reviewerName, report.change_notes);
      const now = new Date().toISOString();
      const { data, error } = await client
        .from("daily_reports")
        .update({
          analysis: { ...((report.analysis as any) || {}), email_out_error: sent.ok ? null : sent.error ?? null },
          email_out_status: sent.ok ? "Sent" : "Not sent",
          email_out_at: sent.ok ? now : report.email_out_at,
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
        action: "changes_resent",
        detail: sent.ok
          ? `Change request re-sent to ${report.sender_email}`
          : `Tried to re-send the change request to ${report.sender_email}, but it was NOT sent (${sent.error ?? "unknown error"})`,
      });
      if (!sent.ok) return res.status(502).json({ message: `The email wasn't sent: ${sent.error ?? "unknown error"}` });
      res.json({ ...data, email_sent: true });
    },
  );

  // ---- Replace workbook (reviewer uploads the corrected file) -------------
  // Supervisors (reports not yet signed off) and Admins / Area Managers (any
  // emailed report) can upload a corrected workbook. The SAME Report Day tab
  // is read. /preview returns what would change without saving; the plain
  // endpoint applies it, logs every change and sends the report back to
  // Pending Review. Run hours already added at sign-off are not re-added.
  const replaceWorkbookSchema = z.object({
    attachment_base64: z.string().min(1, "Choose a workbook to upload"),
    attachment_name: z.string().min(1),
  });

  async function prepareReplaceWorkbook(req: Request, res: Response) {
    const parsed = replaceWorkbookSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: parsed.error.errors[0].message });
      return null;
    }
    const p = parsed.data;
    if (!/\.xlsx?$/i.test(p.attachment_name)) {
      res.status(400).json({ message: "Upload the daily report Excel workbook (.xlsx)." });
      return null;
    }
    const client = supabaseAdmin || supabaseAnon;
    const { data: report } = await client
      .from("daily_reports")
      .select("*")
      .eq("id", req.params.id)
      .maybeSingle();
    const scope = areaScopeOf(req.profile!);
    if (!report || (scope && report.area !== scope)) {
      res.status(404).json({ message: "Report not found" });
      return null;
    }
    if (report.source !== "email") {
      res.status(400).json({ message: "Only emailed daily reports have a workbook to replace." });
      return null;
    }
    if (report.status === "Correction pending") {
      res.status(400).json({ message: "This is a held correction. Use Apply correction or Discard instead." });
      return null;
    }
    const role = req.profile!.role;
    if (report.status === "Signed off" && role !== "admin" && role !== "area") {
      res.status(403).json({
        message: "This report is signed off. Only an Admin or Area Manager can replace its workbook.",
      });
      return null;
    }
    if (report.report_day == null) {
      res.status(400).json({ message: "This report has no Report Day, so the matching tab can't be found." });
      return null;
    }
    let excel;
    try {
      excel = parseDailyReportWorkbook(
        Buffer.from(p.attachment_base64, "base64"),
        Number(report.report_day),
      );
    } catch (e: any) {
      res.status(422).json({
        message: e instanceof ExcelParseError
          ? e.message
          : `Could not read the workbook: ${e?.message ?? e}`,
      });
      return null;
    }
    const next: Record<string, any> = {
      attachment_name: p.attachment_name,
      attachment_base64: p.attachment_base64,
      attachment_mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      attachment_size: Buffer.from(p.attachment_base64, "base64").length,
      source_sheet: excel.source_sheet,
      report_date: excel.report_date,
      well_name: excel.well_name,
      well_context: excel.well_context,
      kpis: excel.kpis,
      kpi_cell_map: excel.kpi_cell_map,
      summary: excel.summary,
    };
    const changes = describeReportChanges(report, next);
    const missingFields = dropManualRateField(excel.missing_fields || [], report.job_id, await manualRateJobIds(client)).map((f) =>
      f === "Report date (D3)" && excel.report_date
        ? `Report date (D3) — filled in as ${excel.report_date} from the prior day`
        : f,
    );
    const warnings: string[] = [];
    const norm = (v: any) => String(v ?? "").trim().toUpperCase();
    if (report.well_name && excel.well_name && norm(report.well_name) !== norm(excel.well_name))
      warnings.push(
        `The well name in this file (${excel.well_name}) is different from the report (${report.well_name}). Make sure it's the right workbook.`,
      );
    if (excel.incomplete)
      warnings.push(`${excel.source_sheet} in this file doesn't look filled in yet.`);
    return { client, report, next, changes, missingFields, warnings, excel };
  }

  app.post(
    "/api/daily-reports/:id/replace-workbook/preview",
    requireAuth,
    requireRole("admin", "area", "super"),
    async (req: Request, res: Response) => {
      const prep = await prepareReplaceWorkbook(req, res);
      if (!prep) return;
      res.json({
        source_sheet: prep.excel.source_sheet,
        report_date: prep.excel.report_date,
        well_name: prep.excel.well_name,
        changes: prep.changes,
        missing_fields: prep.missingFields,
        warnings: prep.warnings,
      });
    },
  );

  app.post(
    "/api/daily-reports/:id/replace-workbook",
    requireAuth,
    requireRole("admin", "area", "super"),
    async (req: Request, res: Response) => {
      const prep = await prepareReplaceWorkbook(req, res);
      if (!prep) return;
      const { client, report, next, changes, missingFields } = prep;
      const actor = req.profile!;
      const analysis = correctedAnalysis(
        report,
        missingFields.length ? { missing_fields: missingFields } : {},
        changes,
        null,
      );
      // Keep a held correction link if one is waiting on this report.
      const pend = (report.analysis as any)?.pending_correction_id;
      if (pend) analysis.pending_correction_id = pend;
      analysis.workbook_replaced_by = actor.id;
      analysis.workbook_replaced_by_name = actor.name;
      analysis.workbook_replaced_at = new Date().toISOString();
      const status = report.status === "Needs job match" ? "Needs job match" : "Pending Review";
      const { data: upd, error } = await client
        .from("daily_reports")
        .update({
          ...next,
          status,
          reviewed_by: null,
          reviewed_by_name: null,
          reviewed_at: null,
          change_notes: null,
          email_out_status: null,
          email_out_at: null,
          analysis,
        })
        .eq("id", report.id)
        .select()
        .single();
      if (error) return res.status(400).json({ message: error.message });
      const hoursChanged = changes.some((x) => x.startsWith("Run hours"));
      await client.from("daily_report_events").insert({
        report_id: report.id,
        actor_id: actor.id,
        actor_name: actor.name,
        actor_role: actor.role,
        action: "workbook_replaced",
        detail:
          `Uploaded "${next.attachment_name}" (${next.source_sheet}) to replace "${report.attachment_name ?? "the original workbook"}". ` +
          (changes.length ? `Changes: ${changes.join("; ")}. ` : "No values changed. ") +
          (report.status === "Signed off" ? "The sign-off was cleared; " : "") +
          `${status === "Pending Review" ? "Back to Pending Review." : "Still needs a job match."}` +
          (report.run_hours_applied && hoursChanged
            ? " Run hours from the original sign-off were already added to the centrifuges and were not changed; adjust the asset's run hours by hand if needed."
            : ""),
      });
      if (missingFields.length) {
        await client.from("daily_report_events").insert({
          report_id: report.id,
          actor_name: "System",
          actor_role: "field",
          action: "needs_review",
          detail: `${next.source_sheet} in "${next.attachment_name}" is missing critical data: ${missingFields.join("; ")}. Check with the crew before signing off.`,
        });
      }
      res.json(upd);
    },
  );

  // ---- Corrections to signed-off reports ----------------------------------
  // A corrected workbook for a day that was already signed off is held as a
  // separate "Correction pending" report (not linked to the job, so it never
  // counts twice). An Admin or Area Manager applies it onto the original, or
  // discards it.
  async function loadCorrection(req: Request, res: Response) {
    const client = supabaseAdmin || supabaseAnon;
    const { data: c } = await client
      .from("daily_reports")
      .select("*")
      .eq("id", req.params.id)
      .maybeSingle();
    const scope = areaScopeOf(req.profile!);
    if (!c || (scope && c.area !== scope)) {
      res.status(404).json({ message: "Report not found" });
      return null;
    }
    const originalId = (c.analysis as any)?.correction_of;
    if (c.status !== "Correction pending" || !originalId) {
      res.status(400).json({ message: "This report is not a pending correction." });
      return null;
    }
    const { data: orig } = await client
      .from("daily_reports")
      .select("*")
      .eq("id", originalId)
      .maybeSingle();
    if (!orig) {
      res.status(404).json({
        message: "The original report no longer exists. Discard this correction, or assign it to a job instead.",
      });
      return null;
    }
    return { client, c, orig };
  }

  app.post(
    "/api/daily-reports/:id/apply-correction",
    requireAuth,
    requireRole("admin", "area"),
    async (req: Request, res: Response) => {
      const loaded = await loadCorrection(req, res);
      if (!loaded) return;
      const { client, c, orig } = loaded;
      const actor = req.profile!;
      const changes: string[] = Array.isArray((c.analysis as any)?.correction_changes)
        ? (c.analysis as any).correction_changes
        : describeReportChanges(orig, c);
      const origEmailId = orig.email_message_id;
      const newEmailId = c.email_message_id;
      // Free the correction's email id (unique) before moving it onto the original.
      const { error: e1 } = await client
        .from("daily_reports")
        .update({ email_message_id: `superseded:${c.id}` })
        .eq("id", c.id);
      if (e1) return res.status(400).json({ message: e1.message });
      const analysis = correctedAnalysis(
        orig,
        { missing_fields: (c.analysis as any)?.missing_fields },
        changes,
        origEmailId,
      );
      if (!analysis.missing_fields) delete analysis.missing_fields;
      delete analysis.pending_correction_id;
      const fields = correctionFields(c);
      fields.email_message_id = newEmailId;
      const { data: upd, error: e2 } = await client
        .from("daily_reports")
        .update({
          ...fields,
          status: "Pending Review",
          reviewed_by: null,
          reviewed_by_name: null,
          reviewed_at: null,
          change_notes: null,
          analysis,
        })
        .eq("id", orig.id)
        .select()
        .single();
      if (e2) {
        // put the correction back the way it was
        await client.from("daily_reports").update({ email_message_id: newEmailId }).eq("id", c.id);
        return res.status(400).json({ message: e2.message });
      }
      await client.from("daily_reports").delete().eq("id", c.id);
      const hoursChanged = changes.some((x) => x.startsWith("Run hours"));
      await client.from("daily_report_events").insert({
        report_id: orig.id,
        actor_id: actor.id,
        actor_name: actor.name,
        actor_role: actor.role,
        action: "correction_applied",
        detail:
          `Applied corrected workbook "${c.attachment_name}". ` +
          (changes.length ? `Changes: ${changes.join("; ")}. ` : "No values changed. ") +
          `Back to Pending Review for a new sign-off.` +
          (orig.run_hours_applied && hoursChanged
            ? " Run hours from the original sign-off were already added to the centrifuges and were not changed; adjust the asset's run hours by hand if needed."
            : ""),
      });
      res.json(upd);
    },
  );

  app.post(
    "/api/daily-reports/:id/discard-correction",
    requireAuth,
    requireRole("admin", "area"),
    async (req: Request, res: Response) => {
      const loaded = await loadCorrection(req, res);
      if (!loaded) return;
      const { client, c, orig } = loaded;
      const actor = req.profile!;
      const analysis = { ...((orig.analysis as any) || {}) };
      const ids: string[] = Array.isArray(analysis.superseded_email_ids)
        ? analysis.superseded_email_ids
        : [];
      if (!ids.includes(c.email_message_id)) ids.push(c.email_message_id);
      analysis.superseded_email_ids = ids;
      delete analysis.pending_correction_id;
      const { error } = await client
        .from("daily_reports")
        .update({ analysis })
        .eq("id", orig.id);
      if (error) return res.status(400).json({ message: error.message });
      await client.from("daily_reports").delete().eq("id", c.id);
      await client.from("daily_report_events").insert({
        report_id: orig.id,
        actor_id: actor.id,
        actor_name: actor.name,
        actor_role: actor.role,
        action: "correction_discarded",
        detail: `Discarded corrected workbook "${c.attachment_name}". The signed-off report was kept as it was.`,
      });
      res.json({ ok: true, original_id: orig.id });
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
      res.json({ ...data, email_out_ready: emailConfigured() || gmailConfigured(), ingest_ready: !!INGEST_TOKEN });
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

  // (normJobId is defined at module scope and shared with the daily-report
  // matcher — uppercase, spaces and dashes equivalent.)

  // Read the rig / job name straight out of an .xlsx JSA workbook. In the JSA
  // template the rig name lives in cell K4 of the "JSA" sheet (labeled
  // "Rig Name:" in J4). Returns the raw cell text, or null when the file is not
  // a readable xlsx or the cell is empty. PDF JSAs return null (no cells).
  const readJsaRigNameFromWorkbook = (
    base64: string,
    mime: string | null | undefined,
  ): string | null => {
    // Only spreadsheet JSAs have cells; skip PDFs and anything else.
    if (mime && mime.includes("pdf")) return null;
    try {
      const buf = Buffer.from(base64, "base64");
      const wb = XLSX.read(buf, { type: "buffer" });
      // Prefer the sheet literally named "JSA"; fall back to the first sheet.
      const sheetName =
        wb.SheetNames.find((n) => n.trim().toUpperCase() === "JSA") ||
        wb.SheetNames[0];
      const ws = sheetName ? wb.Sheets[sheetName] : undefined;
      const cell = ws ? (ws as any)["K4"] : undefined;
      const raw = cell && cell.v != null ? String(cell.v).trim() : "";
      return raw ? raw : null;
    } catch {
      return null;
    }
  };

  // Word (.docx) JSAs — e.g. North Louisiana's "DFS JSA" form. There are no
  // cells, so read the document text and pull the "Location:" (rig / job) and
  // "Date:" lines from it. Returns nulls when the file isn't a readable .docx.
  const isWordJsa = (name: string | null | undefined, mime: string | null | undefined) =>
    /wordprocessingml|msword/i.test(String(mime ?? "")) || /\.docx?$/i.test(String(name ?? ""));
  const readJsaFromWord = (
    base64: string,
  ): { location: string | null; date: string | null; text: string | null } => {
    try {
      const buf = Buffer.from(base64, "base64");
      // In the ESM server bundle CFB lives on the default export, not the
      // namespace (verified 2026-10-21) — check both.
      const CFB = (XLSX as any).CFB ?? (XLSX as any).default?.CFB;
      if (!CFB) return { location: null, date: null, text: null };
      const cfb = CFB.read(buf, { type: "buffer" });
      const i = (cfb.FullPaths as string[]).findIndex((p) => /word\/document\.xml$/i.test(p));
      if (i < 0) return { location: null, date: null, text: null };
      const xml = Buffer.from(cfb.FileIndex[i].content).toString("utf8");
      const decode = (t: string) =>
        t.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
      const paras = (xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) || []).map((p) =>
        decode((p.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || []).map((t) => t.replace(/<[^>]+>/g, "")).join("")),
      );
      const clean = (v: string) => v.replace(/_+/g, " ").replace(/\s+/g, " ").trim();
      let location: string | null = null;
      let date: string | null = null;
      for (const para of paras) {
        if (!location) {
          const m = para.match(/Location\s*:\s*(.*?)(?=\s*(?:Date|Job Task|Supervisor|Work Activity)\s*:|$)/i);
          if (m && clean(m[1])) location = clean(m[1]);
        }
        if (!date) {
          const m = para.match(/Date\s*:\s*(.*?)(?=\s*(?:Location|Job Task|Supervisor)\s*:|$)/i);
          const d = m ? clean(m[1]).match(/(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/) : null;
          if (d) {
            const yy = d[3].length === 2 ? 2000 + Number(d[3]) : Number(d[3]);
            const mm = Number(d[1]);
            const dd = Number(d[2]);
            if (yy >= 2000 && yy <= 2100 && mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31)
              date = `${yy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
          }
        }
      }
      return { location, date, text: paras.join("\n") };
    } catch {
      return { location: null, date: null, text: null };
    }
  };

  // All cell text of an .xlsx JSA (every sheet), for the "find a job number
  // anywhere in the file" fallback. Null for unreadable files.
  const readJsaWorkbookText = (base64: string): string | null => {
    try {
      const wb = XLSX.read(Buffer.from(base64, "base64"), { type: "buffer" });
      const parts: string[] = [];
      for (const n of wb.SheetNames) {
        const ws = wb.Sheets[n] as any;
        for (const k of Object.keys(ws || {})) {
          if (k[0] === "!") continue;
          const v = ws[k]?.v;
          if (v != null && typeof v !== "number") parts.push(String(v));
        }
      }
      return parts.join("\n");
    } catch {
      return null;
    }
  };

  // Find exactly one active job whose number appears in free text (a file
  // name or the file's contents). Spaces, dashes and underscores are treated
  // alike, and the number must stand on its own ("H&P 541" matches
  // "J Lee JSA H&P 541.xlsx" but not "H&P 5410"). The longest match wins
  // (so "H&P 541" beats "H&P 54"); a tie between different jobs, or a job
  // number shorter than 4 characters, is never guessed.
  const findJobInText = (text: string | null | undefined, jobs: any[]): any | null => {
    if (!text) return null;
    const hay = " " + normJobId(String(text).replace(/\.(xlsx?|xlsm|xlsb|docx?|pdf)\b/gi, " ").replace(/_+/g, " ")) + " ";
    const esc = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    let best: any[] = [];
    let bestLen = 0;
    for (const j of jobs) {
      const n = normJobId(j.job_number);
      if (n.replace(/\s/g, "").length < 4) continue;
      const re = new RegExp("(^|[^A-Z0-9])" + esc(n) + "(?=[^A-Z0-9]|$)");
      if (!re.test(hay)) continue;
      if (n.length > bestLen) { best = [j]; bestLen = n.length; }
      else if (n.length === bestLen) best.push(j);
    }
    return best.length === 1 ? best[0] : null;
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

    // Match to a job. Precedence for the job identifier:
    //   1) explicit job_number override on the request (rare)
    //   2) the rig name read from the JSA workbook cell K4 (primary)
    //   3) a job number parsed from the email subject (fallback, e.g. PDFs)
    // Comparison against jobs.job_number is space/dash-insensitive so that
    // "H&P 266" (K4) matches "H&P 266", and "WT 3050" matches "WT-3050".
    const word = isWordJsa(p.attachment_name, p.attachment_mime);
    const rigFromWorkbook = word
      ? null
      : readJsaRigNameFromWorkbook(p.attachment_base64, p.attachment_mime);
    const wordInfo = word
      ? readJsaFromWord(p.attachment_base64)
      : { location: null, date: null, text: null };
    const explicit = p.job_number && p.job_number.trim();
    const subjectNumber = parseJobNumber(p.subject);
    // Candidate job identifiers, strongest first:
    //   request override → workbook K4 → Word "Location:" → (below) file name
    //   → same-email daily report's job → job number anywhere in the file →
    //   email subject.
    const candidates: { value: string; source: string }[] = [];
    if (explicit) candidates.push({ value: explicit, source: "request" });
    if (rigFromWorkbook) candidates.push({ value: rigFromWorkbook, source: "workbook cell K4" });
    if (wordInfo.location) candidates.push({ value: wordInfo.location, source: "the JSA's Location line" });
    let job_id: string | null = null;
    let area: string | null = null;
    let customer_id: string | null = null;
    let jobNumber: string | null = candidates[0]?.value ?? subjectNumber ?? null;
    let matchSource: string | null = candidates[0]?.source ?? (subjectNumber ? "email subject" : null);
    const { data: allJobs } = await client
      .from("jobs")
      .select("id, area, customer_id, job_number")
      .is("archived_at", null);
    const findJob = (v: string) => (allJobs || []).find((j: any) => normJobId(j.job_number) === normJobId(v)) as any;
    for (const c of candidates) {
      const m = findJob(c.value);
      if (m) {
        job_id = m.id; area = m.area; customer_id = m.customer_id;
        jobNumber = c.value; matchSource = c.source;
        break;
      }
    }
    // The attachment's file name names the job (e.g. "J Lee JSA H&P 541.xlsx").
    if (!job_id) {
      const m = findJobInText(p.attachment_name, allJobs || []);
      if (m) {
        job_id = m.id; area = m.area; customer_id = m.customer_id;
        jobNumber = m.job_number; matchSource = "the file name";
      }
    }
    // Same email also carried a daily report (e.g. Dustin Dillard's crews send
    // the report + JSA together): use that report's job.
    if (!job_id) {
      const { data: sib } = await client
        .from("daily_reports")
        .select("job_id, area, customer_id, job:jobs(job_number)")
        .eq("email_message_id", p.email_message_id)
        .not("job_id", "is", null)
        .limit(1);
      const r = (sib || [])[0] as any;
      if (r?.job_id) {
        job_id = r.job_id; area = r.area; customer_id = r.customer_id;
        jobNumber = r.job?.job_number ?? jobNumber;
        matchSource = "the daily report in the same email";
      }
    }
    // A job number written anywhere in the JSA itself (any cell / any line).
    if (!job_id) {
      const isPdf = /pdf/i.test(String(p.attachment_mime ?? "")) || /\.pdf$/i.test(p.attachment_name);
      const fileText = word ? wordInfo.text : isPdf ? null : readJsaWorkbookText(p.attachment_base64);
      const m = findJobInText(fileText, allJobs || []);
      if (m) {
        job_id = m.id; area = m.area; customer_id = m.customer_id;
        jobNumber = m.job_number; matchSource = "the JSA's contents";
      }
    }
    if (!job_id && subjectNumber) {
      const m = findJob(subjectNumber);
      if (m) {
        job_id = m.id; area = m.area; customer_id = m.customer_id;
        jobNumber = subjectNumber; matchSource = "email subject";
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
      jsa_date: p.jsa_date ?? wordInfo.date ?? null,
      job_number_raw: jobNumber,
      attachment_name: p.attachment_name,
      attachment_mime:
        p.attachment_mime ??
        (word ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : "application/pdf"),
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
          ? ` and matched job \"${jobNumber}\" (from ${matchSource}) to this JSA.`
          : jobNumber
            ? ` — \"${jobNumber}\" (from ${matchSource}) did not match any job; awaiting assignment.`
            : ` — no rig name in the file and no job number in the subject; awaiting assignment.`),
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
    // Field techs: only JSAs matched to their assigned job(s).
    const jsaJobIds = await jobScopeOf(req.profile!);
    if (jsaJobIds) q = q.in("job_id", jsaJobIds.length ? jsaJobIds : ["00000000-0000-0000-0000-000000000000"]);
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
    const jsaJobIds = await jobScopeOf(req.profile!);
    if (jsaJobIds && !jsaJobIds.includes((data as any).job_id))
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
        .select("area, job_id, attachment_name, attachment_mime, attachment_base64")
        .eq("id", req.params.id)
        .single();
      if (error || !data) return res.status(404).json({ message: "JSA not found" });
      const scope = areaScopeOf(req.profile!);
      if (scope && data.area !== scope)
        return res.status(404).json({ message: "JSA not found" });
      const jsaJobIds = await jobScopeOf(req.profile!);
      if (jsaJobIds && !jsaJobIds.includes((data as any).job_id))
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
        .select("area, job_id, attachment_name, attachment_mime, attachment_base64")
        .eq("id", req.params.id)
        .single();
      if (error || !data) return res.status(404).json({ message: "JSA not found" });
      const scope = areaScopeOf(req.profile!);
      if (scope && data.area !== scope)
        return res.status(404).json({ message: "JSA not found" });
      const jsaJobIds = await jobScopeOf(req.profile!);
      if (jsaJobIds && !jsaJobIds.includes((data as any).job_id))
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
      if (await jobIsArchived(client, job.id))
        return res.status(409).json({ message: ARCHIVED_JOB_MSG });

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
    // Field techs: only their assigned job(s).
    const fieldJobIds = await jobScopeOf(req.profile!);
    if (fieldJobIds && !fieldJobIds.includes(data.id)) {
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

  // ==== Job services / service charges (any job) ===========================

  // Equipment picked for a service charge must be in the job's area (it is
  // normally a unit assigned to the job). null clears it.
  async function resolveServiceAsset(
    job: { id: string; area: string },
    assetId: string | null | undefined,
  ): Promise<{ ok: true; asset_id: string | null } | { ok: false; message: string }> {
    if (!assetId) return { ok: true, asset_id: null };
    const { data } = await padClient()
      .from("assets")
      .select("id, area, job_id")
      .eq("id", assetId)
      .maybeSingle();
    if (!data) return { ok: false, message: "That equipment wasn't found" };
    if (data.job_id !== job.id && data.area !== job.area)
      return { ok: false, message: "That equipment isn't on this job or in its area" };
    return { ok: true, asset_id: data.id };
  }

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

  // List service charges for a job. Supervisors, area managers and admins in
  // the job's area can read them (they carry billed amounts, so field techs
  // don't). Each row is joined with its equipment tag and the field ticket it
  // is billed on (a ticket line carrying its service_id), if any.
  app.get(
    "/api/jobs/:jobId/services",
    requireAuth,
    requireRole("admin", "area", "super"),
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
      const rows = (data || []) as any[];
      const assetIds = Array.from(new Set(rows.map((r) => r.asset_id).filter(Boolean)));
      const assetById = new Map<string, any>();
      if (assetIds.length) {
        const { data: as } = await padClient()
          .from("assets")
          .select("id, tag, category")
          .in("id", assetIds);
        for (const a of as || []) assetById.set(a.id, a);
      }
      const ticketOf = new Map<string, number>();
      const { data: tickets } = await padClient()
        .from("field_tickets")
        .select("ticket_number, line_items")
        .eq("job_id", job.id);
      for (const t of (tickets || []) as any[])
        for (const l of Array.isArray(t.line_items) ? t.line_items : [])
          if (l?.service_id && !ticketOf.has(l.service_id))
            ticketOf.set(l.service_id, t.ticket_number);
      res.json(
        rows.map((r) => ({
          ...r,
          asset_tag: r.asset_id ? assetById.get(r.asset_id)?.tag ?? null : null,
          asset_category: r.asset_id ? assetById.get(r.asset_id)?.category ?? null : null,
          on_ticket: ticketOf.get(r.id) ?? null,
        })),
      );
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
      // Service charges can be logged on any job (manned or unmanned).
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
      const assetRes = await resolveServiceAsset(job, parsed.data.asset_id ?? null);
      if (!assetRes.ok) return res.status(400).json({ message: assetRes.message });
      const { data, error } = await padClient()
        .from("job_services")
        .insert({
          asset_id: assetRes.asset_id,
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
        patch.notes = parsed.data.notes.trim();
      if (parsed.data.asset_id !== undefined) {
        const assetRes = await resolveServiceAsset(job, parsed.data.asset_id);
        if (!assetRes.ok) return res.status(400).json({ message: assetRes.message });
        patch.asset_id = assetRes.asset_id;
      }
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
      // Don't orphan a billed line: it must come off its field ticket first.
      const { data: tks } = await padClient()
        .from("field_tickets")
        .select("ticket_number, line_items")
        .eq("job_id", job.id);
      const onTicket = ((tks || []) as any[]).find((t) =>
        (Array.isArray(t.line_items) ? t.line_items : []).some(
          (l: any) => l?.service_id === req.params.serviceId,
        ),
      );
      if (onTicket)
        return res.status(400).json({
          message: `This charge is billed on field ticket #${onTicket.ticket_number}. Remove it from that ticket first.`,
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

  // Key a well name for matching reports to pad wells. Field crews write the
  // full lease name on reports (e.g. "SHOCK-N-AWE UL M 507H") while a pad well
  // is usually entered short ("Shock-N-Awe 507H"). The stable, unique part is
  // the well-number token at the end — the digits + optional single trailing
  // letter, like "507H" or "4H". When a name has such a token we key on it so
  // the long and short forms match; otherwise we fall back to the whole name,
  // trimmed and lowercased. Space/dash differences are collapsed either way.
  const normWellName = (s: string | null | undefined) => {
    const base = (s ?? "").trim().toLowerCase().replace(/[\s-]+/g, " ");
    // Trailing well number: digits then an optional single letter (H/h, etc.),
    // as the last token of the name.
    const m = base.match(/(\d+\s?[a-z]?)\s*$/);
    if (m) {
      const tok = m[1].replace(/\s+/g, "");
      // Guard: require at least one digit (already true) and avoid keying on a
      // bare single digit that could collide (e.g. "4"); a lone number is still
      // fine because well numbers are unique within a pad.
      return `#${tok}`;
    }
    return base;
  };
  const reportDay = (r: any): string | null => {
    const d = String(r.report_date || r.received_at || "").slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
  };

  // Summarize a job's daily reports into per-well-name stats used to drive the
  // report-inferred well model (days, first/last report, and which well is the
  // crew's current one = the well on the most recent dated report).
  async function wellReportStats(jobId: string): Promise<{
    byName: Map<
      string,
      {
        days: number;
        first: string;
        last: string;
        display: string;
        accrued: number | null;
        dayRateSum: number; // sum of each report day's own AL57 rate
        latestDayRate: number | null; // AL57 on the well's most recent report
      }
    >;
    currentKey: string | null;
  }> {
    const client = padClient();
    const { data: reports } = await client
      .from("daily_reports")
      .select("well_name, report_date, received_at, report_day, kpis")
      .eq("job_id", jobId);
    // Read the AS57 cumulative accrued figure out of the stored KPIs.
    const accruedOf = (r: any): number | null => {
      const raw = r?.kpis?.accrued_current_well;
      if (raw == null) return null;
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    };
    // Read this report day's own AL57 day rate out of the stored KPIs.
    const dayRateOfReport = (r: any): number | null => {
      const raw = r?.kpis?.day_rate;
      if (raw == null) return null;
      const n = Number(raw);
      return Number.isFinite(n) && n > 0 ? n : null;
    };
    const dated: {
      name: string;
      day: string;
      reportDay: number;
      accrued: number | null;
      dayRate: number | null;
    }[] = [];
    for (const r of reports ?? []) {
      const day = reportDay(r);
      const name = (r.well_name as string | null) ?? "";
      const rd = Number((r as any).report_day);
      if (day && name.trim())
        dated.push({
          name: name.trim(),
          day,
          reportDay: Number.isFinite(rd) ? rd : 0,
          accrued: accruedOf(r),
          dayRate: dayRateOfReport(r),
        });
    }
    dated.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    const byName = new Map<
      string,
      {
        days: number;
        first: string;
        last: string;
        display: string;
        accrued: number | null;
        dayRateSum: number;
        latestDayRate: number | null;
      }
    >();
    // Track, per well, which dated report currently owns the accrued figure so
    // a later report only overrides it when that report actually carries an
    // AS57 value (blank/duplicate rows must not wipe a real number).
    const accruedAt = new Map<string, { day: string; reportDay: number }>();
    // Track which report currently owns the well's "latest" AL57 day rate.
    const rateAt = new Map<string, { day: string; reportDay: number }>();
    for (const { name, day, reportDay: rd, accrued, dayRate } of dated) {
      const key = normWellName(name);
      const cur = byName.get(key);
      if (cur) {
        cur.days += 1;
        if (day < cur.first) cur.first = day;
        if (day > cur.last) cur.last = day;
        if (dayRate != null) cur.dayRateSum += dayRate;
      } else {
        byName.set(key, {
          days: 1,
          first: day,
          last: day,
          display: name!.trim(),
          accrued: null,
          dayRateSum: dayRate != null ? dayRate : 0,
          latestDayRate: null,
        });
      }
      // Revenue = the accrued (AS57) total on the MOST RECENT report for the
      // well that actually reports a value. Compare by date, then day number.
      if (accrued != null) {
        const owner = accruedAt.get(key);
        const isNewer =
          !owner ||
          day > owner.day ||
          (day === owner.day && rd >= owner.reportDay);
        if (isNewer) {
          byName.get(key)!.accrued = accrued;
          accruedAt.set(key, { day, reportDay: rd });
        }
      }
      // Latest AL57 day rate for the well: newest report that carried one.
      if (dayRate != null) {
        const owner = rateAt.get(key);
        const isNewer =
          !owner ||
          day > owner.day ||
          (day === owner.day && rd >= owner.reportDay);
        if (isNewer) {
          byName.get(key)!.latestDayRate = dayRate;
          rateAt.set(key, { day, reportDay: rd });
        }
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
        .select("id, day_rate, status, manual_day_rate")
        .eq("id", job.id)
        .single();
      // Set day rate jobs bill per calendar day, split to the well on report.
      const manualBill = jobRow?.manual_day_rate
        ? (await computeManualBilling([jobRow as any])).get(job.id)
        : undefined;
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
        // Revenue is the cumulative accrued figure (cell AS57) from the most
        // recent daily report for this well. Only fall back to the day-rate
        // estimate when no report carried an AS57 value. That fallback now sums
        // each report day's OWN AL57 rate (so mid-job rate changes are exact),
        // and only when NO report carried an AL57 rate at all does it use the
        // job's single fallback rate x days.
        const accrued = stat?.accrued ?? null;
        const dayRateSum = stat?.dayRateSum ?? 0;
        const revenue = manualBill
          ? manualBill.by_well_key.get(key) ?? (days > 0 ? 0 : null)
          : accrued != null
            ? accrued
            : dayRateSum > 0
              ? dayRateSum
              : dayRate != null
                ? dayRate * days
                : null;
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
          revenue,
          is_current: isCurrent,
        });
        wellsByPad.set(w.pad_id, arr);
      }
      const result = (pads ?? []).map((p: any) => ({
        ...p,
        wells: wellsByPad.get(p.id) ?? [],
      }));
      // Billing-calendar jobs (Mud Plant): no wells — the pad lists MONTHS,
      // each with its billed days and revenue from the billing calendar.
      if (manualBill?.mode === "calendar" && result.length) {
        const host = result.find((p: any) => p.status === "Open") ?? result[0];
        host.wells = calendarMonthRows(
          job.id,
          host.id,
          manualBill.billing_start_date ?? null,
          manualBill.through_date,
          manualBill.daily,
          (wells ?? []).filter((w: any) => w.pad_id === host.id).map((w: any) => String(w.name ?? "")),
        );
      }
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

  // ---- Revenue module ----------------------------------------------------
  // Admin sees all areas; area managers see only their own area's jobs.
  // Revenue = the ACCRUED (cell AS57) cumulative figure from the most recent
  // daily report per well, summed to the job. "Daily revenue" uses a simpler
  // basis: one report-day = the job's day rate (day rate x report days).

  // Compute, for a set of jobs, the accrued (AS57) revenue per job by summing
  // each well's latest reported AS57 value. One pass over the jobs' reports.
  // Service charges (job_services.cost) are billed to the customer: summed per
  // job and per service date for the Revenue module.
  async function serviceChargesByJob(
    jobIds: string[],
  ): Promise<Map<string, { total: number; byDay: Map<string, number> }>> {
    const out = new Map<string, { total: number; byDay: Map<string, number> }>();
    if (!jobIds.length) return out;
    const { data, error } = await padClient()
      .from("job_services")
      .select("job_id, service_date, cost")
      .in("job_id", jobIds);
    if (error) {
      console.error("[revenue] job_services", error.message);
      return out;
    }
    for (const r of (data || []) as any[]) {
      const amt = Number(r.cost);
      if (!Number.isFinite(amt) || amt <= 0) continue;
      const day = String(r.service_date ?? "").slice(0, 10);
      const cur = out.get(r.job_id) ?? { total: 0, byDay: new Map<string, number>() };
      cur.total = Math.round((cur.total + amt) * 100) / 100;
      if (/^\d{4}-\d{2}-\d{2}$/.test(day)) cur.byDay.set(day, (cur.byDay.get(day) ?? 0) + amt);
      out.set(r.job_id, cur);
    }
    return out;
  }

  async function jobAccruedRevenue(
    jobIds: string[],
  ): Promise<Map<string, { revenue: number | null; hasAccrued: boolean }>> {
    const out = new Map<string, { revenue: number | null; hasAccrued: boolean }>();
    for (const id of jobIds) out.set(id, { revenue: null, hasAccrued: false });
    if (jobIds.length === 0) return out;
    const client = padClient();
    const { data: reports } = await client
      .from("daily_reports")
      .select("job_id, well_name, report_date, received_at, report_day, kpis")
      .in("job_id", jobIds);
    const accruedOf = (r: any): number | null => {
      const raw = r?.kpis?.accrued_current_well;
      if (raw == null) return null;
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    };
    // Per (job, well) key, keep the accrued value from the most recent report
    // that actually carries one (by date, then report day).
    type Owner = { day: string; reportDay: number; accrued: number };
    const latest = new Map<string, Owner>(); // key: jobId + "\u0000" + wellKey
    for (const r of reports ?? []) {
      const jid = r.job_id as string;
      const day = reportDay(r);
      const accrued = accruedOf(r);
      if (!day || accrued == null) continue;
      const wellKey = normWellName((r.well_name as string | null) ?? "");
      const rd = Number((r as any).report_day);
      const key = jid + "\u0000" + wellKey;
      const owner = latest.get(key);
      const isNewer =
        !owner ||
        day > owner.day ||
        (day === owner.day && (Number.isFinite(rd) ? rd : 0) >= owner.reportDay);
      if (isNewer)
        latest.set(key, {
          day,
          reportDay: Number.isFinite(rd) ? rd : 0,
          accrued,
        });
    }
    for (const [key, owner] of Array.from(latest.entries())) {
      const jid = key.split("\u0000")[0];
      const cur = out.get(jid) ?? { revenue: null, hasAccrued: false };
      cur.revenue = (cur.revenue ?? 0) + owner.accrued;
      cur.hasAccrued = true;
      out.set(jid, cur);
    }
    return out;
  }

  // Revenue summary: totals, by-area, by-job, by-customer, daily & monthly
  // series, and an active/completed split. Admin + area only, area-scoped.
  app.get(
    "/api/revenue/summary",
    requireAuth,
    requireRole("admin", "area"),
    async (req: Request, res: Response) => {
      const scope = areaScopeOf(req.profile!); // null for admin
      const client = padClient();
      // In-scope, non-archived jobs.
      let jq = client
        .from("jobs")
        .select("id, job_number, area, day_rate, customer_id, well_name, status, manual_day_rate")
        .is("archived_at", null);
      if (scope) jq = jq.eq("area", scope);
      const { data: jobs, error: jErr } = await jq;
      if (jErr) return res.status(500).json({ message: jErr.message });
      const jobRows = jobs ?? [];
      const jobIds = jobRows.map((j: any) => j.id);

      // Customer names for the in-scope jobs.
      const custIds = Array.from(
        new Set(jobRows.map((j: any) => j.customer_id).filter(Boolean)),
      );
      const custName = new Map<string, string>();
      if (custIds.length) {
        const { data: custs } = await client
          .from("customers")
          .select("id, name")
          .in("id", custIds);
        for (const c of custs ?? []) custName.set(c.id, c.name);
      }

      // Accrued revenue per job, plus which wells are "current" (for active
      // vs completed) via wellReportStats per job.
      const accrued = await jobAccruedRevenue(jobIds);
      // Set day rate jobs: revenue is the job rate x Active calendar days.
      const manualBill = await computeManualBilling(jobRows as any);
      for (const [jid, b] of Array.from(manualBill.entries()))
        accrued.set(jid, { revenue: b.total, hasAccrued: b.total != null });
      // Service charges are billed to the customer: add them to job revenue.
      const svcCharges = await serviceChargesByJob(jobIds);
      for (const [jid, sc] of Array.from(svcCharges.entries())) {
        const cur = accrued.get(jid) ?? { revenue: null, hasAccrued: false };
        accrued.set(jid, {
          ...cur,
          revenue: Math.round(((cur.revenue ?? 0) + sc.total) * 100) / 100,
          hasAccrued: true,
        });
      }

      // All in-scope reports once, for daily/monthly day-rate revenue and
      // active detection (a job is active if it has a most-recent-dated well).
      // kpis carries each report day's own AL57 day rate (day_rate), which the
      // revenue math prefers over the job's single fallback rate.
      const { data: reps } = await client
        .from("daily_reports")
        .select("job_id, report_date, received_at, report_day, kpis")
        .in("job_id", jobIds.length ? jobIds : ["00000000-0000-0000-0000-000000000000"]);
      // Job fallback rate (used only when a report day carries no AL57 rate).
      const jobFallbackRate = new Map<string, number | null>();
      for (const j of jobRows) {
        const dr =
          j.day_rate != null && !isNaN(Number(j.day_rate))
            ? Number(j.day_rate)
            : null;
        jobFallbackRate.set(j.id, dr);
      }
      // Per-report AL57 day rate, when present and finite.
      const reportDayRate = (r: any): number | null => {
        const raw = r?.kpis?.day_rate;
        if (raw == null) return null;
        const n = Number(raw);
        return Number.isFinite(n) && n > 0 ? n : null;
      };
      // Daily revenue (each report day's own AL57 rate, else the job fallback)
      // and per-job report-day counts. Also track the day rate on each job's
      // most recent report so the job row shows the current rate.
      const dailyMap = new Map<string, number>(); // yyyy-mm-dd -> revenue
      const monthlyMap = new Map<string, number>(); // yyyy-mm -> revenue
      const dailyJobsMap = new Map<string, Set<string>>(); // yyyy-mm-dd -> job ids reporting
      const reportDaysByJob = new Map<string, number>();
      const lastReportByJob = new Map<string, string>();
      const currentRateByJob = new Map<string, number | null>(); // latest report's AL57
      const currentRateDayByJob = new Map<string, string>();
      // One billable day per job per report date. Crews sometimes resend a
      // corrected workbook for the same day (or the same file arrives twice),
      // so several reports can share a job + date. Counting each would bill
      // that day twice; instead keep ONE entry per job+date, preferring a
      // report that carries its own AL57 rate, then the most recently received.
      type DayPick = { rate: number | null; hasOwn: boolean; received: string };
      const perJobDay = new Map<string, DayPick>(); // `${job}|${day}`
      for (const r of reps ?? []) {
        const jid = r.job_id as string;
        const day = reportDay(r);
        if (!day) continue;
        const perReport = reportDayRate(r);
        const prev = lastReportByJob.get(jid);
        if (!prev || day > prev) lastReportByJob.set(jid, day);
        // Track the AL57 rate from the newest report that carried one.
        if (perReport != null) {
          const rd = currentRateDayByJob.get(jid);
          if (!rd || day >= rd) {
            currentRateByJob.set(jid, perReport);
            currentRateDayByJob.set(jid, day);
          }
        }
        const key = `${jid}|${day}`;
        const cand: DayPick = {
          rate: perReport ?? jobFallbackRate.get(jid) ?? null,
          hasOwn: perReport != null,
          received: String(r.received_at ?? ""),
        };
        const cur = perJobDay.get(key);
        if (
          !cur ||
          (cand.hasOwn && !cur.hasOwn) ||
          (cand.hasOwn === cur.hasOwn && cand.received > cur.received)
        )
          perJobDay.set(key, cand);
      }
      for (const [key, pick] of Array.from(perJobDay.entries())) {
        const sep = key.lastIndexOf("|");
        const jid = key.slice(0, sep);
        const day = key.slice(sep + 1);
        reportDaysByJob.set(jid, (reportDaysByJob.get(jid) ?? 0) + 1);
        if (manualBill.has(jid)) continue; // billed by calendar day below
        if (pick.rate != null) {
          dailyMap.set(day, (dailyMap.get(day) ?? 0) + pick.rate);
          if (!dailyJobsMap.has(day)) dailyJobsMap.set(day, new Set());
          dailyJobsMap.get(day)!.add(jid);
          const mon = day.slice(0, 7);
          monthlyMap.set(mon, (monthlyMap.get(mon) ?? 0) + pick.rate);
        }
      }
      for (const [jid, b] of Array.from(manualBill.entries()))
        for (const [day, amt] of Array.from(b.daily.entries())) {
          dailyMap.set(day, (dailyMap.get(day) ?? 0) + amt);
          if (!dailyJobsMap.has(day)) dailyJobsMap.set(day, new Set());
          dailyJobsMap.get(day)!.add(jid);
          const mon = day.slice(0, 7);
          monthlyMap.set(mon, (monthlyMap.get(mon) ?? 0) + amt);
        }
      // Service charges land on their service date.
      for (const [, sc] of Array.from(svcCharges.entries()))
        for (const [day, amt] of Array.from(sc.byDay.entries())) {
          dailyMap.set(day, (dailyMap.get(day) ?? 0) + amt);
          const mon = day.slice(0, 7);
          monthlyMap.set(mon, (monthlyMap.get(mon) ?? 0) + amt);
        }
      // The rate shown on a job row: latest report's AL57 rate, else fallback.
      const dayRateOf = new Map<string, number | null>();
      for (const j of jobRows)
        dayRateOf.set(
          j.id,
          manualBill.has(j.id)
            ? jobFallbackRate.get(j.id) ?? null
            : currentRateByJob.get(j.id) ?? jobFallbackRate.get(j.id) ?? null,
        );

      // Per-job rows (accrued revenue is the headline figure).
      const byJob = jobRows.map((j: any) => {
        const acc = accrued.get(j.id) ?? { revenue: null, hasAccrued: false };
        const days = reportDaysByJob.get(j.id) ?? 0;
        const row = {
          job_id: j.id,
          job_number: j.job_number,
          area: j.area,
          customer_id: j.customer_id ?? null,
          customer_name: j.customer_id
            ? custName.get(j.customer_id) ?? ""
            : "",
          day_rate: dayRateOf.get(j.id),
          report_days: days,
          revenue: acc.revenue, // accrued (AS57); null when no report had one
          has_accrued: acc.hasAccrued,
          active: days > 0, // has report activity
          last_report: lastReportByJob.get(j.id) ?? null,
          billing_basis: "reports" as "reports" | "calendar",
          service_charges: svcCharges.get(j.id)?.total ?? 0,
        };
        // Calendar-billed jobs (Mud Plant) have no daily reports: their status,
        // day count and last day come from the job's billing calendar.
        const mb = manualBill.get(j.id) as any;
        if (mb?.mode === "calendar") {
          row.active = !!mb.billing_today;
          row.report_days = Number(mb.billable_days ?? 0);
          row.last_report = mb.last_billed_date ?? null;
          row.billing_basis = "calendar";
        }
        return row;
      });

      const sumRev = (rows: { revenue: number | null }[]) => {
        const vals = rows
          .map((r) => r.revenue)
          .filter((v): v is number => v != null);
        return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
      };

      // By area.
      const areaMap = new Map<string, { revenue: number | null; jobs: number }>();
      for (const r of byJob) {
        const cur = areaMap.get(r.area) ?? { revenue: null, jobs: 0 };
        if (r.revenue != null) cur.revenue = (cur.revenue ?? 0) + r.revenue;
        cur.jobs += 1;
        areaMap.set(r.area, cur);
      }
      const byArea = Array.from(areaMap.entries())
        .map(([area, v]) => ({ area, revenue: v.revenue, jobs: v.jobs }))
        .sort((a, b) => (b.revenue ?? 0) - (a.revenue ?? 0));

      // By customer.
      const custMap = new Map<
        string,
        { customer_id: string | null; name: string; revenue: number | null; jobs: number }
      >();
      for (const r of byJob) {
        const cid = r.customer_id ?? "none";
        const cur =
          custMap.get(cid) ??
          {
            customer_id: r.customer_id ?? null,
            name: r.customer_name || "(no customer)",
            revenue: null,
            jobs: 0,
          };
        if (r.revenue != null) cur.revenue = (cur.revenue ?? 0) + r.revenue;
        cur.jobs += 1;
        custMap.set(cid, cur);
      }
      const byCustomer = Array.from(custMap.values()).sort(
        (a, b) => (b.revenue ?? 0) - (a.revenue ?? 0),
      );

      const daily = Array.from(dailyMap.entries())
        .map(([date, revenue]) => ({ date, revenue }))
        .sort((a, b) => (a.date < b.date ? -1 : 1));
      const monthly = Array.from(monthlyMap.entries())
        .map(([month, revenue]) => ({ month, revenue }))
        .sort((a, b) => (a.month < b.month ? -1 : 1));

      // Period headline figures (day-rate basis, same series as the charts):
      //  - latest day: the most recent report date on or before today (Central)
      //  - month to date: current calendar month through today
      //  - year to date: Jan 1 of the current year through today
      // Null (rendered "—") when no report day falls in the period.
      const todayCentral = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Chicago",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date()); // yyyy-mm-dd
      const curMonth = todayCentral.slice(0, 7);
      const curYear = todayCentral.slice(0, 4);
      let latestDay: string | null = null;
      let mtd: number | null = null;
      let ytd: number | null = null;
      let mtdDays = 0;
      let ytdDays = 0;
      for (const [d, v] of Array.from(dailyMap.entries())) {
        if (d > todayCentral) continue; // ignore future-dated typos
        if (!latestDay || d > latestDay) latestDay = d;
        if (d.startsWith(curMonth)) {
          mtd = (mtd ?? 0) + v;
          mtdDays++;
        }
        if (d.startsWith(curYear)) {
          ytd = (ytd ?? 0) + v;
          ytdDays++;
        }
      }
      // Daily revenue = the current day rate of every ACTIVE job, summed.
      // Each job's rate is cell AL57 from its most recent dated daily report
      // that carries one (newest report_date, then highest report day), else
      // the job's stored rate. This is exactly the Dashboard / Jobs page
      // "Daily revenue" logic, so the numbers agree everywhere.
      const newestRated = new Map<string, { date: string; day: number; rate: number }>();
      for (const r of reps ?? []) {
        const d = r.report_date ? String(r.report_date).slice(0, 10) : null;
        if (!d) continue;
        const rate = reportDayRate(r);
        if (rate == null) continue;
        const rd = Number(r.report_day ?? 0) || 0;
        const cur = newestRated.get(r.job_id);
        if (!cur || d > cur.date || (d === cur.date && rd > cur.day))
          newestRated.set(r.job_id, { date: d, day: rd, rate });
      }
      const activeStatusJobs = jobRows.filter((j: any) =>
        manualBill.has(j.id) ? j.status === "Active" : isLiveJobStatus(j.status),
      );
      const currentJobs = activeStatusJobs.map((j: any) => {
        const mb = manualBill.get(j.id);
        if (mb)
          return {
            job_id: j.id,
            job_number: j.job_number,
            area: j.area,
            day_rate: mb.today_rate,
            source: mb.today_rate != null ? "job" : null,
            report_date: null,
            report_day: null,
          };
        const nr = newestRated.get(j.id);
        const rate = nr ? nr.rate : jobFallbackRate.get(j.id) ?? null;
        return {
          job_id: j.id,
          job_number: j.job_number,
          area: j.area,
          day_rate: rate,
          source: nr ? "report" : rate != null ? "job" : null,
          report_date: nr?.date ?? null,
          report_day: nr?.day ?? null,
        };
      });
      const ratedCurrent = currentJobs.filter((c) => c.day_rate != null);
      const current_daily = {
        revenue: ratedCurrent.length
          ? ratedCurrent.reduce((sum, c) => sum + (c.day_rate as number), 0)
          : null,
        active_jobs: currentJobs.length,
        missing_rate: currentJobs.length - ratedCurrent.length,
        jobs: currentJobs.sort((x, y) => (y.day_rate ?? 0) - (x.day_rate ?? 0)),
      };

      const periods = {
        as_of: todayCentral,
        current_daily,
        latest_day: latestDay
          ? {
              date: latestDay,
              revenue: dailyMap.get(latestDay) ?? null,
              jobs: dailyJobsMap.get(latestDay)?.size ?? 0,
            }
          : null,
        month_to_date: { month: curMonth, revenue: mtd, days: mtdDays },
        year_to_date: { year: curYear, revenue: ytd, days: ytdDays },
      };

      const activeJobs = byJob.filter((j) => j.active);
      const completedJobs = byJob.filter((j) => !j.active);
      const topJobs = [...byJob]
        .filter((j) => j.revenue != null)
        .sort((a, b) => (b.revenue ?? 0) - (a.revenue ?? 0))
        .slice(0, 10);

      res.json({
        scope: scope ?? "all",
        totals: {
          revenue: sumRev(byJob),
          jobs: byJob.length,
          active_jobs: activeJobs.length,
          completed_jobs: completedJobs.length,
          active_revenue: sumRev(activeJobs),
          completed_revenue: sumRev(completedJobs),
          jobs_missing_accrued: byJob.filter((j) => !j.has_accrued).length,
        },
        by_area: byArea,
        by_customer: byCustomer,
        by_job: byJob.sort((a, b) => (b.revenue ?? 0) - (a.revenue ?? 0)),
        top_jobs: topJobs,
        daily,
        monthly,
        periods,
      });
    },
  );

  // CSV export of the by-job revenue breakdown (same scope as the summary).
  app.get(
    "/api/revenue/export",
    requireAuth,
    requireRole("admin", "area"),
    async (req: Request, res: Response) => {
      const scope = areaScopeOf(req.profile!);
      const client = padClient();
      let jq = client
        .from("jobs")
        .select("id, job_number, area, day_rate, customer_id, status, manual_day_rate")
        .is("archived_at", null);
      if (scope) jq = jq.eq("area", scope);
      const { data: jobs, error } = await jq;
      if (error) return res.status(500).json({ message: error.message });
      const jobRows = jobs ?? [];
      const jobIds = jobRows.map((j: any) => j.id);
      const custIds = Array.from(
        new Set(jobRows.map((j: any) => j.customer_id).filter(Boolean)),
      );
      const custName = new Map<string, string>();
      if (custIds.length) {
        const { data: custs } = await client
          .from("customers")
          .select("id, name")
          .in("id", custIds);
        for (const c of custs ?? []) custName.set(c.id, c.name);
      }
      const accrued = await jobAccruedRevenue(jobIds);
      const manualBill = await computeManualBilling(jobRows as any);
      for (const [jid, b] of Array.from(manualBill.entries()))
        accrued.set(jid, { revenue: b.total, hasAccrued: b.total != null });
      // Service charges are billed to the customer: add them to job revenue.
      const svcCharges = await serviceChargesByJob(jobIds);
      for (const [jid, sc] of Array.from(svcCharges.entries())) {
        const cur = accrued.get(jid) ?? { revenue: null, hasAccrued: false };
        accrued.set(jid, {
          ...cur,
          revenue: Math.round(((cur.revenue ?? 0) + sc.total) * 100) / 100,
          hasAccrued: true,
        });
      }
      const { data: reps } = await client
        .from("daily_reports")
        .select("job_id, report_date, received_at, report_day, kpis")
        .in("job_id", jobIds.length ? jobIds : ["00000000-0000-0000-0000-000000000000"]);
      const reportDaysByJob = new Map<string, number>();
      // Current AL57 day rate per job = the rate on its most recent report that
      // carried one (so the CSV shows the current, possibly-changed rate).
      const currentRateByJob = new Map<string, number | null>();
      const currentRateDayByJob = new Map<string, string>();
      const al57 = (r: any): number | null => {
        const raw = r?.kpis?.day_rate;
        if (raw == null) return null;
        const n = Number(raw);
        return Number.isFinite(n) && n > 0 ? n : null;
      };
      for (const r of reps ?? []) {
        const day = reportDay(r);
        if (!day) continue;
        reportDaysByJob.set(r.job_id, (reportDaysByJob.get(r.job_id) ?? 0) + 1);
        const rate = al57(r);
        if (rate != null) {
          const cur = currentRateDayByJob.get(r.job_id);
          if (!cur || day >= cur) {
            currentRateByJob.set(r.job_id, rate);
            currentRateDayByJob.set(r.job_id, day);
          }
        }
      }
      const esc = (v: any) => {
        const s = v == null ? "" : String(v);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      };
      const header = [
        "Job Number",
        "Area",
        "Customer",
        "Day Rate",
        "Report Days",
        "Revenue (Accrued AS57)",
      ];
      const lines = [header.join(",")];
      for (const j of jobRows) {
        const acc = accrued.get(j.id) ?? { revenue: null };
        const fallback =
          j.day_rate != null && !isNaN(Number(j.day_rate))
            ? Number(j.day_rate)
            : null;
        // Prefer the current AL57 rate from the latest report; else fallback.
        const dr = manualBill.has(j.id)
          ? fallback
          : currentRateByJob.get(j.id) ?? fallback;
        lines.push(
          [
            esc(j.job_number),
            esc(j.area),
            esc(j.customer_id ? custName.get(j.customer_id) ?? "" : ""),
            esc(dr ?? ""),
            esc(reportDaysByJob.get(j.id) ?? 0),
            esc(acc.revenue ?? ""),
          ].join(","),
        );
      }
      const csv = lines.join("\r\n");
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="revenue-${scope ? scope.replace(/\s+/g, "-") : "all"}-${todayIso()}.csv"`,
      );
      res.send(csv);
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
      // Next number = highest existing "Pad N" + 1 (not the pad count), so a
      // deleted or merged pad never causes two pads with the same name.
      const { data: existingPads } = await client
        .from("pads")
        .select("name")
        .eq("job_id", job.id);
      const maxN = (existingPads ?? []).reduce((m: number, p: any) => {
        const mm = /^Pad\s+(\d+)$/i.exec(String(p.name ?? "").trim());
        return mm ? Math.max(m, Number(mm[1])) : m;
      }, 0);
      const padName = `Pad ${Math.max(maxN, (existingPads ?? []).length) + 1}`;
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

  // Delete a pad (admin / area manager only). Its wells come off the pad and
  // go back to "not on a pad yet"; daily reports are never touched, so the
  // wells can be added to another pad and their days/revenue reattach.
  app.delete(
    "/api/pads/:padId",
    requireAuth,
    requireRole("admin", "area"),
    async (req: Request, res: Response) => {
      const client = padClient();
      const { data: pad } = await client
        .from("pads")
        .select("id, job_id, name")
        .eq("id", req.params.padId)
        .single();
      if (!pad) return res.status(404).json({ message: "Pad not found" });
      const job = await loadScopedJob(req, res, pad.job_id);
      if (!job) return;
      const { error } = await client.from("pads").delete().eq("id", pad.id);
      if (error) return res.status(400).json({ message: error.message });
      res.status(204).end();
    },
  );

  // Merge a pad into another pad on the same job (admin / area manager only):
  // every well moves to the target pad, then the emptied pad is deleted.
  app.post(
    "/api/pads/:padId/merge",
    requireAuth,
    requireRole("admin", "area"),
    async (req: Request, res: Response) => {
      const intoId =
        typeof req.body?.into_pad_id === "string" ? req.body.into_pad_id : "";
      if (!intoId)
        return res.status(400).json({ message: "into_pad_id is required" });
      if (intoId === req.params.padId)
        return res.status(400).json({ message: "Pick a different pad" });
      const client = padClient();
      const { data: pads } = await client
        .from("pads")
        .select("id, job_id, name")
        .in("id", [req.params.padId, intoId]);
      const src = (pads ?? []).find((p: any) => p.id === req.params.padId);
      const dst = (pads ?? []).find((p: any) => p.id === intoId);
      if (!src || !dst) return res.status(404).json({ message: "Pad not found" });
      if (src.job_id !== dst.job_id)
        return res.status(400).json({ message: "Pads must be on the same job" });
      const job = await loadScopedJob(req, res, src.job_id);
      if (!job) return;
      const { error: mErr } = await client
        .from("wells")
        .update({ pad_id: dst.id })
        .eq("pad_id", src.id);
      if (mErr) return res.status(400).json({ message: mErr.message });
      const { error: dErr } = await client.from("pads").delete().eq("id", src.id);
      if (dErr) return res.status(400).json({ message: dErr.message });
      res.json({ merged: true, into: dst });
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
      // A well lives on exactly one pad per job. If this job already has the
      // well (same normalized name) on this pad, it's a no-op; if it's on a
      // different pad, move it here instead of creating a duplicate.
      const key = normWellName(parsed.data.name);
      const { data: jobWells } = await client
        .from("wells")
        .select("id, pad_id, name")
        .eq("job_id", pad.job_id);
      const existingWell = (jobWells ?? []).find(
        (w: any) => normWellName(w.name) === key,
      );
      if (existingWell) {
        if (existingWell.pad_id === pad.id)
          return res.json({ ...existingWell, stints: [], unchanged: true });
        const { data: moved, error: mErr } = await client
          .from("wells")
          .update({ pad_id: pad.id })
          .eq("id", existingWell.id)
          .select()
          .single();
        if (mErr) return res.status(400).json({ message: mErr.message });
        return res.json({ ...moved, stints: [], moved: true });
      }
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

  // Move a well to another pad on the same job.
  app.patch(
    "/api/wells/:wellId",
    requireAuth,
    requireRole("admin", "area", "super", "field"),
    async (req: Request, res: Response) => {
      const padId = typeof req.body?.pad_id === "string" ? req.body.pad_id : "";
      if (!padId) return res.status(400).json({ message: "pad_id is required" });
      const client = padClient();
      const { data: well } = await client
        .from("wells")
        .select("id, job_id, pad_id")
        .eq("id", req.params.wellId)
        .single();
      if (!well) return res.status(404).json({ message: "Well not found" });
      const job = await loadScopedJob(req, res, well.job_id);
      if (!job) return;
      const { data: target } = await client
        .from("pads")
        .select("id, job_id")
        .eq("id", padId)
        .single();
      if (!target || target.job_id !== well.job_id)
        return res.status(400).json({ message: "Pad must be on the same job" });
      const { data: moved, error } = await client
        .from("wells")
        .update({ pad_id: padId })
        .eq("id", well.id)
        .select()
        .single();
      if (error) return res.status(400).json({ message: error.message });
      res.json(moved);
    },
  );

  // Remove a well from its pad. Daily reports are untouched — the well simply
  // goes back to "not on a pad yet" and can be added to another pad.
  app.delete(
    "/api/wells/:wellId",
    requireAuth,
    requireRole("admin", "area", "super"),
    async (req: Request, res: Response) => {
      const client = padClient();
      const { data: well } = await client
        .from("wells")
        .select("id, job_id")
        .eq("id", req.params.wellId)
        .single();
      if (!well) return res.status(404).json({ message: "Well not found" });
      const job = await loadScopedJob(req, res, well.job_id);
      if (!job) return;
      const { error } = await client.from("wells").delete().eq("id", well.id);
      if (error) return res.status(400).json({ message: error.message });
      res.status(204).end();
    },
  );

  // NOTE: manual well open/close and pad close/reopen routes were removed.
  // Well activity is now inferred from daily reports (see /api/jobs/:jobId/pads
  // and /api/jobs/:jobId/unassigned-wells). Wells are only attached to pads.


  // Forecast: upcoming work + centrifuge planning (server/forecast.ts)
  registerRentalRoutes(app);
  registerForecastRoutes(app);

  return httpServer;
}
