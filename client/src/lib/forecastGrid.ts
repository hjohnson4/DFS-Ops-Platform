import type { ForecastBoard, ForecastJob } from "@shared/schema";

// View level: 0 = committed only, 1 = + likely, 2 = + bids.
export type ForecastLevel = 0 | 1 | 2;
export type PieceKind = "act" | "awd" | "lik" | "bid" | "shop" | "idle" | "conflict";

export interface Piece {
  kind: PieceKind;
  label: string;
  frac: number; // share of the month (0..1)
  tip: string;
}
export interface GridRow {
  asset: ForecastBoard["assets"][number];
  cells: Piece[][];
}
export interface NeedRow {
  forecast: ForecastJob;
  category: string;
  missing: number;
  cells: number[]; // share of each month the job runs
}
export interface CategoryBlock {
  category: string;
  rows: GridRow[];
  needs: NeedRow[];
  spare: number[];
  short: number[];
}

const DAY = 86400000;
const toMs = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const shortDate = (d: string | null) =>
  d
    ? new Date(toMs(d)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
    : "";
export const monthLabel = (ym: string) =>
  new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7) - 1, 1)).toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

function monthRange(ym: string): [number, number, number] {
  const s = Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7) - 1, 1);
  const e = Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0);
  return [s, e, Math.round((e - s) / DAY) + 1];
}

export function stageKind(stage: string): PieceKind {
  if (stage === "Likely") return "lik";
  if (stage === "Bid") return "bid";
  return "awd";
}
export function visibleAt(stage: string, lvl: ForecastLevel) {
  if (stage === "Likely") return lvl >= 1;
  if (stage === "Bid") return lvl >= 2;
  return true; // Awarded / Converted
}

interface Seg {
  id: string;
  kind: PieceKind;
  label: string;
  s: number;
  e: number;
  tip: string;
}

const SHOP_RE = /shop|repair|down|out of service/i;

export function buildGrid(board: ForecastBoard, lvl: ForecastLevel, categories: readonly string[]): CategoryBlock[] {
  const ws = toMs(board.window_start);
  const we = toMs(board.window_end);
  const jobs = new Map(board.jobs.map((j) => [j.id, j]));
  const assetsById = new Map(board.assets.map((a) => [a.id, a]));
  const visibleForecasts = board.forecasts.filter((f) => visibleAt(f.stage, lvl));

  const segsFor = (a: ForecastBoard["assets"][number]): Seg[] => {
    const out: Seg[] = [];
    const j = a.job_id ? jobs.get(a.job_id) : undefined;
    if (j) {
      const s = Math.max(ws, j.started_on ? toMs(j.started_on) : ws);
      const e = j.est_release_on ? Math.min(we, toMs(j.est_release_on)) : we;
      if (e >= s)
        out.push({
          id: "j" + j.id,
          kind: "act",
          label: j.job_number + (j.est_release_on ? "" : " ∞"),
          s,
          e,
          tip: `${j.job_number}${j.customer_name ? " · " + j.customer_name : ""} — ${
            j.est_release_on ? "est. release " + shortDate(j.est_release_on) : "indefinite"
          }`,
        });
    }
    for (const f of visibleForecasts) {
      if (!(f.asset_ids || []).includes(a.id)) continue;
      if (f.stage === "Converted" && a.job_id && a.job_id === f.converted_job_id) continue;
      const s = Math.max(ws, toMs(f.start_on));
      const e = f.end_on ? Math.min(we, toMs(f.end_on)) : we;
      if (e < s) continue;
      out.push({
        id: "f" + f.id,
        kind: stageKind(f.stage),
        label: f.rig + (f.end_on ? "" : " ∞"),
        s,
        e,
        tip: `${f.rig} (${f.stage === "Converted" ? "job created" : f.stage + " " + f.odds + "%"}) — ${shortDate(
          f.start_on,
        )} → ${f.end_on ? shortDate(f.end_on) : "indefinite"}`,
      });
    }
    if (!a.job_id && SHOP_RE.test(a.status || ""))
      out.push({ id: "shop", kind: "shop", label: "In shop", s: ws, e: we, tip: `Status: ${a.status}` });
    return out;
  };

  const cellsFor = (segs: Seg[]): Piece[][] =>
    board.months.map((ym) => {
      const [ms, , dim] = monthRange(ym);
      const pieces: Piece[] = [];
      let prevKey = "";
      for (let d = 0; d < dim; d++) {
        const t = ms + d * DAY;
        let on = segs.filter((g) => g.s <= t && t <= g.e);
        // "In shop" only shows when nothing else is planned that day.
        if (on.length > 1) on = on.filter((g) => g.kind !== "shop");
        const key = on.map((g) => g.id).join("|");
        if (key === prevKey && pieces.length) {
          pieces[pieces.length - 1].frac += 1 / dim;
          continue;
        }
        prevKey = key;
        if (!on.length) pieces.push({ kind: "idle", label: "—", frac: 1 / dim, tip: "Spare" });
        else if (on.length === 1)
          pieces.push({ kind: on[0].kind, label: on[0].label, frac: 1 / dim, tip: on[0].tip });
        else
          pieces.push({
            kind: "conflict",
            label: on.map((g) => g.label.replace(" ∞", "")).join(" + "),
            frac: 1 / dim,
            tip: "Double-booked: " + on.map((g) => g.tip).join(" | "),
          });
      }
      return pieces;
    });

  return categories.map((category) => {
    const rows = board.assets
      .filter((a) => a.category === category)
      .map((a) => ({ asset: a, cells: cellsFor(segsFor(a)) }));

    const needs: NeedRow[] = [];
    for (const f of visibleForecasts) {
      if (f.stage === "Converted") continue;
      const needed = category === "Big Bowl Centrifuge" ? f.big_bowl_needed : f.small_bowl_needed;
      const placed = (f.asset_ids || []).filter((id) => assetsById.get(id)?.category === category).length;
      const missing = needed - placed;
      if (missing <= 0) continue;
      const s = Math.max(ws, toMs(f.start_on));
      const e = f.end_on ? Math.min(we, toMs(f.end_on)) : we;
      needs.push({
        forecast: f,
        category,
        missing,
        cells: board.months.map((ym) => {
          const [ms, me, dim] = monthRange(ym);
          const a = Math.max(ms, s);
          const b = Math.min(me, e);
          return b >= a ? (Math.round((b - a) / DAY) + 1) / dim : 0;
        }),
      });
    }

    const spare = board.months.map((_, i) =>
      rows.filter((r) => r.cells[i].every((p) => p.kind === "idle")).length,
    );
    const short = board.months.map((_, i) => {
      const toPlace = needs.reduce((n, r) => n + (r.cells[i] > 0 ? r.missing : 0), 0);
      return Math.max(0, toPlace - spare[i]);
    });
    return { category, rows, needs, spare, short };
  });
}

// Revenue by month: committed = active jobs + awarded forecasts;
// weighted adds likely/bid at their odds. Rates come from the job's stored
// day rate / the forecast's day rate; anything without a rate is skipped.
export function revenueByMonth(board: ForecastBoard) {
  const ws = toMs(board.window_start);
  const we = toMs(board.window_end);
  const overlapDays = (ym: string, s: number, e: number) => {
    const [ms, me] = monthRange(ym);
    const a = Math.max(ms, s);
    const b = Math.min(me, e);
    return b >= a ? Math.round((b - a) / DAY) + 1 : 0;
  };
  let noRate = 0;
  const rows = board.months.map((ym) => ({ month: ym, committed: 0, weighted: 0 }));
  for (const j of board.jobs) {
    if (j.day_rate == null) {
      noRate++;
      continue;
    }
    const s = Math.max(ws, j.started_on ? toMs(j.started_on) : ws);
    const e = j.est_release_on ? toMs(j.est_release_on) : we;
    rows.forEach((r) => {
      const v = overlapDays(r.month, s, e) * j.day_rate!;
      r.committed += v;
      r.weighted += v;
    });
  }
  for (const f of board.forecasts) {
    if (f.stage === "Converted") continue;
    if (f.day_rate == null) {
      noRate++;
      continue;
    }
    const s = toMs(f.start_on);
    const e = f.end_on ? toMs(f.end_on) : we;
    rows.forEach((r) => {
      const v = overlapDays(r.month, s, e) * f.day_rate!;
      if (f.stage === "Awarded") r.committed += v;
      r.weighted += (v * f.odds) / 100;
    });
  }
  return { rows, noRate };
}

export const todayIso = () => fmt(Date.now());
