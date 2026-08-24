import { useState, useEffect, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  type JobWithCustomer,
  type JsaWithJob,
  type CrewMember,
} from "@shared/schema";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Plus, X, ArrowUp, ArrowDown } from "lucide-react";

interface Props {
  trigger: ReactNode;
  job: JobWithCustomer;
  jsa?: JsaWithJob; // present = edit mode
  onSaved?: () => void;
}

interface StepDraft {
  step_description: string;
  hazards: string;
  controls: string;
}

function today() {
  const d = new Date();
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
}

const emptyStep = (): StepDraft => ({
  step_description: "",
  hazards: "",
  controls: "",
});

export function JsaFormDialog({ trigger, job, jsa, onSaved }: Props) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const editing = !!jsa;

  const [jsaDate, setJsaDate] = useState(today());
  const [wellName, setWellName] = useState("");
  const [taskDescription, setTaskDescription] = useState("");
  const [ppe, setPpe] = useState("");
  const [crew, setCrew] = useState<CrewMember[]>([]);
  const [steps, setSteps] = useState<StepDraft[]>([emptyStep()]);

  const seed = () => {
    if (jsa) {
      setJsaDate(jsa.jsa_date);
      setWellName(jsa.well_name ?? "");
      setTaskDescription(jsa.task_description ?? "");
      setPpe(jsa.ppe ?? "");
      setCrew(jsa.crew?.length ? jsa.crew : []);
      setSteps(
        jsa.steps?.length
          ? jsa.steps.map((s) => ({
              step_description: s.step_description,
              hazards: s.hazards ?? "",
              controls: s.controls ?? "",
            }))
          : [emptyStep()],
      );
    } else {
      setJsaDate(today());
      setWellName("");
      setTaskDescription("");
      setPpe("");
      setCrew([]);
      setSteps([emptyStep()]);
    }
  };
  useEffect(() => {
    if (open) seed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const setCrewAt = (i: number, patch: Partial<CrewMember>) =>
    setCrew((prev) => prev.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  const addCrew = () => setCrew((prev) => [...prev, { name: "", role: "" }]);
  const removeCrew = (i: number) =>
    setCrew((prev) => prev.filter((_, idx) => idx !== i));

  const setStepAt = (i: number, patch: Partial<StepDraft>) =>
    setSteps((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  const addStep = () => setSteps((prev) => [...prev, emptyStep()]);
  const removeStep = (i: number) =>
    setSteps((prev) =>
      prev.length <= 1 ? prev : prev.filter((_, idx) => idx !== i),
    );
  const moveStep = (i: number, dir: -1 | 1) =>
    setSteps((prev) => {
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  const save = useMutation({
    mutationFn: async () => {
      const cleanSteps = steps
        .filter((s) => s.step_description.trim() !== "")
        .map((s) => ({
          step_description: s.step_description.trim(),
          hazards: s.hazards.trim() || null,
          controls: s.controls.trim() || null,
        }));
      const body = {
        jsa_date: jsaDate,
        well_name: wellName.trim() || null,
        task_description: taskDescription.trim() || null,
        ppe: ppe.trim() || null,
        crew: crew
          .filter((c) => c.name.trim() !== "")
          .map((c) => ({ name: c.name.trim(), role: c.role?.trim() || null })),
        steps: cleanSteps,
      };
      const res = editing
        ? await apiRequest("PATCH", `/api/jsas/${jsa!.id}`, body)
        : await apiRequest("POST", `/api/jobs/${job.id}/jsas`, body);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/jobs", job.id, "jsas"] });
      queryClient.invalidateQueries({ queryKey: ["/api/jsas"] });
      toast({ title: editing ? "JSA updated" : "JSA submitted" });
      setOpen(false);
      onSaved?.();
    },
    onError: (e: any) =>
      toast({
        title: editing ? "Could not update JSA" : "Could not submit JSA",
        description: e.message,
        variant: "destructive",
      }),
  });

  const validSteps = steps.filter((s) => s.step_description.trim() !== "").length;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {editing
              ? `Edit JSA #${jsa!.jsa_number} · Job ${job.job_number}`
              : `New JSA · Job ${job.job_number}`}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Customer</Label>
              <div className="rounded-md border border-card-border bg-muted/40 px-3 py-2 text-sm">
                {job.customer_name}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Job number</Label>
              <div className="rounded-md border border-card-border bg-muted/40 px-3 py-2 text-sm">
                {job.job_number} · {job.area}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>JSA date</Label>
              <Input
                type="date"
                value={jsaDate}
                onChange={(e) => setJsaDate(e.target.value)}
                data-testid="input-jsa-date"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Well name (optional)</Label>
              <Input
                value={wellName}
                onChange={(e) => setWellName(e.target.value)}
                placeholder="e.g. Keg 1-0-39"
                data-testid="input-jsa-well"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Task description</Label>
            <Textarea
              value={taskDescription}
              onChange={(e) => setTaskDescription(e.target.value)}
              rows={2}
              placeholder="What work is being performed?"
              data-testid="input-jsa-task"
            />
          </div>

          <div className="space-y-1.5">
            <Label>Required PPE (optional)</Label>
            <Input
              value={ppe}
              onChange={(e) => setPpe(e.target.value)}
              placeholder="e.g. Hard hat, FR clothing, safety glasses, gloves"
              data-testid="input-jsa-ppe"
            />
          </div>

          {/* Crew */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label>Crew</Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addCrew}
                data-testid="button-jsa-add-crew"
              >
                <Plus className="mr-1 h-3.5 w-3.5" /> Add crew
              </Button>
            </div>
            {crew.length === 0 ? (
              <div className="rounded-md border border-dashed border-card-border bg-muted/30 px-3 py-2.5 text-xs text-muted-foreground">
                No crew added yet.
              </div>
            ) : (
              <div className="space-y-2">
                {crew.map((c, i) => (
                  <div key={i} className="flex gap-2">
                    <Input
                      className="flex-1"
                      placeholder="Name"
                      value={c.name}
                      onChange={(e) => setCrewAt(i, { name: e.target.value })}
                    />
                    <Input
                      className="flex-1"
                      placeholder="Role (optional)"
                      value={c.role ?? ""}
                      onChange={(e) => setCrewAt(i, { role: e.target.value })}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => removeCrew(i)}
                      aria-label="Remove crew member"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Job steps → hazards → controls */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>
                Job steps · hazards · controls{" "}
                <span className="font-normal text-muted-foreground">
                  ({validSteps} step{validSteps === 1 ? "" : "s"})
                </span>
              </Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addStep}
                data-testid="button-jsa-add-step"
              >
                <Plus className="mr-1 h-3.5 w-3.5" /> Add step
              </Button>
            </div>
            <div className="space-y-3">
              {steps.map((s, i) => (
                <div
                  key={i}
                  className="rounded-md border border-card-border p-3 space-y-2"
                  data-testid={`jsa-step-${i}`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-muted-foreground">
                      Step {i + 1}
                    </span>
                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => moveStep(i, -1)}
                        disabled={i === 0}
                        aria-label="Move step up"
                      >
                        <ArrowUp className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => moveStep(i, 1)}
                        disabled={i === steps.length - 1}
                        aria-label="Move step down"
                      >
                        <ArrowDown className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => removeStep(i)}
                        disabled={steps.length <= 1}
                        aria-label="Remove step"
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                  <Textarea
                    value={s.step_description}
                    onChange={(e) =>
                      setStepAt(i, { step_description: e.target.value })
                    }
                    rows={2}
                    placeholder="Step description"
                  />
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <Textarea
                      value={s.hazards}
                      onChange={(e) => setStepAt(i, { hazards: e.target.value })}
                      rows={2}
                      placeholder="Potential hazards"
                    />
                    <Textarea
                      value={s.controls}
                      onChange={(e) => setStepAt(i, { controls: e.target.value })}
                      rows={2}
                      placeholder="Controls / mitigations"
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button
            onClick={() => save.mutate()}
            disabled={save.isPending || !jsaDate || validSteps < 1}
            data-testid="button-save-jsa"
          >
            {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {editing ? "Save changes" : "Submit JSA"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
