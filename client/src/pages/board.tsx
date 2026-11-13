import { useEffect, useMemo, useState } from "react";
import { AssetModelLine } from "@/lib/assetModel";
import { useLocation, useRoute } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { PhotoPicker, PhotoGrid, uploadBoardPhotos } from "@/components/BoardPhotos";
import { PhoneAlertsPrompt } from "@/components/PhoneAlerts";
import type { BoardUnread } from "@/lib/boardUnread";
import {
  MessagesSquare,
  ListChecks,
  CheckCircle2,
  Plus,
  Package,
  Loader2,
  Eye,
  MessageCircle,
  Calendar,
  Briefcase,
  User,
  Pencil,
  Trash2,
  CornerDownRight,
  Play,
  Hand,
  RotateCcw,
  XCircle,
  Boxes,
  Pin,
  PinOff,
  Check,
  Camera,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { ROLE_LABELS, BOARD_PRIORITIES, type BoardPost, type BoardTask, type BoardPriority, type BoardFile } from "@shared/schema";

export type Meta = {
  area: string;
  areas: string[];
  can_write: boolean;
  members: { id: string; name: string; role: keyof typeof ROLE_LABELS; area: string | null }[];
  jobs: { id: string; job_number: string; well_name: string | null }[];
  assets: { id: string; label: string; category?: string; description?: string | null }[];
  email_ready: boolean;
  sms_ready: boolean;
};
type TaskDetail = BoardTask & {
  can_write: boolean;
  comments: { id: string; author_id?: string | null; author_name: string | null; body: string; created_at: string; files?: BoardFile[] }[];
  activity: { id: string; actor_name: string | null; action: string; detail: string | null; created_at: string }[];
};

const NONE = "__none__";
const AREA_KEY = "dfs.board.area";

function when(ts: string | null | undefined): string {
  if (!ts) return "";
  const d = new Date(ts);
  const diff = Date.now() - d.getTime();
  const min = Math.round(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
function shortDate(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Date(iso.slice(0, 10) + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const PRIORITY_STYLE: Record<BoardPriority, string> = {
  Low: "bg-muted text-muted-foreground border-transparent",
  Normal: "bg-secondary text-secondary-foreground border-transparent",
  High: "bg-amber-100 text-amber-900 border-amber-200 dark:bg-amber-900/30 dark:text-amber-200 dark:border-amber-800",
  Urgent: "bg-red-100 text-red-900 border-red-200 dark:bg-red-900/30 dark:text-red-200 dark:border-red-800",
};
const STATUS_STYLE: Record<string, string> = {
  Open: "bg-sky-100 text-sky-900 border-sky-200 dark:bg-sky-900/30 dark:text-sky-200 dark:border-sky-800",
  Assigned: "bg-violet-100 text-violet-900 border-violet-200 dark:bg-violet-900/30 dark:text-violet-200 dark:border-violet-800",
  "In progress": "bg-amber-100 text-amber-900 border-amber-200 dark:bg-amber-900/30 dark:text-amber-200 dark:border-amber-800",
  Done: "bg-emerald-100 text-emerald-900 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-200 dark:border-emerald-800",
  Cancelled: "bg-muted text-muted-foreground border-transparent line-through",
};

function photoToast(toast: ReturnType<typeof useToast>["toast"], failed: number) {
  if (failed) toast({ title: `${failed} photo${failed > 1 ? "s" : ""} didn't upload`, description: "Try adding it again.", variant: "destructive" });
}

function invalidateBoard() {
  queryClient.invalidateQueries({
    predicate: (q) => typeof q.queryKey[0] === "string" && (q.queryKey[0] as string).startsWith("/api/board"),
  });
  queryClient.invalidateQueries({ queryKey: ["/api/notifications"] });
}

function alertToast(toast: ReturnType<typeof useToast>["toast"], alerts: any, who: string | null) {
  if (!alerts || !who) return;
  const bits: string[] = [];
  if (alerts.email === "sent") bits.push("email");
  if (alerts.sms === "sent") bits.push("text");
  if (alerts.push > 0) bits.push("phone alert");
  if (bits.length) toast({ title: `${who} was notified by ${bits.join(" and ")}` });
  else if (alerts.email === "failed" || alerts.sms === "failed")
    toast({ title: "Saved, but the alert didn't send", description: `${who} will still see it in their bell.`, variant: "destructive" });
}

// ===========================================================================
export default function BoardPage() {
  const { profile } = useAuth();
  const [, navigate] = useLocation();
  const [, taskParams] = useRoute("/board/task/:id");
  const openTaskId = taskParams?.id || null;

  const [area, setArea] = useState<string>(() => localStorage.getItem(AREA_KEY) || profile?.area || "");
  const [tab, setTab] = useState<"feed" | "tasks" | "done">(openTaskId ? "tasks" : "feed");

  const { data: meta, isLoading } = useQuery<Meta>({
    queryKey: [`/api/board/meta?area=${encodeURIComponent(area)}`],
  });
  useEffect(() => {
    if (meta?.area && meta.area !== area) setArea(meta.area);
  }, [meta?.area]);
  const changeArea = (a: string) => {
    setArea(a);
    localStorage.setItem(AREA_KEY, a);
  };

  // "What's new": remember when I last looked at this area (to mark newer
  // posts "New"), then record that I've seen it now.
  const { data: unread } = useQuery<BoardUnread>({ queryKey: ["/api/board/unread"] });
  const [seenSnap, setSeenSnap] = useState<Record<string, string>>({});
  useEffect(() => {
    const a = meta?.area;
    if (!a || !unread || a in seenSnap) return;
    setSeenSnap((m) => ({ ...m, [a]: unread.by_area?.[a]?.seen_at || "" }));
    if (unread.by_area?.[a])
      apiRequest("POST", "/api/board/seen", { area: a })
        .then(() => queryClient.invalidateQueries({ queryKey: ["/api/board/unread"] }))
        .catch(() => {});
  }, [meta?.area, unread]);

  if (isLoading || !meta) {
    return (
      <div className="p-6 flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading the board…
      </div>
    );
  }
  const readOnly = !meta.can_write;

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-6xl mx-auto">
      <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <MessagesSquare className="h-6 w-6 text-primary" />
            <h1 className="text-2xl font-semibold tracking-tight">{meta.area} Board</h1>
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            Post updates, hand out tasks and ask for supplies for your area.
          </p>
        </div>
        {meta.areas.length > 1 && (
          <Select value={meta.area} onValueChange={changeArea}>
            <SelectTrigger className="w-full md:w-56" data-testid="select-board-area">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {meta.areas.map((a) => (
                <SelectItem key={a} value={a}>
                  {a}
                  {profile?.role === "area" && a !== profile.area ? " (view only)" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {readOnly && (
        <div className="flex items-center gap-2 rounded-md border bg-muted/50 px-3 py-2 text-sm text-muted-foreground" data-testid="banner-view-only">
          <Eye className="h-4 w-4" /> You're viewing the {meta.area} board. You can read it, but posting and task changes are for that area's team.
        </div>
      )}

      {!readOnly && <PhoneAlertsPrompt />}

      <div className="flex gap-1 border-b">
        {[
          { k: "feed", label: "Feed", icon: MessagesSquare },
          { k: "tasks", label: "Tasks", icon: ListChecks },
          { k: "done", label: "Done", icon: CheckCircle2 },
        ].map((t) => {
          const Icon = t.icon;
          const on = tab === t.k;
          return (
            <button
              key={t.k}
              onClick={() => setTab(t.k as any)}
              className={`flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                on ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
              data-testid={`tab-board-${t.k}`}
            >
              <Icon className="h-4 w-4" />
              {t.label}
            </button>
          );
        })}
      </div>

      {tab === "feed" && <Feed meta={meta} readOnly={readOnly} seenAt={seenSnap[meta.area] || ""} />}
      {tab === "tasks" && <Tasks meta={meta} readOnly={readOnly} onOpen={(id) => navigate(`/board/task/${id}`)} />}
      {tab === "done" && <DoneList meta={meta} onOpen={(id) => navigate(`/board/task/${id}`)} />}

      {openTaskId && <TaskDialog id={openTaskId} meta={meta} onClose={() => navigate("/board")} />}
    </div>
  );
}

// ---- Feed -----------------------------------------------------------------
function Feed({ meta, readOnly, seenAt }: { meta: Meta; readOnly: boolean; seenAt: string }) {
  const { profile } = useAuth();
  const { toast } = useToast();
  const key = `/api/board/posts?area=${encodeURIComponent(meta.area)}`;
  const { data: posts = [], isLoading } = useQuery<BoardPost[]>({ queryKey: [key], refetchInterval: 60_000 });
  const [body, setBody] = useState("");
  const [jobId, setJobId] = useState<string>(NONE);
  const [photos, setPhotos] = useState<File[]>([]);
  const [pin, setPin] = useState(false);
  const [needsAck, setNeedsAck] = useState(false);
  const manager = profile?.role === "admin" || (profile?.role === "area" && profile.area === meta.area);

  const post = useMutation({
    mutationFn: async (v: { body: string; parent_id?: string; job_id?: string | null; photos?: File[]; pin?: boolean; needs_ack?: boolean }) => {
      const { photos: files, ...rest } = v;
      const created = await (await apiRequest("POST", "/api/board/posts", { area: meta.area, ...rest, has_photos: !!files?.length })).json();
      const failed = files?.length ? await uploadBoardPhotos({ post_id: created.id }, files) : 0;
      return { created, failed };
    },
    onSuccess: (r) => {
      invalidateBoard();
      photoToast(toast, r.failed);
    },
    onError: (e: any) => toast({ title: "Couldn't post", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-4 max-w-3xl">
      {!readOnly && (
        <div className="rounded-lg border bg-card p-3 space-y-2">
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={`Share an update with the ${meta.area} team…`}
            rows={3}
            data-testid="input-post-body"
          />
          {manager && (
            <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
              <label className="flex items-center gap-2 cursor-pointer min-h-8">
                <Checkbox checked={pin || needsAck} onCheckedChange={(v) => { setPin(!!v); if (!v) setNeedsAck(false); }} data-testid="check-post-pin" />
                <Pin className="h-3.5 w-3.5 text-muted-foreground" /> Pin to the top
              </label>
              <label className="flex items-center gap-2 cursor-pointer min-h-8">
                <Checkbox checked={needsAck} onCheckedChange={(v) => { setNeedsAck(!!v); if (v) setPin(true); }} data-testid="check-post-ack" />
                <Check className="h-3.5 w-3.5 text-muted-foreground" /> Ask everyone to tap "Got it"
              </label>
            </div>
          )}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
            <PhotoPicker files={photos} onChange={setPhotos} />
            <Select value={jobId} onValueChange={setJobId}>
              <SelectTrigger className="w-full sm:w-64 h-9" data-testid="select-post-job">
                <SelectValue placeholder="Tag a job (optional)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>No job tag</SelectItem>
                {meta.jobs.map((j) => (
                  <SelectItem key={j.id} value={j.id}>
                    {j.job_number}
                    {j.well_name ? ` · ${j.well_name}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            </div>
            <Button
              className="max-sm:h-11"
              disabled={(!body.trim() && !photos.length) || post.isPending}
              onClick={() =>
                post.mutate(
                  { body, job_id: jobId === NONE ? null : jobId, photos, pin: pin || needsAck, needs_ack: needsAck },
                  { onSuccess: () => { setBody(""); setJobId(NONE); setPhotos([]); setPin(false); setNeedsAck(false); } },
                )
              }
              data-testid="button-post"
            >
              {post.isPending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />} Post
            </Button>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="text-sm text-muted-foreground flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading posts…
        </div>
      ) : posts.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          No posts yet on the {meta.area} board.
        </div>
      ) : (
        posts.map((p) => (
          <PostCard
            key={p.id}
            post={p}
            meta={meta}
            readOnly={readOnly}
            meId={profile?.id || ""}
            seenAt={seenAt}
            onReply={(b, files) => post.mutateAsync({ body: b, parent_id: p.id, photos: files })}
          />
        ))
      )}
    </div>
  );
}

function PostCard({
  post,
  meta,
  readOnly,
  meId,
  seenAt,
  onReply,
}: {
  post: BoardPost;
  meta: Meta;
  readOnly: boolean;
  meId: string;
  seenAt: string;
  onReply: (body: string, files: File[]) => Promise<any>;
}) {
  const [replying, setReplying] = useState(false);
  const [reply, setReply] = useState("");
  const [replyPhotos, setReplyPhotos] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const pinned = !!post.pinned_at;
  return (
    <div
      className={`rounded-lg border p-4 ${pinned ? "bg-amber-50/70 border-amber-300 dark:bg-amber-950/20 dark:border-amber-800" : "bg-card"}`}
      data-testid={`post-${post.id}`}
    >
      <PostBody post={post} meta={meta} meId={meId} seenAt={seenAt} />
      {post.ack && <AckBar post={post} canAck={!readOnly && post.author_id !== meId} />}
      {(post.replies?.length || 0) > 0 && (
        <div className="mt-3 space-y-3 border-l-2 pl-4 ml-1">
          {post.replies!.map((r) => (
            <PostBody key={r.id} post={r} meta={meta} meId={meId} seenAt={seenAt} small />
          ))}
        </div>
      )}
      {!readOnly &&
        (replying ? (
          <div className="mt-3 space-y-2">
            <Textarea value={reply} onChange={(e) => setReply(e.target.value)} rows={2} placeholder="Write a reply…" autoFocus data-testid={`input-reply-${post.id}`} />
            <div className="flex gap-2 justify-end items-center flex-wrap">
              <div className="mr-auto">
                <PhotoPicker files={replyPhotos} onChange={setReplyPhotos} compact testId={`button-reply-photo-${post.id}`} />
              </div>
              <Button variant="ghost" size="sm" onClick={() => { setReplying(false); setReply(""); setReplyPhotos([]); }}>
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={(!reply.trim() && !replyPhotos.length) || busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await onReply(reply, replyPhotos);
                    setReply("");
                    setReplyPhotos([]);
                    setReplying(false);
                  } finally {
                    setBusy(false);
                  }
                }}
                data-testid={`button-send-reply-${post.id}`}
              >
                Reply
              </Button>
            </div>
          </div>
        ) : (
          <button onClick={() => setReplying(true)} className="mt-2 -ml-1 px-1 py-1.5 text-sm md:text-xs font-medium text-muted-foreground hover:text-foreground flex items-center gap-1" data-testid={`button-reply-${post.id}`}>
            <CornerDownRight className="h-3.5 w-3.5" /> Reply
          </button>
        ))}
    </div>
  );
}

function PostBody({ post, meta, meId, seenAt, small }: { post: BoardPost; meta: Meta; meId: string; seenAt: string; small?: boolean }) {
  const { profile } = useAuth();
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(post.body);
  const mine = post.author_id === meId;
  const manager = profile?.role === "admin" || (profile?.role === "area" && profile.area === post.area);
  const canRemove = mine || manager;
  const isNew = !!seenAt && !mine && post.created_at > seenAt;
  const pin = async (pinned: boolean) => {
    try {
      await apiRequest("POST", `/api/board/posts/${post.id}/pin`, { pinned });
      invalidateBoard();
    } catch (e: any) {
      toast({ title: "Couldn't change the pin", description: e.message, variant: "destructive" });
    }
  };
  const save = async () => {
    try {
      await apiRequest("PATCH", `/api/board/posts/${post.id}`, { body: text });
      setEditing(false);
      invalidateBoard();
    } catch (e: any) {
      toast({ title: "Couldn't save", description: e.message, variant: "destructive" });
    }
  };
  const remove = async () => {
    if (!confirm("Remove this post?")) return;
    try {
      await apiRequest("DELETE", `/api/board/posts/${post.id}`);
      invalidateBoard();
    } catch (e: any) {
      toast({ title: "Couldn't remove", description: e.message, variant: "destructive" });
    }
  };
  return (
    <div>
      <div className="flex items-center gap-2 flex-wrap">
        {!small && post.pinned_at && (
          <span className="inline-flex items-center gap-1 text-xs font-semibold text-amber-800 dark:text-amber-300" data-testid={`label-pinned-${post.id}`}>
            <Pin className="h-3 w-3" /> Pinned
          </span>
        )}
        <span className={`font-medium ${small ? "text-sm" : ""}`}>{post.author_name || "Someone"}</span>
        {isNew && <Badge className="text-[10px] px-1.5 py-0 bg-red-600 text-white border-transparent hover:bg-red-600" data-testid={`badge-new-${post.id}`}>New</Badge>}
        <span className="text-xs text-muted-foreground">{when(post.created_at)}</span>
        {post.edited_at && <span className="text-xs text-muted-foreground">(edited)</span>}
        {post.job_number && (
          <Badge variant="outline" className="text-xs gap-1">
            <Briefcase className="h-3 w-3" /> {post.job_number}
          </Badge>
        )}
        <div className="ml-auto flex items-center gap-1">
          {!small && manager && !editing && (
            <button
              onClick={() => pin(!post.pinned_at)}
              className="p-2 md:p-1 text-muted-foreground hover:text-foreground"
              aria-label={post.pinned_at ? "Unpin post" : "Pin post"}
              title={post.pinned_at ? "Unpin" : "Pin to the top"}
              data-testid={`button-pin-${post.id}`}
            >
              {post.pinned_at ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
            </button>
          )}
          {mine && meta.can_write && !editing && (
            <button onClick={() => setEditing(true)} className="p-2 md:p-1 text-muted-foreground hover:text-foreground" aria-label="Edit post">
              <Pencil className="h-3.5 w-3.5" />
            </button>
          )}
          {canRemove && !editing && (
            <button onClick={remove} className="p-2 md:p-1 text-muted-foreground hover:text-destructive" aria-label="Remove post">
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
      {editing ? (
        <div className="mt-2 space-y-2">
          <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} />
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" size="sm" onClick={() => { setEditing(false); setText(post.body); }}>
              Cancel
            </Button>
            <Button size="sm" disabled={!text.trim()} onClick={save}>
              Save
            </Button>
          </div>
        </div>
      ) : (
        <>
          {post.body && <p className={`mt-1 whitespace-pre-wrap break-words ${small ? "text-sm" : "text-[15px]"}`}>{post.body}</p>}
          <PhotoGrid files={post.files} small={small} canDelete={canRemove} onDeleted={invalidateBoard} />
        </>
      )}
    </div>
  );
}

// "Got it" bar on a post that asks for it. Managers / the writer see who
// hasn't tapped it yet.
function AckBar({ post, canAck }: { post: BoardPost; canAck: boolean }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const a = post.ack!;
  const ack = async () => {
    setBusy(true);
    try {
      await apiRequest("POST", `/api/board/posts/${post.id}/ack`);
      invalidateBoard();
    } catch (e: any) {
      toast({ title: "Couldn't save", description: e.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };
  const all = a.total > 0 && a.done >= a.total;
  return (
    <div className="mt-3 rounded-md border bg-background/70 p-2.5 space-y-2" data-testid={`ack-${post.id}`}>
      <div className="flex items-center gap-2 flex-wrap">
        {canAck &&
          (a.mine ? (
            <span className="inline-flex items-center gap-1.5 text-sm font-medium text-emerald-700 dark:text-emerald-400 h-9" data-testid={`ack-mine-${post.id}`}>
              <CheckCircle2 className="h-4 w-4" /> You tapped Got it
            </span>
          ) : (
            <Button size="sm" className="max-sm:h-11 max-sm:flex-1" disabled={busy} onClick={ack} data-testid={`button-ack-${post.id}`}>
              {busy ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Check className="h-4 w-4 mr-1.5" />} Got it
            </Button>
          ))}
        <button
          onClick={() => setOpen((o) => !o)}
          className="ml-auto inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground min-h-9"
          data-testid={`button-ack-count-${post.id}`}
        >
          <span className={`tabular-nums font-medium ${all ? "text-emerald-700 dark:text-emerald-400" : "text-foreground"}`}>
            {a.done} of {a.total}
          </span>{" "}
          got it
          {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </button>
      </div>
      {open && (
        <div className="text-xs space-y-1.5">
          {a.missing && a.missing.length > 0 && (
            <div data-testid={`ack-missing-${post.id}`}>
              <span className="font-medium text-foreground">Still waiting on: </span>
              <span className="text-muted-foreground">{a.missing.join(", ")}</span>
            </div>
          )}
          {a.acked.length > 0 && (
            <div>
              <span className="font-medium text-foreground">Got it: </span>
              <span className="text-muted-foreground">{a.acked.map((x) => x.name).join(", ")}</span>
            </div>
          )}
          {!a.acked.length && !a.missing?.length && <div className="text-muted-foreground">No one yet.</div>}
        </div>
      )}
    </div>
  );
}

// ---- Tasks ----------------------------------------------------------------
function Tasks({ meta, readOnly, onOpen }: { meta: Meta; readOnly: boolean; onOpen: (id: string) => void }) {
  const { profile } = useAuth();
  const key = `/api/board/tasks?area=${encodeURIComponent(meta.area)}&view=open`;
  const { data: tasks = [], isLoading } = useQuery<BoardTask[]>({ queryKey: [key], refetchInterval: 60_000 });
  const [filter, setFilter] = useState<"all" | "mine" | "unassigned" | "supply">("all");
  const [creating, setCreating] = useState<null | "task" | "supply">(null);
  const [phoneCol, setPhoneCol] = useState<string>("Open");

  const shown = useMemo(() => {
    return tasks.filter((t) =>
      filter === "mine" ? t.assignee_id === profile?.id : filter === "unassigned" ? !t.assignee_id : filter === "supply" ? t.kind === "supply" : true,
    );
  }, [tasks, filter, profile?.id]);
  const cols: { status: string; label: string }[] = [
    { status: "Open", label: "Open" },
    { status: "Assigned", label: "Assigned" },
    { status: "In progress", label: "In progress" },
  ];
  const count = (f: typeof filter) =>
    tasks.filter((t) => (f === "mine" ? t.assignee_id === profile?.id : f === "unassigned" ? !t.assignee_id : f === "supply" ? t.kind === "supply" : true)).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="flex gap-1.5 overflow-x-auto -mx-4 px-4 pb-1 md:mx-0 md:px-0 md:pb-0 md:flex-wrap md:overflow-visible">
          {[
            { k: "all", label: "All open" },
            { k: "mine", label: "Assigned to me" },
            { k: "unassigned", label: "Unassigned" },
            { k: "supply", label: "Supply requests" },
          ].map((f) => (
            <button
              key={f.k}
              onClick={() => setFilter(f.k as any)}
              className={`shrink-0 whitespace-nowrap rounded-full border px-3 py-1.5 md:py-1 text-sm md:text-xs font-medium transition-colors ${
                filter === f.k ? "bg-primary text-primary-foreground border-primary" : "bg-card text-muted-foreground hover:text-foreground"
              }`}
              data-testid={`filter-tasks-${f.k}`}
            >
              {f.label} <span className="opacity-70 tabular-nums">{count(f.k as any)}</span>
            </button>
          ))}
        </div>
        {!readOnly && (
          <div className="grid grid-cols-2 gap-2 md:flex">
            <Button variant="outline" className="max-md:h-11" onClick={() => setCreating("supply")} data-testid="button-new-supply">
              <Package className="h-4 w-4 mr-1.5" /> Supply request
            </Button>
            <Button className="max-md:h-11" onClick={() => setCreating("task")} data-testid="button-new-task">
              <Plus className="h-4 w-4 mr-1.5" /> New task
            </Button>
          </div>
        )}
      </div>

      {isLoading ? (
        <div className="text-sm text-muted-foreground flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading tasks…
        </div>
      ) : (
        <>
        {/* Phone: one column at a time */}
        <div className="grid grid-cols-3 rounded-lg border bg-muted/40 p-1 md:hidden" data-testid="phone-status-switch">
          {cols.map((c) => {
            const n = shown.filter((t) => t.status === c.status).length;
            const on = phoneCol === c.status;
            return (
              <button
                key={c.status}
                onClick={() => setPhoneCol(c.status)}
                className={`rounded-md py-2 text-sm font-medium transition-colors ${on ? "bg-card shadow-sm text-foreground" : "text-muted-foreground"}`}
                data-testid={`phone-col-${c.status}`}
              >
                {c.label} <span className="tabular-nums opacity-70">{n}</span>
              </button>
            );
          })}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {cols.map((c) => {
            const list = shown.filter((t) => t.status === c.status);
            return (
              <div key={c.status} className={`rounded-lg bg-muted/40 border p-2.5 min-h-[120px] ${phoneCol === c.status ? "" : "max-md:hidden"}`} data-testid={`column-${c.status}`}>
                <div className="flex items-center justify-between px-1 pb-2">
                  <span className="text-sm font-semibold">{c.label}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">{list.length}</span>
                </div>
                <div className="space-y-2">
                  {list.length === 0 && <div className="text-xs text-muted-foreground px-1 py-3">Nothing here.</div>}
                  {list.map((t) => (
                    <TaskCard key={t.id} t={t} onOpen={() => onOpen(t.id)} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        </>
      )}

      {creating && <NewTaskDialog meta={meta} kind={creating} onClose={() => setCreating(null)} />}
    </div>
  );
}

export function TaskCard({ t, onOpen }: { t: BoardTask; onOpen: () => void }) {
  const overdue = !!t.due_date && t.due_date < todayIso() && t.status !== "Done" && t.status !== "Cancelled";
  return (
    <button onClick={onOpen} className="w-full text-left rounded-md border bg-card p-3 hover:border-primary/50 transition-colors" data-testid={`task-card-${t.id}`}>
      <div className="flex items-center gap-1.5 flex-wrap text-xs">
        <span className="font-mono text-muted-foreground">T-{t.number}</span>
        {t.kind === "supply" && (
          <Badge variant="outline" className="text-[11px] gap-1 py-0">
            <Package className="h-3 w-3" /> Supply
          </Badge>
        )}
        {t.priority !== "Normal" && <Badge className={`text-[11px] py-0 ${PRIORITY_STYLE[t.priority]}`}>{t.priority}</Badge>}
      </div>
      <div className="mt-1 text-sm font-medium leading-snug">{t.title}</div>
      <div className="mt-2 flex items-center gap-3 flex-wrap text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <User className="h-3 w-3" /> {t.assignee_name || "Anyone"}
        </span>
        {t.due_date && (
          <span className={`flex items-center gap-1 ${overdue ? "text-red-600 dark:text-red-400 font-medium" : ""}`}>
            <Calendar className="h-3 w-3" /> {overdue ? "Overdue " : ""}
            {shortDate(t.due_date)}
          </span>
        )}
        {t.job_number && (
          <span className="flex items-center gap-1">
            <Briefcase className="h-3 w-3" /> {t.job_number}
          </span>
        )}
        {t.comment_count > 0 && (
          <span className="flex items-center gap-1">
            <MessageCircle className="h-3 w-3" /> {t.comment_count}
          </span>
        )}
        {(t.photo_count || 0) > 0 && (
          <span className="flex items-center gap-1">
            <Camera className="h-3 w-3" /> {t.photo_count}
          </span>
        )}
      </div>
    </button>
  );
}

function DoneList({ meta, onOpen }: { meta: Meta; onOpen: (id: string) => void }) {
  const key = `/api/board/tasks?area=${encodeURIComponent(meta.area)}&view=done`;
  const { data: tasks = [], isLoading } = useQuery<BoardTask[]>({ queryKey: [key] });
  if (isLoading)
    return (
      <div className="text-sm text-muted-foreground flex items-center gap-2">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  if (!tasks.length) return <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">No finished tasks yet.</div>;
  return (
    <div className="rounded-lg border bg-card divide-y">
      {tasks.map((t) => (
        <button key={t.id} onClick={() => onOpen(t.id)} className="w-full text-left px-4 py-3 hover:bg-muted/40 flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-4" data-testid={`done-row-${t.id}`}>
          <span className="font-mono text-xs text-muted-foreground w-16 shrink-0">T-{t.number}</span>
          <span className="flex-1 min-w-0 text-sm font-medium truncate">
            {t.kind === "supply" && <Package className="inline h-3.5 w-3.5 mr-1 -mt-0.5 text-muted-foreground" />}
            {t.title}
          </span>
          <Badge className={`text-[11px] w-fit ${STATUS_STYLE[t.status]}`}>{t.status}</Badge>
          <span className="text-xs text-muted-foreground sm:w-48 sm:text-right">
            {t.status === "Done" ? `${t.done_by_name || "—"} · ${when(t.done_at)}` : when(t.updated_at)}
          </span>
        </button>
      ))}
    </div>
  );
}

// ---- New task / supply request ---------------------------------------------
export function NewTaskDialog({
  meta,
  kind: initialKind,
  onClose,
  presetJobId,
  presetAssetId,
  presetLabel,
  allowKindSwitch,
}: {
  meta: Meta;
  kind: "task" | "supply";
  onClose: () => void;
  presetJobId?: string | null;
  presetAssetId?: string | null;
  // Shown under the title, e.g. "From job WT-2214" when opened from a job page.
  presetLabel?: string;
  allowKindSwitch?: boolean;
}) {
  const { toast } = useToast();
  const [kind, setKind] = useState<"task" | "supply">(initialKind);
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [priority, setPriority] = useState<BoardPriority>("Normal");
  const [due, setDue] = useState("");
  const [jobId, setJobId] = useState(presetJobId || NONE);
  const [assetId, setAssetId] = useState(presetAssetId || NONE);
  const [assignee, setAssignee] = useState(NONE);
  const [photos, setPhotos] = useState<File[]>([]);
  const supply = kind === "supply";
  // A job/asset passed in from another page may not be in this board's list
  // (e.g. an asset sitting in another area) — keep it selectable anyway.
  const jobs = presetJobId && !meta.jobs.some((j) => j.id === presetJobId) && presetLabel
    ? [...meta.jobs, { id: presetJobId, job_number: presetLabel, well_name: null }]
    : meta.jobs;
  const assets = presetAssetId && !meta.assets.some((a) => a.id === presetAssetId) && presetLabel
    ? [...meta.assets, { id: presetAssetId, label: presetLabel }]
    : meta.assets;

  const create = useMutation({
    mutationFn: async () => {
      const t = await (
        await apiRequest("POST", "/api/board/tasks", {
          area: meta.area,
          kind,
          title,
          details: details || null,
          priority,
          due_date: due || null,
          job_id: jobId === NONE ? null : jobId,
          asset_id: assetId === NONE ? null : assetId,
          assignee_id: assignee === NONE ? null : assignee,
        })
      ).json();
      t.failed = photos.length ? await uploadBoardPhotos({ task_id: t.id }, photos) : 0;
      return t;
    },
    onSuccess: (t: any) => {
      invalidateBoard();
      toast({ title: `${supply ? "Supply request" : "Task"} T-${t.number} added` });
      photoToast(toast, t.failed);
      alertToast(toast, t.alerts, meta.members.find((m) => m.id === t.assignee_id)?.name || null);
      onClose();
    },
    onError: (e: any) => toast({ title: "Couldn't save", description: e.message, variant: "destructive" }),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg max-sm:inset-0 max-sm:left-0 max-sm:top-0 max-sm:translate-x-0 max-sm:translate-y-0 max-sm:h-[100dvh] max-sm:max-w-none max-sm:rounded-none max-sm:border-0 max-sm:p-4 max-sm:pb-[max(1rem,env(safe-area-inset-bottom))] max-sm:content-start overflow-y-auto sm:max-h-[90vh]">
        <DialogHeader className="text-left pr-8">
          <DialogTitle>{supply ? "New supply request" : "New task"}</DialogTitle>
          <DialogDescription>
            {meta.area} board{presetLabel ? ` · ${presetLabel}` : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {allowKindSwitch && (
            <div className="grid grid-cols-2 rounded-lg border bg-muted/40 p-1" data-testid="switch-task-kind">
              {(["task", "supply"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setKind(k)}
                  className={`rounded-md py-2 text-sm font-medium flex items-center justify-center gap-1.5 ${kind === k ? "bg-card shadow-sm" : "text-muted-foreground"}`}
                  data-testid={`kind-${k}`}
                >
                  {k === "task" ? <ListChecks className="h-4 w-4" /> : <Package className="h-4 w-4" />}
                  {k === "task" ? "Task" : "Supply request"}
                </button>
              ))}
            </div>
          )}
          <div>
            <label className="text-sm font-medium">{supply ? "What do you need?" : "Task"}</label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={supply ? "e.g. 2 cases of shaker screens for H&P 540" : "e.g. Swap bowl on CTF-104"}
              className="mt-1"
              autoFocus
              data-testid="input-task-title"
            />
          </div>
          <div>
            <label className="text-sm font-medium">{supply ? "Details: items, quantities, where it's going" : "Details (optional)"}</label>
            <Textarea value={details} onChange={(e) => setDetails(e.target.value)} rows={4} className="mt-1" data-testid="input-task-details" />
            <div className="mt-2">
              <PhotoPicker files={photos} onChange={setPhotos} testId="button-task-photo" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-medium">Priority</label>
              <Select value={priority} onValueChange={(v) => setPriority(v as BoardPriority)}>
                <SelectTrigger className="mt-1" data-testid="select-task-priority">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BOARD_PRIORITIES.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-sm font-medium">{supply ? "Needed by" : "Due"} (optional)</label>
              <Input type="date" value={due} onChange={(e) => setDue(e.target.value)} className="mt-1" data-testid="input-task-due" />
            </div>
          </div>
          <div>
            <label className="text-sm font-medium">Assign to</label>
            <Select value={assignee} onValueChange={setAssignee}>
              <SelectTrigger className="mt-1" data-testid="select-task-assignee">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Leave open for anyone to claim</SelectItem>
                {meta.members.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.name} · {ROLE_LABELS[m.role]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {assignee !== NONE && (
              <p className="text-xs text-muted-foreground mt-1">
                They'll get a bell alert, and a phone alert if they turned those on.
              </p>
            )}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-medium">Job (optional)</label>
              <Select value={jobId} onValueChange={setJobId}>
                <SelectTrigger className="mt-1" data-testid="select-task-job">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>None</SelectItem>
                  {jobs.map((j) => (
                    <SelectItem key={j.id} value={j.id}>
                      {j.job_number}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-sm font-medium">Asset (optional)</label>
              <Select value={assetId} onValueChange={setAssetId}>
                <SelectTrigger className="mt-1" data-testid="select-task-asset">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>None</SelectItem>
                  {assets.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      <span className="flex flex-col">
                        <span>
                          {a.label}
                          {a.category ? ` · ${a.category}` : ""}
                        </span>
                        <AssetModelLine asset={a} />
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" className="max-sm:h-11" onClick={onClose}>
            Cancel
          </Button>
          <Button className="max-sm:h-11" disabled={!title.trim() || create.isPending} onClick={() => create.mutate()} data-testid="button-save-task">
            {create.isPending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
            {supply ? "Send request" : "Add task"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---- Task detail ----------------------------------------------------------
function TaskDialog({ id, meta, onClose }: { id: string; meta: Meta; onClose: () => void }) {
  const { profile } = useAuth();
  const { toast } = useToast();
  const { data: t, isLoading, error } = useQuery<TaskDetail>({ queryKey: ["/api/board/tasks", id] });
  const [comment, setComment] = useState("");
  const [commentPhotos, setCommentPhotos] = useState<File[]>([]);
  const [taskPhotos, setTaskPhotos] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);

  const update = async (patch: Record<string, any>) => {
    setBusy(true);
    try {
      const r = await (await apiRequest("PATCH", `/api/board/tasks/${id}`, patch)).json();
      invalidateBoard();
      if (patch.assignee_id) alertToast(toast, r.alerts, meta.members.find((m) => m.id === patch.assignee_id)?.name || null);
    } catch (e: any) {
      toast({ title: "Couldn't update", description: e.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };
  const addComment = async () => {
    setBusy(true);
    try {
      const c = await (await apiRequest("POST", `/api/board/tasks/${id}/comments`, { body: comment, has_photos: commentPhotos.length > 0 })).json();
      const failed = commentPhotos.length ? await uploadBoardPhotos({ comment_id: c.id }, commentPhotos) : 0;
      setComment("");
      setCommentPhotos([]);
      invalidateBoard();
      photoToast(toast, failed);
    } catch (e: any) {
      toast({ title: "Couldn't add comment", description: e.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const timeline = useMemo(() => {
    if (!t) return [];
    return [
      ...t.comments.map((c) => ({ kind: "c" as const, id: c.id, who: c.author_name, text: c.body, ts: c.created_at, files: c.files, mine: c.author_id === profile?.id })),
      ...t.activity.map((a) => ({ kind: "a" as const, id: a.id, who: a.actor_name, text: activityText(a.action, a.detail), ts: a.created_at, files: undefined, mine: false })),
    ].sort((a, b) => a.ts.localeCompare(b.ts));
  }, [t]);

  const canWrite = !!t?.can_write;
  const closed = t?.status === "Done" || t?.status === "Cancelled";
  const mine = t?.assignee_id === profile?.id;
  const canCancel = profile?.role === "admin" || profile?.role === "area" || t?.created_by === profile?.id;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl max-sm:inset-0 max-sm:left-0 max-sm:top-0 max-sm:translate-x-0 max-sm:translate-y-0 max-sm:h-[100dvh] max-sm:max-w-none max-sm:rounded-none max-sm:border-0 max-sm:p-4 max-sm:pb-[max(1rem,env(safe-area-inset-bottom))] max-sm:content-start overflow-y-auto sm:max-h-[90vh]">
        {isLoading || !t ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            {error ? (error as any).message || "Task not found." : <Loader2 className="h-5 w-5 animate-spin mx-auto" />}
          </div>
        ) : (
          <>
            <DialogHeader className="text-left pr-8">
              <div className="flex items-center gap-2 flex-wrap text-xs">
                <span className="font-mono text-muted-foreground">T-{t.number}</span>
                {t.kind === "supply" && (
                  <Badge variant="outline" className="text-[11px] gap-1">
                    <Package className="h-3 w-3" /> Supply request
                  </Badge>
                )}
                <Badge className={`text-[11px] ${STATUS_STYLE[t.status]}`}>{t.status}</Badge>
                <Badge className={`text-[11px] ${PRIORITY_STYLE[t.priority]}`}>{t.priority}</Badge>
                <span className="text-muted-foreground">{t.area}</span>
              </div>
              <DialogTitle className="text-lg leading-snug pt-1">{t.title}</DialogTitle>
              <DialogDescription>
                From {t.created_by_name || "—"} · {when(t.created_at)}
              </DialogDescription>
            </DialogHeader>

            {t.details && <p className="text-sm whitespace-pre-wrap rounded-md bg-muted/40 border p-3">{t.details}</p>}
            {(t.files?.length || 0) > 0 && (
              <PhotoGrid files={t.files} canDelete={canWrite && (t.created_by === profile?.id || profile?.role === "admin" || profile?.role === "area")} onDeleted={invalidateBoard} />
            )}
            {canWrite && !closed && (
              <div className="flex items-center gap-2 flex-wrap">
                <PhotoPicker files={taskPhotos} onChange={setTaskPhotos} compact testId="button-detail-photo" />
                {taskPhotos.length > 0 && (
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      const failed = await uploadBoardPhotos({ task_id: t.id }, taskPhotos);
                      setTaskPhotos([]);
                      setBusy(false);
                      invalidateBoard();
                      photoToast(toast, failed);
                    }}
                    data-testid="button-detail-photo-save"
                  >
                    Add {taskPhotos.length} photo{taskPhotos.length > 1 ? "s" : ""}
                  </Button>
                )}
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
              <Field label="Assigned to">
                {canWrite && !closed ? (
                  <Select value={t.assignee_id || NONE} onValueChange={(v) => update({ assignee_id: v === NONE ? null : v })}>
                    <SelectTrigger className="h-9" data-testid="select-detail-assignee">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>Open for anyone</SelectItem>
                      {meta.members.map((m) => (
                        <SelectItem key={m.id} value={m.id}>
                          {m.name} · {ROLE_LABELS[m.role]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <span>{t.assignee_name || "Anyone"}</span>
                )}
              </Field>
              <Field label={t.kind === "supply" ? "Needed by" : "Due"}>
                {canWrite && !closed ? (
                  <Input type="date" className="h-9" value={t.due_date || ""} onChange={(e) => update({ due_date: e.target.value || null })} data-testid="input-detail-due" />
                ) : (
                  <span>{t.due_date ? shortDate(t.due_date) : "—"}</span>
                )}
              </Field>
              <Field label="Priority">
                {canWrite && !closed ? (
                  <Select value={t.priority} onValueChange={(v) => update({ priority: v })}>
                    <SelectTrigger className="h-9" data-testid="select-detail-priority">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {BOARD_PRIORITIES.map((p) => (
                        <SelectItem key={p} value={p}>
                          {p}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <span>{t.priority}</span>
                )}
              </Field>
              <Field label="Job / asset">
                <span className="flex items-center gap-3 h-9">
                  {t.job_number ? (
                    <span className="flex items-center gap-1">
                      <Briefcase className="h-3.5 w-3.5 text-muted-foreground" /> {t.job_number}
                    </span>
                  ) : null}
                  {t.asset_tag ? (
                    <span className="flex items-center gap-1">
                      <Boxes className="h-3.5 w-3.5 text-muted-foreground" /> {t.asset_tag}
                    </span>
                  ) : null}
                  {!t.job_number && !t.asset_tag && "—"}
                </span>
              </Field>
            </div>

            {canWrite && (
              <div className="flex flex-wrap gap-2">
                {!closed && !mine && (
                  <Button variant="outline" size="sm" className="max-sm:h-11 max-sm:flex-1 max-sm:basis-[45%]" disabled={busy} onClick={() => update({ assignee_id: profile!.id })} data-testid="button-claim">
                    <Hand className="h-4 w-4 mr-1.5" /> Take it
                  </Button>
                )}
                {!closed && t.status !== "In progress" && (
                  <Button variant="outline" size="sm" className="max-sm:h-11 max-sm:flex-1 max-sm:basis-[45%]" disabled={busy} onClick={() => update({ status: "In progress", ...(t.assignee_id ? {} : { assignee_id: profile!.id }) })} data-testid="button-start">
                    <Play className="h-4 w-4 mr-1.5" /> Start
                  </Button>
                )}
                {!closed && (
                  <Button size="sm" className="max-sm:h-11 max-sm:flex-1 max-sm:basis-[45%]" disabled={busy} onClick={() => update({ status: "Done" })} data-testid="button-done">
                    <CheckCircle2 className="h-4 w-4 mr-1.5" /> Mark done
                  </Button>
                )}
                {closed && (
                  <Button variant="outline" size="sm" className="max-sm:h-11 max-sm:flex-1 max-sm:basis-[45%]" disabled={busy} onClick={() => update({ status: t.assignee_id ? "Assigned" : "Open" })} data-testid="button-reopen">
                    <RotateCcw className="h-4 w-4 mr-1.5" /> Reopen
                  </Button>
                )}
                {!closed && canCancel && (
                  <Button variant="ghost" size="sm" className="text-muted-foreground max-sm:h-11 max-sm:flex-1 max-sm:basis-[45%]" disabled={busy} onClick={() => confirm("Cancel this task?") && update({ status: "Cancelled" })} data-testid="button-cancel-task">
                    <XCircle className="h-4 w-4 mr-1.5" /> Cancel task
                  </Button>
                )}
              </div>
            )}

            <div className="border-t pt-3">
              <div className="text-sm font-semibold mb-2">Comments & history</div>
              <div className="space-y-2.5">
                {timeline.map((e) =>
                  e.kind === "c" ? (
                    <div key={e.id} className="rounded-md border bg-card p-2.5">
                      <div className="text-xs">
                        <span className="font-medium">{e.who || "Someone"}</span> <span className="text-muted-foreground">· {when(e.ts)}</span>
                      </div>
                      {e.text && <p className="text-sm mt-0.5 whitespace-pre-wrap break-words">{e.text}</p>}
                      <PhotoGrid files={e.files} small canDelete={e.mine} onDeleted={invalidateBoard} />
                    </div>
                  ) : (
                    <div key={e.id} className="text-xs text-muted-foreground pl-1">
                      <span className="font-medium text-foreground/80">{e.who || "Someone"}</span> {e.text} · {when(e.ts)}
                    </div>
                  ),
                )}
              </div>
              {canWrite && (
                <div className="mt-3 space-y-2">
                  <Textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={2} placeholder="Add a comment…" data-testid="input-task-comment" />
                  <div className="flex items-center gap-2 justify-between flex-wrap">
                    <PhotoPicker files={commentPhotos} onChange={setCommentPhotos} compact testId="button-comment-photo" />
                    <Button size="sm" className="max-sm:h-11 max-sm:px-5" disabled={(!comment.trim() && !commentPhotos.length) || busy} onClick={addComment} data-testid="button-add-comment">
                      Comment
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground mb-1">{label}</div>
      {children}
    </div>
  );
}

function activityText(action: string, detail: string | null): string {
  switch (action) {
    case "created":
      return `created this ${detail === "Supply request" ? "supply request" : "task"}`;
    case "assigned":
      return `assigned it to ${detail || "someone"}`;
    case "unassigned":
      return "left it open for anyone";
    case "status":
      return `changed status: ${detail}`;
    case "edited":
      return "edited the details";
    default:
      return action;
  }
}
