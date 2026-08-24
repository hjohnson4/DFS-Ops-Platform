import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import type { JobWithCustomer } from "@shared/schema";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Loader2, Upload, FileText } from "lucide-react";

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

const MAX_BYTES = 20 * 1024 * 1024; // 20 MB

export function UploadServiceReportDialog({
  trigger,
  onUploaded,
}: {
  trigger: React.ReactNode;
  onUploaded?: () => void;
}) {
  const { profile } = useAuth();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);

  const [jobId, setJobId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [notes, setNotes] = useState("");

  const { data: jobs, isLoading: jobsLoading } = useQuery<JobWithCustomer[]>({
    queryKey: ["/api/jobs"],
    enabled: open,
  });

  // Only active jobs are valid targets for a service report. The list is
  // already area-scoped server-side, so no extra area filter is needed here.
  const activeJobs = useMemo(
    () => (jobs ?? []).filter((j) => j.status === "Active"),
    [jobs],
  );

  function reset() {
    setJobId("");
    setFile(null);
    setNotes("");
  }

  const upload = useMutation({
    mutationFn: async () => {
      if (!jobId) throw new Error("Choose a job");
      if (!file) throw new Error("Choose a PDF to upload");
      if (file.size > MAX_BYTES)
        throw new Error("File is too large (20 MB max)");
      const file_base64 = await fileToBase64(file);
      const res = await apiRequest("POST", "/api/service-reports", {
        job_id: jobId,
        file_name: file.name,
        file_mime: file.type || "application/pdf",
        file_base64,
        notes: notes.trim() ? notes.trim() : null,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/service-reports"] });
      toast({ title: "Service report uploaded" });
      reset();
      setOpen(false);
      onUploaded?.();
    },
    onError: (e: any) =>
      toast({
        title: "Could not upload service report",
        description: e.message,
        variant: "destructive",
      }),
  });

  useEffect(() => {
    if (!open) reset();
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <span onClick={() => setOpen(true)}>{trigger}</span>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Upload service report</DialogTitle>
          <DialogDescription>
            Attach a service report (PDF) to the job where you are servicing
            equipment. It will appear on the Service dashboard for your
            {profile?.area ? ` (${profile.area})` : ""} area.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Job ------------------------------------------------------- */}
          <div className="space-y-1.5">
            <Label>Job</Label>
            <Select value={jobId} onValueChange={setJobId}>
              <SelectTrigger data-testid="select-service-report-job">
                <SelectValue
                  placeholder={
                    jobsLoading ? "Loading jobs…" : "Select a job"
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {activeJobs.length === 0 && !jobsLoading ? (
                  <div className="px-3 py-2 text-sm text-muted-foreground">
                    No active jobs in your area.
                  </div>
                ) : (
                  activeJobs.map((j) => (
                    <SelectItem key={j.id} value={j.id}>
                      {j.job_number}
                      {j.well_name ? ` — ${j.well_name}` : ""} · {j.area}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>

          {/* File ------------------------------------------------------ */}
          <div className="space-y-1.5">
            <Label htmlFor="service-report-file">Service report file</Label>
            <Input
              id="service-report-file"
              type="file"
              accept="application/pdf,.pdf"
              data-testid="input-service-report-file"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            {file ? (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <FileText className="h-3.5 w-3.5" />
                {file.name} · {(file.size / 1024).toFixed(0)} KB
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">
                PDF, up to 20 MB.
              </div>
            )}
          </div>

          {/* Notes ----------------------------------------------------- */}
          <div className="space-y-1.5">
            <Label htmlFor="service-report-notes">Notes (optional)</Label>
            <Textarea
              id="service-report-notes"
              placeholder="Any context for this report…"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              data-testid="input-service-report-notes"
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            data-testid="button-cancel-service-report"
          >
            Cancel
          </Button>
          <Button
            onClick={() => upload.mutate()}
            disabled={upload.isPending || !jobId || !file}
            data-testid="button-submit-service-report"
          >
            {upload.isPending ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <Upload className="mr-1.5 h-4 w-4" />
            )}
            Upload
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
