import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  History,
  Search,
  Loader2,
  FileText,
  ShieldAlert,
  Wrench,
  HardHat,
  CheckCircle2,
  MessageSquareWarning,
  Inbox,
  Link2,
  RotateCcw,
  X,
} from "lucide-react";

// ---- Types (mirror the /api/audit-trail response) -------------------------
type AuditEntity = "daily_report" | "jsa" | "rig_up" | "maintenance";
type AuditEntry = {
  id: string;
  entity: AuditEntity;
  entity_label: string;
  record_id: string | null;
  actor_id: string | null;
  actor_name: string | null;
  actor_role: string | null;
  action: string;
  detail: string | null;
  area: string | null;
  href: string | null;
  occurred_at: string | null;
};
type AuditResponse = {
  total: number;
  limit: number;
  offset: number;
  items: AuditEntry[];
  facets: { actions: string[]; actors: string[] };
};

const ENTITY_META: Record<
  AuditEntity,
  { label: string; icon: typeof FileText; tone: string }
> = {
  daily_report: {
    label: "Daily Report",
    icon: FileText,
    tone: "bg-sky-500/15 text-sky-700 dark:text-sky-400",
  },
  jsa: {
    label: "JSA",
    icon: ShieldAlert,
    tone: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  },
  rig_up: {
    label: "Rig-Up",
    icon: HardHat,
    tone: "bg-violet-500/15 text-violet-700 dark:text-violet-400",
  },
  maintenance: {
    label: "Service",
    icon: Wrench,
    tone: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  },
};

// Icon shown next to the action verb.
function actionIcon(action: string) {
  const a = action.toLowerCase();
  if (a.includes("sign")) return CheckCircle2;
  if (a.includes("change")) return MessageSquareWarning;
  if (a.includes("ingest") || a.includes("receiv")) return Inbox;
  if (a.includes("match")) return Link2;
  if (a.includes("reopen")) return RotateCcw;
  return History;
}

const ROLE_TONE: Record<string, string> = {
  admin: "bg-primary/15 text-primary",
  area: "bg-blue-500/15 text-blue-700 dark:text-blue-400",
  super: "bg-teal-500/15 text-teal-700 dark:text-teal-400",
  field: "bg-muted text-muted-foreground",
};

function relTime(iso: string | null): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (isNaN(t)) return iso;
  const diff = Date.now() - t;
  const s = Math.round(diff / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

function fullTime(iso: string | null): string {
  if (!iso) return "";
  const dt = new Date(iso);
  return isNaN(dt.getTime()) ? "" : dt.toLocaleString();
}

const PAGE_SIZE = 50;

export default function AuditTrailPage() {
  const [, navigate] = useLocation();

  // Filters
  const [search, setSearch] = useState("");
  const [entity, setEntity] = useState<string>("all");
  const [action, setAction] = useState<string>("all");
  const [actor, setActor] = useState<string>("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [offset, setOffset] = useState(0);

  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (search.trim()) p.set("q", search.trim());
    if (entity !== "all") p.set("entity", entity);
    if (action !== "all") p.set("action", action);
    if (actor !== "all") p.set("actor", actor);
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    p.set("limit", String(PAGE_SIZE));
    p.set("offset", String(offset));
    return p.toString();
  }, [search, entity, action, actor, from, to, offset]);

  const { data, isLoading, isFetching } = useQuery<AuditResponse>({
    queryKey: ["audit-trail", params],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/audit-trail?${params}`);
      return res.json();
    },
    placeholderData: (prev) => prev,
  });

  const items = data?.items || [];
  const total = data?.total ?? 0;
  const facetActions = data?.facets?.actions || [];
  const facetActors = data?.facets?.actors || [];

  const hasActiveFilters =
    !!search.trim() ||
    entity !== "all" ||
    action !== "all" ||
    actor !== "all" ||
    !!from ||
    !!to;

  function resetFilters() {
    setSearch("");
    setEntity("all");
    setAction("all");
    setActor("all");
    setFrom("");
    setTo("");
    setOffset(0);
  }

  // Any filter change resets pagination to the first page.
  function onFilterChange<T>(setter: (v: T) => void) {
    return (v: T) => {
      setter(v);
      setOffset(0);
    };
  }

  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + PAGE_SIZE, total);

  return (
    <div className="p-6 space-y-6 max-w-6xl mx-auto">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2">
          <History className="h-6 w-6 text-primary" />
          <h1 className="text-2xl font-semibold tracking-tight">Audit Trail</h1>
        </div>
        <p className="text-sm text-muted-foreground mt-1">
          A unified, read-only record of every sign-off, review, ingest, and
          service action across the platform.
        </p>
      </div>

      {/* Filters */}
      <div className="rounded-lg border bg-card p-4 space-y-3">
        <div className="flex flex-col md:flex-row md:items-center gap-3">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => onFilterChange(setSearch)(e.target.value)}
              placeholder="Search by person, action, record, or note…"
              className="pl-9"
              data-testid="input-search-audit"
            />
          </div>
          <Select value={entity} onValueChange={onFilterChange(setEntity)}>
            <SelectTrigger className="w-full md:w-[160px]" data-testid="select-audit-entity">
              <SelectValue placeholder="All types" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              <SelectItem value="daily_report">Daily Reports</SelectItem>
              <SelectItem value="jsa">JSAs</SelectItem>
              <SelectItem value="rig_up">Rig-Up Reports</SelectItem>
              <SelectItem value="maintenance">Service</SelectItem>
            </SelectContent>
          </Select>
          <Select value={action} onValueChange={onFilterChange(setAction)}>
            <SelectTrigger className="w-full md:w-[170px]" data-testid="select-audit-action">
              <SelectValue placeholder="All actions" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All actions</SelectItem>
              {facetActions.map((a) => (
                <SelectItem key={a} value={a}>
                  {a}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={actor} onValueChange={onFilterChange(setActor)}>
            <SelectTrigger className="w-full md:w-[160px]" data-testid="select-audit-actor">
              <SelectValue placeholder="All people" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All people</SelectItem>
              {facetActors.map((a) => (
                <SelectItem key={a} value={a}>
                  {a}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground whitespace-nowrap">From</span>
            <Input
              type="date"
              value={from}
              onChange={(e) => onFilterChange(setFrom)(e.target.value)}
              className="w-[160px]"
              data-testid="input-audit-from"
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground whitespace-nowrap">To</span>
            <Input
              type="date"
              value={to}
              onChange={(e) => onFilterChange(setTo)(e.target.value)}
              className="w-[160px]"
              data-testid="input-audit-to"
            />
          </div>
          {hasActiveFilters && (
            <Button
              variant="ghost"
              size="sm"
              onClick={resetFilters}
              className="gap-1 text-muted-foreground"
              data-testid="button-clear-audit-filters"
            >
              <X className="h-4 w-4" /> Clear filters
            </Button>
          )}
          <div className="sm:ml-auto text-xs text-muted-foreground flex items-center gap-2">
            {isFetching && <Loader2 className="h-3 w-3 animate-spin" />}
            {total > 0 ? (
              <span data-testid="text-audit-count">
                Showing {pageStart}–{pageEnd} of {total}
              </span>
            ) : null}
          </div>
        </div>
      </div>

      {/* Timeline */}
      {isLoading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading activity…
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <History className="h-10 w-10 text-muted-foreground/40 mb-3" />
          <p className="text-sm font-medium">No activity found</p>
          <p className="text-xs text-muted-foreground mt-1">
            {hasActiveFilters
              ? "Try widening your filters or clearing them."
              : "Actions like sign-offs, reviews, and ingests will appear here."}
          </p>
        </div>
      ) : (
        <ol className="relative border-l ml-2 space-y-1" data-testid="list-audit-entries">
          {items.map((e) => {
            const meta = ENTITY_META[e.entity];
            const EntIcon = meta.icon;
            const ActIcon = actionIcon(e.action);
            return (
              <li key={e.id} className="relative pl-6 py-3" data-testid={`audit-entry-${e.id}`}>
                {/* timeline dot */}
                <span className="absolute -left-[7px] top-4 h-3 w-3 rounded-full border-2 border-background bg-primary" />
                <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center flex-wrap gap-2">
                      <ActIcon className="h-4 w-4 text-primary shrink-0" />
                      <span className="font-medium">{e.action}</span>
                      <span
                        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${meta.tone}`}
                      >
                        <EntIcon className="h-3 w-3" />
                        {meta.label}
                      </span>
                    </div>
                    <div className="text-sm text-muted-foreground mt-1 flex items-center flex-wrap gap-x-1.5 gap-y-0.5">
                      <span className="font-medium text-foreground">
                        {e.actor_name || "Unknown"}
                      </span>
                      {e.actor_role && (
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                            ROLE_TONE[e.actor_role] || "bg-muted text-muted-foreground"
                          }`}
                        >
                          {e.actor_role}
                        </span>
                      )}
                      <span>·</span>
                      <span className="truncate">{e.entity_label}</span>
                      {e.area && (
                        <>
                          <span>·</span>
                          <span>{e.area}</span>
                        </>
                      )}
                    </div>
                    {e.detail && (
                      <p className="text-sm mt-1.5 rounded-md bg-muted/60 px-3 py-1.5 text-foreground/90">
                        {e.detail}
                      </p>
                    )}
                    {e.href && (
                      <button
                        onClick={() => navigate(e.href!)}
                        className="text-xs text-primary hover:underline mt-1.5 inline-flex items-center gap-1"
                        data-testid={`button-audit-open-${e.id}`}
                      >
                        <Link2 className="h-3 w-3" /> Open record
                      </button>
                    )}
                  </div>
                  <div
                    className="text-xs text-muted-foreground whitespace-nowrap shrink-0"
                    title={fullTime(e.occurred_at)}
                  >
                    {relTime(e.occurred_at)}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {/* Pagination */}
      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between pt-2">
          <Button
            variant="outline"
            size="sm"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            data-testid="button-audit-prev"
          >
            Previous
          </Button>
          <span className="text-xs text-muted-foreground">
            Page {Math.floor(offset / PAGE_SIZE) + 1} of{" "}
            {Math.max(1, Math.ceil(total / PAGE_SIZE))}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={pageEnd >= total}
            onClick={() => setOffset(offset + PAGE_SIZE)}
            data-testid="button-audit-next"
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}
