// Job standby billing.
//
// Some jobs have equipment on location on standby with no crew, so no daily
// reports come in. An admin or area manager can put any job ON STANDBY at a
// set standby day rate from a start date. Every calendar day on standby bills
// that rate (start day counts, through today Central).
//
// Standby turns itself OFF when daily reports start again: the first report
// dated on or after the standby start ends standby the day BEFORE that
// report's date, and from that day on the report's own day rate (AL57) bills
// as usual. The job's cumulative revenue = report revenue + every standby day.
// Standby can also be ended by hand on a chosen last standby day.
//
// Periods live in job_standby_periods (one open period per job at most).
import { supabaseAnon, supabaseAdmin } from "./supabase";
import { todayCentral } from "./manualBilling";

const client = () => supabaseAdmin || supabaseAnon;

export function addDaysIso(iso: string, n: number): string {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export type StandbyPeriod = {
  id: string;
  rate: number;
  start_date: string;
  end_date: string | null; // last standby day; null = still on standby
  ended_reason: "report" | "manual" | null;
  created_by_name: string | null;
  ended_by_name: string | null;
  created_at: string | null;
  days: number; // billable standby days so far
  total: number; // days x rate
};

export type JobStandby = {
  active: boolean;
  rate: number | null; // current standby rate when active
  start_date: string | null; // current period's start when active
  days: number; // all periods
  total: number; // all periods
  periods: StandbyPeriod[]; // newest first
  byDay: Map<string, number>;
};

export function publicStandby(s: JobStandby | undefined) {
  if (!s) return null;
  const { byDay: _b, ...rest } = s;
  return rest;
}

function dayOf(r: any): string | null {
  const d = r?.report_date ? String(r.report_date).slice(0, 10) : null;
  if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  return null;
}

// Load standby for a set of jobs. Open periods whose job has a daily report
// dated on/after the start are closed automatically (persisted).
export async function standbyByJob(jobIds: string[]): Promise<Map<string, JobStandby>> {
  const out = new Map<string, JobStandby>();
  if (!jobIds.length) return out;
  const { data, error } = await client()
    .from("job_standby_periods")
    .select("*")
    .in("job_id", jobIds)
    .order("start_date", { ascending: true });
  if (error) {
    // Table not created yet (SQL not run) — standby simply doesn't exist.
    if (!/does not exist|schema cache/i.test(error.message))
      console.error("[standby] load", error.message);
    return out;
  }
  const rows = ((data || []) as any[]).sort((a, b) =>
    String(a.start_date) < String(b.start_date) ? -1 : 1,
  );
  if (!rows.length) return out;
  const today = todayCentral();

  // Auto-end: first report dated on/after each open period's start.
  const open = rows.filter((p) => !p.end_date);
  if (open.length) {
    const openJobIds = Array.from(new Set(open.map((p) => p.job_id)));
    const minStart = open.reduce((m, p) => (p.start_date < m ? p.start_date : m), open[0].start_date);
    const { data: reps } = await client()
      .from("daily_reports")
      .select("job_id, report_date")
      .in("job_id", openJobIds)
      .gte("report_date", minStart);
    for (const p of open) {
      let first: string | null = null;
      for (const r of reps ?? []) {
        if (r.job_id !== p.job_id) continue;
        const d = dayOf(r);
        if (!d || d < p.start_date || d > today) continue;
        if (!first || d < first) first = d;
      }
      if (!first) continue;
      const end = addDaysIso(first, -1);
      p.end_date = end;
      p.ended_reason = "report";
      p.ended_by_name = `Daily report ${first}`;
      const { error: upErr } = await client()
        .from("job_standby_periods")
        .update({ end_date: end, ended_reason: "report", ended_by_name: p.ended_by_name })
        .eq("id", p.id)
        .is("end_date", null);
      if (upErr) console.error("[standby] auto-end", upErr.message);
    }
  }

  for (const p of rows) {
    const rate = Number(p.rate);
    const start = String(p.start_date).slice(0, 10);
    const lastRaw = p.end_date ? String(p.end_date).slice(0, 10) : today;
    const last = lastRaw > today ? today : lastRaw;
    const cur =
      out.get(p.job_id) ??
      ({ active: false, rate: null, start_date: null, days: 0, total: 0, periods: [], byDay: new Map() } as JobStandby);
    let days = 0;
    if (Number.isFinite(rate) && rate >= 0 && start <= last) {
      for (let d = start; d <= last; d = addDaysIso(d, 1)) {
        // Overlapping periods never double-bill a day.
        if (cur.byDay.has(d)) continue;
        cur.byDay.set(d, rate);
        days++;
      }
    }
    const total = Math.round(days * (Number.isFinite(rate) ? rate : 0) * 100) / 100;
    cur.days += days;
    cur.total = Math.round((cur.total + total) * 100) / 100;
    if (!p.end_date) {
      cur.active = true;
      cur.rate = rate;
      cur.start_date = start;
    }
    cur.periods.unshift({
      id: p.id,
      rate,
      start_date: start,
      end_date: p.end_date ? String(p.end_date).slice(0, 10) : null,
      ended_reason: p.ended_reason ?? null,
      created_by_name: p.created_by_name ?? null,
      ended_by_name: p.ended_by_name ?? null,
      created_at: p.created_at ?? null,
      days,
      total,
    });
    out.set(p.job_id, cur);
  }
  return out;
}
