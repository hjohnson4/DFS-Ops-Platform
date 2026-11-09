// Ticket preview: what a job's field ticket would look like if the job ended
// today. Built live from the daily reports (each day's cost breakdown, day
// cost and running total), grouped the way the paper ticket is written:
//   - one package line per run of days at the same package cost
//     ("Closed Loop Package 10/25 - 11/5", 12 x $2,525), with the equipment
//     breakdown under it;
//   - one line per extra charge (screens, trucking, disposal, drive-by ...)
//     with the dated counts under it;
//   - service charges logged on the job that aren't on a ticket yet;
//   - standby days (equipment on location, no crew; see server/standby.ts),
//     one line per run of days at the same standby rate. A standby day goes
//     on the well the equipment was last on (the well with the latest report
//     before it; else the next well; else the job itself when it has no
//     reports). Standby days already on any ticket on the job are left out.
// Days already on a field ticket (any status) for the well are left out, so a
// well can have as many tickets as needed and the preview always starts after
// the last one.
//
// Admin / Area Manager can edit it (header fields, any line's description,
// quantity or price, hide a line, add their own lines such as trucking or
// rig-up material). Edits are kept in ticket_preview_drafts per job + well
// until the preview is turned into a real field ticket. Supervisors view only.
import type { Express, Request, Response } from "express";
import { supabaseAnon, supabaseAdmin } from "./supabase";
import { requireAuth, requireRole, areaScopeOf } from "./auth";
import { todayCentral } from "./manualBilling";
import { standbyByJob } from "./standby";
import {
  wellKey,
  ticketPreviewDraftSchema,
  type CostLine,
  type LineItem,
  type TicketPreview,
  type TicketPreviewDay,
  type TicketPreviewLine,
  type TicketPreviewStandbyDay,
  type TicketPreviewDraft,
} from "@shared/schema";

const db = () => supabaseAdmin || supabaseAnon;
const MANAGE = ["admin", "area"] as const;
const VIEW = ["admin", "area", "super"] as const;

const DRAFT_SQL_HINT =
  'Saving ticket preview edits needs a one-time database update: run "Ticket preview setup.sql" in the Supabase SQL Editor.';
const missingTable = (msg: string) => /ticket_preview_drafts|does not exist|schema cache/i.test(msg);

const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: any): number | null => {
  const n = Number(v);
  return v === null || v === undefined || v === "" || !Number.isFinite(n) ? null : n;
};
const md = (d: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  return m ? `${Number(m[2])}/${Number(m[3])}` : d;
};
const addDays = (d: string, n: number) => {
  const [y, m, dd] = d.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, dd + n));
  return t.toISOString().slice(0, 10);
};
const range = (a: string, b: string) => (a === b ? md(a) : `${md(a)} – ${md(b)}`);
const STATUS_RANK: Record<string, number> = { "Signed off": 3, "Pending Review": 2, "Correction pending": 2, "Changes requested": 1 };

async function loadJob(req: Request, res: Response) {
  const scope = areaScopeOf(req.profile!);
  const { data: job } = await db()
    .from("jobs")
    .select("id,job_number,area,status,crewing,well_name,customer:customers(name)")
    .eq("id", req.params.id)
    .single();
  if (!job || (scope && job.area !== scope)) {
    res.status(404).json({ message: "Job not found" });
    return null;
  }
  return job as any;
}

async function loadDraft(jobId: string, wk: string): Promise<{ draft: TicketPreviewDraft | null; ready: boolean; by: string | null; at: string | null }> {
  const { data, error } = await db()
    .from("ticket_preview_drafts")
    .select("*")
    .eq("job_id", jobId)
    .eq("well_key", wk)
    .maybeSingle();
  if (error) return { draft: null, ready: !missingTable(error.message), by: null, at: null };
  if (!data) return { draft: null, ready: true, by: null, at: null };
  return {
    draft: {
      header: data.header || {},
      overrides: data.overrides || {},
      extra_lines: Array.isArray(data.extra_lines) ? data.extra_lines : [],
    },
    ready: true,
    by: data.updated_by_name ?? null,
    at: data.updated_at ?? null,
  };
}

export async function buildTicketPreview(
  job: any,
  wellParam: string | null,
  canEdit: boolean,
  // Testing aid: cost breakdowns to use in place of what's stored.
  costOverride?: Map<string, CostLine[]>,
  // Testing aid: standby days (date -> rate) to use in place of what's stored.
  standbyOverride?: Map<string, number>,
): Promise<TicketPreview> {
  const [{ data: reports }, { data: tickets }, { data: services }, standbyMap] = await Promise.all([
    db()
      .from("daily_reports")
      .select("id,report_day,report_date,well_name,status,kpis,well_context,analysis,created_at")
      .eq("job_id", job.id),
    db()
      .from("field_tickets")
      .select("ticket_number,ticket_date,well_name,county,po_afe,ordered_by,line_items,created_at")
      .eq("job_id", job.id)
      .order("created_at", { ascending: false }),
    db().from("job_services").select("*").eq("job_id", job.id).order("service_date", { ascending: true }),
    standbyByJob([job.id]),
  ]);
  const standbyByDay: Map<string, number> = standbyOverride ?? standbyMap.get(job.id)?.byDay ?? new Map();
  const standbyActive = standbyMap.get(job.id)?.active ?? false;

  if (costOverride)
    for (const r of (reports || []) as any[])
      if (costOverride.has(r.id)) r.well_context = { ...(r.well_context || {}), cost_lines: costOverride.get(r.id) };
  // One report per well + date: prefer signed off, then the newest.
  const best = new Map<string, any>();
  for (const r of (reports || []) as any[]) {
    if (r.analysis?.correction_of) continue; // a correction waiting on the original
    if (r.status === "Needs job match") continue;
    const date = String(r.report_date ?? "").slice(0, 10);
    const well = String(r.well_name ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !well) continue;
    const k = `${wellKey(well)}|${date}`;
    const cur = best.get(k);
    const rank = (x: any) => STATUS_RANK[x.status] ?? 0;
    if (!cur || rank(r) > rank(cur) || (rank(r) === rank(cur) && String(r.created_at) > String(cur.created_at)))
      best.set(k, r);
  }

  // Days covered by real ticket lines (not service-charge lines), per well.
  const covered = new Map<string, Map<string, number>>(); // wk -> date -> ticket #
  // Standby days on any ticket on the job (a "Standby" section or a line
  // that says standby), whatever well it was written to.
  const standbyCovered = new Map<string, number>(); // date -> ticket #
  const isStandbyLine = (l: LineItem) => /standby/i.test(String(l.section ?? "")) || /^\s*standby\b/i.test(String(l.description ?? ""));
  for (const t of (tickets || []) as any[]) {
    for (const l of (Array.isArray(t.line_items) ? t.line_items : []) as LineItem[]) {
      if (!l.start_date || l.service_id) continue;
      if (isStandbyLine(l)) {
        const end = l.end_date && l.end_date > l.start_date ? l.end_date : l.start_date;
        for (let d = l.start_date; d <= end; d = addDays(d, 1)) if (!standbyCovered.has(d)) standbyCovered.set(d, t.ticket_number);
        continue;
      }
      const wk = wellKey(l.well_name || t.well_name);
      if (!wk) continue;
      const end = l.end_date && l.end_date > l.start_date ? l.end_date : l.start_date;
      const m = covered.get(wk) || new Map<string, number>();
      for (let d = l.start_date; d <= end; d = addDays(d, 1)) if (!m.has(d)) m.set(d, t.ticket_number);
      covered.set(wk, m);
    }
  }

  // Wells on the job and how many un-ticketed report days each has.
  const wells = new Map<string, { well_name: string; open_days: number; last_date: string; total_days: number }>();
  best.forEach((r, k) => {
    const [wk, date] = k.split("|");
    const w = wells.get(wk) || { well_name: String(r.well_name).trim(), open_days: 0, last_date: "", total_days: 0 };
    w.total_days += 1;
    if (!covered.get(wk)?.has(date)) w.open_days += 1;
    if (date > w.last_date) w.last_date = date;
    wells.set(wk, w);
  });

  // Standby days -> well: the well with the latest report before the day,
  // else the first well after it, else the job (no reports at all).
  const reportDates = new Map<string, string[]>(); // wk -> sorted dates
  best.forEach((_r, k) => {
    const [w, date] = k.split("|");
    const arr = reportDates.get(w) || [];
    arr.push(date);
    reportDates.set(w, arr);
  });
  const standbyWell = (d: string): string => {
    let before: { wk: string; date: string } | null = null;
    let after: { wk: string; date: string } | null = null;
    reportDates.forEach((dates, w) => {
      for (const x of dates) {
        if (x < d && (!before || x > before.date)) before = { wk: w, date: x };
        if (x > d && (!after || x < after.date)) after = { wk: w, date: x };
      }
    });
    return (before as any)?.wk ?? (after as any)?.wk ?? "";
  };
  const jobWellName = String(job.well_name ?? "").trim() || "Standby";
  const standbyDays: { date: string; rate: number; wk: string; on_ticket: number | null }[] = [];
  Array.from(standbyByDay.keys())
    .sort()
    .forEach((date) => {
      let w = standbyWell(date);
      if (!w) {
        w = wellKey(jobWellName);
        if (!wells.has(w)) wells.set(w, { well_name: jobWellName, open_days: 0, last_date: "", total_days: 0 });
      }
      const on = standbyCovered.get(date) ?? null;
      standbyDays.push({ date, rate: standbyByDay.get(date)!, wk: w, on_ticket: on });
      const rec = wells.get(w)!;
      if (on == null) rec.open_days += 1;
      if (date > rec.last_date) rec.last_date = date;
    });

  const wellList = Array.from(wells.entries())
    .map(([wk, w]) => ({ key: wk, ...w }))
    .sort((a, b) => (a.last_date < b.last_date ? 1 : -1));

  // Which well: the one asked for, else the most recent well with open days.
  let wk = wellParam ? wellKey(wellParam) : "";
  if (!wk || !wells.has(wk)) wk = (wellList.find((w) => w.open_days > 0) || wellList[0])?.key ?? "";
  const wellName = wk ? wells.get(wk)!.well_name : "";
  const coveredHere = covered.get(wk) || new Map<string, number>();

  // Every report day on this well (for the running-total check), and the open ones.
  const allDays: any[] = [];
  best.forEach((r, k) => {
    if (k.startsWith(wk + "|")) allDays.push(r);
  });
  allDays.sort((a, b) => (a.report_date < b.report_date ? -1 : 1));
  const standbyHere = standbyDays.filter((s) => s.wk === wk);
  const lastTicketed =
    [...Array.from(coveredHere.keys()), ...standbyHere.filter((s) => s.on_ticket != null).map((s) => s.date)].sort().pop() ?? null;

  const days: TicketPreviewDay[] = [];
  for (const r of allDays) {
    const date = String(r.report_date).slice(0, 10);
    const cost = (Array.isArray(r.well_context?.cost_lines) ? r.well_context.cost_lines : null) as CostLine[] | null;
    const dayCost = num(r.kpis?.day_rate);
    const pkg = cost ? round2(cost.filter((c) => c.kind === "package").reduce((s, c) => s + (Number(c.amount) || 0), 0)) : dayCost;
    days.push({
      report_id: r.id,
      report_day: r.report_day ?? null,
      date,
      status: r.status,
      day_cost: dayCost,
      cumulative: num(r.kpis?.accrued_current_well),
      package_cost: pkg,
      has_breakdown: !!cost,
      on_ticket: coveredHere.get(date) ?? null,
    });
  }
  const open = days.filter((d) => d.on_ticket == null);

  // ---- Lines -------------------------------------------------------------
  const lines: TicketPreviewLine[] = [];
  const reportById = new Map<string, any>(allDays.map((r) => [r.id, r]));
  const pkgName = (cost: CostLine[] | null) => {
    const names = (cost || []).filter((c) => c.kind === "package" && c.amount > 0).map((c) => c.label);
    if (names.some((n) => /closed\s*loop/i.test(n))) return "Closed Loop Package";
    if (names.some((n) => /centrifuge/i.test(n))) return "Centrifuge Package";
    return job.crewing === "Manned" ? "Closed Loop Package" : "Centrifuge Package";
  };
  // Package runs: consecutive open days at the same package cost.
  let run: { start: string; end: string; rate: number; days: number; cost: CostLine[] | null } | null = null;
  const flush = () => {
    if (!run) return;
    const breakdown = (run.cost || [])
      .filter((c) => c.kind === "package" && c.amount > 0)
      .map((c) => ({ label: c.label, amount: c.amount }));
    lines.push({
      key: `pkg:${run.start}`,
      kind: "package",
      description: pkgName(run.cost),
      dates_label: range(run.start, run.end),
      start_date: run.start,
      end_date: run.end,
      quantity: run.days,
      unit_cost: run.rate,
      total: round2(run.days * run.rate),
      breakdown,
      notes: [],
      edited: false,
      hidden: false,
      service_ids: [],
    });
    run = null;
  };
  const zeroDays = open.filter((d) => !(Number(d.package_cost) > 0));
  for (const d of open) {
    const rate = d.package_cost ?? 0;
    if (!(rate > 0)) {
      flush(); // a $0 day isn't billed; it breaks the run
      continue;
    }
    const cost = (reportById.get(d.report_id)?.well_context?.cost_lines ?? null) as CostLine[] | null;
    if (run && rate === run.rate) {
      run.end = d.date;
      run.days += 1;
    } else {
      flush();
      run = { start: d.date, end: d.date, rate, days: 1, cost };
    }
  }
  flush();

  // Extra charges: one line per label, dated counts underneath.
  const extras = new Map<string, { label: string; unit: number | null; entries: { date: string; amount: number }[] }>();
  for (const d of open) {
    const cost = (reportById.get(d.report_id)?.well_context?.cost_lines ?? []) as CostLine[];
    for (const c of cost) {
      if (c.kind !== "extra" || !(Number(c.amount) > 0)) continue;
      const e = extras.get(c.label) || { label: c.label, unit: c.unit_price ?? null, entries: [] };
      e.entries.push({ date: d.date, amount: Number(c.amount) });
      if (!e.unit && c.unit_price) e.unit = c.unit_price;
      extras.set(c.label, e);
    }
  }
  extras.forEach((e) => {
    const total = round2(e.entries.reduce((s, x) => s + x.amount, 0));
    // No unit price but every day at the same charge (e.g. Driveby/Call-out
    // $700): count the days at that charge.
    if (!e.unit && e.entries.every((x) => x.amount === e.entries[0].amount)) e.unit = e.entries[0].amount;
    const countable = e.unit && e.entries.every((x) => Math.abs(x.amount / e.unit! - Math.round(x.amount / e.unit!)) < 1e-6);
    const perDay = e.entries.every((x) => x.amount === e.unit);
    const unitWord = /screen/i.test(e.label) ? "screens" : /trucking|disposal/i.test(e.label) ? "loads" : "";
    const notes = e.entries.map((x) =>
      countable && perDay && !unitWord ? `${md(x.date)}` : countable ? `${md(x.date)} – ${Math.round(x.amount / e.unit!)}${unitWord ? " " + unitWord : ""}` : `${md(x.date)} – $${x.amount.toLocaleString("en-US")}`,
    );
    const first = e.entries[0].date;
    const last = e.entries[e.entries.length - 1].date;
    lines.push({
      key: `extra:${e.label}`,
      kind: "extra",
      description: e.label.trim(),
      dates_label: null,
      start_date: first,
      end_date: last,
      quantity: countable ? Math.round(total / e.unit!) : 1,
      unit_cost: countable ? e.unit! : total,
      total,
      breakdown: [],
      notes,
      edited: false,
      hidden: false,
      service_ids: [],
    });
  });

  // Standby: one line per run of consecutive open standby days at one rate.
  const openStandby = standbyHere.filter((s) => s.on_ticket == null && s.rate > 0);
  let sRun: { start: string; end: string; rate: number; days: number } | null = null;
  const flushStandby = () => {
    if (!sRun) return;
    lines.push({
      key: `standby:${sRun.start}`,
      kind: "standby",
      description: "Standby",
      dates_label: range(sRun.start, sRun.end),
      start_date: sRun.start,
      end_date: sRun.end,
      quantity: sRun.days,
      unit_cost: sRun.rate,
      total: round2(sRun.days * sRun.rate),
      breakdown: [],
      notes: ["Equipment on location, no crew"],
      edited: false,
      hidden: false,
      service_ids: [],
    });
    sRun = null;
  };
  for (const s of openStandby) {
    if (sRun && s.rate === sRun.rate && addDays(sRun.end, 1) === s.date) {
      sRun.end = s.date;
      sRun.days += 1;
    } else {
      flushStandby();
      sRun = { start: s.date, end: s.date, rate: s.rate, days: 1 };
    }
  }
  flushStandby();
  // Keep the ticket in date order: package and standby runs by start date.
  {
    const dated = lines.filter((l) => l.kind === "package" || l.kind === "standby");
    const rest = lines.filter((l) => l.kind !== "package" && l.kind !== "standby");
    dated.sort((a, b) => (String(a.start_date) < String(b.start_date) ? -1 : 1));
    lines.splice(0, lines.length, ...dated, ...rest);
  }

  // Service charges on this well (or with no well) not yet on a ticket, on or
  // after the last ticketed day.
  const billed = new Set<string>();
  for (const t of (tickets || []) as any[])
    for (const l of (Array.isArray(t.line_items) ? t.line_items : []) as LineItem[]) if (l.service_id) billed.add(l.service_id);
  const svcByType = new Map<string, any[]>();
  for (const s of (services || []) as any[]) {
    if (billed.has(s.id)) continue;
    if (s.well_name && wellKey(s.well_name) !== wk) continue;
    if (lastTicketed && s.service_date <= lastTicketed) continue;
    const arr = svcByType.get(s.service_type) || [];
    arr.push(s);
    svcByType.set(s.service_type, arr);
  }
  svcByType.forEach((arr, type) => {
    const rates = Array.from(new Set(arr.map((s) => Number(s.cost) || 0)));
    const total = round2(arr.reduce((s, x) => s + (Number(x.cost) || 0), 0));
    const same = rates.length === 1;
    lines.push({
      key: `svc:${type}`,
      kind: "service",
      description: type === "Drive-by Service" ? "Drive by Service" : type,
      dates_label: null,
      start_date: arr[0].service_date,
      end_date: arr[arr.length - 1].service_date,
      quantity: same ? arr.length : 1,
      unit_cost: same ? rates[0] : total,
      total,
      breakdown: [],
      notes: arr.map((s) => `${md(s.service_date)} – ${String(s.notes || "Service").split(/\r?\n/)[0].slice(0, 60)}${same ? "" : ` ($${(Number(s.cost) || 0).toLocaleString("en-US")})`}`),
      edited: false,
      hidden: false,
      service_ids: arr.map((s) => s.id),
      service_costs: arr.map((s) => Number(s.cost) || 0),
    });
  });

  // ---- Draft edits -------------------------------------------------------
  const { draft, ready, by, at } = wk ? await loadDraft(job.id, wk) : { draft: null, ready: true, by: null, at: null };
  for (const l of lines) {
    const o = draft?.overrides?.[l.key];
    if (!o) continue;
    if (o.description != null && o.description.trim()) l.description = o.description.trim();
    if (o.quantity != null) l.quantity = o.quantity;
    if (o.unit_cost != null) l.unit_cost = o.unit_cost;
    if (o.hidden) l.hidden = true;
    l.total = round2(l.quantity * l.unit_cost);
    l.edited = true;
  }
  for (const x of draft?.extra_lines ?? []) {
    lines.push({
      key: `user:${x.id}`,
      kind: "user",
      description: x.description,
      dates_label: null,
      start_date: x.date || [...open.map((d) => d.date), ...openStandby.map((s) => s.date)].sort().pop() || todayCentral(),
      end_date: null,
      quantity: x.quantity,
      unit_cost: x.unit_cost,
      total: round2(x.quantity * x.unit_cost),
      breakdown: [],
      notes: x.note ? [x.note] : [],
      edited: true,
      hidden: false,
      service_ids: [],
      user_id: x.id,
      user_date: x.date ?? null,
    });
  }
  const total = round2(lines.filter((l) => !l.hidden).reduce((s, l) => s + l.total, 0));

  // ---- Checks ------------------------------------------------------------
  const flags: string[] = [];
  const allSum = round2(days.reduce((s, d) => s + (d.day_cost ?? 0), 0));
  const lastCum = [...days].reverse().find((d) => d.cumulative != null)?.cumulative ?? null;
  if (lastCum != null && Math.abs(lastCum - allSum) > 0.5) {
    const diff = round2(lastCum - allSum);
    flags.push(
      diff > 0
        ? `The report's running total ($${lastCum.toLocaleString("en-US")}) is $${diff.toLocaleString("en-US")} more than the report days in DFS Ops add up to. A report day may be missing or out of date.`
        : `The report days in DFS Ops add up to $${(-diff).toLocaleString("en-US")} more than the report's running total ($${lastCum.toLocaleString("en-US")}). A day may be counted twice or out of date.`,
    );
  }
  // Gaps between open days.
  for (let i = 1; i < days.length; i++) {
    const from = addDays(days[i - 1].date, 1);
    const to = addDays(days[i].date, -1);
    if (!(from <= to && days[i].on_ticket == null)) continue;
    // Standby days fill a gap; only flag the days that are neither.
    let gs: string | null = null;
    for (let d = from; d <= addDays(to, 1); d = addDays(d, 1)) {
      const hole = d <= to && !standbyByDay.has(d);
      if (hole && !gs) gs = d;
      if (!hole && gs) {
        const ge = addDays(d, -1);
        flags.push(`No report in DFS Ops for ${gs === ge ? md(gs) : `${md(gs)} – ${md(ge)}`}.`);
        gs = null;
      }
    }
  }
  if (openStandby.length && standbyActive && openStandby[openStandby.length - 1].date === todayCentral())
    flags.push(`The job is still on standby, so the standby line counts through today (${md(todayCentral())}).`);
  const zeroStandby = standbyHere.filter((s) => s.on_ticket == null && !(s.rate > 0));
  if (zeroStandby.length)
    flags.push(`${zeroStandby.length} standby day${zeroStandby.length === 1 ? " has" : "s have"} a $0 rate and ${zeroStandby.length === 1 ? "is" : "are"} left off the ticket.`);
  if (zeroDays.length)
    flags.push(
      `${zeroDays.length} day${zeroDays.length === 1 ? " has" : "s have"} a $0 day cost and ${zeroDays.length === 1 ? "is" : "are"} left off the ticket (${zeroDays.slice(0, 6).map((d) => md(d.date)).join(", ")}${zeroDays.length > 6 ? ", …" : ""}).`,
    );
  const pending = open.filter((d) => d.status !== "Signed off");
  if (pending.length)
    flags.push(`${pending.length} day${pending.length === 1 ? "" : "s"} not signed off yet (${pending.map((d) => md(d.date)).join(", ")}).`);
  if (open.some((d) => !d.has_breakdown))
    flags.push(
      "Some days don't have the equipment breakdown yet, so they use the day cost as the package rate. An Admin can fill it in with Refresh KPIs on the Daily Reports page.",
    );

  // ---- Header ------------------------------------------------------------
  const lastTicket = ((tickets || []) as any[]).find((t) => wellKey(t.well_name).includes(wk)) || (tickets || [])[0] || null;
  const header = {
    customer: job.customer?.name ?? "",
    address: "",
    city_state_zip: "",
    county: lastTicket?.county ?? "",
    well_name: wellName,
    date: todayCentral(),
    ordered_by: lastTicket?.ordered_by ?? "",
    po_afe: lastTicket?.po_afe ?? "",
    job_no: job.job_number,
    ticket_type: "delivery" as const,
    comments: lastTicket?.po_afe ? `PO# ${lastTicket.po_afe}` : "",
    ...(draft?.header || {}),
  };

  return {
    job_id: job.id,
    job_number: job.job_number,
    job_status: job.status,
    wells: wellList.map(({ key, well_name, open_days, last_date }) => ({ key, well_name, open_days, last_date })),
    well_key: wk,
    well_name: wellName,
    last_ticketed_date: lastTicketed,
    header,
    days,
    standby: standbyHere.map(({ date, rate, on_ticket }) => ({ date, rate, on_ticket })) as TicketPreviewStandbyDay[],
    lines,
    total,
    flags,
    can_edit: canEdit,
    drafts_ready: ready,
    draft_saved_by: by,
    draft_saved_at: at,
  };
}

export function registerTicketPreviewRoutes(app: Express) {
  app.get("/api/jobs/:id/ticket-preview", requireAuth, requireRole(...VIEW), async (req, res) => {
    const job = await loadJob(req, res);
    if (!job) return;
    try {
      const canEdit = (MANAGE as readonly string[]).includes(req.profile!.role);
      res.json(await buildTicketPreview(job, req.query.well ? String(req.query.well) : null, canEdit));
    } catch (e: any) {
      res.status(500).json({ message: e?.message ?? String(e) });
    }
  });

  // Save edits for one well (Admin / Area Manager).
  app.put("/api/jobs/:id/ticket-preview", requireAuth, requireRole(...MANAGE), async (req, res) => {
    const job = await loadJob(req, res);
    if (!job) return;
    const parsed = ticketPreviewDraftSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.errors[0].message });
    const p = parsed.data;
    const wk = wellKey(p.well_name);
    if (!wk) return res.status(400).json({ message: "Pick a well." });
    const { error } = await db()
      .from("ticket_preview_drafts")
      .upsert(
        {
          job_id: job.id,
          well_key: wk,
          well_name: p.well_name,
          header: p.header ?? {},
          overrides: p.overrides ?? {},
          extra_lines: p.extra_lines ?? [],
          updated_by: req.profile!.id,
          updated_by_name: req.profile!.name ?? null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "job_id,well_key" },
      );
    if (error) return res.status(400).json({ message: missingTable(error.message) ? DRAFT_SQL_HINT : error.message });
    res.json(await buildTicketPreview(job, p.well_name, true));
  });

  // Reset to the reports (drops the saved edits for the well). Also used after
  // the preview is turned into a real ticket.
  app.delete("/api/jobs/:id/ticket-preview", requireAuth, requireRole(...MANAGE), async (req, res) => {
    const job = await loadJob(req, res);
    if (!job) return;
    const wk = wellKey(String(req.query.well ?? ""));
    if (!wk) return res.status(400).json({ message: "Pick a well." });
    const { error } = await db().from("ticket_preview_drafts").delete().eq("job_id", job.id).eq("well_key", wk);
    if (error && !missingTable(error.message)) return res.status(400).json({ message: error.message });
    res.json(await buildTicketPreview(job, String(req.query.well), true));
  });
}
