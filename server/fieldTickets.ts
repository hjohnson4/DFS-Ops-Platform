// Field tickets: billable field work on a job.
//
// Workflow (db/field-ticket-workflow.sql):
//   Open      Area Manager / Admin builds the ticket, section by section, and
//             can save it and come back as work is done.
//   Closed    All the work is on it. Locked. Area Manager / Admin can reopen.
//   Approved  An Admin has approved it. Only an Admin can reopen it.
// Supervisors can view tickets but not change them. Field techs don't see them.
//
// Each line can carry its own dates, well and section. The ticket's overall
// work dates (ticket_date / ticket_end_date) are derived from the line dates.
import type { Express, Request, Response } from "express";
import { supabaseAnon, supabaseAdmin } from "./supabase";
import { requireAuth, requireRole, areaScopeOf } from "./auth";
import {
  createFieldTicketSchema,
  updateFieldTicketSchema,
  isLiveJobStatus,
  ticketCloseProblems,
  wellKey,
  type LineItem,
  type TicketHistoryEntry,
  type TicketCoverageDay,
} from "@shared/schema";
import { z } from "zod";

const db = () => supabaseAdmin || supabaseAnon;

const MANAGE = ["admin", "area"] as const; // create / edit / close / reopen / delete
const VIEW = ["admin", "area", "super"] as const;

const TICKET_SELECT =
  "*, job:jobs!field_tickets_job_id_fkey(job_number,area,status,customer_id,customer:customers(name,primary_contact,phone,email)), creator:profiles!field_tickets_created_by_fkey(name)";

const WORKFLOW_SQL_HINT =
  "Field ticket workflow needs a one-time database update: run \"Field ticket workflow.sql\" in the Supabase SQL Editor.";

// Friendlier messages for database errors.
function ticketDbError(msg: string): string {
  if (/ticket_end_date/.test(msg))
    return "Date ranges need a one-time database update (db/field-ticket-date-range.sql).";
  if (/(status|ticket_type|ordered_by|closed_at|closed_by|approved_at|approved_by|history)/.test(msg) &&
      /(column|schema cache)/i.test(msg))
    return WORKFLOW_SQL_HINT;
  if (/field_tickets_ticket_number_key|duplicate key/.test(msg))
    return "That ticket number is already used. Pick another number.";
  if (/field_ticket_next_number|set_field_ticket_next_number/.test(msg) && /function/i.test(msg))
    return WORKFLOW_SQL_HINT;
  return msg;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const clean = (s: string | null | undefined) => {
  const t = String(s ?? "").trim();
  return t === "" ? null : t;
};

// Normalize lines from the client: recompute totals, tidy dates and text.
function normalizeLines(
  lines: z.infer<typeof createFieldTicketSchema>["line_items"],
): LineItem[] {
  return (lines ?? []).map((li) => {
    const start = clean(li.start_date);
    let end = clean(li.end_date);
    if (!start) end = null;
    else if (end && end <= start) end = null;
    return {
      description: li.description.trim(),
      quantity: li.quantity,
      unit_cost: li.unit_cost,
      total: round2(li.quantity * li.unit_cost),
      start_date: start,
      end_date: end,
      well_name: clean(li.well_name),
      section: clean(li.section),
      ...(li.service_id ? { service_id: li.service_id } : {}),
    };
  });
}

// Overall work dates from line dates (null when no line has dates).
function datesFromLines(lines: LineItem[]): { start: string; end: string | null } | null {
  const starts = lines.map((l) => l.start_date).filter(Boolean) as string[];
  if (starts.length === 0) return null;
  const ends = lines
    .filter((l) => l.start_date)
    .map((l) => (l.end_date || l.start_date) as string);
  const start = starts.sort()[0];
  const end = ends.sort()[ends.length - 1];
  return { start, end: end > start ? end : null };
}

// Header well: the distinct line wells, in first-seen order.
function wellsFromLines(lines: LineItem[]): string | null {
  const seen = new Map<string, string>();
  for (const l of lines) {
    const k = wellKey(l.well_name);
    if (k && !seen.has(k)) seen.set(k, String(l.well_name));
  }
  return seen.size ? Array.from(seen.values()).join(", ") : null;
}

function entry(req: Request, action: string, note?: string | null): TicketHistoryEntry {
  return {
    at: new Date().toISOString(),
    by: req.profile?.name ?? null,
    role: req.profile?.role ?? null,
    action,
    note: note ?? null,
  };
}

async function namesFor(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const uniq = Array.from(new Set(ids.filter(Boolean)));
  if (uniq.length === 0) return out;
  const { data } = await db().from("profiles").select("id,name").in("id", uniq);
  (data || []).forEach((p: any) => out.set(p.id, p.name));
  return out;
}

async function flatten(rows: any[]): Promise<any[]> {
  const names = await namesFor(
    rows.flatMap((r) => [r.closed_by, r.approved_by]).filter(Boolean),
  );
  return rows.map((t) => {
    const { job, creator, ...rest } = t;
    return {
      ...rest,
      status: rest.status ?? "open",
      ticket_type: rest.ticket_type ?? null,
      ordered_by: rest.ordered_by ?? null,
      closed_at: rest.closed_at ?? null,
      closed_by: rest.closed_by ?? null,
      approved_at: rest.approved_at ?? null,
      approved_by: rest.approved_by ?? null,
      history: Array.isArray(rest.history) ? rest.history : [],
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
      closed_by_name: rest.closed_by ? names.get(rest.closed_by) ?? null : null,
      approved_by_name: rest.approved_by ? names.get(rest.approved_by) ?? null : null,
    };
  });
}

async function loadOne(id: string) {
  const { data } = await db().from("field_tickets").select(TICKET_SELECT).eq("id", id).single();
  if (!data) return null;
  return (await flatten([data]))[0];
}

// Load a ticket + parent job and enforce area scope. `needLive` also requires
// the job to be active. Sends the error response and returns null on failure.
async function loadForWrite(req: Request, res: Response, needLive: boolean) {
  const { data: ticket } = await db()
    .from("field_tickets")
    .select("*")
    .eq("id", req.params.id)
    .single();
  if (!ticket) {
    res.status(404).json({ message: "Field ticket not found" });
    return null;
  }
  const { data: job } = await db()
    .from("jobs")
    .select("id,area,status")
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
  if (needLive && !isLiveJobStatus(job.status)) {
    res.status(400).json({ message: "This job isn't active, so its tickets can't be changed." });
    return null;
  }
  const status = (ticket.status ?? "open") as string;
  const history: TicketHistoryEntry[] = Array.isArray(ticket.history) ? ticket.history : [];
  return { ticket, job, status, history };
}

// Insert, retrying when an automatic number collides with a hand-typed one.
async function insertTicket(row: any, explicitNumber: number | null) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const { data, error } = await db().from("field_tickets").insert(row).select().single();
    if (!error) return { data, error: null };
    const dup = /field_tickets_ticket_number_key|duplicate key/.test(error.message);
    if (!dup || explicitNumber != null) return { data: null, error };
    // automatic number was taken by a manual one: the sequence has advanced,
    // so simply try again
  }
  return { data: null, error: { message: "Couldn't find a free ticket number. Try again." } };
}

export function registerFieldTicketRoutes(app: Express) {
  // All tickets the user can see. ?status=active|past filters on the job.
  app.get("/api/field-tickets", requireAuth, requireRole(...VIEW), async (req: Request, res: Response) => {
    const scope = areaScopeOf(req.profile!);
    const { data, error } = await db()
      .from("field_tickets")
      .select(TICKET_SELECT)
      .order("ticket_date", { ascending: false })
      .order("ticket_number", { ascending: false });
    if (error) return res.status(500).json({ message: error.message });
    let rows = await flatten(data || []);
    if (scope) rows = rows.filter((r: any) => r.area === scope);
    const status = String(req.query.status || "").toLowerCase();
    if (status === "active") rows = rows.filter((r: any) => isLiveJobStatus(r.job_status));
    else if (status === "past") rows = rows.filter((r: any) => !isLiveJobStatus(r.job_status));
    res.json(rows);
  });

  // The next automatic ticket number (for the create form and admin setting).
  app.get("/api/field-tickets/next-number", requireAuth, requireRole(...MANAGE), async (_req, res) => {
    const { data, error } = await db().rpc("field_ticket_next_number");
    if (error) {
      // Before the workflow SQL: fall back to max + 1.
      const { data: top } = await db()
        .from("field_tickets")
        .select("ticket_number")
        .order("ticket_number", { ascending: false })
        .limit(1);
      return res.json({ next: (top?.[0]?.ticket_number ?? 0) + 1, configurable: false });
    }
    res.json({ next: Number(data), configurable: true });
  });

  // Admin: set the next automatic ticket number.
  app.post("/api/field-tickets/next-number", requireAuth, requireRole("admin"), async (req, res) => {
    const n = Number(req.body?.next);
    if (!Number.isInteger(n) || n < 1)
      return res.status(400).json({ message: "Enter a whole number of 1 or more." });
    const { data, error } = await db().rpc("set_field_ticket_next_number", { n });
    if (error) return res.status(400).json({ message: ticketDbError(error.message) });
    res.json({ next: Number(data) });
  });

  // Tickets on one job.
  app.get("/api/jobs/:id/field-tickets", requireAuth, requireRole(...VIEW), async (req, res) => {
    const scope = areaScopeOf(req.profile!);
    const { data: job } = await db().from("jobs").select("area").eq("id", req.params.id).single();
    if (!job || (scope && job.area !== scope))
      return res.status(404).json({ message: "Job not found" });
    const { data, error } = await db()
      .from("field_tickets")
      .select(TICKET_SELECT)
      .eq("job_id", req.params.id)
      .order("ticket_date", { ascending: false })
      .order("ticket_number", { ascending: false });
    if (error) return res.status(500).json({ message: error.message });
    res.json(await flatten(data || []));
  });

  // Signed-off report days on a job and which tickets cover them.
  app.get("/api/jobs/:id/ticket-coverage", requireAuth, requireRole(...VIEW), async (req, res) => {
    const scope = areaScopeOf(req.profile!);
    const { data: job } = await db()
      .from("jobs")
      .select("id,area,day_rate")
      .eq("id", req.params.id)
      .single();
    if (!job || (scope && job.area !== scope))
      return res.status(404).json({ message: "Job not found" });
    const [{ data: reports, error: rErr }, { data: tickets, error: tErr }] = await Promise.all([
      db()
        .from("daily_reports")
        .select("report_date,well_name,kpis,status")
        .eq("job_id", job.id)
        .eq("status", "Signed off"),
      db().from("field_tickets").select("ticket_number,well_name,line_items").eq("job_id", job.id),
    ]);
    if (rErr) return res.status(500).json({ message: rErr.message });
    if (tErr) return res.status(500).json({ message: tErr.message });

    // One row per well + date (duplicate reports for a day count once).
    const days = new Map<string, TicketCoverageDay>();
    for (const r of reports || []) {
      const date = String(r.report_date ?? "").slice(0, 10);
      const well = String(r.well_name ?? "").trim();
      if (!date || !well) continue;
      const k = `${wellKey(well)}|${date}`;
      const rateRaw = Number((r as any).kpis?.day_rate);
      const rate = Number.isFinite(rateRaw) && rateRaw > 0 ? rateRaw : job.day_rate != null ? Number(job.day_rate) : null;
      if (!days.has(k)) days.set(k, { well_name: well, date, rate, tickets: [] });
    }
    // Mark days covered by ticket lines (line well, else the ticket's well).
    for (const t of tickets || []) {
      const lines: LineItem[] = Array.isArray(t.line_items) ? t.line_items : [];
      for (const l of lines) {
        if (!l.start_date) continue;
        if (l.service_id) continue; // service charge lines don't cover report days
        const wk = wellKey(l.well_name || t.well_name);
        if (!wk) continue;
        const end = l.end_date && l.end_date > l.start_date ? l.end_date : l.start_date;
        days.forEach((d, key) => {
          if (key.startsWith(wk + "|") && d.date >= l.start_date! && d.date <= end) {
            if (!d.tickets.includes(t.ticket_number)) d.tickets.push(t.ticket_number);
          }
        });
      }
    }
    const list = Array.from(days.values()).sort((a, b) =>
      a.date === b.date ? a.well_name.localeCompare(b.well_name) : a.date.localeCompare(b.date),
    );
    res.json({
      days: list,
      uncovered: list.filter((d) => d.tickets.length === 0).length,
      doubled: list.filter((d) => d.tickets.length > 1).length,
    });
  });

  // Create (Area Manager / Admin). Job must be active. Starts Open.
  app.post("/api/jobs/:id/field-tickets", requireAuth, requireRole(...MANAGE), async (req, res) => {
    const parsed = createFieldTicketSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.errors[0].message });
    const p = parsed.data;
    const { data: job } = await db().from("jobs").select("area,status").eq("id", req.params.id).single();
    if (!job) return res.status(404).json({ message: "Job not found" });
    if (req.profile!.role !== "admin" && job.area !== req.profile!.area)
      return res.status(403).json({ message: "Outside your area" });
    if (!isLiveJobStatus(job.status))
      return res.status(400).json({ message: "Field tickets can only be created for active jobs." });

    const lines = normalizeLines(p.line_items);
    const lineSum = round2(lines.reduce((s, l) => s + l.total, 0));
    const fromLines = datesFromLines(lines);
    const start = fromLines?.start ?? p.ticket_date;
    let end = fromLines ? fromLines.end : clean(p.ticket_end_date);
    if (end && end < start) return res.status(400).json({ message: "End date can't be before the start date." });
    if (end === start) end = null;

    const row: any = {
      job_id: req.params.id,
      ticket_date: start,
      ...(end ? { ticket_end_date: end } : {}),
      county: clean(p.county),
      well_name: wellsFromLines(lines) ?? clean(p.well_name),
      po_afe: clean(p.po_afe),
      description: clean(p.description),
      line_items: lines,
      asset_ids: p.asset_ids ?? [],
      amount: p.amount != null ? p.amount : lines.length ? lineSum : null,
      comments: clean(p.comments),
      created_by: req.profile!.id,
      status: "open",
      ticket_type: p.ticket_type ?? null,
      ordered_by: clean(p.ordered_by),
      history: [entry(req, "Opened")],
    };
    if (p.ticket_number != null) row.ticket_number = p.ticket_number;
    const { data, error } = await insertTicket(row, p.ticket_number ?? null);
    if (error) return res.status(400).json({ message: ticketDbError(error.message) });
    res.status(201).json(await loadOne(data.id));
  });

  // Edit (Area Manager / Admin) while the ticket is Open and the job active.
  app.patch("/api/field-tickets/:id", requireAuth, requireRole(...MANAGE), async (req, res) => {
    const parsed = updateFieldTicketSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.errors[0].message });
    const loaded = await loadForWrite(req, res, true);
    if (!loaded) return;
    if (loaded.status !== "open")
      return res.status(400).json({ message: "This ticket is closed. Reopen it to make changes." });
    const p = parsed.data;
    const t = loaded.ticket;
    const patch: any = {};
    if (p.ticket_number != null && p.ticket_number !== t.ticket_number) patch.ticket_number = p.ticket_number;
    if (p.ticket_type !== undefined) patch.ticket_type = p.ticket_type ?? null;
    if (p.ordered_by !== undefined) patch.ordered_by = clean(p.ordered_by);
    if (p.county !== undefined) patch.county = clean(p.county);
    if (p.po_afe !== undefined) patch.po_afe = clean(p.po_afe);
    if (p.description !== undefined) patch.description = clean(p.description);
    if (p.comments !== undefined) patch.comments = clean(p.comments);
    if (p.asset_ids !== undefined) patch.asset_ids = p.asset_ids ?? [];

    let lines: LineItem[] | null = null;
    if (p.line_items !== undefined) {
      lines = normalizeLines(p.line_items);
      patch.line_items = lines;
    }
    const effLines: LineItem[] = lines ?? (Array.isArray(t.line_items) ? t.line_items : []);
    const fromLines = datesFromLines(effLines);
    if (fromLines) {
      patch.ticket_date = fromLines.start;
      if ((t.ticket_end_date ?? null) !== fromLines.end) patch.ticket_end_date = fromLines.end;
    } else if (p.ticket_date !== undefined || p.ticket_end_date !== undefined) {
      const start = p.ticket_date ?? t.ticket_date;
      let end = p.ticket_end_date !== undefined ? clean(p.ticket_end_date) : t.ticket_end_date ?? null;
      if (end && end < start) return res.status(400).json({ message: "End date can't be before the start date." });
      if (end === start) end = null;
      patch.ticket_date = start;
      if ((t.ticket_end_date ?? null) !== end) patch.ticket_end_date = end;
    }
    const lineWells = wellsFromLines(effLines);
    if (lineWells) patch.well_name = lineWells;
    else if (p.well_name !== undefined) patch.well_name = clean(p.well_name);

    if (p.amount !== undefined) patch.amount = p.amount ?? null;
    else if (lines) patch.amount = lines.length ? round2(lines.reduce((s, l) => s + l.total, 0)) : null;

    patch.history = [...loaded.history, entry(req, "Saved")];
    const { error } = await db().from("field_tickets").update(patch).eq("id", t.id);
    if (error) return res.status(400).json({ message: ticketDbError(error.message) });
    res.json(await loadOne(t.id));
  });

  // Close (Area Manager / Admin). Checks the ticket is complete.
  app.post("/api/field-tickets/:id/close", requireAuth, requireRole(...MANAGE), async (req, res) => {
    const loaded = await loadForWrite(req, res, false);
    if (!loaded) return;
    if (loaded.status !== "open") return res.status(400).json({ message: "Only an open ticket can be closed." });
    const problems = ticketCloseProblems({
      ticket_type: loaded.ticket.ticket_type,
      well_name: loaded.ticket.well_name,
      line_items: loaded.ticket.line_items,
    });
    if (problems.length) return res.status(400).json({ message: problems.join(" "), problems });
    const { error } = await db()
      .from("field_tickets")
      .update({
        status: "closed",
        closed_at: new Date().toISOString(),
        closed_by: req.profile!.id,
        history: [...loaded.history, entry(req, "Closed", clean(req.body?.note))],
      })
      .eq("id", loaded.ticket.id);
    if (error) return res.status(400).json({ message: ticketDbError(error.message) });
    res.json(await loadOne(loaded.ticket.id));
  });

  // Approve (Admin only) a closed ticket.
  app.post("/api/field-tickets/:id/approve", requireAuth, requireRole("admin"), async (req, res) => {
    const loaded = await loadForWrite(req, res, false);
    if (!loaded) return;
    if (loaded.status !== "closed")
      return res.status(400).json({ message: "Close the ticket before approving it." });
    const { error } = await db()
      .from("field_tickets")
      .update({
        status: "approved",
        approved_at: new Date().toISOString(),
        approved_by: req.profile!.id,
        history: [...loaded.history, entry(req, "Approved", clean(req.body?.note))],
      })
      .eq("id", loaded.ticket.id);
    if (error) return res.status(400).json({ message: ticketDbError(error.message) });
    res.json(await loadOne(loaded.ticket.id));
  });

  // Reopen: Area Manager / Admin from Closed; Admin only from Approved.
  app.post("/api/field-tickets/:id/reopen", requireAuth, requireRole(...MANAGE), async (req, res) => {
    const loaded = await loadForWrite(req, res, true);
    if (!loaded) return;
    if (loaded.status === "open") return res.status(400).json({ message: "This ticket is already open." });
    if (loaded.status === "approved" && req.profile!.role !== "admin")
      return res.status(403).json({ message: "Only an Admin can reopen an approved ticket." });
    const { error } = await db()
      .from("field_tickets")
      .update({
        status: "open",
        closed_at: null,
        closed_by: null,
        approved_at: null,
        approved_by: null,
        history: [
          ...loaded.history,
          entry(req, loaded.status === "approved" ? "Reopened (approval removed)" : "Reopened", clean(req.body?.note)),
        ],
      })
      .eq("id", loaded.ticket.id);
    if (error) return res.status(400).json({ message: ticketDbError(error.message) });
    res.json(await loadOne(loaded.ticket.id));
  });

  // Delete (Area Manager / Admin). Approved tickets: Admin only.
  app.delete("/api/field-tickets/:id", requireAuth, requireRole(...MANAGE), async (req, res) => {
    const loaded = await loadForWrite(req, res, true);
    if (!loaded) return;
    if (loaded.status === "approved" && req.profile!.role !== "admin")
      return res.status(403).json({ message: "Only an Admin can delete an approved ticket." });
    const { error } = await db().from("field_tickets").delete().eq("id", loaded.ticket.id);
    if (error) return res.status(400).json({ message: error.message });
    res.status(204).end();
  });
}
