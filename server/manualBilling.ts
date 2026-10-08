// Set day rate billing ("manual day rate" jobs).
//
// Some customers (Verdun Oil & Gas) cannot carry daily costs on the daily
// report. For those jobs the job's own day rate is billed EVERY calendar day,
// starting on the job's oldest daily report date and running through today
// (Central time). A day bills $0 when the job was on Rig Move, On Hold or
// Completed that day.
//
// Rate / status history lives in job_rate_events. Each change applies from the
// day it was saved (Central). The FIRST time a job's rate is saved, that rate
// applies back to the job's first report — the history starts with a base
// event dated 2000-01-01. Several changes on the same day: the last one wins.
// With no events at all, the job's current rate is used for every day, with
// earlier days treated as Active and today using the job's current status.
import { supabaseAnon, supabaseAdmin } from "./supabase";
import type { ManualBilling, ManualBillingEvent } from "@shared/schema";

const client = () => supabaseAdmin || supabaseAnon;

export const BASE_EFFECTIVE_DATE = "2000-01-01";

export function todayCentral(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function addDays(iso: string, n: number): string {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Same well-name key as the routes (trailing well-number token, else the name).
export function wellKey(s: string | null | undefined): string {
  const base = (s ?? "").trim().toLowerCase().replace(/[\s-]+/g, " ");
  const m = base.match(/(\d+\s?[a-z]?)\s*$/);
  if (m) return `#${m[1].replace(/\s+/g, "")}`;
  return base;
}

const num = (v: any): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export type ManualBillingFull = ManualBilling & {
  daily: Map<string, number>; // yyyy-mm-dd -> billed amount (billable days only)
  by_well_key: Map<string, number>; // wellKey -> revenue
};

type JobLite = {
  id: string;
  day_rate: any;
  status: string;
  manual_day_rate?: boolean | null;
};

export async function loadRateEvents(
  jobIds: string[],
): Promise<Map<string, ManualBillingEvent[]>> {
  const out = new Map<string, ManualBillingEvent[]>();
  for (const id of jobIds) out.set(id, []);
  if (!jobIds.length) return out;
  const { data, error } = await client()
    .from("job_rate_events")
    .select("job_id, effective_date, day_rate, status, created_by_name, created_at")
    .in("job_id", jobIds)
    .order("effective_date", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) return out; // table not created yet -> no history
  for (const e of data ?? []) {
    out.get(e.job_id)?.push({
      effective_date: String(e.effective_date).slice(0, 10),
      day_rate: num(e.day_rate),
      status: e.status,
      created_by_name: e.created_by_name ?? null,
      created_at: e.created_at,
    });
  }
  return out;
}

// Compute billing for every manual job in `jobs` (others are ignored).
export async function computeManualBilling(
  jobs: JobLite[],
): Promise<Map<string, ManualBillingFull>> {
  const out = new Map<string, ManualBillingFull>();
  const manual = jobs.filter((j) => j.manual_day_rate);
  if (!manual.length) return out;
  const ids = manual.map((j) => j.id);
  const today = todayCentral();
  const events = await loadRateEvents(ids);
  const { data: reps } = await client()
    .from("daily_reports")
    .select("job_id, well_name, report_date, report_day")
    .in("job_id", ids);
  const repsByJob = new Map<string, { day: string; rd: number; well: string }[]>();
  for (const r of reps ?? []) {
    const day = r.report_date ? String(r.report_date).slice(0, 10) : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day > today) continue;
    const arr = repsByJob.get(r.job_id) ?? [];
    arr.push({ day, rd: Number(r.report_day) || 0, well: (r.well_name ?? "").trim() });
    repsByJob.set(r.job_id, arr);
  }

  for (const j of manual) {
    const evs = events.get(j.id) ?? [];
    const jobRate = num(j.day_rate);
    const reports = (repsByJob.get(j.id) ?? []).sort((a, b) =>
      a.day !== b.day ? (a.day < b.day ? -1 : 1) : a.rd - b.rd,
    );
    const start = reports.length ? reports[0].day : null;

    // State in effect on `day`: last event dated on/before it; before the
    // first event, the first event-day's final state.
    const stateOn = (day: string): { rate: number | null; status: string } => {
      if (!evs.length)
        return { rate: jobRate, status: day < today ? "Active" : j.status };
      let pick: ManualBillingEvent | null = null;
      for (const e of evs) {
        if (e.effective_date <= day) pick = e;
        else break;
      }
      if (!pick) {
        const firstDay = evs[0].effective_date;
        for (const e of evs) if (e.effective_date === firstDay) pick = e;
      }
      return { rate: pick!.day_rate, status: pick!.status };
    };

    const daily = new Map<string, number>();
    const byWell = new Map<string, number>();
    const wellDisplay = new Map<string, string>();
    let total = 0;
    let billable = 0;
    let missingRateDays = 0;
    if (start) {
      let ri = 0;
      let curWell = reports[0].well;
      for (let d = start; d <= today; d = addDays(d, 1)) {
        while (ri < reports.length && reports[ri].day <= d) {
          if (reports[ri].well) curWell = reports[ri].well;
          ri++;
        }
        const st = stateOn(d);
        if (st.status !== "Active") continue;
        if (st.rate == null || st.rate <= 0) {
          missingRateDays++;
          continue;
        }
        billable++;
        total += st.rate;
        daily.set(d, st.rate);
        const k = wellKey(curWell);
        byWell.set(k, (byWell.get(k) ?? 0) + st.rate);
        if (!wellDisplay.has(k)) wellDisplay.set(k, curWell);
      }
    }
    const todayState = stateOn(today);
    const currentWell = reports.length ? reports[reports.length - 1].well || null : null;
    const curKey = currentWell ? wellKey(currentWell) : null;
    out.set(j.id, {
      start_date: start,
      through_date: today,
      billable_days: billable,
      missing_rate_days: missingRateDays,
      total: start && (billable > 0 || missingRateDays === 0) ? Math.round(total * 100) / 100 : null,
      today_rate:
        todayState.status === "Active" && todayState.rate != null && todayState.rate > 0
          ? todayState.rate
          : todayState.status === "Active"
            ? null
            : 0,
      today_status: todayState.status,
      current_well: currentWell,
      current_well_revenue: curKey != null ? byWell.get(curKey) ?? 0 : null,
      by_well: Array.from(byWell.entries()).map(([k, v]) => ({
        well: wellDisplay.get(k) ?? k,
        revenue: Math.round(v * 100) / 100,
      })),
      events: evs,
      daily,
      by_well_key: byWell,
    });
  }
  return out;
}

// Strip the Map fields so the summary can be sent as JSON.
export function publicBilling(b: ManualBillingFull | undefined): ManualBilling | null {
  if (!b) return null;
  const { daily, by_well_key, ...rest } = b;
  return rest;
}

// Record a rate/status change for a manual job (called after a job edit).
// `before` is the job row before the edit, `after` the row after it.
export async function recordRateChange(
  before: JobLite,
  after: JobLite,
  by: { id: string; name: string | null },
): Promise<void> {
  if (!after.manual_day_rate) return;
  const rateChanged = num(before.day_rate) !== num(after.day_rate);
  const statusChanged = before.status !== after.status;
  const switchedOn = !before.manual_day_rate && !!after.manual_day_rate;
  if (!rateChanged && !statusChanged && !switchedOn) return;
  const c = client();
  const { data: existing, error } = await c
    .from("job_rate_events")
    .select("id")
    .eq("job_id", after.id)
    .limit(1);
  if (error) return; // table missing — nothing to record
  const today = todayCentral();
  const rows: any[] = [];
  const meta = { job_id: after.id, created_by: by.id, created_by_name: by.name };
  if (!existing || existing.length === 0) {
    // First save: the rate applies back to the first report, as Active.
    rows.push({ ...meta, effective_date: BASE_EFFECTIVE_DATE, day_rate: num(after.day_rate), status: "Active" });
    if (after.status !== "Active")
      rows.push({ ...meta, effective_date: today, day_rate: num(after.day_rate), status: after.status });
  } else {
    rows.push({ ...meta, effective_date: today, day_rate: num(after.day_rate), status: after.status });
  }
  await c.from("job_rate_events").insert(rows);
}
