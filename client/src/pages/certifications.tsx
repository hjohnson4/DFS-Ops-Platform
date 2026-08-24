import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import {
  ROLE_LABELS,
  CERT_TYPES,
  certStatusOf,
  type CertRosterEntry,
  type CertificationWithNames,
  type CertStatus,
} from "@shared/schema";
import { SafetyTabs } from "@/components/SafetyTabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import {
  BadgeCheck,
  Loader2,
  Plus,
  ChevronDown,
  ChevronRight,
  FileText,
  Download,
  Trash2,
} from "lucide-react";

// Tone classes per compliance status.
const STATUS_TONE: Record<CertStatus, string> = {
  Compliant: "bg-green-500/15 text-green-700 dark:text-green-400",
  "Expiring soon": "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  Expired: "bg-red-500/15 text-red-700 dark:text-red-400",
  "No expiry": "bg-muted text-muted-foreground",
};

function StatusPill({ status }: { status: CertStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_TONE[status]}`}
    >
      {status}
    </span>
  );
}

// A person's overall compliance: expired if any cert is expired, else expiring
// soon if any is expiring soon, else compliant if they have any dated cert,
// else "No certs".
function rollup(certs: CertificationWithNames[]): CertStatus | "No certs" {
  if (!certs.length) return "No certs";
  const statuses = certs.map((c) => certStatusOf(c.expiry_date));
  if (statuses.includes("Expired")) return "Expired";
  if (statuses.includes("Expiring soon")) return "Expiring soon";
  if (statuses.includes("Compliant")) return "Compliant";
  return "No expiry";
}

export default function CertificationsPage() {
  const { profile } = useAuth();
  const { toast } = useToast();
  const canManage = profile?.role === "admin" || profile?.role === "area";

  const { data: roster, isLoading } = useQuery<CertRosterEntry[]>({
    queryKey: ["/api/certifications"],
  });

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [dialogOpen, setDialogOpen] = useState(false);
  const [presetProfile, setPresetProfile] = useState<string | undefined>();

  // Roster-wide compliance summary.
  const summary = useMemo(() => {
    let compliant = 0,
      expiring = 0,
      expired = 0,
      nocerts = 0;
    for (const e of roster || []) {
      const r = rollup(e.certs);
      if (r === "Expired") expired++;
      else if (r === "Expiring soon") expiring++;
      else if (r === "No certs") nocerts++;
      else compliant++;
    }
    return { compliant, expiring, expired, nocerts, total: (roster || []).length };
  }, [roster]);

  function openUploadFor(profileId?: string) {
    setPresetProfile(profileId);
    setDialogOpen(true);
  }

  async function downloadCert(c: CertificationWithNames) {
    try {
      const res = await apiRequest("GET", `/api/certifications/${c.id}/attachment`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = c.attachment_name || "certification";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      toast({
        title: "Could not download file",
        description: e.message,
        variant: "destructive",
      });
    }
  }

  const del = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/certifications/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/certifications"] });
      toast({ title: "Certification removed" });
    },
    onError: (e: any) =>
      toast({
        title: "Could not remove certification",
        description: e.message,
        variant: "destructive",
      }),
  });

  return (
    <div className="p-6 max-w-5xl">
      <h1 className="text-xl font-semibold mb-3">Safety / JSAs</h1>
      <SafetyTabs />

      <div className="flex items-center justify-between mb-1">
        <h2 className="text-base font-semibold">Certifications</h2>
        {canManage && (
          <Button size="sm" onClick={() => openUploadFor(undefined)} data-testid="button-add-cert">
            <Plus className="h-4 w-4 mr-1" />
            Upload certification
          </Button>
        )}
      </div>
      <p className="text-sm text-muted-foreground mb-4">
        Safety compliance for field employees — area managers, supervisors, and
        field techs.
        {canManage
          ? " Upload certificate files and record expiry dates to keep compliance current."
          : ""}
      </p>

      {/* Summary strip */}
      {!isLoading && roster && roster.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
          {[
            { label: "Compliant", value: summary.compliant, tone: "text-green-600 dark:text-green-400" },
            { label: "Expiring soon", value: summary.expiring, tone: "text-amber-600 dark:text-amber-400" },
            { label: "Expired", value: summary.expired, tone: "text-red-600 dark:text-red-400" },
            { label: "No certs on file", value: summary.nocerts, tone: "text-muted-foreground" },
          ].map((s) => (
            <div
              key={s.label}
              className="rounded-lg border border-card-border p-3"
              data-testid={`summary-${s.label.toLowerCase().replace(/\s/g, "-")}`}
            >
              <div className={`text-2xl font-semibold tabular-nums ${s.tone}`}>{s.value}</div>
              <div className="text-xs text-muted-foreground">{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {isLoading ? (
        <div className="text-sm text-muted-foreground py-8 text-center">Loading…</div>
      ) : !roster || roster.length === 0 ? (
        <div className="rounded-lg border border-dashed border-card-border bg-muted/30 p-10 text-center">
          <BadgeCheck className="h-6 w-6 mx-auto text-muted-foreground mb-2" />
          <div className="text-sm text-muted-foreground">
            No field employees found for your area.
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-card-border overflow-hidden divide-y divide-card-border">
          {roster.map((entry) => {
            const r = rollup(entry.certs);
            const isOpen = expanded[entry.profile.id];
            return (
              <div key={entry.profile.id} data-testid={`roster-row-${entry.profile.id}`}>
                {/* Employee header row */}
                <button
                  type="button"
                  onClick={() =>
                    setExpanded((s) => ({ ...s, [entry.profile.id]: !s[entry.profile.id] }))
                  }
                  className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted/40"
                  data-testid={`toggle-${entry.profile.id}`}
                >
                  {isOpen ? (
                    <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                  ) : (
                    <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{entry.profile.name}</div>
                    <div className="text-xs text-muted-foreground truncate">
                      {ROLE_LABELS[entry.profile.role]}
                      {entry.profile.area ? ` · ${entry.profile.area}` : ""}
                    </div>
                  </div>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {entry.certs.length} {entry.certs.length === 1 ? "cert" : "certs"}
                  </span>
                  {r === "No certs" ? (
                    <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-muted text-muted-foreground">
                      No certs
                    </span>
                  ) : (
                    <StatusPill status={r} />
                  )}
                </button>

                {/* Expanded cert list */}
                {isOpen && (
                  <div className="bg-muted/20 px-4 pb-3">
                    {entry.certs.length === 0 ? (
                      <div className="flex items-center justify-between py-3 text-sm text-muted-foreground">
                        <span>No certifications on file.</span>
                        {canManage && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => openUploadFor(entry.profile.id)}
                            data-testid={`add-for-${entry.profile.id}`}
                          >
                            <Plus className="h-3.5 w-3.5 mr-1" />
                            Add
                          </Button>
                        )}
                      </div>
                    ) : (
                      <table className="w-full text-sm">
                        <thead className="text-muted-foreground">
                          <tr className="text-left">
                            <th className="py-2 pr-3 font-medium">Certification</th>
                            <th className="py-2 pr-3 font-medium">Issued</th>
                            <th className="py-2 pr-3 font-medium">Expires</th>
                            <th className="py-2 pr-3 font-medium">Status</th>
                            <th className="py-2 pr-3 font-medium">File</th>
                            {canManage && <th className="py-2 font-medium text-right">Actions</th>}
                          </tr>
                        </thead>
                        <tbody>
                          {entry.certs.map((c) => {
                            const st = certStatusOf(c.expiry_date);
                            return (
                              <tr key={c.id} className="border-t border-card-border" data-testid={`cert-${c.id}`}>
                                <td className="py-2 pr-3">
                                  <div className="font-medium">{c.cert_type}</div>
                                  {c.issuing_org && (
                                    <div className="text-xs text-muted-foreground">{c.issuing_org}</div>
                                  )}
                                </td>
                                <td className="py-2 pr-3 text-muted-foreground tabular-nums">
                                  {c.issue_date || "—"}
                                </td>
                                <td className="py-2 pr-3 text-muted-foreground tabular-nums">
                                  {c.expiry_date || "—"}
                                </td>
                                <td className="py-2 pr-3">
                                  <StatusPill status={st} />
                                </td>
                                <td className="py-2 pr-3">
                                  {c.attachment_name ? (
                                    <button
                                      type="button"
                                      onClick={() => downloadCert(c)}
                                      className="inline-flex items-center gap-1 text-primary hover:underline"
                                      data-testid={`download-${c.id}`}
                                    >
                                      <FileText className="h-3.5 w-3.5" />
                                      <span className="max-w-[10rem] truncate">{c.attachment_name}</span>
                                      <Download className="h-3 w-3" />
                                    </button>
                                  ) : (
                                    <span className="text-muted-foreground">—</span>
                                  )}
                                </td>
                                {canManage && (
                                  <td className="py-2 text-right">
                                    <button
                                      type="button"
                                      onClick={() => {
                                        if (confirm(`Remove ${c.cert_type} for ${entry.profile.name}?`))
                                          del.mutate(c.id);
                                      }}
                                      className="text-muted-foreground hover:text-red-600"
                                      data-testid={`delete-${c.id}`}
                                    >
                                      <Trash2 className="h-4 w-4" />
                                    </button>
                                  </td>
                                )}
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    )}
                    {canManage && entry.certs.length > 0 && (
                      <div className="pt-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => openUploadFor(entry.profile.id)}
                          data-testid={`add-more-${entry.profile.id}`}
                        >
                          <Plus className="h-3.5 w-3.5 mr-1" />
                          Add certification
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {canManage && (
        <UploadDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          roster={roster || []}
          presetProfile={presetProfile}
        />
      )}
    </div>
  );
}

// ---- Upload dialog ---------------------------------------------------------

function UploadDialog({
  open,
  onOpenChange,
  roster,
  presetProfile,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  roster: CertRosterEntry[];
  presetProfile?: string;
}) {
  const { toast } = useToast();
  const [profileId, setProfileId] = useState<string>("");
  const [certType, setCertType] = useState<string>("");
  const [customType, setCustomType] = useState<string>("");
  const [issuingOrg, setIssuingOrg] = useState<string>("");
  const [issueDate, setIssueDate] = useState<string>("");
  const [expiryDate, setExpiryDate] = useState<string>("");
  const [notes, setNotes] = useState<string>("");
  const [file, setFile] = useState<File | null>(null);

  // Sync the preset employee when the dialog opens from a specific row.
  useMemo(() => {
    if (open) setProfileId(presetProfile || "");
  }, [open, presetProfile]);

  function reset() {
    setProfileId("");
    setCertType("");
    setCustomType("");
    setIssuingOrg("");
    setIssueDate("");
    setExpiryDate("");
    setNotes("");
    setFile(null);
  }

  const create = useMutation({
    mutationFn: async () => {
      const resolvedType = certType === "__custom__" ? customType.trim() : certType;
      const body: Record<string, any> = {
        profile_id: profileId,
        cert_type: resolvedType,
        issuing_org: issuingOrg.trim() || null,
        issue_date: issueDate || null,
        expiry_date: expiryDate || null,
        notes: notes.trim() || null,
      };
      if (file) {
        const base64 = await fileToBase64(file);
        body.attachment_base64 = base64;
        body.attachment_name = file.name;
        body.attachment_mime = file.type || "application/octet-stream";
      }
      const res = await apiRequest("POST", "/api/certifications", body);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/certifications"] });
      toast({ title: "Certification saved" });
      reset();
      onOpenChange(false);
    },
    onError: (e: any) =>
      toast({
        title: "Could not save certification",
        description: e.message,
        variant: "destructive",
      }),
  });

  const resolvedType = certType === "__custom__" ? customType.trim() : certType;
  const valid = profileId && resolvedType.length > 0;

  // Roster is already area-scoped by the server, so every employee here is
  // one the current manager may add certs for.
  const people = roster.map((r) => r.profile);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Upload certification</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 overflow-y-auto flex-1 -mx-6 px-6">
          <div>
            <Label>Employee</Label>
            <Select value={profileId} onValueChange={setProfileId}>
              <SelectTrigger data-testid="select-employee">
                <SelectValue placeholder="Select an employee" />
              </SelectTrigger>
              <SelectContent>
                {people.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name} · {ROLE_LABELS[p.role]}
                    {p.area ? ` · ${p.area}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label>Certification type</Label>
            <Select value={certType} onValueChange={setCertType}>
              <SelectTrigger data-testid="select-cert-type">
                <SelectValue placeholder="Select a certification" />
              </SelectTrigger>
              <SelectContent>
                {CERT_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
                <SelectItem value="__custom__">Other (type it in)</SelectItem>
              </SelectContent>
            </Select>
            {certType === "__custom__" && (
              <Input
                className="mt-2"
                placeholder="Certification name"
                value={customType}
                onChange={(e) => setCustomType(e.target.value)}
                data-testid="input-custom-type"
              />
            )}
          </div>

          <div>
            <Label>Issuing organization (optional)</Label>
            <Input
              placeholder="e.g. PEC Safety, Red Cross"
              value={issuingOrg}
              onChange={(e) => setIssuingOrg(e.target.value)}
              data-testid="input-issuing-org"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Issue date</Label>
              <Input
                type="date"
                value={issueDate}
                onChange={(e) => setIssueDate(e.target.value)}
                data-testid="input-issue-date"
              />
            </div>
            <div>
              <Label>Expiry date</Label>
              <Input
                type="date"
                value={expiryDate}
                onChange={(e) => setExpiryDate(e.target.value)}
                data-testid="input-expiry-date"
              />
            </div>
          </div>

          <div>
            <Label>Certificate file (optional)</Label>
            <Input
              type="file"
              accept=".pdf,.png,.jpg,.jpeg,image/*,application/pdf"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
              data-testid="input-file"
            />
            {file && (
              <div className="text-xs text-muted-foreground mt-1">
                {file.name} · {(file.size / 1024).toFixed(0)} KB
              </div>
            )}
          </div>

          <div>
            <Label>Notes (optional)</Label>
            <Textarea
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              data-testid="input-notes"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => create.mutate()}
            disabled={!valid || create.isPending}
            data-testid="button-save-cert"
          >
            {create.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Read a File into a base64 string (no data: prefix) for JSON upload.
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
