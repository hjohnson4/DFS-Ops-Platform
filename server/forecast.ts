import type { Express, Request, Response } from "express";
import { supabaseAnon, supabaseAdmin } from "./supabase";
import { requireAuth, requireRole, areaScopeOf } from "./auth";
import {
  AREAS,
  FORECAST_CATEGORIES,
  FORECAST_DEFAULT_ODDS,
  createForecastJobSchema,
  updateForecastJobSchema,
  setForecastUnitsSchema,
  convertForecastSchema,
  setJobReleaseSchema,
  uploadBidDocumentSchema,
} from "@shared/schema";

// Forecast: upcoming work + centrifuge planning.
// Tables (created by the SQL migration given to the user):
//   forecast_jobs, forecast_units (forecast_job_id, asset_id), jobs.est_release_on

const db = () => supabaseAdmin || supabaseAnon;

// Jobs in these statuses still hold their centrifuges on the forecast.
const LIVE_STATUSES = ["Active", "Rig Move"];

// Bid PDFs: the hosting service caps one request at ~4.5 MB, so keep each
// file to 3 MB (about 4 MB once encoded for upload).
export const BID_DOC_MAX_BYTES = 3 * 1024 * 1024;
const BID_DOC_COLS = "id, forecast_job_id, job_id, area, file_name, file_mime, file_size, uploaded_by_name, created_at";

// Today's date in Chicago (the business runs on Central time).
function chicagoToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

// Six months starting with the current month: ["2026-10", ..., "2027-03"].
export function forecastWindow(today = chicagoToday()) {
  let y = Number(today.slice(0, 4));
  let m = Number(today.slice(5, 7));
  const months: string[] = [];
  for (let i = 0; i < 6; i++) {
    months.push(`${y}-${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  const last = months[5];
  const lastDay = new Date(Date.UTC(Number(last.slice(0, 4)), Number(last.slice(5, 7)), 0)).getUTCDate();
  return { months, window_start: `${months[0]}-01`, window_end: `${last}-${String(lastDay).padStart(2, "0")}` };
}

const missingTable = (msg?: string) =>
  !!msg && /forecast_jobs|forecast_units|est_release_on|bid_documents/.test(msg) && /does not exist|schema cache|column/i.test(msg);
const SETUP_MSG =
  "The Forecast tables aren't set up yet. Run the Forecast SQL in the Supabase SQL editor, then refresh.";

async function loadForecast(id: string) {
  const { data } = await db().from("forecast_jobs").select("*").eq("id", id).maybeSingle();
  return data as any;
}

function canTouchArea(req: Request, area: string) {
  const scope = areaScopeOf(req.profile!);
  return !scope || scope === area;
}

export function registerForecastRoutes(app: Express) {
  // ---- Board -------------------------------------------------------------
  app.get(
    "/api/forecast",
    requireAuth,
    requireRole("admin", "area", "super"),
    async (req: Request, res: Response) => {
      const scope = areaScopeOf(req.profile!);
      const qArea = String(req.query.area || "");
      const area = scope || ((AREAS as readonly string[]).includes(qArea) ? qArea : null);
      const win = forecastWindow();
      const client = db();

      // Forecast jobs that touch the window (open stages + converted ones that
      // still have units waiting to move).
      let fq = client
        .from("forecast_jobs")
        .select("*, units:forecast_units(asset_id)")
        .in("stage", ["Bid", "Likely", "Awarded", "Converted"])
        .lte("start_on", win.window_end)
        .order("start_on", { ascending: true });
      if (area) fq = fq.eq("area", area);
      const { data: fRows, error: fErr } = await fq;
      if (fErr) {
        if (missingTable(fErr.message)) return res.status(409).json({ message: SETUP_MSG, setup_required: true });
        return res.status(500).json({ message: fErr.message });
      }
      const forecasts = (fRows || [])
        .filter((f: any) => !f.end_on || f.end_on >= win.window_start)
        .map((f: any) => ({
          ...f,
          day_rate: f.day_rate == null ? null : Number(f.day_rate),
          asset_ids: (f.units || []).map((u: any) => u.asset_id),
          units: undefined,
        }));
      // How many bid PDFs each upcoming job has (best effort: the table may
      // not exist yet on an older setup).
      if (forecasts.length) {
        const { data: dRows } = await client
          .from("bid_documents")
          .select("forecast_job_id")
          .in("forecast_job_id", forecasts.map((f: any) => f.id));
        const counts = new Map<string, number>();
        (dRows || []).forEach((d: any) => counts.set(d.forecast_job_id, (counts.get(d.forecast_job_id) || 0) + 1));
        forecasts.forEach((f: any) => (f.bid_doc_count = counts.get(f.id) || 0));
      }
      const plannedIds = new Set<string>();
      forecasts.forEach((f: any) => f.asset_ids.forEach((a: string) => plannedIds.add(a)));

      // Centrifuges in the area, plus any unit placed on a forecast here.
      let aq = client
        .from("assets")
        .select("id, tag, category, area, status, job_id")
        .in("category", FORECAST_CATEGORIES as unknown as string[]);
      if (area) aq = aq.eq("area", area);
      const { data: aRows, error: aErr } = await aq;
      if (aErr) return res.status(500).json({ message: aErr.message });
      const assets: any[] = [...(aRows || [])];
      const have = new Set(assets.map((a) => a.id));
      const extra = Array.from(plannedIds).filter((id) => !have.has(id));
      if (extra.length) {
        const { data: more } = await client
          .from("assets")
          .select("id, tag, category, area, status, job_id")
          .in("id", extra);
        (more || []).forEach((a: any) => assets.push(a));
      }
      // Asset-number order: compare the numeric part, then the full tag.
      const num = (t: string) => {
        const m = String(t).match(/(\d+)/);
        return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
      };
      assets.sort((a, b) => num(a.tag) - num(b.tag) || String(a.tag).localeCompare(String(b.tag)));

      // Active jobs: any job holding one of these units, plus jobs in the area.
      const jobIds = Array.from(new Set(assets.map((a) => a.job_id).filter(Boolean)));
      let jq = client
        .from("jobs")
        .select("id, job_number, area, status, started_on, est_release_on, day_rate, archived_at, customer:customers(name)")
        .is("archived_at", null)
        .in("status", LIVE_STATUSES);
      if (area) jq = jq.or(`area.eq."${area}"${jobIds.length ? `,id.in.(${jobIds.join(",")})` : ""}`);
      const { data: jRows, error: jErr } = await jq;
      if (jErr) {
        if (missingTable(jErr.message)) return res.status(409).json({ message: SETUP_MSG, setup_required: true });
        return res.status(500).json({ message: jErr.message });
      }
      const jobs = (jRows || []).map((j: any) => ({
        id: j.id,
        job_number: j.job_number,
        area: j.area,
        customer_name: j.customer?.name ?? "",
        started_on: j.started_on,
        est_release_on: j.est_release_on ?? null,
        day_rate: j.day_rate == null ? null : Number(j.day_rate),
      }));
      const activeIds = new Set(jobs.map((j) => j.id));
      // A unit on an archived / completed job counts as free.
      assets.forEach((a) => {
        if (a.job_id && !activeIds.has(a.job_id)) a.job_id = null;
      });

      res.json({ ...win, assets, jobs, forecasts });
    },
  );

  // ---- Forecast jobs CRUD ------------------------------------------------
  app.post(
    "/api/forecast-jobs",
    requireAuth,
    requireRole("admin", "area"),
    async (req: Request, res: Response) => {
      const parsed = createForecastJobSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ message: parsed.error.errors[0].message });
      const v = parsed.data;
      if (!canTouchArea(req, v.area))
        return res.status(403).json({ message: "You can only plan work in your area" });
      const { data, error } = await db()
        .from("forecast_jobs")
        .insert({
          rig: v.rig,
          customer_id: v.customer_id ?? null,
          customer_name: v.customer_name ?? null,
          area: v.area,
          stage: v.stage,
          odds: v.odds ?? FORECAST_DEFAULT_ODDS[v.stage],
          start_on: v.start_on,
          end_on: v.end_on ?? null,
          day_rate: v.day_rate ?? null,
          big_bowl_needed: v.big_bowl_needed,
          small_bowl_needed: v.small_bowl_needed,
          notes: v.notes ?? null,
          created_by: req.profile!.id,
          created_by_name: req.profile!.name,
        })
        .select()
        .single();
      if (error) {
        if (missingTable(error.message)) return res.status(409).json({ message: SETUP_MSG, setup_required: true });
        return res.status(400).json({ message: error.message });
      }
      res.status(201).json(data);
    },
  );

  app.patch(
    "/api/forecast-jobs/:id",
    requireAuth,
    requireRole("admin", "area"),
    async (req: Request, res: Response) => {
      const parsed = updateForecastJobSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ message: parsed.error.errors[0].message });
      const f = await loadForecast(String(req.params.id));
      if (!f) return res.status(404).json({ message: "Forecast job not found" });
      if (!canTouchArea(req, f.area) || (parsed.data.area && !canTouchArea(req, parsed.data.area)))
        return res.status(403).json({ message: "You can only plan work in your area" });
      if (f.stage === "Converted")
        return res.status(400).json({ message: "This forecast is already a job. Edit the job instead." });
      const patch: Record<string, any> = { ...parsed.data, updated_at: new Date().toISOString() };
      // Changing the stage resets the odds to that stage's default unless
      // odds were sent too.
      if (parsed.data.stage && parsed.data.odds == null && parsed.data.stage !== f.stage)
        patch.odds = FORECAST_DEFAULT_ODDS[parsed.data.stage];
      const start = patch.start_on ?? f.start_on;
      const end = "end_on" in patch ? patch.end_on : f.end_on;
      if (end && end < start)
        return res.status(400).json({ message: "End date must be on or after the start date" });
      const { data, error } = await db()
        .from("forecast_jobs")
        .update(patch)
        .eq("id", f.id)
        .select()
        .single();
      if (error) return res.status(400).json({ message: error.message });
      // A lost job frees its planned units.
      if (patch.stage === "Lost") await db().from("forecast_units").delete().eq("forecast_job_id", f.id);
      res.json(data);
    },
  );

  app.delete(
    "/api/forecast-jobs/:id",
    requireAuth,
    requireRole("admin", "area"),
    async (req: Request, res: Response) => {
      const f = await loadForecast(String(req.params.id));
      if (!f) return res.status(404).json({ message: "Forecast job not found" });
      if (!canTouchArea(req, f.area))
        return res.status(403).json({ message: "You can only plan work in your area" });
      await db().from("bid_documents").delete().eq("forecast_job_id", f.id).is("job_id", null);
      const { error } = await db().from("forecast_jobs").delete().eq("id", f.id);
      if (error) return res.status(400).json({ message: error.message });
      res.status(204).end();
    },
  );

  // Replace the set of units planned for a forecast job.
  app.put(
    "/api/forecast-jobs/:id/units",
    requireAuth,
    requireRole("admin", "area"),
    async (req: Request, res: Response) => {
      const parsed = setForecastUnitsSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ message: parsed.error.errors[0].message });
      const f = await loadForecast(String(req.params.id));
      if (!f) return res.status(404).json({ message: "Forecast job not found" });
      if (!canTouchArea(req, f.area))
        return res.status(403).json({ message: "You can only plan work in your area" });
      const ids = Array.from(new Set(parsed.data.asset_ids));
      if (ids.length) {
        const { data: rows } = await db()
          .from("assets")
          .select("id, area, category")
          .in("id", ids);
        const ok = (rows || []).filter((a: any) =>
          (FORECAST_CATEGORIES as readonly string[]).includes(a.category),
        );
        if (ok.length !== ids.length)
          return res.status(400).json({ message: "Only centrifuges can be planned on a forecast job" });
        const scope = areaScopeOf(req.profile!);
        if (scope && ok.some((a: any) => a.area !== scope))
          return res.status(403).json({ message: "You can only plan units from your area" });
      }
      const client = db();
      const { error: delErr } = await client.from("forecast_units").delete().eq("forecast_job_id", f.id);
      if (delErr) return res.status(400).json({ message: delErr.message });
      if (ids.length) {
        const { error } = await client
          .from("forecast_units")
          .insert(ids.map((asset_id) => ({ forecast_job_id: f.id, asset_id })));
        if (error) return res.status(400).json({ message: error.message });
      }
      res.json({ asset_ids: ids });
    },
  );

  // Turn an awarded forecast into a real job.
  app.post(
    "/api/forecast-jobs/:id/convert",
    requireAuth,
    requireRole("admin", "area"),
    async (req: Request, res: Response) => {
      const parsed = convertForecastSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ message: parsed.error.errors[0].message });
      const f = await loadForecast(String(req.params.id));
      if (!f) return res.status(404).json({ message: "Forecast job not found" });
      if (!canTouchArea(req, f.area))
        return res.status(403).json({ message: "You can only plan work in your area" });
      if (f.stage !== "Awarded")
        return res.status(400).json({ message: "Only an Awarded forecast can be converted to a job" });
      const client = db();
      const { data: job, error } = await client
        .from("jobs")
        .insert({
          job_number: parsed.data.job_number,
          area: f.area,
          customer_id: parsed.data.customer_id,
          status: "Active",
          crewing: "Manned",
          started_on: f.start_on,
          est_release_on: f.end_on ?? null,
          day_rate: f.day_rate ?? null,
          well_name: parsed.data.well_name?.trim() || null,
          description: f.notes ?? null,
        })
        .select()
        .single();
      if (error) {
        if (error.code === "23505")
          return res.status(409).json({
            message: `Job ${parsed.data.job_number} is already active in ${f.area}. Archive that job first, or use a different number.`,
          });
        return res.status(400).json({ message: error.message });
      }

      // Move the chosen units now — only units planned on this forecast that
      // aren't on another active job.
      const want = new Set(parsed.data.asset_ids ?? []);
      const { data: planned } = await client
        .from("forecast_units")
        .select("asset_id, asset:assets(id, job_id, job:jobs(status, archived_at))")
        .eq("forecast_job_id", f.id);
      const movable = (planned || [])
        .filter((p: any) => want.has(p.asset_id))
        .filter((p: any) => {
          const j = p.asset?.job;
          return !p.asset?.job_id || !j || j.archived_at || !LIVE_STATUSES.includes(j.status);
        })
        .map((p: any) => p.asset_id);
      let moved: string[] = [];
      if (movable.length) {
        const { error: mErr } = await client
          .from("assets")
          .update({ job_id: job.id, status: "On Job", area: f.area })
          .in("id", movable);
        if (!mErr) {
          moved = movable;
          await client.from("forecast_units").delete().eq("forecast_job_id", f.id).in("asset_id", movable);
        }
      }
      // Bid PDFs follow the bid onto the real job.
      await client.from("bid_documents").update({ job_id: job.id, area: f.area }).eq("forecast_job_id", f.id);
      await client
        .from("forecast_jobs")
        .update({ stage: "Converted", odds: 100, converted_job_id: job.id, updated_at: new Date().toISOString() })
        .eq("id", f.id);
      res.status(201).json({ job, moved_asset_ids: moved });
    },
  );

  // ---- Bid documents (PDFs) ----------------------------------------------
  // Who can see a document: anyone who can see the Forecast (admin, area,
  // super), limited to their own area.
  const canSeeDoc = (req: Request, d: any) => canTouchArea(req, d.area);

  app.get(
    "/api/forecast-jobs/:id/documents",
    requireAuth,
    requireRole("admin", "area", "super"),
    async (req: Request, res: Response) => {
      const f = await loadForecast(String(req.params.id));
      if (!f || !canTouchArea(req, f.area)) return res.status(404).json({ message: "Forecast job not found" });
      const { data, error } = await db()
        .from("bid_documents")
        .select(BID_DOC_COLS)
        .eq("forecast_job_id", f.id)
        .order("created_at", { ascending: false });
      if (error) {
        if (missingTable(error.message)) return res.status(409).json({ message: SETUP_MSG, setup_required: true });
        return res.status(500).json({ message: error.message });
      }
      res.json(data || []);
    },
  );

  app.post(
    "/api/forecast-jobs/:id/documents",
    requireAuth,
    requireRole("admin", "area"),
    async (req: Request, res: Response) => {
      const parsed = uploadBidDocumentSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ message: parsed.error.errors[0].message });
      const f = await loadForecast(String(req.params.id));
      if (!f) return res.status(404).json({ message: "Forecast job not found" });
      if (!canTouchArea(req, f.area))
        return res.status(403).json({ message: "You can only plan work in your area" });
      const bytes = Buffer.from(parsed.data.file_base64, "base64");
      if (!bytes.length) return res.status(400).json({ message: "The file is empty" });
      if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-")
        return res.status(400).json({ message: "Only PDF files can be added as bid documents" });
      if (bytes.length > BID_DOC_MAX_BYTES)
        return res.status(400).json({ message: "This PDF is over 3 MB. Save a smaller copy or split it, then try again." });
      const name = parsed.data.file_name.trim().replace(/[\\/]/g, "_") || "bid.pdf";
      const { data, error } = await db()
        .from("bid_documents")
        .insert({
          forecast_job_id: f.id,
          job_id: f.converted_job_id ?? null,
          area: f.area,
          file_name: /\.pdf$/i.test(name) ? name : `${name}.pdf`,
          file_mime: "application/pdf",
          file_size: bytes.length,
          file_base64: parsed.data.file_base64,
          uploaded_by: req.profile!.id,
          uploaded_by_name: req.profile!.name,
        })
        .select(BID_DOC_COLS)
        .single();
      if (error) {
        if (missingTable(error.message)) return res.status(409).json({ message: SETUP_MSG, setup_required: true });
        return res.status(400).json({ message: error.message });
      }
      res.status(201).json(data);
    },
  );

  // Bid PDFs carried over to a real job.
  app.get(
    "/api/jobs/:id/bid-documents",
    requireAuth,
    requireRole("admin", "area", "super"),
    async (req: Request, res: Response) => {
      const { data, error } = await db()
        .from("bid_documents")
        .select(BID_DOC_COLS)
        .eq("job_id", String(req.params.id))
        .order("created_at", { ascending: false });
      if (error) {
        // Not set up yet = nothing to show.
        if (missingTable(error.message)) return res.json([]);
        return res.status(500).json({ message: error.message });
      }
      res.json((data || []).filter((d: any) => canSeeDoc(req, d)));
    },
  );

  app.get(
    "/api/bid-documents/:id/file",
    requireAuth,
    requireRole("admin", "area", "super"),
    async (req: Request, res: Response) => {
      const { data } = await db()
        .from("bid_documents")
        .select("area, file_name, file_mime, file_base64")
        .eq("id", String(req.params.id))
        .maybeSingle();
      if (!data || !canSeeDoc(req, data)) return res.status(404).json({ message: "File not found" });
      const d: any = data;
      res.setHeader("Content-Type", d.file_mime || "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="${String(d.file_name || "bid.pdf").replace(/"/g, "")}"`);
      res.send(Buffer.from(d.file_base64, "base64"));
    },
  );

  app.delete(
    "/api/bid-documents/:id",
    requireAuth,
    requireRole("admin", "area"),
    async (req: Request, res: Response) => {
      const { data } = await db().from("bid_documents").select("id, area").eq("id", String(req.params.id)).maybeSingle();
      if (!data || !canSeeDoc(req, data)) return res.status(404).json({ message: "File not found" });
      const { error } = await db().from("bid_documents").delete().eq("id", (data as any).id);
      if (error) return res.status(400).json({ message: error.message });
      res.status(204).end();
    },
  );

  // Planned release date for an active job (null = indefinite).
  app.patch(
    "/api/jobs/:id/est-release",
    requireAuth,
    requireRole("admin", "area"),
    async (req: Request, res: Response) => {
      const parsed = setJobReleaseSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ message: parsed.error.errors[0].message });
      const { data: job } = await db().from("jobs").select("id, area").eq("id", String(req.params.id)).maybeSingle();
      if (!job) return res.status(404).json({ message: "Job not found" });
      if (!canTouchArea(req, (job as any).area))
        return res.status(403).json({ message: "You can only plan work in your area" });
      const { error } = await db()
        .from("jobs")
        .update({ est_release_on: parsed.data.est_release_on })
        .eq("id", String(req.params.id));
      if (error) {
        if (missingTable(error.message)) return res.status(409).json({ message: SETUP_MSG, setup_required: true });
        return res.status(400).json({ message: error.message });
      }
      res.json({ id: String(req.params.id), est_release_on: parsed.data.est_release_on });
    },
  );
}
