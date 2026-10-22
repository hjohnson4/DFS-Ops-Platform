// One dialog for field tickets: create, edit (while Open), view, close,
// reopen and approve.
//
//   Area Manager / Admin  create, edit an Open ticket, close, reopen, delete
//   Admin                 also approve a Closed ticket, reopen an Approved one
//   Supervisor            view only
//
// A ticket is built in sections. Every line has its own dates and well, and
// its quantity follows the number of days unless typed over.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  type Asset,
  type Customer,
  type JobWithCustomer,
  type FieldTicket,
  type FieldTicketWithJob,
  type FieldTicketStatus,
  type FieldTicketType,
  type LineItem,
  type JobService,
  type TicketCoverage,
  FIELD_TICKET_STATUS_LABEL,
  FIELD_TICKET_TYPE_LABEL,
  isLiveJobStatus,
  lineDays,
  ticketCloseProblems,
  wellKey,
} from "@shared/schema";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { buildFieldTicketHtml, printFieldTicket } from "@/lib/fieldTicketExport";
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  FileDown,
  History,
  Loader2,
  Lock,
  Plus,
  RotateCcw,
  ShieldCheck,
  Trash2,
  XCircle,
} from "lucide-react";

// ---------------------------------------------------------------- helpers
const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });

const shortDate = (d?: string | null) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d ?? ""));
  if (!m) return "—";
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
};
const rangeLabel = (a?: string | null, b?: string | null) =>
  !a ? "—" : b && b > a ? `${shortDate(a)} – ${shortDate(b)}` : shortDate(a);

const stamp = (iso?: string | null) =>
  iso
    ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : "—";

function today() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function addDay(iso: string, n = 1) {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

let uid = 0;
const nextId = () => `k${++uid}`;

interface DraftLine {
  key: string;
  description: string;
  start: string;
  end: string;
  quantity: string;
  unit_cost: string;
  qtyAuto: boolean; // quantity follows the day count until typed over
  service_id?: string | null; // a job service charge this line bills
}
interface DraftSection {
  key: string;
  title: string;
  well: string;
  lines: DraftLine[];
}

const blankLine = (): DraftLine => ({
  key: nextId(),
  description: "",
  start: "",
  end: "",
  quantity: "",
  unit_cost: "",
  qtyAuto: true,
});
const blankSection = (well = ""): DraftSection => ({ key: nextId(), title: "", well, lines: [blankLine()] });

const lineTotal = (l: DraftLine) => {
  const q = Number(l.quantity);
  const u = Number(l.unit_cost);
  return isNaN(q) || isNaN(u) ? 0 : Math.round(q * u * 100) / 100;
};

// Saved lines → sections (consecutive lines with the same section + well).
function toSections(items: LineItem[], ticketWell: string | null): DraftSection[] {
  const out: DraftSection[] = [];
  for (const li of items) {
    const title = li.section ?? "";
    const well = li.well_name ?? (ticketWell && !ticketWell.includes(",") ? ticketWell : "");
    let sec = out[out.length - 1];
    if (!sec || sec.title !== title || wellKey(sec.well) !== wellKey(well)) {
      sec = { key: nextId(), title, well, lines: [] };
      out.push(sec);
    }
    const days = lineDays(li.start_date, li.end_date);
    sec.lines.push({
      key: nextId(),
      description: li.description,
      start: li.start_date ?? "",
      end: li.end_date ?? li.start_date ?? "",
      quantity: String(li.quantity),
      unit_cost: String(li.unit_cost),
      qtyAuto: days != null && Number(li.quantity) === days,
      service_id: li.service_id ?? null,
    });
  }
  return out.length ? out : [blankSection(ticketWell ?? "")];
}

// Sections → line items for the API (blank lines dropped).
function toLineItems(sections: DraftSection[]) {
  const items: LineItem[] = [];
  for (const s of sections)
    for (const l of s.lines) {
      if (!l.description.trim() || l.quantity.trim() === "" || l.unit_cost.trim() === "") continue;
      items.push({
        description: l.description.trim(),
        quantity: Number(l.quantity),
        unit_cost: Number(l.unit_cost),
        total: lineTotal(l),
        start_date: l.start || null,
        end_date: l.start && l.end && l.end > l.start ? l.end : null,
        well_name: s.well.trim() || null,
        section: s.title.trim() || null,
        ...(l.service_id ? { service_id: l.service_id } : {}),
      });
    }
  return items;
}

export function StatusBadge({ status }: { status: FieldTicketStatus }) {
  const cls =
    status === "open"
      ? "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
      : status === "closed"
        ? "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200"
        : "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${cls}`}
      data-testid={`ticket-status-${status}`}
    >
      {status === "open" ? <Circle className="h-2.5 w-2.5 fill-current" /> : status === "closed" ? <Lock className="h-3 w-3" /> : <ShieldCheck className="h-3 w-3" />}
      {FIELD_TICKET_STATUS_LABEL[status] ?? status}
    </span>
  );
}

// ---------------------------------------------------------------- component
interface Props {
  trigger: ReactNode;
  job?: JobWithCustomer; // fixed job (job page); omit to pick customer + job
  ticket?: FieldTicket | FieldTicketWithJob; // existing ticket to view / edit
}

export function FieldTicketDialog({ trigger, job: fixedJob, ticket: initial }: Props) {
  const { toast } = useToast();
  const { profile } = useAuth();
  const role = profile?.role;
  const canManage = role === "admin" || role === "area";
  const isAdmin = role === "admin";
  const [open, setOpen] = useState(false);

  // The ticket as last saved (updates after each action).
  const [saved, setSaved] = useState<FieldTicketWithJob | null>((initial as FieldTicketWithJob) ?? null);
  useEffect(() => {
    if (open) setSaved((initial as FieldTicketWithJob) ?? null);
  }, [open, initial]);

  // ---- customer + job (only when not fixed)
  const { data: customers } = useQuery<Customer[]>({ queryKey: ["/api/customers"], enabled: open && !fixedJob && !initial });
  const { data: jobs } = useQuery<JobWithCustomer[]>({ queryKey: ["/api/jobs"], enabled: open && !fixedJob });
  const [customerId, setCustomerId] = useState("");
  const [pickedJobId, setPickedJobId] = useState("");
  const jobId = fixedJob?.id ?? saved?.job_id ?? pickedJobId;
  const job: JobWithCustomer | undefined =
    fixedJob ?? (jobs || []).find((j) => j.id === jobId);
  const jobLive = saved ? isLiveJobStatus((saved as any).job_status ?? job?.status) : job ? isLiveJobStatus(job.status) : true;

  const status: FieldTicketStatus = saved?.status ?? "open";
  const editable = canManage && status === "open" && jobLive;

  // ---- form state
  const [number, setNumber] = useState("");
  const [type, setType] = useState<FieldTicketType | "">("");
  const [orderedBy, setOrderedBy] = useState("");
  const [county, setCounty] = useState("");
  const [poAfe, setPoAfe] = useState("");
  const [description, setDescription] = useState("");
  const [comments, setComments] = useState("");
  const [assetIds, setAssetIds] = useState<string[]>([]);
  const [sections, setSections] = useState<DraftSection[]>([blankSection()]);
  const [showHistory, setShowHistory] = useState(false);
  const [reopenNote, setReopenNote] = useState<string | null>(null); // non-null = asking

  const seed = (t: FieldTicketWithJob | null) => {
    setNumber(t ? String(t.ticket_number) : "");
    setType((t?.ticket_type as FieldTicketType) ?? "");
    setOrderedBy(t?.ordered_by ?? "");
    setCounty(t?.county ?? "");
    setPoAfe(t?.po_afe ?? "");
    setDescription(t?.description ?? "");
    setComments(t?.comments ?? "");
    setAssetIds(t?.asset_ids ?? []);
    setSections(t ? toSections(t.line_items ?? [], t.well_name) : [blankSection(fixedJob?.well_name ?? "")]);
    setReopenNote(null);
    setShowHistory(false);
  };
  useEffect(() => {
    if (open) {
      seed((initial as FieldTicketWithJob) ?? null);
      if (!fixedJob && !initial) {
        setCustomerId("");
        setPickedJobId("");
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Equipment: units on this job, plus any already on the ticket.
  const { data: allAssets } = useQuery<Asset[]>({ queryKey: ["/api/assets"], enabled: open });
  const eligibleAssets = (allAssets || []).filter(
    (a) => (jobId && a.job_id === jobId) || assetIds.includes(a.id),
  );
  const toggleAsset = (id: string) =>
    setAssetIds((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const { data: nextNum } = useQuery<{ next: number; configurable: boolean }>({
    queryKey: ["/api/field-tickets/next-number"],
    enabled: open && canManage && !saved,
  });

  const { data: coverage } = useQuery<TicketCoverage>({
    queryKey: ["/api/jobs", jobId, "ticket-coverage"],
    queryFn: async () => (await apiRequest("GET", `/api/jobs/${jobId}/ticket-coverage`)).json(),
    enabled: open && !!jobId,
  });

  // Wells to pick from: report wells + the job's well + wells already used.
  const wellOptions = useMemo(() => {
    const m = new Map<string, string>();
    const add = (w?: string | null) => {
      const k = wellKey(w);
      if (k && !m.has(k)) m.set(k, String(w).trim());
    };
    (coverage?.days ?? []).forEach((d) => add(d.well_name));
    add(job?.well_name);
    sections.forEach((s) => add(s.well));
    return Array.from(m.values());
  }, [coverage, job, sections]);

  // Day keys (well|date) covered by the lines currently on this form.
  const draftCovered = useMemo(() => {
    const set = new Set<string>();
    for (const s of sections) {
      const wk = wellKey(s.well);
      if (!wk) continue;
      for (const l of s.lines) {
        if (!l.start) continue;
        const end = l.end && l.end > l.start ? l.end : l.start;
        for (let d = l.start; d <= end; d = addDay(d)) set.add(`${wk}|${d}`);
      }
    }
    return set;
  }, [sections]);

  // Report days not on any OTHER ticket and not on this form.
  const thisNumber = saved?.ticket_number;
  const openDays = useMemo(
    () =>
      (coverage?.days ?? []).filter(
        (d) =>
          d.tickets.filter((n) => n !== thisNumber).length === 0 &&
          !draftCovered.has(`${wellKey(d.well_name)}|${d.date}`),
      ),
    [coverage, draftCovered, thisNumber],
  );
  // Days on this form that another ticket also covers.
  const doubleDays = useMemo(
    () =>
      (coverage?.days ?? []).filter(
        (d) =>
          d.tickets.some((n) => n !== thisNumber) && draftCovered.has(`${wellKey(d.well_name)}|${d.date}`),
      ),
    [coverage, draftCovered, thisNumber],
  );
  const ticketWells = new Set(sections.map((s) => wellKey(s.well)).filter(Boolean));
  const openDaysHere = openDays.filter((d) => ticketWells.has(wellKey(d.well_name)));

  // ---- section / line editing
  const patchSection = (k: string, p: Partial<DraftSection>) =>
    setSections((prev) => prev.map((s) => (s.key === k ? { ...s, ...p } : s)));
  const patchLine = (sk: string, lk: string, p: Partial<DraftLine>) =>
    setSections((prev) =>
      prev.map((s) =>
        s.key !== sk
          ? s
          : {
              ...s,
              lines: s.lines.map((l) => {
                if (l.key !== lk) return l;
                const n = { ...l, ...p };
                if (p.start !== undefined && (!n.end || n.end < n.start)) n.end = n.start;
                if ((p.start !== undefined || p.end !== undefined) && n.qtyAuto) {
                  const days = lineDays(n.start, n.end);
                  if (days != null) n.quantity = String(days);
                }
                return n;
              }),
            },
      ),
    );
  const addLine = (sk: string) =>
    setSections((prev) => prev.map((s) => (s.key === sk ? { ...s, lines: [...s.lines, blankLine()] } : s)));
  const removeLine = (sk: string, lk: string) =>
    setSections((prev) =>
      prev.map((s) =>
        s.key !== sk ? s : { ...s, lines: s.lines.length === 1 ? [blankLine()] : s.lines.filter((l) => l.key !== lk) },
      ),
    );
  const removeSection = (sk: string) =>
    setSections((prev) => (prev.length === 1 ? [blankSection()] : prev.filter((s) => s.key !== sk)));

  // Service charges on this job not yet billed on a ticket (or billed on this
  // one but taken off the draft) — "Add service charges" puts them on as lines.
  const { data: jobServices } = useQuery<JobService[]>({
    queryKey: ["/api/jobs", jobId, "services"],
    enabled: open && !!jobId && canManage,
  });
  const draftServiceIds = new Set(
    sections.flatMap((s) => s.lines.map((l) => l.service_id).filter(Boolean) as string[]),
  );
  const openCharges = (jobServices ?? []).filter(
    (v) =>
      !draftServiceIds.has(v.id) &&
      Number(v.cost ?? 0) > 0 &&
      (v.on_ticket == null || v.on_ticket === saved?.ticket_number),
  );
  const addServiceCharges = (sk: string) => {
    if (openCharges.length === 0) return;
    const sorted = [...openCharges].sort((a, b) => a.service_date.localeCompare(b.service_date));
    setSections((prev) =>
      prev.map((s) => {
        if (s.key !== sk) return s;
        const kept = s.lines.filter((l) => l.description.trim() || l.quantity.trim() || l.unit_cost.trim());
        const added: DraftLine[] = sorted.map((v) => {
          const day = String(v.service_date).slice(0, 10);
          const what = (v.notes ?? "").trim();
          return {
            key: nextId(),
            description: `${v.service_type}${v.asset_tag ? ` (${v.asset_tag})` : ""}${what ? ` — ${what}` : ""}`,
            start: day,
            end: day,
            quantity: "1",
            unit_cost: String(v.cost ?? 0),
            qtyAuto: false,
            service_id: v.id,
          };
        });
        const firstWell = sorted.find((v) => v.well_name)?.well_name ?? "";
        return { ...s, well: s.well.trim() ? s.well : firstWell, lines: [...kept, ...added] };
      }),
    );
    toast({
      title: `Added ${sorted.length} service charge${sorted.length === 1 ? "" : "s"}`,
      description: "Check the well on this section before saving.",
    });
  };

  // Fill a section from signed-off report days (not yet on a ticket) for a well:
  // consecutive days at the same rate become one line.
  const fillFromReports = (sk: string, well: string) => {
    const wk = wellKey(well);
    const days = openDays.filter((d) => wellKey(d.well_name) === wk).sort((a, b) => a.date.localeCompare(b.date));
    if (days.length === 0) {
      toast({ title: "Nothing to add", description: `Every signed-off report day on ${well} is already on a ticket.` });
      return;
    }
    const runs: { start: string; end: string; rate: number | null }[] = [];
    for (const d of days) {
      const last = runs[runs.length - 1];
      if (last && addDay(last.end) === d.date && last.rate === d.rate) last.end = d.date;
      else runs.push({ start: d.date, end: d.date, rate: d.rate });
    }
    setSections((prev) =>
      prev.map((s) => {
        if (s.key !== sk) return s;
        const keep = s.lines.filter((l) => l.description.trim() || l.quantity.trim() || l.unit_cost.trim());
        const added: DraftLine[] = runs.map((r) => ({
          key: nextId(),
          description: "Solids control package",
          start: r.start,
          end: r.end,
          quantity: String(lineDays(r.start, r.end) ?? 1),
          unit_cost: r.rate != null ? String(r.rate) : "",
          qtyAuto: true,
        }));
        return { ...s, well: s.well || well, lines: [...keep, ...added] };
      }),
    );
    toast({ title: `Added ${days.length} report day${days.length === 1 ? "" : "s"}`, description: "Check the description and rate on each line." });
  };

  // ---- totals + close checklist
  const items = toLineItems(sections);
  const total = items.reduce((s, l) => s + l.total, 0);
  const problems = ticketCloseProblems({ ticket_type: type || null, line_items: items });
  const incompleteLines = sections.some((s) =>
    s.lines.some((l) => (l.description.trim() || l.quantity.trim() || l.unit_cost.trim()) && !(l.description.trim() && l.quantity.trim() && l.unit_cost.trim())),
  );

  // ---- API
  const refresh = (t?: FieldTicketWithJob) => {
    queryClient.invalidateQueries({ queryKey: ["/api/field-tickets"] });
    queryClient.invalidateQueries({ predicate: (q) => typeof q.queryKey[0] === "string" && (q.queryKey[0] as string).startsWith("/api/field-tickets") });
    if (jobId) {
      queryClient.invalidateQueries({ queryKey: ["/api/jobs", jobId, "field-tickets"] });
      queryClient.invalidateQueries({ queryKey: ["/api/jobs", jobId, "ticket-coverage"] });
      queryClient.invalidateQueries({ queryKey: ["/api/jobs", jobId, "services"] });
    }
    if (t) {
      setSaved(t);
      seed(t);
    }
  };

  const body = () => ({
    ticket_number: number.trim() === "" ? null : Number(number),
    ticket_type: type || null,
    ordered_by: orderedBy.trim() || null,
    ticket_date: items.find((l) => l.start_date)?.start_date ?? saved?.ticket_date ?? today(),
    county: county.trim() || null,
    po_afe: poAfe.trim() || null,
    description: description.trim() || null,
    comments: comments.trim() || null,
    asset_ids: assetIds,
    well_name: sections[0]?.well.trim() || null,
    line_items: items.map(({ total: _t, ...li }) => li),
  });

  const saveMut = useMutation({
    mutationFn: async (then: "keep" | "close") => {
      const res = saved
        ? await apiRequest("PATCH", `/api/field-tickets/${saved.id}`, body())
        : await apiRequest("POST", `/api/jobs/${jobId}/field-tickets`, body());
      let t: FieldTicketWithJob = await res.json();
      if (then === "close") t = await (await apiRequest("POST", `/api/field-tickets/${t.id}/close`, {})).json();
      return { t, then };
    },
    onSuccess: ({ t, then }) => {
      refresh(t);
      toast({
        title: then === "close" ? `Ticket #${t.ticket_number} closed` : `Ticket #${t.ticket_number} saved`,
        description: then === "close" ? (isAdmin ? "Approve it when you're ready." : "It's waiting for Admin approval.") : "It stays open so you can add more work later.",
      });
    },
    onError: (e: any) => toast({ title: "Could not save the ticket", description: e.message, variant: "destructive" }),
  });

  const actionMut = useMutation({
    mutationFn: async (a: { kind: "approve" | "reopen"; note?: string }) =>
      (await apiRequest("POST", `/api/field-tickets/${saved!.id}/${a.kind}`, { note: a.note || null })).json(),
    onSuccess: (t: FieldTicketWithJob, a) => {
      refresh(t);
      toast({ title: a.kind === "approve" ? `Ticket #${t.ticket_number} approved` : `Ticket #${t.ticket_number} reopened` });
    },
    onError: (e: any) => toast({ title: "Could not update the ticket", description: e.message, variant: "destructive" }),
  });

  const busy = saveMut.isPending || actionMut.isPending;

  const pdf = () => {
    const base: any = saved ?? {};
    const draft = {
      ...base,
      ticket_number: number || base.ticket_number || nextNum?.next || "DRAFT",
      status,
      ticket_type: type || null,
      ordered_by: orderedBy || null,
      county: county || null,
      po_afe: poAfe || null,
      description: description || null,
      comments: comments || null,
      line_items: items,
      asset_ids: assetIds,
      amount: editable ? total : base.amount ?? total,
      well_name: Array.from(new Set(items.map((l) => l.well_name).filter(Boolean))).join(", ") || base.well_name || null,
      ticket_date: items.find((l) => l.start_date)?.start_date ?? base.ticket_date ?? today(),
      job_number: base.job_number ?? job?.job_number ?? "",
      area: base.area ?? job?.area ?? "",
      customer_name: base.customer_name ?? (job as any)?.customer_name ?? (job as any)?.customer?.name ?? "",
    } as FieldTicketWithJob;
    printFieldTicket(
      buildFieldTicketHtml(draft, {
        generatedBy: profile?.name,
        units: assetIds.map((id) => (allAssets || []).find((a) => a.id === id)?.tag).filter(Boolean) as string[],
      }),
    );
  };

  // ---------------------------------------------------------------- render
  const selectedCustomerJobs = (jobs || []).filter((j) => j.customer_id === customerId && isLiveJobStatus(j.status));
  const pickingJob = !fixedJob && !saved;
  const ro = !editable;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-5xl" data-testid="dialog-field-ticket">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            {saved ? `Field ticket #${saved.ticket_number}` : "New field ticket"}
            <StatusBadge status={status} />
            {job && (
              <span className="ml-auto text-sm font-normal text-muted-foreground">
                {job.job_number} · {(saved as any)?.customer_name || (job as any).customer_name || (job as any).customer?.name || ""} · {job.area}
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        {/* status banner */}
        {saved && status !== "open" && (
          <div className="rounded-md border border-card-border bg-muted/40 px-3 py-2 text-sm flex flex-wrap items-center gap-x-4 gap-y-1">
            <span>
              <Lock className="inline h-3.5 w-3.5 mr-1 -mt-0.5" />
              Closed {stamp(saved.closed_at)}
              {saved.closed_by_name ? ` by ${saved.closed_by_name}` : ""}
            </span>
            {status === "approved" ? (
              <span className="text-emerald-700 dark:text-emerald-300">
                <ShieldCheck className="inline h-3.5 w-3.5 mr-1 -mt-0.5" />
                Approved {stamp(saved.approved_at)}
                {saved.approved_by_name ? ` by ${saved.approved_by_name}` : ""}
              </span>
            ) : (
              <span className="text-amber-700 dark:text-amber-300">Waiting for Admin approval</span>
            )}
          </div>
        )}
        {saved && status === "open" && !canManage && (
          <div className="rounded-md border border-card-border bg-muted/40 px-3 py-2 text-sm">
            This ticket is still open. Your Area Manager is adding work to it.
          </div>
        )}
        {saved && !jobLive && status === "open" && canManage && (
          <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-sm">
            This job isn't active, so the ticket can't be edited. You can still close it.
          </div>
        )}

        <div className="space-y-4">
          {/* customer + job picker */}
          {pickingJob && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Customer</Label>
                <Select value={customerId} onValueChange={(v) => { setCustomerId(v); setPickedJobId(""); }}>
                  <SelectTrigger data-testid="select-ticket-customer"><SelectValue placeholder="Select customer" /></SelectTrigger>
                  <SelectContent>
                    {(customers || []).map((c) => (
                      <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Job No.</Label>
                <Select
                  value={pickedJobId}
                  onValueChange={(v) => {
                    setPickedJobId(v);
                    const j = (jobs || []).find((x) => x.id === v);
                    setSections((prev) => prev.map((s, i) => (i === 0 && !s.well ? { ...s, well: j?.well_name ?? "" } : s)));
                  }}
                  disabled={!customerId}
                >
                  <SelectTrigger data-testid="select-ticket-job">
                    <SelectValue placeholder={!customerId ? "Select customer first" : selectedCustomerJobs.length ? "Select job" : "No active jobs"} />
                  </SelectTrigger>
                  <SelectContent>
                    {selectedCustomerJobs.map((j) => (
                      <SelectItem key={j.id} value={j.id}>{j.job_number} · {j.area}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          {/* header fields */}
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            <div className="space-y-1.5">
              <Label>Ticket No.</Label>
              {ro ? (
                <div className="text-sm font-medium py-2">#{saved?.ticket_number}</div>
              ) : (
                <Input
                  inputMode="numeric"
                  value={number}
                  onChange={(e) => setNumber(e.target.value.replace(/[^0-9]/g, ""))}
                  placeholder={nextNum ? `Next: ${nextNum.next}` : "Automatic"}
                  data-testid="input-ticket-number"
                />
              )}
            </div>
            <div className="space-y-1.5">
              <Label>Ticket type</Label>
              {ro ? (
                <div className="text-sm py-2">{type ? FIELD_TICKET_TYPE_LABEL[type] : "—"}</div>
              ) : (
                <Select value={type} onValueChange={(v) => setType(v as FieldTicketType)}>
                  <SelectTrigger data-testid="select-ticket-type"><SelectValue placeholder="Pick one" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="service">Service ticket</SelectItem>
                    <SelectItem value="delivery">Delivery ticket</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </div>
            <Field label="County" value={county} onChange={setCounty} ro={ro} testid="input-ticket-county" />
            <Field label="P.O. / A.F.E." value={poAfe} onChange={setPoAfe} ro={ro} testid="input-ticket-po" />
            <Field label="Ordered by" value={orderedBy} onChange={setOrderedBy} ro={ro} testid="input-ticket-ordered-by" />
          </div>

          <datalist id="ticket-well-options">
            {wellOptions.map((w) => (
              <option key={w} value={w} />
            ))}
          </datalist>

          {/* sections */}
          {sections.map((s, si) => {
            const secTotal = s.lines.reduce((sum, l) => sum + lineTotal(l), 0);
            const wellsWithOpenDays = Array.from(
              openDays.reduce((m, d) => m.set(d.well_name, (m.get(d.well_name) ?? 0) + 1), new Map<string, number>()),
            );
            return (
              <div key={s.key} className="rounded-lg border border-card-border overflow-hidden" data-testid={`ticket-section-${si}`}>
                <div className="flex flex-wrap items-center gap-2 bg-muted/50 px-3 py-2 border-b border-card-border">
                  <span className="text-xs font-semibold text-muted-foreground">Section {si + 1}</span>
                  {ro ? (
                    <>
                      <span className="text-sm font-semibold">{s.title || "Work"}</span>
                      <span className="text-sm text-muted-foreground">· {s.well || "—"}</span>
                    </>
                  ) : (
                    <>
                      <Input
                        value={s.title}
                        onChange={(e) => patchSection(s.key, { title: e.target.value })}
                        placeholder="Section name, e.g. Unmanned package"
                        className="h-8 w-56 bg-background"
                        data-testid={`input-section-title-${si}`}
                      />
                      <Input
                        value={s.well}
                        onChange={(e) => patchSection(s.key, { well: e.target.value })}
                        list="ticket-well-options"
                        placeholder="Well"
                        className="h-8 w-60 bg-background"
                        data-testid={`input-section-well-${si}`}
                      />
                    </>
                  )}
                  <span className="ml-auto text-sm font-semibold tabular-nums">{money(secTotal)}</span>
                  {!ro && (
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive" onClick={() => removeSection(s.key)} aria-label="Remove section">
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
                <table className="w-full text-sm">
                  <thead className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    <tr className="text-left">
                      <th className="px-3 py-1.5 font-medium w-[32%]">Description</th>
                      <th className="px-2 py-1.5 font-medium">Dates</th>
                      <th className="px-2 py-1.5 font-medium text-right w-[72px]">Qty</th>
                      <th className="px-2 py-1.5 font-medium text-right w-[112px] whitespace-nowrap">Unit cost</th>
                      <th className="px-3 py-1.5 font-medium text-right w-28">Total</th>
                      {!ro && <th className="w-8" />}
                    </tr>
                  </thead>
                  <tbody>
                    {s.lines.map((l, li) => (
                      <tr key={l.key} className="border-t border-card-border align-top" data-testid={`ticket-line-${si}-${li}`}>
                        <td className="px-3 py-1.5">
                          {ro ? l.description || "—" : (
                            <Textarea
                              value={l.description}
                              onChange={(e) => patchLine(s.key, l.key, { description: e.target.value })}
                              rows={l.description.length > 48 ? 2 : 1}
                              className="min-h-[34px] resize-y"
                              placeholder="e.g. Solids control package: 21x72 centrifuge"
                              data-testid={`input-line-desc-${si}-${li}`}
                            />
                          )}
                        </td>
                        <td className="px-2 py-1.5 whitespace-nowrap">
                          {ro ? (
                            <span>
                              {rangeLabel(l.start, l.end)}
                              {lineDays(l.start, l.end) ? <span className="text-muted-foreground"> · {lineDays(l.start, l.end)}d</span> : null}
                            </span>
                          ) : (
                            <div className="flex items-center gap-1">
                              <Input type="date" value={l.start} onChange={(e) => patchLine(s.key, l.key, { start: e.target.value })} className="h-8 w-[136px]" data-testid={`input-line-start-${si}-${li}`} />
                              <span className="text-muted-foreground">→</span>
                              <Input type="date" value={l.end} min={l.start || undefined} onChange={(e) => patchLine(s.key, l.key, { end: e.target.value })} className="h-8 w-[136px]" data-testid={`input-line-end-${si}-${li}`} />
                            </div>
                          )}
                        </td>
                        <td className="px-2 py-1.5 text-right">
                          {ro ? l.quantity : (
                            <Input
                              inputMode="decimal"
                              value={l.quantity}
                              onChange={(e) => patchLine(s.key, l.key, { quantity: e.target.value, qtyAuto: false })}
                              className="h-8 w-[60px] text-right"
                              title={l.qtyAuto ? "Follows the number of days. Type to override." : "Typed in"}
                              data-testid={`input-line-qty-${si}-${li}`}
                            />
                          )}
                        </td>
                        <td className="px-2 py-1.5 text-right">
                          {ro ? money(Number(l.unit_cost) || 0) : (
                            <Input inputMode="decimal" value={l.unit_cost} onChange={(e) => patchLine(s.key, l.key, { unit_cost: e.target.value })} className="h-8 w-[100px] text-right" data-testid={`input-line-cost-${si}-${li}`} />
                          )}
                        </td>
                        <td className={`px-3 py-1.5 text-right font-medium tabular-nums ${ro ? "" : "pt-3"}`}>{money(lineTotal(l))}</td>
                        {!ro && (
                          <td className="pr-2 py-1.5">
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive" onClick={() => removeLine(s.key, l.key)} aria-label="Remove line">
                              <XCircle className="h-3.5 w-3.5" />
                            </Button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!ro && (
                  <div className="flex flex-wrap items-center gap-2 border-t border-card-border px-3 py-2">
                    <Button variant="outline" size="sm" onClick={() => addLine(s.key)} data-testid={`button-add-line-${si}`}>
                      <Plus className="mr-1 h-3.5 w-3.5" /> Add line
                    </Button>
                    {openCharges.length > 0 && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => addServiceCharges(s.key)}
                        data-testid={`button-add-service-charges-${si}`}
                      >
                        <Plus className="mr-1 h-3.5 w-3.5" /> Add service charges ({openCharges.length})
                      </Button>
                    )}
                    {wellsWithOpenDays.length > 0 && (
                      <Select value="" onValueChange={(w) => fillFromReports(s.key, w)}>
                        <SelectTrigger className="h-8 w-auto gap-2 text-sm" data-testid={`select-fill-reports-${si}`}>
                          <SelectValue placeholder="Fill from daily reports…" />
                        </SelectTrigger>
                        <SelectContent>
                          {wellsWithOpenDays.map(([w, n]) => (
                            <SelectItem key={w} value={w}>
                              {w} · {n} day{n === 1 ? "" : "s"} not on a ticket
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {!ro && (
            <Button variant="outline" size="sm" onClick={() => setSections((p) => [...p, blankSection(p[p.length - 1]?.well ?? "")])} data-testid="button-add-section">
              <Plus className="mr-1 h-3.5 w-3.5" /> Add section
            </Button>
          )}

          {/* coverage warnings */}
          {(openDaysHere.length > 0 || doubleDays.length > 0) && (status === "open" || canManage) && (
            <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 px-3 py-2.5 text-sm space-y-1" data-testid="ticket-coverage-warning">
              {openDaysHere.length > 0 && (
                <div className="flex gap-2">
                  <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
                  <div>
                    <b>{openDaysHere.length} signed-off report day{openDaysHere.length === 1 ? "" : "s"} on this ticket's well{ticketWells.size === 1 ? "" : "s"} {openDaysHere.length === 1 ? "isn't" : "aren't"} on any ticket:</b>{" "}
                    {summarizeDays(openDaysHere)}
                  </div>
                </div>
              )}
              {doubleDays.length > 0 && (
                <div className="flex gap-2">
                  <AlertTriangle className="h-4 w-4 text-red-600 shrink-0 mt-0.5" />
                  <div>
                    <b>{doubleDays.length} day{doubleDays.length === 1 ? " is" : "s are"} also on another ticket:</b>{" "}
                    {summarizeDays(doubleDays, true)}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* equipment (unit numbers) */}
          <div className="space-y-1.5">
            <Label>Equipment on this ticket</Label>
            {ro ? (
              <div className="text-sm">
                {assetIds.length
                  ? assetIds.map((id) => (allAssets || []).find((a) => a.id === id)?.tag ?? "unit").join(", ")
                  : "—"}
              </div>
            ) : eligibleAssets.length === 0 ? (
              <div className="text-sm text-muted-foreground">{jobId ? "No units are assigned to this job." : "Pick a job first."}</div>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {eligibleAssets.map((a) => {
                  const on = assetIds.includes(a.id);
                  return (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => toggleAsset(a.id)}
                      className={`rounded-md border px-2 py-1 text-xs ${on ? "border-primary bg-primary/10 text-foreground font-semibold" : "border-card-border text-muted-foreground hover:text-foreground"}`}
                      data-testid={`ticket-asset-${a.id}`}
                    >
                      {on && <CheckCircle2 className="inline h-3 w-3 mr-1 -mt-0.5" />}
                      {a.tag}
                      <span className="font-normal text-muted-foreground"> · {a.category}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* description + comments */}
          <div className="grid sm:grid-cols-2 gap-3">
            <TextBlock label="Description of work (optional)" value={description} onChange={setDescription} ro={ro} testid="input-ticket-description" />
            <TextBlock label="Comments" value={comments} onChange={setComments} ro={ro} testid="input-ticket-comments" />
          </div>

          {/* checklist + total */}
          <div className="flex flex-wrap items-start gap-4">
            {status === "open" && canManage && (
              <div className="text-sm space-y-0.5" data-testid="ticket-close-checklist">
                <div className="font-semibold text-xs uppercase tracking-wide text-muted-foreground mb-1">Needed to close</div>
                {[
                  ["Ticket type", !!type],
                  ["At least one line", items.length > 0],
                  ["Dates on every line", items.length > 0 && items.every((l) => l.start_date)],
                  ["A well on every section", items.length > 0 && items.every((l) => l.well_name)],
                ].map(([label, ok]) => (
                  <div key={String(label)} className={ok ? "text-emerald-700 dark:text-emerald-300" : "text-muted-foreground"}>
                    {ok ? <CheckCircle2 className="inline h-3.5 w-3.5 mr-1 -mt-0.5" /> : <Circle className="inline h-3.5 w-3.5 mr-1 -mt-0.5" />}
                    {label}
                  </div>
                ))}
              </div>
            )}
            <div className="ml-auto text-right">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">Ticket total</div>
              <div className="text-2xl font-bold tabular-nums" data-testid="ticket-total">
                {money(ro && saved?.amount != null ? Number(saved.amount) : total)}
              </div>
            </div>
          </div>

          {/* history */}
          {saved && (saved.history?.length ?? 0) > 0 && (
            <div>
              <button className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1" onClick={() => setShowHistory((v) => !v)} data-testid="button-ticket-history">
                <History className="h-3.5 w-3.5" /> {showHistory ? "Hide" : "Show"} history ({saved.history.length})
              </button>
              {showHistory && (
                <ol className="mt-2 border-l-2 border-card-border pl-3 space-y-1.5 text-sm">
                  {[...saved.history].reverse().map((h, i) => (
                    <li key={i}>
                      <span className="font-medium">{h.action}</span>
                      <span className="text-muted-foreground"> · {stamp(h.at)}{h.by ? ` · ${h.by}` : ""}</span>
                      {h.note && <div className="text-muted-foreground text-xs">“{h.note}”</div>}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}

          {/* reopen note */}
          {reopenNote !== null && (
            <div className="rounded-md border border-card-border p-3 space-y-2">
              <Label>Why are you reopening it? (optional)</Label>
              <Textarea value={reopenNote} onChange={(e) => setReopenNote(e.target.value)} rows={2} data-testid="input-reopen-note" />
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => setReopenNote(null)}>Cancel</Button>
                <Button size="sm" onClick={() => actionMut.mutate({ kind: "reopen", note: reopenNote })} disabled={busy} data-testid="button-confirm-reopen">
                  {actionMut.isPending && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />} Reopen ticket
                </Button>
              </div>
            </div>
          )}

          {/* footer actions */}
          <div className="flex flex-wrap items-center gap-2 border-t border-card-border pt-3">
            <Button variant="outline" size="sm" onClick={pdf} disabled={pickingJob && !jobId} data-testid="button-ticket-pdf">
              <FileDown className="mr-1 h-4 w-4" /> {editable ? "Preview PDF" : "PDF"}
            </Button>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {editable && (
                <>
                  <Button
                    variant="outline"
                    onClick={() => saveMut.mutate("keep")}
                    disabled={busy || !jobId || incompleteLines}
                    data-testid="button-ticket-save-open"
                  >
                    {saveMut.isPending && saveMut.variables === "keep" && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                    Save &amp; keep open
                  </Button>
                  <Button
                    onClick={() => saveMut.mutate("close")}
                    disabled={busy || !jobId || incompleteLines || problems.length > 0}
                    title={problems.length ? problems.join(" ") : undefined}
                    data-testid="button-ticket-close"
                  >
                    {saveMut.isPending && saveMut.variables === "close" && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                    <Lock className="mr-1 h-4 w-4" /> Save &amp; close ticket
                  </Button>
                </>
              )}
              {saved && status === "open" && canManage && !jobLive && (
                <Button onClick={() => apiRequest("POST", `/api/field-tickets/${saved.id}/close`, {}).then((r) => r.json()).then((t) => { refresh(t); toast({ title: `Ticket #${t.ticket_number} closed` }); }).catch((e) => toast({ title: "Could not close", description: e.message, variant: "destructive" }))} data-testid="button-ticket-close-inactive">
                  <Lock className="mr-1 h-4 w-4" /> Close ticket
                </Button>
              )}
              {saved && status === "closed" && canManage && jobLive && reopenNote === null && (
                <Button variant="outline" onClick={() => setReopenNote("")} disabled={busy} data-testid="button-ticket-reopen">
                  <RotateCcw className="mr-1 h-4 w-4" /> Reopen
                </Button>
              )}
              {saved && status === "approved" && isAdmin && jobLive && reopenNote === null && (
                <Button variant="outline" onClick={() => setReopenNote("")} disabled={busy} data-testid="button-ticket-reopen">
                  <RotateCcw className="mr-1 h-4 w-4" /> Reopen (removes approval)
                </Button>
              )}
              {saved && status === "closed" && isAdmin && (
                <Button onClick={() => actionMut.mutate({ kind: "approve" })} disabled={busy} className="bg-emerald-700 hover:bg-emerald-800" data-testid="button-ticket-approve">
                  {actionMut.isPending && actionMut.variables?.kind === "approve" && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                  <ShieldCheck className="mr-1 h-4 w-4" /> Approve
                </Button>
              )}
            </div>
          </div>
          {editable && incompleteLines && (
            <div className="text-xs text-destructive text-right">Finish or remove the lines that are missing a description, quantity or unit cost.</div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// "Sep 26 (J 504H) · Oct 2–3 (I 503H)" with runs of consecutive days merged.
function summarizeDays(days: { well_name: string; date: string; tickets?: number[] }[], withTickets = false): string {
  const byWell = new Map<string, string[]>();
  days.forEach((d) => byWell.set(d.well_name, [...(byWell.get(d.well_name) ?? []), d.date]));
  const parts: string[] = [];
  byWell.forEach((dates, well) => {
    const sorted = Array.from(new Set(dates)).sort();
    const runs: string[] = [];
    let a = sorted[0];
    let b = sorted[0];
    for (let i = 1; i <= sorted.length; i++) {
      const d = sorted[i];
      if (d && addDay(b) === d) b = d;
      else {
        runs.push(rangeLabel(a, b));
        a = b = d;
      }
    }
    parts.push(`${runs.join(", ")} (${well})`);
  });
  let s = parts.join(" · ");
  if (withTickets) {
    const nums = Array.from(new Set(days.flatMap((d) => d.tickets ?? [])));
    if (nums.length) s += ` — see ticket ${nums.map((n) => `#${n}`).join(", ")}`;
  }
  return s;
}

function Field({ label, value, onChange, ro, testid }: { label: string; value: string; onChange: (v: string) => void; ro: boolean; testid: string }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {ro ? <div className="text-sm py-2">{value || "—"}</div> : <Input value={value} onChange={(e) => onChange(e.target.value)} data-testid={testid} />}
    </div>
  );
}
function TextBlock({ label, value, onChange, ro, testid }: { label: string; value: string; onChange: (v: string) => void; ro: boolean; testid: string }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {ro ? <div className="text-sm whitespace-pre-wrap min-h-[20px]">{value || "—"}</div> : <Textarea value={value} onChange={(e) => onChange(e.target.value)} rows={2} data-testid={testid} />}
    </div>
  );
}
