import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import {
  ROLE_LABELS,
  certStatusOf,
  type CertRosterEntry,
  type CertificationWithNames,
  type CertStatus,
} from "@shared/schema";
import { SafetyTabs } from "@/components/SafetyTabs";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  UserCircle,
  BadgeCheck,
  Download,
  FileText,
  Mail,
  MapPin,
  Briefcase,
} from "lucide-react";

// Tone classes per compliance status (mirrors the Certifications tab).
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
// soon if any is, else compliant if they have any dated cert, else "No certs".
function rollup(certs: CertificationWithNames[]): CertStatus | "No certs" {
  if (!certs.length) return "No certs";
  const statuses = certs.map((c) => certStatusOf(c.expiry_date));
  if (statuses.includes("Expired")) return "Expired";
  if (statuses.includes("Expiring soon")) return "Expiring soon";
  if (statuses.includes("Compliant")) return "Compliant";
  return "No expiry";
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function EmployeeProfilesPage() {
  const { toast } = useToast();
  const [selectedId, setSelectedId] = useState<string>("");

  const { data: roster, isLoading } = useQuery<CertRosterEntry[]>({
    queryKey: ["/api/certifications"],
  });

  const people = useMemo(
    () =>
      (roster ?? [])
        .slice()
        .sort((a, b) =>
          (a.profile.name ?? "").localeCompare(b.profile.name ?? ""),
        ),
    [roster],
  );

  const selected = useMemo(
    () => people.find((e) => e.profile.id === selectedId) ?? null,
    [people, selectedId],
  );

  // Sort a person's certs: soonest expiry first, undated last.
  const sortedCerts = useMemo(() => {
    if (!selected) return [];
    return selected.certs.slice().sort((a, b) => {
      if (!a.expiry_date && !b.expiry_date) return 0;
      if (!a.expiry_date) return 1;
      if (!b.expiry_date) return -1;
      return a.expiry_date.localeCompare(b.expiry_date);
    });
  }, [selected]);

  async function downloadCert(c: CertificationWithNames) {
    try {
      const res = await apiRequest(
        "GET",
        `/api/certifications/${c.id}/attachment`,
      );
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

  return (
    <div className="p-6 max-w-5xl">
      <h1 className="text-xl font-semibold mb-3">Safety / JSAs</h1>
      <SafetyTabs />

      <div className="flex items-center gap-2 mb-1">
        <UserCircle className="h-5 w-5 text-muted-foreground" />
        <h2 className="text-base font-semibold">Employee Profiles</h2>
      </div>
      <p className="text-sm text-muted-foreground mb-4">
        Select an employee to review their safety certifications and compliance
        status.
      </p>

      {/* Employee picker */}
      <div className="max-w-sm mb-6">
        <Select value={selectedId} onValueChange={setSelectedId}>
          <SelectTrigger data-testid="select-employee-profile">
            <SelectValue placeholder="Select an employee…" />
          </SelectTrigger>
          <SelectContent>
            {people.map((e) => (
              <SelectItem key={e.profile.id} value={e.profile.id}>
                {e.profile.name} · {ROLE_LABELS[e.profile.role]}
                {e.profile.area ? ` · ${e.profile.area}` : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <div className="text-sm text-muted-foreground py-10 text-center">
          Loading…
        </div>
      ) : people.length === 0 ? (
        <div className="rounded-lg border border-dashed border-card-border bg-muted/30 p-10 text-center">
          <UserCircle className="h-6 w-6 mx-auto text-muted-foreground mb-2" />
          <div className="text-sm text-muted-foreground">
            No field employees on the roster yet.
          </div>
        </div>
      ) : !selected ? (
        <div className="rounded-lg border border-dashed border-card-border bg-muted/30 p-10 text-center">
          <UserCircle className="h-6 w-6 mx-auto text-muted-foreground mb-2" />
          <div className="text-sm text-muted-foreground">
            Choose an employee above to view their profile.
          </div>
        </div>
      ) : (
        <ProfileCard
          entry={selected}
          certs={sortedCerts}
          onDownload={downloadCert}
        />
      )}
    </div>
  );
}

function ProfileCard({
  entry,
  certs,
  onDownload,
}: {
  entry: CertRosterEntry;
  certs: CertificationWithNames[];
  onDownload: (c: CertificationWithNames) => void;
}) {
  const { profile } = entry;
  const overall = rollup(certs);

  // Compliance counts for the header summary.
  const counts = certs.reduce(
    (acc, c) => {
      acc[certStatusOf(c.expiry_date)]++;
      return acc;
    },
    { Compliant: 0, "Expiring soon": 0, Expired: 0, "No expiry": 0 } as Record<
      CertStatus,
      number
    >,
  );

  return (
    <div className="rounded-lg border border-card-border overflow-hidden">
      {/* Header: employee identity + overall status */}
      <div className="border-b border-card-border bg-muted/30 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-full bg-primary/10 text-primary">
              <UserCircle className="h-6 w-6" />
            </div>
            <div>
              <div className="font-semibold" data-testid="text-employee-name">
                {profile.name}
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground mt-0.5">
                <span className="inline-flex items-center gap-1">
                  <Briefcase className="h-3 w-3" />
                  {ROLE_LABELS[profile.role]}
                </span>
                {profile.area && (
                  <span className="inline-flex items-center gap-1">
                    <MapPin className="h-3 w-3" />
                    {profile.area}
                  </span>
                )}
                {profile.email && (
                  <span className="inline-flex items-center gap-1">
                    <Mail className="h-3 w-3" />
                    {profile.email}
                  </span>
                )}
              </div>
            </div>
          </div>
          <div className="text-right">
            <div className="text-xs text-muted-foreground mb-1">
              Overall status
            </div>
            {overall === "No certs" ? (
              <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                No certs
              </span>
            ) : (
              <StatusPill status={overall} />
            )}
          </div>
        </div>

        {/* Compliance summary chips */}
        {certs.length > 0 && (
          <div className="flex flex-wrap gap-3 mt-3 text-xs">
            <span className="text-green-700 dark:text-green-400">
              {counts.Compliant} compliant
            </span>
            <span className="text-amber-700 dark:text-amber-400">
              {counts["Expiring soon"]} expiring soon
            </span>
            <span className="text-red-700 dark:text-red-400">
              {counts.Expired} expired
            </span>
            {counts["No expiry"] > 0 && (
              <span className="text-muted-foreground">
                {counts["No expiry"]} no expiry
              </span>
            )}
          </div>
        )}
      </div>

      {/* Certifications list */}
      <div className="p-4">
        <div className="flex items-center gap-1.5 text-sm font-semibold mb-3">
          <BadgeCheck className="h-4 w-4 text-muted-foreground" />
          Certifications
          <span className="text-xs font-normal text-muted-foreground">
            ({certs.length})
          </span>
        </div>

        {certs.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No certifications on file for this employee.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-card-border text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Certification</th>
                  <th className="py-2 pr-3 font-medium">Status</th>
                  <th className="py-2 pr-3 font-medium">Issued</th>
                  <th className="py-2 pr-3 font-medium">Expires</th>
                  <th className="py-2 pr-3 font-medium">Issuing org</th>
                  <th className="py-2 font-medium text-right">File</th>
                </tr>
              </thead>
              <tbody>
                {certs.map((c) => {
                  const status = certStatusOf(c.expiry_date);
                  return (
                    <tr
                      key={c.id}
                      className="border-b border-card-border last:border-0"
                      data-testid={`row-cert-${c.id}`}
                    >
                      <td className="py-2.5 pr-3 font-medium">{c.cert_type}</td>
                      <td className="py-2.5 pr-3">
                        <StatusPill status={status} />
                      </td>
                      <td className="py-2.5 pr-3 whitespace-nowrap text-muted-foreground">
                        {fmtDate(c.issue_date)}
                      </td>
                      <td className="py-2.5 pr-3 whitespace-nowrap text-muted-foreground">
                        {fmtDate(c.expiry_date)}
                      </td>
                      <td className="py-2.5 pr-3 text-muted-foreground">
                        {c.issuing_org || "—"}
                      </td>
                      <td className="py-2.5 text-right">
                        {c.attachment_name ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => onDownload(c)}
                            data-testid={`button-download-cert-${c.id}`}
                          >
                            <Download className="mr-1.5 h-3.5 w-3.5" />
                            View
                          </Button>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                            <FileText className="h-3.5 w-3.5 opacity-60" />
                            None
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
