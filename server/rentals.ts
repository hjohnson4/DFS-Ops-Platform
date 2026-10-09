// Rental centrifuges: units DFS rents from a third party and puts to work.
//
// Cost   = the monthly rental rate, prorated by day (rate / days in that
//          month) for every day from received (rental_start) through returned
//          (rental_end) or today, plus any one-time charges (delivery, pickup…).
// Earned = the asset's own day rate x each day it was on a job, from the
//          asset_job_stints history (kept by a database trigger). A day counts
//          once even if the unit moved between jobs that day; the rate is the
//          one saved on the most recent job record for that day. Only days
//          inside the rental period count.
import type { Express, Request, Response } from "express";
import { supabaseAnon, supabaseAdmin } from "./supabase";
import { requireAuth, requireRole, areaScopeOf } from "./auth";
import { todayCentral } from "./manualBilling";
import { createRentalChargeSchema, type RentalSummary } from "@shared/schema";

const db = () => supabaseAdmin || supabaseAnon;

// Who may see rental cost and profit.
export const RENTAL_MONEY_ROLES = ["admin", "area"];
export const canSeeRentalMoney = (role?: string | null) => !!role && RENTAL_MONEY_ROLES.includes(role);

// Columns only Admins / Area Managers may see.
const MONEY_FIELDS = ["rental_monthly_rate", "rental_notes"];
export function stripRentalMoney<T extends Record<string, any>>(row: T, role?: string | null): T {
  if (!row || canSeeRentalMoney(role)) return row;
  const out: any = { ...row };
  MONEY_FIELDS.forEach((k) => delete out[k]);
  return out;
}

function addDays(iso: string, n: number): string {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function daysInMonth(iso: string): number {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
const num = (v: any): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const round2 = (n: number) => Math.round(n * 100) / 100;

type Stint = { job_id: string | null; day_rate: any; start_date: string; end_date: string | null; created_at?: string };
type Charge = { amount: any; charge_date: string };

export function computeRental(
  asset: { rental_monthly_rate: any; rental_start: string | null; rental_end: string | null },
  stints: Stint[],
  charges: Charge[],
  today = todayCentral(),
): RentalSummary {
  const start = asset.rental_start;
  const monthly = num(asset.rental_monthly_rate);
  const one_time = round2(charges.reduce((s, c) => s + (num(c.amount) ?? 0), 0));
  if (!start) {
    return {
      through: null,
      days_on_rent: 0,
      days_on_job: 0,
      days_missing_rate: 0,
      rent_cost: 0,
      one_time_charges: one_time,
      total_cost: one_time,
      earned: 0,
      profit: round2(-one_time),
      on_rent: false,
      monthly_rate: monthly,
    };
  }
  const end = asset.rental_end && asset.rental_end < today ? asset.rental_end : today;
  // Newest record first, so the first match for a day is the latest one.
  const sorted = [...stints].sort(
    (a, b) => b.start_date.localeCompare(a.start_date) || String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")),
  );
  let days = 0;
  let onJob = 0;
  let missing = 0;
  let rent = 0;
  let earned = 0;
  for (let d = start; d <= end; d = addDays(d, 1)) {
    days++;
    if (monthly != null) rent += monthly / daysInMonth(d);
    const s = sorted.find((x) => x.job_id && x.start_date <= d && (x.end_date == null || x.end_date >= d));
    if (s) {
      onJob++;
      const r = num(s.day_rate);
      if (r == null) missing++;
      else earned += r;
    }
    if (days > 3660) break; // safety: 10 years
  }
  rent = round2(rent);
  earned = round2(earned);
  const total = round2(rent + one_time);
  return {
    through: end < start ? null : end,
    days_on_rent: end < start ? 0 : days,
    days_on_job: onJob,
    days_missing_rate: missing,
    rent_cost: rent,
    one_time_charges: one_time,
    total_cost: total,
    earned,
    profit: round2(earned - total),
    on_rent: !asset.rental_end || asset.rental_end >= today,
    monthly_rate: monthly,
  };
}

const missingSetup = (msg?: string) =>
  !!msg && /rental_|asset_job_stints|is_rental/.test(msg) && /does not exist|schema cache|column/i.test(msg);
const SETUP_MSG =
  "Rental tracking isn't set up yet. Run the rental centrifuges SQL in the Supabase SQL editor, then refresh.";

async function loadRentalBits(assetIds: string[]) {
  if (!assetIds.length) return { stints: new Map<string, any[]>(), charges: new Map<string, any[]>() };
  const client = db();
  const [{ data: st }, { data: ch }] = await Promise.all([
    client
      .from("asset_job_stints")
      .select("id, asset_id, job_id, day_rate, start_date, end_date, created_at, job:jobs(job_number)")
      .in("asset_id", assetIds),
    client
      .from("rental_charges")
      .select("id, asset_id, charge_date, description, amount, created_by_name, created_at")
      .in("asset_id", assetIds)
      .order("charge_date", { ascending: true }),
  ]);
  const stints = new Map<string, any[]>();
  (st || []).forEach((s: any) => stints.set(s.asset_id, [...(stints.get(s.asset_id) || []), s]));
  const charges = new Map<string, any[]>();
  (ch || []).forEach((c: any) => charges.set(c.asset_id, [...(charges.get(c.asset_id) || []), c]));
  return { stints, charges };
}

export function registerRentalRoutes(app: Express) {
  // All rental units with cost / earned / profit (Admins + Area Managers).
  app.get("/api/rentals", requireAuth, requireRole("admin", "area"), async (req: Request, res: Response) => {
    const scope = areaScopeOf(req.profile!);
    let q = db()
      .from("assets")
      .select(
        "id, tag, category, area, status, job_id, day_rate, is_rental, rental_vendor, rental_ref, rental_monthly_rate, rental_start, rental_end, rental_notes, job:jobs(id, job_number)",
      )
      .eq("is_rental", true)
      .order("tag", { ascending: true });
    if (scope) q = q.eq("area", scope);
    const { data, error } = await q;
    if (error) {
      if (missingSetup(error.message)) return res.status(409).json({ message: SETUP_MSG, setup_required: true });
      return res.status(500).json({ message: error.message });
    }
    const rows = data || [];
    const { stints, charges } = await loadRentalBits(rows.map((a: any) => a.id));
    const today = todayCentral();
    const out = rows.map((a: any) => ({
      ...a,
      rental: computeRental(a, stints.get(a.id) || [], charges.get(a.id) || [], today),
    }));
    const t = out.reduce(
      (s: any, a: any) => {
        s.total_cost += a.rental.total_cost;
        s.earned += a.rental.earned;
        s.profit += a.rental.profit;
        if (a.rental.on_rent) s.on_rent++;
        return s;
      },
      { total_cost: 0, earned: 0, profit: 0, on_rent: 0 },
    );
    res.json({
      today,
      rentals: out,
      totals: { total_cost: round2(t.total_cost), earned: round2(t.earned), profit: round2(t.profit), on_rent: t.on_rent, count: out.length },
    });
  });

  // One rental unit: summary, one-time charges and job history.
  app.get("/api/assets/:id/rental", requireAuth, requireRole("admin", "area"), async (req: Request, res: Response) => {
    const { data: a, error } = await db()
      .from("assets")
      .select("id, area, day_rate, is_rental, rental_monthly_rate, rental_start, rental_end")
      .eq("id", String(req.params.id))
      .maybeSingle();
    if (error) {
      if (missingSetup(error.message)) return res.status(409).json({ message: SETUP_MSG, setup_required: true });
      return res.status(500).json({ message: error.message });
    }
    if (!a) return res.status(404).json({ message: "Asset not found" });
    const scope = areaScopeOf(req.profile!);
    if (scope && (a as any).area !== scope) return res.status(404).json({ message: "Asset not found" });
    const { stints, charges } = await loadRentalBits([(a as any).id]);
    const st = stints.get((a as any).id) || [];
    const ch = charges.get((a as any).id) || [];
    res.json({
      summary: computeRental(a as any, st, ch),
      charges: ch,
      jobs: st
        .filter((s: any) => s.job_id)
        .sort((x: any, y: any) => y.start_date.localeCompare(x.start_date))
        .map((s: any) => ({
          job_id: s.job_id,
          job_number: s.job?.job_number ?? null,
          day_rate: num(s.day_rate),
          start_date: s.start_date,
          end_date: s.end_date,
        })),
    });
  });

  app.post(
    "/api/assets/:id/rental-charges",
    requireAuth,
    requireRole("admin", "area"),
    async (req: Request, res: Response) => {
      const parsed = createRentalChargeSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ message: parsed.error.errors[0].message });
      const { data: a } = await db().from("assets").select("id, area, is_rental").eq("id", String(req.params.id)).maybeSingle();
      if (!a) return res.status(404).json({ message: "Asset not found" });
      const scope = areaScopeOf(req.profile!);
      if (scope && (a as any).area !== scope) return res.status(403).json({ message: "Outside your area" });
      if (!(a as any).is_rental) return res.status(400).json({ message: "This asset isn't marked as a rental" });
      const { data, error } = await db()
        .from("rental_charges")
        .insert({
          asset_id: (a as any).id,
          charge_date: parsed.data.charge_date,
          description: parsed.data.description,
          amount: parsed.data.amount,
          created_by: req.profile!.id,
          created_by_name: req.profile!.name,
        })
        .select()
        .single();
      if (error) {
        if (missingSetup(error.message) || /rental_charges/.test(error.message))
          return res.status(409).json({ message: SETUP_MSG, setup_required: true });
        return res.status(400).json({ message: error.message });
      }
      res.status(201).json(data);
    },
  );

  app.delete("/api/rental-charges/:id", requireAuth, requireRole("admin", "area"), async (req: Request, res: Response) => {
    const { data: c } = await db()
      .from("rental_charges")
      .select("id, asset:assets(area)")
      .eq("id", String(req.params.id))
      .maybeSingle();
    if (!c) return res.status(404).json({ message: "Charge not found" });
    const scope = areaScopeOf(req.profile!);
    if (scope && (c as any).asset?.area !== scope) return res.status(403).json({ message: "Outside your area" });
    const { error } = await db().from("rental_charges").delete().eq("id", (c as any).id);
    if (error) return res.status(400).json({ message: error.message });
    res.status(204).end();
  });
}
