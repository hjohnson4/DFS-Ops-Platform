import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import {
  RIG_INSPECTION_CHECKLIST,
  isLiveJobStatus,
  type JobWithCustomer,
} from "@shared/schema";
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
import { Loader2, ClipboardCheck, ImagePlus, X } from "lucide-react";

type Answer = "Yes" | "No" | "N/A";
const MAX_PHOTOS = 24;
const MAX_PHOTO_BYTES = 20 * 1024 * 1024; // original file; it is shrunk before upload

interface PendingPhoto {
  file: File;
  url: string;
}

// Local "YYYY-MM-DDTHH:mm" for a datetime-local input.
function nowLocal(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Shrink a phone photo to max 1600px JPEG so each upload stays small.
async function compressImage(file: File): Promise<{ base64: string; mime: string; name: string }> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error(`Could not read ${file.name}`));
      i.src = url;
    });
    const max = 1600;
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d")!.drawImage(img, 0, 0, w, h);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.8);
    const base = file.name.replace(/\.[^.]+$/, "") || "photo";
    return {
      base64: dataUrl.slice(dataUrl.indexOf(",") + 1),
      mime: "image/jpeg",
      name: `${base}.jpg`.slice(0, 200),
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Sections in checklist order.
const SECTIONS: { name: string; items: typeof RIG_INSPECTION_CHECKLIST }[] = (() => {
  const out: { name: string; items: typeof RIG_INSPECTION_CHECKLIST }[] = [];
  for (const def of RIG_INSPECTION_CHECKLIST) {
    let s = out.find((x) => x.name === def.section);
    if (!s) out.push((s = { name: def.section, items: [] }));
    s.items.push(def);
  }
  return out;
})();

// In-app "Official Rig Inspection". Filed as a rig-up report for a job and
// held for the area manager's sign-off, same as an uploaded rig-up report.
export function NewRigInspectionDialog({
  open,
  onOpenChange,
  userArea,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  userArea: string | null;
}) {
  const { toast } = useToast();
  const { profile } = useAuth();

  const [jobId, setJobId] = useState("");
  const [site, setSite] = useState("");
  const [rigNumber, setRigNumber] = useState("");
  const [conductedOn, setConductedOn] = useState(nowLocal);
  const [preparedBy, setPreparedBy] = useState(profile?.name ?? "");
  const [notes, setNotes] = useState("");
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [itemNotes, setItemNotes] = useState<Record<string, string>>({});
  const [photos, setPhotos] = useState<PendingPhoto[]>([]);
  const [progress, setProgress] = useState("");

  const { data: jobs, isLoading: jobsLoading } = useQuery<JobWithCustomer[]>({
    queryKey: ["/api/jobs"],
    enabled: open,
  });
  const selectableJobs = useMemo(
    () =>
      (jobs || [])
        .filter((j) => !j.archived_at && isLiveJobStatus(j.status))
        .filter((j) => !userArea || j.area === userArea)
        .sort((a, b) => a.job_number.localeCompare(b.job_number)),
    [jobs, userArea],
  );

  function pickJob(id: string) {
    setJobId(id);
    const j = selectableJobs.find((x) => x.id === id);
    if (j) {
      setSite(j.well_name ? `${j.customer_name} — ${j.well_name}` : j.customer_name || "");
      setRigNumber(j.job_number || "");
    }
  }

  const required = RIG_INSPECTION_CHECKLIST.filter((d) => d.required);
  const { answeredReq, passCount, totalCount, flaggedCount } = useMemo(() => {
    let answeredReq = 0;
    let pass = 0;
    let total = 0;
    let flagged = 0;
    for (const def of RIG_INSPECTION_CHECKLIST) {
      const a = answers[def.key];
      if (!a) continue;
      if (def.required) answeredReq += 1;
      if (a === "N/A") continue;
      total += 1;
      if (a === def.flagOn) flagged += 1;
      else pass += 1;
    }
    return { answeredReq, passCount: pass, totalCount: total, flaggedCount: flagged };
  }, [answers]);

  function reset() {
    setJobId("");
    setSite("");
    setRigNumber("");
    setConductedOn(nowLocal());
    setPreparedBy(profile?.name ?? "");
    setNotes("");
    setAnswers({});
    setItemNotes({});
    photos.forEach((p) => URL.revokeObjectURL(p.url));
    setPhotos([]);
    setProgress("");
  }

  function close() {
    reset();
    onOpenChange(false);
  }

  function onPickPhotos(files: FileList | null) {
    if (!files || !files.length) return;
    const next: PendingPhoto[] = [];
    for (const file of Array.from(files)) {
      if (photos.length + next.length >= MAX_PHOTOS) break;
      if (!file.type.startsWith("image/")) continue;
      if (file.size > MAX_PHOTO_BYTES) {
        toast({
          title: "Photo too large",
          description: `${file.name} is over 20 MB and was skipped.`,
          variant: "destructive",
        });
        continue;
      }
      next.push({ file, url: URL.createObjectURL(file) });
    }
    if (next.length) setPhotos((p) => [...p, ...next]);
  }

  function removePhoto(i: number) {
    setPhotos((p) => {
      const copy = [...p];
      const [removed] = copy.splice(i, 1);
      if (removed) URL.revokeObjectURL(removed.url);
      return copy;
    });
  }

  const file = useMutation({
    mutationFn: async () => {
      if (!jobId) throw new Error("Choose a job");
      if (!site.trim()) throw new Error("Site conducted is required");
      if (!conductedOn) throw new Error("Conducted on is required");
      if (!preparedBy.trim()) throw new Error("Prepared by is required");
      const left = required.filter((d) => !answers[d.key]);
      if (left.length)
        throw new Error(
          `Answer all required questions (${left.length} left). First one: "${left[0].label}"`,
        );
      const checklist = RIG_INSPECTION_CHECKLIST.map((d) => ({
        key: d.key,
        answer: answers[d.key] ?? null,
        note: itemNotes[d.key]?.trim() ? itemNotes[d.key].trim() : null,
      }));
      setProgress("Filing inspection…");
      const res = await apiRequest("POST", "/api/rig-up-reports/inspection", {
        job_id: jobId,
        site_conducted: site.trim(),
        rig_number: rigNumber.trim() || null,
        conducted_on: conductedOn,
        prepared_by: preparedBy.trim(),
        notes: notes.trim() || null,
        checklist,
      });
      const created = (await res.json()) as { id: string };
      // Photos go up one at a time after the report exists.
      let failed = 0;
      for (let i = 0; i < photos.length; i++) {
        setProgress(`Uploading photo ${i + 1} of ${photos.length}…`);
        try {
          const c = await compressImage(photos[i].file);
          await apiRequest("POST", `/api/rig-up-reports/${created.id}/photos`, {
            file_name: c.name,
            file_mime: c.mime,
            file_base64: c.base64,
          });
        } catch {
          failed += 1;
        }
      }
      return { failed };
    },
    onSuccess: ({ failed }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/rig-up-reports"] });
      toast({
        title: "Rig inspection filed",
        description:
          failed > 0
            ? `${failed} photo(s) did not upload. Open the report to add them again.`
            : "It is waiting for the area manager's sign-off.",
        variant: failed > 0 ? "destructive" : undefined,
      });
      close();
    },
    onError: (e: any) => {
      setProgress("");
      toast({
        title: "Could not file rig inspection",
        description: e.message,
        variant: "destructive",
      });
    },
  });

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto p-4 sm:p-6">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ClipboardCheck className="h-5 w-5" />
            New rig inspection
          </DialogTitle>
          <DialogDescription>
            Official Rig Inspection, filled out in the app. Any "No" answer is
            flagged. The report waits for the area manager's sign-off.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Title page */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5 sm:col-span-2">
              <Label>Job</Label>
              <Select value={jobId} onValueChange={pickJob}>
                <SelectTrigger data-testid="select-rig-job">
                  <SelectValue placeholder={jobsLoading ? "Loading…" : "Choose a job"} />
                </SelectTrigger>
                <SelectContent>
                  {selectableJobs.map((j) => (
                    <SelectItem key={j.id} value={j.id}>
                      {j.job_number} · {j.customer_name} ({j.area})
                    </SelectItem>
                  ))}
                  {!jobsLoading && selectableJobs.length === 0 && (
                    <div className="px-2 py-1.5 text-sm text-muted-foreground">
                      No active jobs in your area
                    </div>
                  )}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Site conducted *</Label>
              <Input value={site} onChange={(e) => setSite(e.target.value)} data-testid="input-rig-site" />
            </div>
            <div className="space-y-1.5">
              <Label>Rig number</Label>
              <Input value={rigNumber} onChange={(e) => setRigNumber(e.target.value)} data-testid="input-rig-number" />
            </div>
            <div className="space-y-1.5">
              <Label>Conducted on *</Label>
              <Input
                type="datetime-local"
                value={conductedOn}
                onChange={(e) => setConductedOn(e.target.value)}
                data-testid="input-rig-conducted"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Prepared by *</Label>
              <Input value={preparedBy} onChange={(e) => setPreparedBy(e.target.value)} data-testid="input-rig-prepared" />
            </div>
          </div>

          {/* Inspection */}
          <div className="rounded-lg border border-card-border">
            <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-1 px-3 py-2 border-b border-card-border bg-muted">
              <span className="text-sm font-semibold">Rig inspection</span>
              <span className="text-xs text-muted-foreground">
                {answeredReq}/{required.length} required · {passCount}/{totalCount} pass ·{" "}
                <span className={flaggedCount > 0 ? "text-red-600 dark:text-red-400 font-medium" : ""}>
                  {flaggedCount} flagged
                </span>
              </span>
            </div>
            {SECTIONS.map((sec) => (
              <div key={sec.name}>
                <div className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground bg-muted/30 border-b border-card-border">
                  {sec.name}
                </div>
                <div className="divide-y divide-card-border border-b border-card-border">
                  {sec.items.map((def) => {
                    const a = answers[def.key];
                    const isFlagged = !!a && a === def.flagOn;
                    return (
                      <div key={def.key} className="px-3 py-2.5">
                        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
                          <span className="text-sm">
                            {def.label}
                            {def.required ? <span className="text-red-600"> *</span> : null}
                          </span>
                          <div className="flex gap-1 shrink-0">
                            {(["Yes", "No", "N/A"] as Answer[]).map((opt) => {
                              const active = a === opt;
                              const bad = active && opt === def.flagOn;
                              const good = active && opt !== def.flagOn && opt !== "N/A";
                              return (
                                <button
                                  key={opt}
                                  type="button"
                                  onClick={() =>
                                    setAnswers((prev) => {
                                      const next = { ...prev };
                                      if (prev[def.key] === opt && !def.required) delete next[def.key];
                                      else next[def.key] = opt;
                                      return next;
                                    })
                                  }
                                  data-testid={`answer-${def.key}-${opt}`}
                                  className={[
                                    "h-9 min-w-[52px] rounded-md border px-2 text-sm font-medium transition-colors",
                                    active
                                      ? bad
                                        ? "bg-red-600 border-red-600 text-white"
                                        : good
                                          ? "bg-emerald-600 border-emerald-600 text-white"
                                          : "bg-slate-600 border-slate-600 text-white"
                                      : "border-input bg-background hover:bg-muted",
                                  ].join(" ")}
                                >
                                  {opt}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                        {isFlagged && (
                          <Input
                            className="mt-2 h-9 text-sm"
                            placeholder={def.key === "other_findings" ? "Describe the other findings" : "What's wrong?"}
                            value={itemNotes[def.key] ?? ""}
                            onChange={(e) => setItemNotes((prev) => ({ ...prev, [def.key]: e.target.value }))}
                            data-testid={`note-${def.key}`}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          {/* Photos */}
          <div className="space-y-2">
            <Label>Photos</Label>
            <div className="flex flex-wrap gap-2">
              {photos.map((p, i) => (
                <div key={i} className="relative h-20 w-20 rounded-md overflow-hidden border border-card-border">
                  <img src={p.url} alt={p.file.name} className="h-full w-full object-cover" />
                  <button
                    type="button"
                    onClick={() => removePhoto(i)}
                    className="absolute top-0.5 right-0.5 rounded bg-black/60 p-0.5 text-white"
                    aria-label="Remove photo"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
              {photos.length < MAX_PHOTOS && (
                <label className="h-20 w-20 rounded-md border border-dashed border-card-border flex flex-col items-center justify-center cursor-pointer text-muted-foreground hover:bg-muted">
                  <ImagePlus className="h-5 w-5" />
                  <span className="text-[10px] mt-0.5">Add</span>
                  <input
                    type="file"
                    accept="image/*"
                    multiple
                    className="hidden"
                    onChange={(e) => {
                      onPickPhotos(e.target.files);
                      e.target.value = "";
                    }}
                    data-testid="input-rig-photos"
                  />
                </label>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Up to {MAX_PHOTOS} photos. They are resized before upload.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label>Additional notes</Label>
            <Textarea
              rows={2}
              placeholder="Anything else the area manager should know"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              data-testid="input-rig-notes"
            />
          </div>
        </div>

        <DialogFooter className="gap-2">
          {progress && <span className="text-xs text-muted-foreground self-center mr-auto">{progress}</span>}
          <Button variant="outline" onClick={close} disabled={file.isPending}>
            Cancel
          </Button>
          <Button onClick={() => file.mutate()} disabled={file.isPending} data-testid="button-file-rig-inspection">
            {file.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            File inspection
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
