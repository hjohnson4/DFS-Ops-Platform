import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import type {
  RigUpReportWithLinks,
  RigUpStatus,
  JobWithCustomer,
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
  DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { Upload, Inbox, Download, ShieldCheck, Trash2 } from "lucide-react";

const STATUS_TONE: Record<RigUpStatus, string> = {
  "Pending sign-off": "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  "Signed off": "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
};

function fmt(d: string | null) {
  if (!d) return "—";
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? d : dt.toLocaleDateString();
}

export default function RigUpReportsPage() {
  const { profile } = useAuth();
  const { toast } = useToast();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [toDelete, setToDelete] = useState<RigUpReportWithLinks | null>(null);

  const { data: reports, isLoading } = useQuery<RigUpReportWithLinks[]>({
    queryKey: ["/api/rig-up-reports"],
  });

  // Uploaders: admins, area managers, supervisors.
  const canUpload =
    profile?.role === "admin" ||
    profile?.role === "area" ||
    profile?.role === "super";
  // Sign-off / delete are reserved for area managers (and admins).
  const isAreaMgr = profile?.role === "area";
  const isAdmin = profile?.role === "admin";

  // A given user may sign off a report only if they are an admin, or an area
  // manager whose area matches the report's (job's) area.
  function canSignOff(r: RigUpReportWithLinks) {
    if (r.status === "Signed off") return false;
    if (isAdmin) return true;
    if (isAreaMgr && profile?.area && r.area === profile.area) return true;
    return false;
  }
  function canDelete(r: RigUpReportWithLinks) {
    if (isAdmin) return true;
    if (isAreaMgr && profile?.area && r.area === profile.area) return true;
    return false;
  }

  const pending = (reports || []).filter(
    (r) => r.status === "Pending sign-off",
  ).length;

  const signOff = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest(
        "POST",
        `/api/rig-up-reports/${id}/sign-off`,
      );
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/rig-up-reports"] });
      toast({ title: "Rig-up report signed off" });
    },
    onError: (e: any) =>
      toast({
        title: "Could not sign off",
        description: e.message,
        variant: "destructive",
      }),
  });

  const del = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/rig-up-reports/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/rig-up-reports"] });
      toast({ title: "Rig-up report removed" });
      setToDelete(null);
    },
    onError: (e: any) =>
      toast({
        title: "Could not remove report",
        description: e.message,
        variant: "destructive",
      }),
  });

  async function download(r: RigUpReportWithLinks) {
    try {
      const res = await apiRequest(
        "GET",
        `/api/rig-up-reports/${r.id}/attachment`,
      );
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = r.attachment_name || "rig-up-report";
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
      <div className="flex items-center justify-between gap-2 mb-1">
        <h2 className="text-base font-semibold">Rig-up Reports</h2>
        <div className="flex items-center gap-2">
          {pending > 0 && (
            <span className="inline-flex items-center rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-400 px-2.5 py-1 text-xs font-medium">
              {pending} awaiting sign-off
            </span>
          )}
          {canUpload && (
            <Button
              size="sm"
              onClick={() => setDialogOpen(true)}
              data-testid="button-upload-rig-up"
            >
              <Upload className="h-3.5 w-3.5 mr-1.5" />
              Upload rig-up report
            </Button>
          )}
        </div>
      </div>
      <p className="text-sm text-muted-foreground mb-5">
        Supervisors and area managers upload rig-up reports for a job. Each
        report is tracked here and held until the area manager for the job's
        area signs it off.
      </p>

      {isLoading ? (
        <div className="text-sm text-muted-foreground py-8 text-center">
          Loading…
        </div>
      ) : reports && reports.length === 0 ? (
        <div className="rounded-lg border border-dashed border-card-border bg-muted/30 p-10 text-center">
          <Inbox className="h-6 w-6 mx-auto text-muted-foreground mb-2" />
          <div className="text-sm text-muted-foreground">
            No rig-up reports yet.
          </div>
          <div className="text-xs text-muted-foreground mt-1">
            {canUpload
              ? "Use “Upload rig-up report” to add one for a job."
              : "Rig-up reports uploaded by supervisors will appear here."}
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-card-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr className="text-left">
                <th className="px-4 py-2.5 font-medium">Uploaded</th>
                <th className="px-4 py-2.5 font-medium">Job / Customer</th>
                <th className="px-4 py-2.5 font-medium">Area</th>
                <th className="px-4 py-2.5 font-medium">Report / File</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {(reports || []).map((r) => (
                <tr
                  key={r.id}
                  className="border-t border-card-border"
                  data-testid={`row-rig-up-${r.id}`}
                >
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    <div>{fmt(r.created_at)}</div>
                    {r.uploaded_by_name && (
                      <div className="text-xs text-muted-foreground">
                        by {r.uploaded_by_name}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="font-medium">{r.job_number || "—"}</div>
                    <div className="text-xs text-muted-foreground">
                      {r.customer_name || "—"}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap">{r.area}</td>
                  <td className="px-4 py-2.5">
                    {r.title && <div className="font-medium">{r.title}</div>}
                    <button
                      className="inline-flex items-center gap-1 text-primary hover:underline text-xs"
                      onClick={() => download(r)}
                      data-testid={`button-download-${r.id}`}
                    >
                      <Download className="h-3 w-3" />
                      {r.attachment_name}
                    </button>
                    {r.report_date && (
                      <div className="text-xs text-muted-foreground">
                        Report date: {fmt(r.report_date)}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <span
                      className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_TONE[r.status]}`}
                      data-testid={`status-${r.id}`}
                    >
                      {r.status}
                    </span>
                    {r.status === "Signed off" && r.signed_off_by_name && (
                      <div className="text-xs text-muted-foreground mt-1">
                        by {r.signed_off_by_name} · {fmt(r.signed_off_at)}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center justify-end gap-1.5">
                      {canSignOff(r) && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={signOff.isPending}
                          onClick={() => signOff.mutate(r.id)}
                          data-testid={`button-sign-off-${r.id}`}
                        >
                          <ShieldCheck className="h-3.5 w-3.5 mr-1" />
                          Sign off
                        </Button>
                      )}
                      {canDelete(r) && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8 text-muted-foreground hover:text-red-600"
                          onClick={() => setToDelete(r)}
                          data-testid={`button-delete-${r.id}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canUpload && (
        <UploadDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          userArea={profile?.role === "admin" ? null : profile?.area ?? null}
        />
      )}

      <AlertDialog
        open={!!toDelete}
        onOpenChange={(o) => !o && setToDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this rig-up report?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the report and its uploaded file. This
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              onClick={() => toDelete && del.mutate(toDelete.id)}
              data-testid="button-confirm-delete"
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function UploadDialog({
  open,
  onOpenChange,
  userArea,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  userArea: string | null;
}) {
  const { toast } = useToast();
  const [jobId, setJobId] = useState("");
  const [reportDate, setReportDate] = useState("");
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [file, setFile] = useState<File | null>(null);

  const { data: jobs } = useQuery<JobWithCustomer[]>({
    queryKey: ["/api/jobs"],
  });
  // Non-admins may only file against jobs in their own area; the server also
  // enforces this, but we filter the picker to avoid confusing 403s.
  const selectableJobs = (jobs || []).filter(
    (j) => !userArea || j.area === userArea,
  );

  function reset() {
    setJobId("");
    setReportDate("");
    setTitle("");
    setNotes("");
    setFile(null);
  }

  const create = useMutation({
    mutationFn: async () => {
      if (!jobId) throw new Error("Choose a job for this rig-up report.");
      if (!file) throw new Error("Attach the rig-up report file.");
      const base64 = await fileToBase64(file);
      const body = {
        job_id: jobId,
        report_date: reportDate || null,
        title: title.trim() || null,
        notes: notes.trim() || null,
        attachment_base64: base64,
        attachment_name: file.name,
        attachment_mime: file.type || "application/octet-stream",
      };
      const res = await apiRequest("POST", "/api/rig-up-reports", body);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/rig-up-reports"] });
      toast({ title: "Rig-up report uploaded" });
      reset();
      onOpenChange(false);
    },
    onError: (e: any) =>
      toast({
        title: "Could not upload report",
        description: e.message,
        variant: "destructive",
      }),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-w-lg max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Upload rig-up report</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 overflow-y-auto flex-1 -mx-6 px-6">
          <div className="space-y-1.5">
            <Label>Job</Label>
            <Select value={jobId} onValueChange={setJobId}>
              <SelectTrigger data-testid="select-job">
                <SelectValue placeholder="Select a job" />
              </SelectTrigger>
              <SelectContent>
                {selectableJobs.length === 0 ? (
                  <div className="px-2 py-2 text-sm text-muted-foreground">
                    No jobs available in your area.
                  </div>
                ) : (
                  selectableJobs.map((j) => (
                    <SelectItem key={j.id} value={j.id}>
                      {j.job_number} · {j.customer_name} ({j.area})
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>Report date</Label>
            <Input
              type="date"
              value={reportDate}
              onChange={(e) => setReportDate(e.target.value)}
              data-testid="input-report-date"
            />
          </div>

          <div className="space-y-1.5">
            <Label>Title / label (optional)</Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Centrifuge rig-up — Pad 3"
              data-testid="input-title"
            />
          </div>

          <div className="space-y-1.5">
            <Label>Notes (optional)</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Any context for the area manager reviewing this report."
              data-testid="input-notes"
            />
          </div>

          <div className="space-y-1.5">
            <Label>Rig-up report file</Label>
            <Input
              type="file"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              data-testid="input-file"
            />
            {file && (
              <div className="text-xs text-muted-foreground">
                {file.name} ({Math.round(file.size / 1024)} KB)
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => create.mutate()}
            disabled={create.isPending || !jobId || !file}
            data-testid="button-submit-rig-up"
          >
            {create.isPending ? "Uploading…" : "Upload"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

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
