// Area board: a free-form feed plus tasks / supply requests, one board per area.
//
// Who can do what (field techs are left out for now):
//   Admin        — every area, read and write.
//   Area Manager — own area read/write; other areas read-only.
//   Supervisor   — own area only, read/write.
// Anyone who can write to an area can post, reply, create tasks or supply
// requests, claim/assign them, change status and comment.
// When a task is assigned to someone else they get an email (on by default)
// and a text (only if they turned it on, gave a phone number, and Twilio is set).
import type { Express, Request, Response } from "express";
import { supabaseAnon, supabaseAdmin } from "./supabase";
import { requireAuth, requireRole } from "./auth";
import { sendBoardEmail, boardEmailReady } from "./email";
import { sendSms, smsConfigured, normalizeUsPhone } from "./sms";
import { sendPush, notifyPush, getPushKeys } from "./push";
import { ALERT_KINDS, alertOn } from "@shared/alerts";
import { todayCentral } from "./manualBilling";
import {
  AREAS,
  boardPostSchema,
  boardPostEditSchema,
  boardTaskCreateSchema,
  boardTaskUpdateSchema,
  boardCommentSchema,
  boardAlertPrefsSchema,
  boardPinSchema,
  boardFileUploadSchema,
  boardPushSubscribeSchema,
} from "@shared/schema";

const db = () => supabaseAdmin || supabaseAnon;
const BOARD_ROLES = ["admin", "area", "super"] as const;
const OPEN_STATUSES = ["Open", "Assigned", "In progress"];

type Who = { id: string; email: string | null; name: string | null; role: string; area: string | null };

export function canViewArea(p: Who, area: string): boolean {
  if (p.role === "admin" || p.role === "area") return true;
  if (p.role === "super") return p.area === area;
  return false;
}
export function canWriteArea(p: Who, area: string): boolean {
  if (p.role === "admin") return true;
  if (p.role === "area" || p.role === "super") return p.area === area;
  return false;
}
function viewableAreas(p: Who): string[] {
  return (AREAS as readonly string[]).filter((a) => canViewArea(p, a));
}
const nameOf = (p: Who) => p.name || p.email || "Someone";
const taskNo = (n: number | string | null | undefined) => `T-${n ?? "?"}`;
const isManagerOf = (p: Who, area: string) => p.role === "admin" || (p.role === "area" && p.area === area);
const FILE_MAX_BYTES = 6 * 1024 * 1024;
const short = (t: string, n = 120) => (t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t);

/** Supervisors + Area Managers who work in an area (admins aren't counted). */
async function areaMembers(area: string): Promise<{ id: string; name: string }[]> {
  const { data } = await db()
    .from("profiles")
    .select("id,name,email,role,area,active")
    .eq("area", area)
    .in("role", ["area", "super"])
    .eq("active", true);
  return (data || []).map((u: any) => ({ id: u.id, name: u.name || u.email || "Someone" }));
}

/** Photo list (no file data) for posts / tasks / comments. */
async function filesFor(col: "post_id" | "task_id" | "comment_id", ids: string[]) {
  const m = new Map<string, { id: string; file_name: string; file_mime: string | null }[]>();
  if (!ids.length) return m;
  const { data } = await db().from("board_files").select(`id,${col},file_name,file_mime,created_at`).in(col, ids).order("created_at");
  (data || []).forEach((f: any) => {
    const k = f[col];
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push({ id: f.id, file_name: f.file_name, file_mime: f.file_mime });
  });
  return m;
}

function appUrl(req: Request): string {
  return (
    (process.env.APP_URL || "").trim() ||
    (req.get("host") ? `${req.protocol}://${req.get("host")}` : "") ||
    "https://dfs-ops-platform.vercel.app"
  ).replace(/\/$/, "");
}
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso.slice(0, 10) + "T12:00:00Z");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

async function logActivity(task: any, actor: Who, action: string, detail?: string | null) {
  await db().from("board_activity").insert({
    area: task.area,
    task_id: task.id,
    actor_id: actor.id,
    actor_name: nameOf(actor),
    action,
    detail: detail || null,
  });
}

async function loadTask(id: string) {
  const { data } = await db().from("board_tasks").select("*").eq("id", id).maybeSingle();
  return data as any;
}

/** Add assignee / job / asset display fields and comment counts to tasks. */
async function decorate(tasks: any[]) {
  if (!tasks.length) return tasks;
  const ids = (k: string) => Array.from(new Set(tasks.map((t) => t[k]).filter(Boolean)));
  const [people, jobs, assets, comments, photos] = await Promise.all([
    ids("assignee_id").length
      ? db().from("profiles").select("id,name,email").in("id", ids("assignee_id"))
      : Promise.resolve({ data: [] as any[] }),
    ids("job_id").length
      ? db().from("jobs").select("id,job_number,well_name").in("id", ids("job_id"))
      : Promise.resolve({ data: [] as any[] }),
    ids("asset_id").length
      ? db().from("assets").select("id,tag").in("id", ids("asset_id"))
      : Promise.resolve({ data: [] as any[] }),
    db().from("board_task_comments").select("task_id").in("task_id", tasks.map((t) => t.id)),
    db().from("board_files").select("task_id").in("task_id", tasks.map((t) => t.id)),
  ]);
  const pc = new Map<string, number>();
  (photos.data || []).forEach((f: any) => pc.set(f.task_id, (pc.get(f.task_id) || 0) + 1));
  const pm = new Map((people.data || []).map((p: any) => [p.id, p.name || p.email]));
  const jm = new Map((jobs.data || []).map((j: any) => [j.id, j]));
  const am = new Map((assets.data || []).map((a: any) => [a.id, a]));
  const cc = new Map<string, number>();
  (comments.data || []).forEach((c: any) => cc.set(c.task_id, (cc.get(c.task_id) || 0) + 1));
  return tasks.map((t) => ({
    ...t,
    assignee_name: t.assignee_id ? pm.get(t.assignee_id) || null : null,
    job_number: t.job_id ? (jm.get(t.job_id) as any)?.job_number || null : null,
    asset_tag: t.asset_id ? (am.get(t.asset_id) as any)?.tag || null : null,
    comment_count: cc.get(t.id) || 0,
    photo_count: pc.get(t.id) || 0,
  }));
}

// Task emails and texts are paused for now — phone alerts cover it. Set to
// true to bring them back (the Settings switches would need re-adding too).
const TASK_EMAIL_SMS = false;

/** Email + text the new assignee. Never throws; returns what happened. */
async function alertAssignee(req: Request, task: any, actor: Who) {
  const out = { email: "skipped" as string, sms: "skipped" as string, push: 0 };
  if (!task.assignee_id || task.assignee_id === actor.id) return out;
  const [{ data: person }, { data: prefs }] = await Promise.all([
    db().from("profiles").select("id,name,email,active").eq("id", task.assignee_id).maybeSingle(),
    db().from("notification_prefs").select("phone,task_email,task_sms").eq("user_id", task.assignee_id).maybeSingle(),
  ]);
  if (!person || person.active === false) return out;
  let jobNumber: string | null = null;
  if (task.job_id) {
    const { data: j } = await db().from("jobs").select("job_number").eq("id", task.job_id).maybeSingle();
    jobNumber = j?.job_number || null;
  }
  const link = `${appUrl(req)}/#/board/task/${task.id}`;
  const what = task.kind === "supply" ? "Supply request" : "Task";
  const due = task.due_date ? ` · due ${fmtDate(task.due_date)}` : "";
  const by = nameOf(actor);

  const wantEmail = TASK_EMAIL_SMS && prefs?.task_email !== false;
  if (wantEmail && person.email) {
    const subject = `${what} ${taskNo(task.number)} assigned to you: ${task.title}`;
    const rows = [
      ["Area", task.area],
      ["Priority", task.priority],
      task.due_date ? ["Due", fmtDate(task.due_date)] : null,
      jobNumber ? ["Job", jobNumber] : null,
      ["Assigned by", by],
    ].filter(Boolean) as string[][];
    const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#1f2937">
<p>${esc(by)} assigned you a ${what.toLowerCase()} on the ${esc(task.area)} board.</p>
<p style="font-size:16px;font-weight:bold;margin:12px 0 4px">${esc(taskNo(task.number))} · ${esc(task.title)}</p>
${task.details ? `<p style="white-space:pre-wrap;margin:0 0 12px">${esc(task.details)}</p>` : ""}
<table style="border-collapse:collapse;margin:8px 0 16px">${rows
      .map((r) => `<tr><td style="padding:2px 12px 2px 0;color:#6b7280">${esc(r[0])}</td><td style="padding:2px 0">${esc(String(r[1]))}</td></tr>`)
      .join("")}</table>
<p><a href="${link}" style="background:#2f6b3f;color:#fff;padding:9px 16px;border-radius:6px;text-decoration:none">Open in DFS Ops</a></p>
<p style="color:#9ca3af;font-size:12px">You can turn these emails off in DFS Ops under Settings → Task alerts.</p></div>`;
    const text = `${by} assigned you ${what.toLowerCase()} ${taskNo(task.number)}: ${task.title}${due}\n${task.details || ""}\n\nOpen: ${link}`;
    const r = await sendBoardEmail(person.email, subject, html, text).catch(() => ({ ok: false }) as any);
    out.email = r.ok ? "sent" : "failed";
  }

  const phone = normalizeUsPhone(prefs?.phone);
  if (TASK_EMAIL_SMS && prefs?.task_sms && phone && smsConfigured()) {
    const body = `DFS Ops: ${by} assigned you ${taskNo(task.number)} - ${task.title}${due}. ${link} Reply STOP to opt out.`;
    const r = await sendSms(phone, body);
    out.sms = r.ok ? "sent" : "failed";
  }

  const pr = await notifyPush("board", [task.assignee_id], {
    title: `${what} ${taskNo(task.number)} for you`,
    body: `${short(task.title)}${due} · from ${by}`,
    url: `/#/board/task/${task.id}`,
    tag: `task-${task.id}`,
  });
  out.push = pr.sent;
  return out;
}

/** Tell the person who asked for it that it's done (email + phone alert). */
async function alertRequesterDone(req: Request, task: any, actor: Who) {
  const out = { email: "skipped" as string, push: 0 };
  if (!task.created_by || task.created_by === actor.id) return out;
  const [{ data: person }, { data: prefs }] = await Promise.all([
    db().from("profiles").select("id,name,email,active").eq("id", task.created_by).maybeSingle(),
    db().from("notification_prefs").select("task_email").eq("user_id", task.created_by).maybeSingle(),
  ]);
  if (!person || person.active === false) return out;
  const what = task.kind === "supply" ? "Supply request" : "Task";
  const by = nameOf(actor);
  const link = `${appUrl(req)}/#/board/task/${task.id}`;
  if (TASK_EMAIL_SMS && prefs?.task_email !== false && person.email) {
    const subject = `Done: ${what} ${taskNo(task.number)} ${task.title}`;
    const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#1f2937">
<p>${esc(by)} marked your ${what.toLowerCase()} done on the ${esc(task.area)} board.</p>
<p style="font-size:16px;font-weight:bold;margin:12px 0 16px">${esc(taskNo(task.number))} · ${esc(task.title)}</p>
<p><a href="${link}" style="background:#2f6b3f;color:#fff;padding:9px 16px;border-radius:6px;text-decoration:none">Open in DFS Ops</a></p>
<p style="color:#9ca3af;font-size:12px">You can turn these emails off in DFS Ops under Settings → Task alerts.</p></div>`;
    const text = `${by} marked your ${what.toLowerCase()} ${taskNo(task.number)} done: ${task.title}\n\nOpen: ${link}`;
    const r = await sendBoardEmail(person.email, subject, html, text).catch(() => ({ ok: false }) as any);
    out.email = r.ok ? "sent" : "failed";
  }
  const pr = await notifyPush("board", [task.created_by], {
    title: `Done: ${what} ${taskNo(task.number)}`,
    body: `${short(task.title)} · marked done by ${by}`,
    url: `/#/board/task/${task.id}`,
    tag: `task-${task.id}`,
  });
  out.push = pr.sent;
  return out;
}

/** Bell items: open tasks assigned to me (overdue ones flagged as warnings). */
export async function boardNotifications(p: Who) {
  if (!BOARD_ROLES.includes(p.role as any)) return [];
  const { data } = await db()
    .from("board_tasks")
    .select("id,number,kind,title,area,priority,due_date,status,created_by_name,updated_at")
    .eq("assignee_id", p.id)
    .in("status", OPEN_STATUSES)
    .order("updated_at", { ascending: false })
    .limit(25);
  const today = todayCentral();
  const since = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
  const { data: finished } = await db()
    .from("board_tasks")
    .select("id,number,kind,title,status,done_at,done_by,done_by_name")
    .eq("created_by", p.id)
    .eq("status", "Done")
    .gt("done_at", since)
    .order("done_at", { ascending: false })
    .limit(10);
  const doneItems = (finished || [])
    .filter((t: any) => t.done_by !== p.id)
    .map((t: any) => ({
      id: `board-done-${t.id}`,
      type: "board_task" as const,
      severity: "info" as const,
      title: `Done: ${t.kind === "supply" ? "Supply request" : "Task"} ${taskNo(t.number)} ${t.title}`,
      detail: t.done_by_name ? `Marked done by ${t.done_by_name}` : "Marked done",
      href: `/board/task/${t.id}`,
      ts: t.done_at || null,
    }));
  const assigned = (data || []).map((t: any) => {
    const overdue = !!t.due_date && t.due_date < today;
    return {
      id: `board-task-${t.id}`,
      type: "board_task" as const,
      severity: (overdue || t.priority === "Urgent" ? "warning" : "info") as "warning" | "info",
      title: `${t.kind === "supply" ? "Supply request" : "Task"} ${taskNo(t.number)}: ${t.title}`,
      detail: [
        t.status,
        t.due_date ? (overdue ? `overdue since ${fmtDate(t.due_date)}` : `due ${fmtDate(t.due_date)}`) : null,
        t.created_by_name ? `from ${t.created_by_name}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      href: `/board/task/${t.id}`,
      ts: t.updated_at || null,
    };
  });
  return [...assigned, ...doneItems];
}

export function registerBoardRoutes(app: Express) {
  const guard = [requireAuth, requireRole("admin", "area", "super")];

  const pickArea = (req: Request): string => {
    const p = req.profile! as Who;
    const a = String(req.query.area || "");
    if ((AREAS as readonly string[]).includes(a)) return a;
    return p.area && (AREAS as readonly string[]).includes(p.area) ? p.area : AREAS[0];
  };

  // Board header info: which areas I can see, who can be assigned, jobs to link.
  app.get("/api/board/meta", ...guard, async (req: Request, res: Response) => {
    const p = req.profile! as Who;
    const area = pickArea(req);
    if (!canViewArea(p, area)) return res.status(403).json({ message: "You can't view that area's board." });
    const [{ data: people }, { data: jobs }, { data: assets }] = await Promise.all([
      db().from("profiles").select("id,name,email,role,area").eq("active", true).in("role", ["admin", "area", "super"]).order("name"),
      db().from("jobs").select("id,job_number,well_name,status").eq("area", area).is("archived_at", null).order("job_number"),
      db().from("assets").select("id,tag,category,description").eq("area", area).order("tag"),
    ]);
    // Assign to people in this area (Supervisors + Area Managers), plus admins.
    const members = (people || [])
      .filter((u: any) => u.role === "admin" || u.area === area)
      .map((u: any) => ({ id: u.id, name: u.name || u.email, role: u.role, area: u.area }));
    res.json({
      area,
      areas: viewableAreas(p),
      can_write: canWriteArea(p, area),
      members,
      jobs: (jobs || []).map((j: any) => ({ id: j.id, job_number: j.job_number, well_name: j.well_name })),
      assets: (assets || []).map((a: any) => ({ id: a.id, label: a.tag, category: a.category, description: a.description ?? null })),
      email_ready: boardEmailReady(),
      sms_ready: smsConfigured(),
    });
  });

  // ---- Feed -------------------------------------------------------------
  app.get("/api/board/posts", ...guard, async (req: Request, res: Response) => {
    const p = req.profile! as Who;
    const area = pickArea(req);
    if (!canViewArea(p, area)) return res.status(403).json({ message: "You can't view that area's board." });
    const { data: top, error } = await db()
      .from("board_posts")
      .select("*")
      .eq("area", area)
      .is("parent_id", null)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) return res.status(400).json({ message: error.message });
    const ids = (top || []).map((t: any) => t.id);
    const { data: replies } = ids.length
      ? await db().from("board_posts").select("*").in("parent_id", ids).is("deleted_at", null).order("created_at")
      : { data: [] as any[] };
    const jobIds = Array.from(new Set([...(top || []), ...(replies || [])].map((x: any) => x.job_id).filter(Boolean)));
    const { data: jobs } = jobIds.length
      ? await db().from("jobs").select("id,job_number").in("id", jobIds)
      : { data: [] as any[] };
    const jm = new Map((jobs || []).map((j: any) => [j.id, j.job_number]));
    const fm = await filesFor("post_id", [...ids, ...(replies || []).map((r: any) => r.id)]);
    const withJob = (x: any) => ({ ...x, job_number: x.job_id ? jm.get(x.job_id) || null : null, files: fm.get(x.id) || [] });

    // "Got it" counts for posts that ask for it.
    const ackIds = (top || []).filter((t: any) => t.needs_ack).map((t: any) => t.id);
    const [{ data: acks }, members] = ackIds.length
      ? await Promise.all([db().from("board_post_acks").select("post_id,user_id,user_name,created_at").in("post_id", ackIds), areaMembers(area)])
      : [{ data: [] as any[] }, [] as { id: string; name: string }[]];
    const ackInfo = (t: any) => {
      if (!t.needs_ack) return null;
      const mine = (acks || []).filter((a: any) => a.post_id === t.id);
      const ackedIds = new Set(mine.map((a: any) => a.user_id));
      const audience = members.filter((m) => m.id !== t.author_id);
      const canSeeMissing = isManagerOf(p, area) || t.author_id === p.id;
      return {
        done: audience.filter((m) => ackedIds.has(m.id)).length,
        total: audience.length,
        mine: ackedIds.has(p.id),
        acked: mine.map((a: any) => ({ name: a.user_name || "Someone", at: a.created_at })),
        missing: canSeeMissing ? audience.filter((m) => !ackedIds.has(m.id)).map((m) => m.name) : null,
      };
    };
    const list = (top || []).map((t: any) => ({
      ...withJob(t),
      ack: ackInfo(t),
      replies: (replies || []).filter((r: any) => r.parent_id === t.id).map(withJob),
    }));
    // Pinned posts first (newest pin on top), then everything else newest first.
    const pinned = list.filter((x: any) => x.pinned_at).sort((a: any, b: any) => (a.pinned_at < b.pinned_at ? 1 : -1));
    res.json([...pinned, ...list.filter((x: any) => !x.pinned_at)]);
  });

  app.post("/api/board/posts", ...guard, async (req: Request, res: Response) => {
    const p = req.profile! as Who;
    const parsed = boardPostSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.errors[0].message });
    const v = parsed.data;
    if (!canWriteArea(p, v.area)) return res.status(403).json({ message: "You can only post on your own area's board." });
    if (v.parent_id) {
      const { data: parent } = await db().from("board_posts").select("id,area,parent_id").eq("id", v.parent_id).maybeSingle();
      if (!parent || parent.area !== v.area) return res.status(400).json({ message: "That post no longer exists." });
      if (parent.parent_id) v.parent_id = parent.parent_id; // keep replies one level deep
    }
    const pin = !v.parent_id && !!(v.pin || v.needs_ack);
    if (pin && !isManagerOf(p, v.area))
      return res.status(403).json({ message: "Only Area Managers and Admins can pin posts." });
    // Admins can send one top-level post to every area's board. Each area gets
    // its own copy so replies and "Got it" taps stay with that area's team.
    // Job tags belong to one area, so they're dropped on an all-areas post.
    const allAreas = !!v.all_areas && !v.parent_id && p.role === "admin";
    if (v.all_areas && !allAreas)
      return res.status(403).json({ message: "Only Admins can post to all areas at once." });
    const targets: string[] = allAreas ? [v.area, ...AREAS.filter((a) => a !== v.area)] : [v.area];
    const pinnedAt = new Date().toISOString();
    const rows = targets.map((area) => ({
      area,
      body: v.body.trim(),
      parent_id: v.parent_id || null,
      job_id: allAreas ? null : v.job_id || null,
      author_id: p.id,
      author_name: nameOf(p),
      ...(pin ? { pinned_at: pinnedAt, pinned_by_name: nameOf(p), needs_ack: !!v.needs_ack } : {}),
    }));
    const { data: inserted, error } = await db().from("board_posts").insert(rows).select();
    if (error || !inserted?.length) return res.status(400).json({ message: error?.message || "Couldn't post." });
    const byArea = new Map(inserted.map((r: any) => [r.area, r]));
    const data: any = byArea.get(v.area) || inserted[0];

    // Phone alerts (quick; finished before replying so Vercel doesn't cut them off).
    const preview = short(v.body.trim() || "Photo", 140);
    if (pin) {
      const sent = new Set<string>([p.id]);
      for (const area of targets) {
        const row: any = byArea.get(area);
        if (!row) continue;
        const ids = (await areaMembers(area)).map((m) => m.id).filter((id) => !sent.has(id));
        ids.forEach((id) => sent.add(id));
        if (!ids.length) continue;
        await notifyPush("board", ids, {
          title: v.needs_ack ? `Please read: ${area} board` : `Pinned on the ${area} board`,
          body: `${nameOf(p)}: ${preview}`,
          url: "/#/board",
          tag: `post-${row.id}`,
        });
      }
    } else if (v.parent_id) {
      const { data: parent } = await db().from("board_posts").select("author_id").eq("id", v.parent_id).maybeSingle();
      if (parent?.author_id && parent.author_id !== p.id)
        await notifyPush("board", [parent.author_id], {
          title: `${nameOf(p)} replied to your post`,
          body: preview,
          url: "/#/board",
          tag: `post-${v.parent_id}`,
        });
    }
    res.json({ ...data, copies: targets.map((a) => byArea.get(a)).filter(Boolean).map((r: any) => ({ id: r.id, area: r.area })) });
  });

  // Pin / unpin a post (Area Managers of that area, Admins).
  app.post("/api/board/posts/:id/pin", ...guard, async (req: Request, res: Response) => {
    const p = req.profile! as Who;
    const parsed = boardPinSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.errors[0].message });
    const { data: post } = await db().from("board_posts").select("*").eq("id", req.params.id).maybeSingle();
    if (!post || post.deleted_at || post.parent_id) return res.status(404).json({ message: "Post not found." });
    if (!isManagerOf(p, post.area)) return res.status(403).json({ message: "Only Area Managers and Admins can pin posts." });
    const patch = parsed.data.pinned
      ? { pinned_at: new Date().toISOString(), pinned_by_name: nameOf(p), needs_ack: parsed.data.needs_ack ?? post.needs_ack ?? false }
      : { pinned_at: null, pinned_by_name: null, needs_ack: false };
    const { data, error } = await db().from("board_posts").update(patch).eq("id", post.id).select().single();
    if (error) return res.status(400).json({ message: error.message });
    if (parsed.data.pinned && !post.pinned_at) {
      const members = await areaMembers(post.area);
      await notifyPush("board", 
        members.map((m) => m.id).filter((id) => id !== p.id),
        {
          title: patch.needs_ack ? `Please read: ${post.area} board` : `Pinned on the ${post.area} board`,
          body: `${post.author_name || "Someone"}: ${short(post.body || "Photo", 140)}`,
          url: "/#/board",
          tag: `post-${post.id}`,
        },
      );
    }
    res.json(data);
  });

  // "Got it" on a post that asks for it.
  app.post("/api/board/posts/:id/ack", ...guard, async (req: Request, res: Response) => {
    const p = req.profile! as Who;
    const { data: post } = await db().from("board_posts").select("id,area,needs_ack,deleted_at").eq("id", req.params.id).maybeSingle();
    if (!post || post.deleted_at) return res.status(404).json({ message: "Post not found." });
    if (!canViewArea(p, post.area)) return res.status(403).json({ message: "You can't view that area's board." });
    const { data: had } = await db().from("board_post_acks").select("post_id").eq("post_id", post.id).eq("user_id", p.id).maybeSingle();
    if (!had) {
      const { error } = await db().from("board_post_acks").insert({ post_id: post.id, user_id: p.id, user_name: nameOf(p) });
      if (error) return res.status(400).json({ message: error.message });
    }
    res.json({ ok: true });
  });

  // ---- Photos -------------------------------------------------------------
  // Photos are shrunk on the phone before upload and stored like service
  // charge files. Anyone who can write to that area can add one.
  app.post("/api/board/files", ...guard, async (req: Request, res: Response) => {
    const p = req.profile! as Who;
    const parsed = boardFileUploadSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.errors[0].message });
    const v = parsed.data;
    let area: string | null = null;
    let ownerOk = false;
    if (v.post_id) {
      const { data } = await db().from("board_posts").select("area,author_id").eq("id", v.post_id).maybeSingle();
      area = data?.area || null;
      ownerOk = data?.author_id === p.id;
    } else if (v.task_id) {
      const t = await loadTask(v.task_id);
      area = t?.area || null;
      ownerOk = true;
    } else if (v.comment_id) {
      const { data: c } = await db().from("board_task_comments").select("task_id,author_id").eq("id", v.comment_id).maybeSingle();
      const t = c ? await loadTask(c.task_id) : null;
      area = t?.area || null;
      ownerOk = c?.author_id === p.id;
    }
    if (!area) return res.status(404).json({ message: "That item no longer exists." });
    if (!canWriteArea(p, area) || !ownerOk) return res.status(403).json({ message: "You can't add photos here." });
    const b64 = v.file_base64.replace(/^data:[^,]*,/, "");
    const size = Buffer.byteLength(b64, "base64");
    if (size > FILE_MAX_BYTES) return res.status(400).json({ message: `${v.file_name} is too large (max 6 MB).` });
    const { data, error } = await db()
      .from("board_files")
      .insert({
        area,
        post_id: v.post_id || null,
        task_id: v.task_id || null,
        comment_id: v.comment_id || null,
        file_name: v.file_name,
        file_mime: v.file_mime,
        file_size: size,
        file_base64: b64,
        uploaded_by: p.id,
        uploaded_by_name: nameOf(p),
      })
      .select("id,file_name,file_mime")
      .single();
    if (error)
      return res.status(400).json({
        message: /board_files/.test(error.message) ? "Photos aren't set up yet — run the Area Board SQL in Supabase." : error.message,
      });
    res.status(201).json(data);
  });

  app.get("/api/board/files/:id", ...guard, async (req: Request, res: Response) => {
    const p = req.profile! as Who;
    const { data: f } = await db().from("board_files").select("area,file_name,file_mime,file_base64").eq("id", req.params.id).maybeSingle();
    if (!f || !canViewArea(p, f.area)) return res.status(404).json({ message: "Photo not found." });
    res.setHeader("Content-Type", f.file_mime || "application/octet-stream");
    res.setHeader("Content-Disposition", `inline; filename="${String(f.file_name).replace(/[^\x20-\x7e]|["\\]/g, "_")}"`);
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.send(Buffer.from(f.file_base64, "base64"));
  });

  app.delete("/api/board/files/:id", ...guard, async (req: Request, res: Response) => {
    const p = req.profile! as Who;
    const { data: f } = await db().from("board_files").select("id,area,uploaded_by").eq("id", req.params.id).maybeSingle();
    if (!f) return res.status(404).json({ message: "Photo not found." });
    if (f.uploaded_by !== p.id && !isManagerOf(p, f.area))
      return res.status(403).json({ message: "Only the person who added it or an Area Manager can remove it." });
    await db().from("board_files").delete().eq("id", f.id);
    res.json({ ok: true });
  });

  app.patch("/api/board/posts/:id", ...guard, async (req: Request, res: Response) => {
    const p = req.profile! as Who;
    const parsed = boardPostEditSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.errors[0].message });
    const { data: post } = await db().from("board_posts").select("*").eq("id", req.params.id).maybeSingle();
    if (!post || post.deleted_at) return res.status(404).json({ message: "Post not found." });
    if (post.author_id !== p.id) return res.status(403).json({ message: "Only the person who wrote it can edit it." });
    const { data, error } = await db()
      .from("board_posts")
      .update({ body: parsed.data.body.trim(), edited_at: new Date().toISOString() })
      .eq("id", post.id)
      .select()
      .single();
    if (error) return res.status(400).json({ message: error.message });
    res.json(data);
  });

  app.delete("/api/board/posts/:id", ...guard, async (req: Request, res: Response) => {
    const p = req.profile! as Who;
    const { data: post } = await db().from("board_posts").select("*").eq("id", req.params.id).maybeSingle();
    if (!post || post.deleted_at) return res.status(404).json({ message: "Post not found." });
    const mine = post.author_id === p.id;
    const manager = p.role === "admin" || (p.role === "area" && p.area === post.area);
    if (!mine && !manager) return res.status(403).json({ message: "Only the writer or an Area Manager can remove it." });
    const { error } = await db().from("board_posts").update({ deleted_at: new Date().toISOString() }).eq("id", post.id);
    if (error) return res.status(400).json({ message: error.message });
    res.json({ ok: true });
  });

  // ---- Tasks ------------------------------------------------------------
  // view: open (default) | done | mine | all
  app.get("/api/board/tasks", ...guard, async (req: Request, res: Response) => {
    const p = req.profile! as Who;
    const area = pickArea(req);
    if (!canViewArea(p, area)) return res.status(403).json({ message: "You can't view that area's board." });
    const view = String(req.query.view || "open");
    let q = db().from("board_tasks").select("*").eq("area", area);
    if (view === "open") q = q.in("status", OPEN_STATUSES);
    else if (view === "done") q = q.in("status", ["Done", "Cancelled"]);
    else if (view === "mine") q = q.eq("assignee_id", p.id).in("status", OPEN_STATUSES);
    if (req.query.job_id) q = q.eq("job_id", String(req.query.job_id));
    if (req.query.asset_id) q = q.eq("asset_id", String(req.query.asset_id));
    const { data, error } = await q
      .order(view === "done" ? "done_at" : "created_at", { ascending: false, nullsFirst: false })
      .limit(view === "done" || view === "all" ? 200 : 500);
    if (error) return res.status(400).json({ message: error.message });
    res.json(await decorate(data || []));
  });

  app.get("/api/board/tasks/:id", ...guard, async (req: Request, res: Response) => {
    const p = req.profile! as Who;
    const task = await loadTask(String(req.params.id));
    if (!task || !canViewArea(p, task.area)) return res.status(404).json({ message: "Task not found." });
    const [[full], { data: comments }, { data: activity }] = await Promise.all([
      decorate([task]),
      db().from("board_task_comments").select("*").eq("task_id", task.id).order("created_at"),
      db().from("board_activity").select("*").eq("task_id", task.id).order("created_at"),
    ]);
    const [tf, cf] = await Promise.all([filesFor("task_id", [task.id]), filesFor("comment_id", (comments || []).map((c: any) => c.id))]);
    res.json({
      ...full,
      files: tf.get(task.id) || [],
      can_write: canWriteArea(p, task.area),
      comments: (comments || []).map((c: any) => ({ ...c, files: cf.get(c.id) || [] })),
      activity: activity || [],
    });
  });

  app.post("/api/board/tasks", ...guard, async (req: Request, res: Response) => {
    const p = req.profile! as Who;
    const parsed = boardTaskCreateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.errors[0].message });
    const v = parsed.data;
    if (!canWriteArea(p, v.area)) return res.status(403).json({ message: "You can only add tasks on your own area's board." });
    const now = new Date().toISOString();
    const { data: task, error } = await db()
      .from("board_tasks")
      .insert({
        area: v.area,
        kind: v.kind,
        title: v.title.trim(),
        details: v.details?.trim() || null,
        priority: v.priority,
        due_date: v.due_date || null,
        job_id: v.job_id || null,
        asset_id: v.asset_id || null,
        assignee_id: v.assignee_id || null,
        status: v.assignee_id ? "Assigned" : "Open",
        created_by: p.id,
        created_by_name: nameOf(p),
        created_at: now,
        updated_at: now,
      })
      .select()
      .single();
    if (error) return res.status(400).json({ message: error.message });
    await logActivity(task, p, "created", v.kind === "supply" ? "Supply request" : "Task");
    let alerts: any = { email: "skipped", sms: "skipped", push: 0 };
    if (task.assignee_id) {
      const [person] = await decorate([task]);
      await logActivity(task, p, "assigned", person.assignee_name);
      alerts = await alertAssignee(req, task, p);
    }
    res.json({ ...task, alerts });
  });

  app.patch("/api/board/tasks/:id", ...guard, async (req: Request, res: Response) => {
    const p = req.profile! as Who;
    const parsed = boardTaskUpdateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.errors[0].message });
    const v = parsed.data;
    const task = await loadTask(String(req.params.id));
    if (!task) return res.status(404).json({ message: "Task not found." });
    if (!canWriteArea(p, task.area)) return res.status(403).json({ message: "This area's board is view-only for you." });
    if (v.status === "Cancelled") {
      const manager = p.role === "admin" || p.role === "area" || task.created_by === p.id;
      if (!manager) return res.status(403).json({ message: "Only the person who created it or an Area Manager can cancel it." });
    }

    const patch: any = { updated_at: new Date().toISOString() };
    const notes: [string, string | null][] = [];
    for (const k of ["title", "details", "priority", "due_date", "job_id", "asset_id"] as const) {
      if (v[k] === undefined) continue;
      const nv = typeof v[k] === "string" ? (v[k] as string).trim() || null : v[k] || null;
      if (k === "title" && !nv) continue;
      if (nv !== (task[k] || null)) patch[k] = nv;
    }
    if (Object.keys(patch).length > 1) notes.push(["edited", null]);

    let reassigned = false;
    if (v.assignee_id !== undefined && (v.assignee_id || null) !== (task.assignee_id || null)) {
      patch.assignee_id = v.assignee_id || null;
      reassigned = !!v.assignee_id;
      if (task.status === "Open" && v.assignee_id && v.status === undefined) patch.status = "Assigned";
      if (!v.assignee_id && task.status === "Assigned" && v.status === undefined) patch.status = "Open";
    }
    if (v.status !== undefined && v.status !== task.status) patch.status = v.status;
    if (patch.status === "Done") {
      patch.done_at = new Date().toISOString();
      patch.done_by_name = nameOf(p);
      patch.done_by = p.id;
    } else if (patch.status && task.status === "Done") {
      patch.done_at = null;
      patch.done_by_name = null;
      patch.done_by = null;
    }

    const { data: updated, error } = await db().from("board_tasks").update(patch).eq("id", task.id).select().single();
    if (error) return res.status(400).json({ message: error.message });

    if (patch.assignee_id !== undefined) {
      const [d] = await decorate([updated]);
      notes.push([d.assignee_name ? "assigned" : "unassigned", d.assignee_name || null]);
    }
    if (patch.status && patch.status !== task.status) notes.push(["status", `${task.status} → ${patch.status}`]);
    for (const [a, d] of notes) await logActivity(updated, p, a, d);

    const alerts: any = reassigned ? await alertAssignee(req, updated, p) : { email: "skipped", sms: "skipped", push: 0 };
    if (patch.status === "Done" && task.status !== "Done") alerts.requester = await alertRequesterDone(req, updated, p);
    res.json({ ...updated, alerts });
  });

  app.post("/api/board/tasks/:id/comments", ...guard, async (req: Request, res: Response) => {
    const p = req.profile! as Who;
    const parsed = boardCommentSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.errors[0].message });
    const task = await loadTask(String(req.params.id));
    if (!task) return res.status(404).json({ message: "Task not found." });
    if (!canWriteArea(p, task.area)) return res.status(403).json({ message: "This area's board is view-only for you." });
    const { data, error } = await db()
      .from("board_task_comments")
      .insert({ task_id: task.id, author_id: p.id, author_name: nameOf(p), body: parsed.data.body.trim() })
      .select()
      .single();
    if (error) return res.status(400).json({ message: error.message });
    await db().from("board_tasks").update({ updated_at: new Date().toISOString() }).eq("id", task.id);
    // Let the requester and the assignee know (not the person commenting).
    await notifyPush("board", 
      [task.created_by, task.assignee_id].filter((id) => id && id !== p.id),
      {
        title: `${nameOf(p)} commented on ${taskNo(task.number)}`,
        body: short(parsed.data.body.trim() || "Photo", 140),
        url: `/#/board/task/${task.id}`,
        tag: `task-${task.id}`,
      },
    );
    res.json(data);
  });

  // ---- What's new ----------------------------------------------------------
  // Count of posts and new tasks from other people since I last opened each
  // area's board. Supervisors / Area Managers: their own area. Admins: all.
  const homeAreas = (p: Who) => (p.role === "admin" ? (AREAS as readonly string[]).slice() : p.area ? [p.area] : []);
  app.get("/api/board/unread", ...guard, async (req: Request, res: Response) => {
    const p = req.profile! as Who;
    const areas = homeAreas(p);
    if (!areas.length) return res.json({ total: 0, by_area: {} });
    const { data: reads } = await db().from("board_reads").select("area,seen_at").eq("user_id", p.id);
    const seen = new Map((reads || []).map((r: any) => [r.area, r.seen_at]));
    const fallback = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
    const by_area: Record<string, { count: number; posts: number; tasks: number; comments: number; seen_at: string }> = {};
    await Promise.all(
      areas.map(async (a) => {
        const since = (seen.get(a) as string) || fallback;
        const [{ data: posts }, { data: tasks }, { data: newComments }] = await Promise.all([
          db().from("board_posts").select("id,author_id").eq("area", a).is("deleted_at", null).gt("created_at", since).limit(200),
          db().from("board_tasks").select("id,created_by").eq("area", a).gt("created_at", since).limit(200),
          db().from("board_task_comments").select("id,author_id,task_id").gt("created_at", since).limit(500),
        ]);
        // Comments on this area's tasks / supply requests count too.
        const others = (newComments || []).filter((c: any) => c.author_id !== p.id);
        const taskIds = Array.from(new Set(others.map((c: any) => c.task_id)));
        const { data: inArea } = taskIds.length
          ? await db().from("board_tasks").select("id").eq("area", a).in("id", taskIds)
          : { data: [] as any[] };
        const areaIds = new Set((inArea || []).map((t: any) => t.id));
        const comments = others.filter((c: any) => areaIds.has(c.task_id));
        const posts_n = (posts || []).filter((x: any) => x.author_id !== p.id).length;
        const tasks_n = (tasks || []).filter((x: any) => x.created_by !== p.id).length;
        const comments_n = (comments || []).filter((x: any) => x.author_id !== p.id).length;
        by_area[a] = { count: posts_n + tasks_n + comments_n, posts: posts_n, tasks: tasks_n, comments: comments_n, seen_at: since };
      }),
    );
    const total = Object.values(by_area).reduce((n, x) => n + x.count, 0);
    res.json({ total, by_area });
  });

  app.post("/api/board/seen", ...guard, async (req: Request, res: Response) => {
    const p = req.profile! as Who;
    // One area ({ area }) or several at once ({ areas: [...] }).
    const asked: string[] = Array.isArray(req.body?.areas) ? req.body.areas.map(String) : [String(req.body?.area || "")];
    const list = Array.from(new Set(asked)).filter((a) => (AREAS as readonly string[]).includes(a) && canViewArea(p, a));
    if (!list.length) return res.status(400).json({ message: "Unknown area." });
    const now = new Date().toISOString();
    for (const area of list) {
      const { data: had } = await db().from("board_reads").select("user_id").eq("user_id", p.id).eq("area", area).maybeSingle();
      const { error } = had
        ? await db().from("board_reads").update({ seen_at: now }).eq("user_id", p.id).eq("area", area)
        : await db().from("board_reads").insert({ user_id: p.id, area, seen_at: now });
      if (error) return res.status(400).json({ message: error.message });
    }
    res.json({ ok: true });
  });

  // ---- Dashboard card: my open tasks (every area) + my open requests -------
  app.get("/api/board/my-tasks", ...guard, async (req: Request, res: Response) => {
    const p = req.profile! as Who;
    const [{ data: mine }, { data: asked }] = await Promise.all([
      db().from("board_tasks").select("*").eq("assignee_id", p.id).in("status", OPEN_STATUSES).order("created_at", { ascending: false }).limit(50),
      db().from("board_tasks").select("*").eq("created_by", p.id).in("status", OPEN_STATUSES).order("created_at", { ascending: false }).limit(50),
    ]);
    const today = todayCentral();
    const rank = (t: any) => (t.due_date && t.due_date < today ? 0 : t.priority === "Urgent" ? 1 : t.priority === "High" ? 2 : 3);
    const sorted = (mine || []).sort((a: any, b: any) => rank(a) - rank(b) || String(a.due_date || "9999").localeCompare(String(b.due_date || "9999")));
    res.json({
      assigned: await decorate(sorted),
      requested: await decorate((asked || []).filter((t: any) => t.assignee_id !== p.id)),
      today,
    });
  });

  // ---- Phone alerts (web push) ---------------------------------------------
  app.get("/api/board/push/key", requireAuth, async (_req: Request, res: Response) => {
    const k = await getPushKeys();
    if (!k) return res.status(503).json({ message: "Phone alerts aren't set up yet — run the Area Board SQL in Supabase." });
    res.json({ key: k.publicKey });
  });

  app.post("/api/board/push/subscribe", requireAuth, async (req: Request, res: Response) => {
    const parsed = boardPushSubscribeSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "That phone didn't send a valid alert subscription." });
    const v = parsed.data;
    const row = {
      user_id: req.profile!.id,
      endpoint: v.endpoint,
      p256dh: v.keys.p256dh,
      auth: v.keys.auth,
      user_agent: String(req.get("user-agent") || "").slice(0, 300),
    };
    const { data: had } = await db().from("board_push_subscriptions").select("id").eq("endpoint", v.endpoint).maybeSingle();
    const { error } = had
      ? await db().from("board_push_subscriptions").update(row).eq("id", had.id)
      : await db().from("board_push_subscriptions").insert(row);
    if (error) return res.status(400).json({ message: error.message });
    res.json({ ok: true });
  });

  app.post("/api/board/push/unsubscribe", requireAuth, async (req: Request, res: Response) => {
    const endpoint = String(req.body?.endpoint || "");
    if (endpoint) await db().from("board_push_subscriptions").delete().eq("endpoint", endpoint).eq("user_id", req.profile!.id);
    res.json({ ok: true });
  });

  app.post("/api/board/push/test", requireAuth, async (req: Request, res: Response) => {
    const r = await sendPush([req.profile!.id], {
      title: "DFS Ops test alert",
      body: "Phone alerts are working. Tap to open the board.",
      url: "/#/board",
      tag: "test",
    });
    res.json(r);
  });

  // ---- My task alert settings ---------------------------------------------
  app.get("/api/board/alert-prefs", requireAuth, async (req: Request, res: Response) => {
    const { data } = await db()
      .from("notification_prefs")
      .select("phone,task_email,task_sms")
      .eq("user_id", req.profile!.id)
      .maybeSingle();
    res.json({
      phone: data?.phone || "",
      task_email: data?.task_email !== false,
      task_sms: !!data?.task_sms,
      email_ready: boardEmailReady(),
      sms_ready: smsConfigured(),
    });
  });

  // Which kinds of phone alerts I want (Settings → Task alerts).
  app.get("/api/alert-prefs/push", requireAuth, async (req: Request, res: Response) => {
    const role = req.profile!.role;
    const { data, error } = await db()
      .from("notification_prefs")
      .select("push_prefs")
      .eq("user_id", req.profile!.id)
      .maybeSingle();
    const saved = ((data as any)?.push_prefs || {}) as Record<string, boolean>;
    res.json({
      ready: !error || !/push_prefs/.test(error.message),
      kinds: ALERT_KINDS.filter((k) => k.roles.includes(role as any)).map((k) => ({
        key: k.key,
        label: k.label,
        desc: k.desc,
        on: alertOn(k.key, role, saved),
      })),
    });
  });

  app.put("/api/alert-prefs/push", requireAuth, async (req: Request, res: Response) => {
    const key = String(req.body?.key || "");
    const on = req.body?.on;
    const def = ALERT_KINDS.find((k) => k.key === key);
    if (!def || typeof on !== "boolean" || !def.roles.includes(req.profile!.role as any))
      return res.status(400).json({ message: "Unknown alert." });
    const { data: existing, error: rErr } = await db()
      .from("notification_prefs")
      .select("user_id,push_prefs")
      .eq("user_id", req.profile!.id)
      .maybeSingle();
    if (rErr && /push_prefs/.test(rErr.message))
      return res.status(400).json({ message: "Run the Phone alert choices setup SQL in Supabase first." });
    const push_prefs = { ...(((existing as any)?.push_prefs as any) || {}), [key]: on };
    const { error } = existing
      ? await db().from("notification_prefs").update({ push_prefs }).eq("user_id", req.profile!.id)
      : await db().from("notification_prefs").insert({ user_id: req.profile!.id, push_prefs });
    if (error) return res.status(400).json({ message: error.message });
    res.json({ ok: true, key, on });
  });

  app.get("/api/board/push/devices", requireAuth, async (req: Request, res: Response) => {
    const { data } = await db().from("board_push_subscriptions").select("id,user_agent,created_at").eq("user_id", req.profile!.id);
    res.json({ count: (data || []).length });
  });

  app.put("/api/board/alert-prefs", requireAuth, async (req: Request, res: Response) => {
    const parsed = boardAlertPrefsSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.errors[0].message });
    const v = parsed.data;
    const phone = v.phone ? normalizeUsPhone(v.phone) : null;
    if (v.phone && !phone) return res.status(400).json({ message: "Enter a 10-digit US cell number." });
    if (v.task_sms && !phone) return res.status(400).json({ message: "Add your cell number to get texts." });
    const { data: existing } = await db()
      .from("notification_prefs")
      .select("user_id,task_sms,sms_consent_at")
      .eq("user_id", req.profile!.id)
      .maybeSingle();
    const row: any = { user_id: req.profile!.id, phone, task_email: v.task_email, task_sms: v.task_sms };
    if (v.task_sms && !existing?.task_sms) row.sms_consent_at = new Date().toISOString();
    const { error } = existing
      ? await db().from("notification_prefs").update(row).eq("user_id", req.profile!.id)
      : await db().from("notification_prefs").insert(row);
    if (error) return res.status(400).json({ message: error.message });
    res.json({ ok: true, phone: phone || "" });
  });

  // Send myself a test email / text so people can check it works.
  app.post("/api/board/alert-prefs/test", requireAuth, async (req: Request, res: Response) => {
    const p = req.profile! as Who;
    const { data } = await db().from("notification_prefs").select("phone,task_sms").eq("user_id", p.id).maybeSingle();
    const link = `${appUrl(req)}/#/board`;
    const email = p.email
      ? await sendBoardEmail(
          p.email,
          "DFS Ops test: task alerts are working",
          `<p style="font-family:Arial,sans-serif">This is a test. When someone assigns you a task on the area board you'll get an email like this.</p><p><a href="${link}">Open the board</a></p>`,
          `This is a test. When someone assigns you a task on the area board you'll get an email like this.\n${link}`,
        ).catch(() => ({ ok: false, error: "Email failed." }) as any)
      : { ok: false, error: "Your account has no email." };
    let sms: { ok: boolean; error?: string } = { ok: false, error: "Texts are off." };
    if (data?.task_sms && data?.phone) sms = await sendSms(data.phone, "DFS Ops: test text. Task alerts are working. Reply STOP to opt out.");
    res.json({ email, sms });
  });
}
