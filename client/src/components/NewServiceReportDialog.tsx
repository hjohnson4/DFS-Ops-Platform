import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  CENTRIFUGE_SERVICE_CHECKLIST,
  RUN_HOUR_CATEGORIES,
  type AssetWithSchedule,
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

type Answer = "Yes" | "No" | "N/A";
const MAX_PHOTO_BYTES = 8 * 1024 * 1024; // 8 MB each
const MAX_PHOTOS = 24;

interface PendingPhoto {
  file: File;
  caption: string;
  url: string; // object URL for preview
}

// In-app digital centrifuge service report. Replaces the external Mitti /
// SafetyCulture PDF: the supervisor fills the 13-item inspection here, records
// the run-hours meter reading (which resets the service baseline), and any
// "No" answer on a good/bad question is flagged and auto-opens a work order.
export function NewServiceReportDialog({
  trigger,
  onFiled,
}: {
  trigger: React.ReactNode;
  onFiled?: () => void;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);

  const [assetId, setAssetId] = useState("");
  const [reportDate, setReportDate] = useState<string>(
    () => new Date().toISOString().slice(0, 10),
  );
  const [runHours, setRunHours] = useState("");
  const [workPerformed, setWorkPerformed] = useState("");
  const [notes, setNotes] = useState("");
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [itemNotes, setItemNotes] = useState<Record<string, string>>({});
  const [photos, setPhotos] = useState<PendingPhoto[]>([]);

  const { data: assets, isLoading: assetsLoading } = useQuery<
    AssetWithSchedule[]
  >({
    queryKey: ["/api/assets"],
    enabled: open,
  });

  // Only centrifuges are serviced with this checklist. The list is already
  // area-scoped server-side.
  const centrifuges = useMemo(
    () =>
      (assets ?? [])
        .filter((a) =>
          (RUN_HOUR_CATEGORIES as string[]).includes(a.category),
        )
        .sort((a, b) => a.tag.localeCompare(b.tag)),
    [assets],
  );

  const selectedAsset = centrifuges.find((a) => a.id === assetId) || null;

  // Live score + flag preview so the supervisor sees the outcome before filing.
  const { answeredCount, passCount, flaggedCount } = useMemo(() => {
    let answered = 0;
    let pass = 0;
    let flagged = 0;
    for (const def of CENTRIFUGE_SERVICE_CHECKLIST) {
      const a = answers[def.key];
      if (!a) continue;
      answered += 1;
      if (a === "N/A") continue;
      if (a === def.flagOn) flagged += 1;
      else pass += 1;
    }
    return { answeredCount: answered, passCount: pass, flaggedCount: flagged };
  }, [answers]);

  function reset() {
    setAssetId("");
    setReportDate(new Date().toISOString().slice(0, 10));
    setRunHours("");
    setWorkPerformed("");
    setNotes("");
    setAnswers({});
    setItemNotes({});
    photos.forEach((p) => URL.revokeObjectURL(p.url));
    setPhotos([]);
  }

  async function onPickPhotos(files: FileList | null) {
    if (!files || !files.length) return;
    const next: PendingPhoto[] = [];
    for (const file of Array.from(files)) {
      if (photos.length + next.length >= MAX_PHOTOS) break;
      if (!file.type.startsWith("image/")) continue;
      if (file.size > MAX_PHOTO_BYTES) {
        toast({
          title: "Photo too large",
          description: `${file.name} is over 8 MB and was skipped.`,
          variant: "destructive",
        });
        continue;
      }
      next.push({ file, caption: "", url: URL.createObjectURL(file) });
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
      if (!assetId) throw new Error("Choose a centrifuge");
      if (!reportDate) throw new Error("Choose a service date");
      const unanswered = CENTRIFUGE_SERVICE_CHECKLIST.filter(
        (d) => !answers[d.key],
      );
      if (unanswered.length)
        throw new Error(
          `Answer all ${CENTRIFUGE_SERVICE_CHECKLIST.length} checklist items (${unanswered.length} left)`,
        );

      const checklist = CENTRIFUGE_SERVICE_CHECKLIST.map((d) => ({
        key: d.key,
        answer: answers[d.key],
        note: itemNotes[d.key]?.trim() ? itemNotes[d.key].trim() : null,
      }));

      const photoPayload = await Promise.all(
        photos.map(async (p) => ({
          file_name: p.file.name.slice(0, 200),
          file_mime: p.file.type || "image/jpeg",
          file_base64: await fileToBase64(p.file),
          caption: p.caption.trim() ? p.caption.trim() : null,
        })),
      );

      const rh = runHours.trim() === "" ? null : Number(runHours);
      if (rh != null && (!Number.isFinite(rh) || rh < 0))
        throw new Error("Run-hours reading must be a non-negative number");

      const res = await apiRequest("POST", "/api/service-forms", {
        asset_id: assetId,
        report_date: reportDate,
        run_hours: rh,
        work_performed: workPerformed.trim() || null,
        notes: notes.trim() || null,
        checklist,
        photos: photoPayload,
      });
      return (await res.json()) as { work_orders_created?: number };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/service-forms"] });
      queryClient.invalidateQueries({ queryKey: ["/api/service/dashboard"] });
      queryClient.invalidateQueries({ queryKey: ["/api/assets"] });
      queryClient.invalidateQueries({ queryKey: ["/api/work-orders"] });
      const woCount = data?.work_orders_created ?? 0;
      toast({
        title: "Service report filed",
        description:
          woCount > 0
            ? `${woCount} work order${woCount === 1 ? "" : "s"} opened for flagged items.`
            : "No flagged items. Service baseline updated.",
      });
      reset();
      setOpen(false);
      onFiled?.();
    },
    onError: (e: any) =>
      toast({
        title: "Could not file service report",
        description: e.message,
        variant: "destructive",
      }),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <span onClick={() => setOpen(true)}>{trigger}</span>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ClipboardCheck className="h-5 w-5" />
            New centrifuge service report
          </DialogTitle>
          <DialogDescription>
            Fill out the inspection in the app. The run-hours reading resets the
            service baseline, and any flagged item opens a work order
            automatically.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Header fields */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Centrifuge</Label>
              <Select value={assetId} onValueChange={setAssetId}>
                <SelectTrigger data-testid="select-service-asset">
                  <SelectValue
                    placeholder={
                      assetsLoading ? "Loading…" : "Choose a centrifuge"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {centrifuges.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.tag} — {a.category}
                    </SelectItem>
                  ))}
                  {!assetsLoading && centrifuges.length === 0 && (
                    <div className="px-2 py-1.5 text-sm text-muted-foreground">
                      No centrifuges in your area
                    </div>
                  )}
                </SelectContent>
              </Select>
              {selectedAsset && (
                <p className="text-xs text-muted-foreground">
                  {selectedAsset.area} ·{" "}
                  {selectedAsset.job_or_well
                    ? selectedAsset.job_or_well
                    : "Unassigned"}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>Service date</Label>
              <Input
                type="date"
                value={reportDate}
                onChange={(e) => setReportDate(e.target.value)}
                data-testid="input-service-date"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Run-hours meter reading</Label>
              <Input
                type="number"
                min={0}
                inputMode="numeric"
                placeholder="e.g. 1450"
                value={runHours}
                onChange={(e) => setRunHours(e.target.value)}
                data-testid="input-service-runhours"
              />
              <p className="text-xs text-muted-foreground">
                Optional. Sets the “run hrs since service” baseline.
              </p>
            </div>
          </div>

          {/* Checklist */}
          <div className="rounded-lg border border-card-border">
            <div className="flex items-center justify-between px-3 py-2 border-b border-card-border bg-muted/40">
              <span className="text-sm font-semibold">Inspection checklist</span>
              <span className="text-xs text-muted-foreground">
                {answeredCount}/{CENTRIFUGE_SERVICE_CHECKLIST.length} answered ·{" "}
                {passCount} pass ·{" "}
                <span
                  className={
                    flaggedCount > 0 ? "text-red-600 dark:text-red-400" : ""
                  }
                >
                  {flaggedCount} flagged
                </span>
              </span>
            </div>
            <div className="divide-y divide-card-border">
              {CENTRIFUGE_SERVICE_CHECKLIST.map((def) => {
                const a = answers[def.key];
                const isFlagged = a && a === def.flagOn;
                return (
                  <div key={def.key} className="px-3 py-2.5">
                    <div className="flex items-start justify-between gap-3">
                      <span className="text-sm">{def.label}</span>
                      <div className="flex gap-1 shrink-0">
                        {(["Yes", "No", "N/A"] as Answer[]).map((opt) => {
                          const active = a === opt;
                          const bad = active && opt === def.flagOn;
                          const good =
                            active && opt !== def.flagOn && opt !== "N/A";
                          return (
                            <button
                              key={opt}
                              type="button"
                              onClick={() =>
                                setAnswers((prev) => ({
                                  ...prev,
                                  [def.key]: opt,
                                }))
                              }
                              data-testid={`answer-${def.key}-${opt}`}
                              className={[
                                "h-7 min-w-[40px] rounded-md border px-2 text-xs font-medium transition-colors",
                                active
                                  ? bad
                                    ? "bg-red-600 border-red-600 text-white"
                                    : good
                                      ? "bg-emerald-600 border-emerald-600 text-white"
                                      : "bg-muted-foreground/80 border-muted-foreground/80 text-white"
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
                        className="mt-2 h-8 text-sm"
                        placeholder="What's wrong? (e.g. Solids port has significant wear)"
                        value={itemNotes[def.key] ?? ""}
                        onChange={(e) =>
                          setItemNotes((prev) => ({
                            ...prev,
                            [def.key]: e.target.value,
                          }))
                        }
                        data-testid={`note-${def.key}`}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Photos */}
          <div className="space-y-2">
            <Label>Photos</Label>
            <div className="flex flex-wrap gap-2">
              {photos.map((p, i) => (
                <div
                  key={i}
                  className="relative h-20 w-20 rounded-md overflow-hidden border border-card-border"
                >
                  <img
                    src={p.url}
                    alt={p.file.name}
                    className="h-full w-full object-cover"
                  />
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
                    capture="environment"
                    className="hidden"
                    onChange={(e) => {
                      onPickPhotos(e.target.files);
                      e.target.value = "";
                    }}
                    data-testid="input-service-photos"
                  />
                </label>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Up to {MAX_PHOTOS} photos, 8 MB each.
            </p>
          </div>

          {/* Free-text */}
          <div className="space-y-1.5">
            <Label>Work performed / parts replaced</Label>
            <Textarea
              rows={2}
              placeholder="e.g. Replaced seals in fluid end"
              value={workPerformed}
              onChange={(e) => setWorkPerformed(e.target.value)}
              data-testid="input-work-performed"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Additional notes</Label>
            <Textarea
              rows={2}
              placeholder="Anything else the area manager should know"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              data-testid="input-service-notes"
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              reset();
              setOpen(false);
            }}
          >
            Cancel
          </Button>
          <Button
            onClick={() => file.mutate()}
            disabled={file.isPending}
            data-testid="button-file-service-report"
          >
            {file.isPending && (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            )}
            File report
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
