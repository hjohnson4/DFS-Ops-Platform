import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import type { SignoffStatus } from "@shared/schema";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { CheckCircle2, Clock, Loader2, RotateCcw } from "lucide-react";

// A shared status badge for the three sign-off states.
export function SignoffBadge({ status }: { status: SignoffStatus }) {
  if (status === "Signed off")
    return (
      <Badge className="gap-1 bg-[color:var(--dfs-signed,#437A22)] text-white" data-testid="badge-signed">
        <CheckCircle2 className="h-3 w-3" /> Signed off
      </Badge>
    );
  if (status === "Changes requested")
    return (
      <Badge variant="destructive" className="gap-1" data-testid="badge-changes">
        <RotateCcw className="h-3 w-3" /> Changes requested
      </Badge>
    );
  return (
    <Badge variant="outline" className="gap-1 text-muted-foreground" data-testid="badge-pending">
      <Clock className="h-3 w-3" /> Pending sign-off
    </Badge>
  );
}

interface Props {
  // "field-daily-reports" or "jsas" — used to build the signoff URL + invalidation
  resource: "field-daily-reports" | "jsas";
  id: string;
  jobId: string;
  status: SignoffStatus;
  // whether the parent job is Active — sign-off is only offered on active jobs
  jobActive: boolean;
  compact?: boolean;
}

// Sign-off / request-changes controls, shown to supervisors+ on pending items.
export function SignoffControls({
  resource,
  id,
  jobId,
  status,
  jobActive,
  compact,
}: Props) {
  const { profile } = useAuth();
  const { toast } = useToast();
  const [changesOpen, setChangesOpen] = useState(false);
  const [notes, setNotes] = useState("");

  const isSupervisor =
    profile?.role === "admin" ||
    profile?.role === "area" ||
    profile?.role === "super";

  const act = useMutation({
    mutationFn: async (payload: { action: string; change_notes?: string }) => {
      const res = await apiRequest(
        "POST",
        `/api/${resource}/${id}/signoff`,
        payload,
      );
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/jobs", jobId, resource] });
      queryClient.invalidateQueries({ queryKey: [`/api/${resource}`] });
      setChangesOpen(false);
      setNotes("");
    },
    onError: (e: any) =>
      toast({
        title: "Action failed",
        description: e.message,
        variant: "destructive",
      }),
  });

  if (!isSupervisor) return <SignoffBadge status={status} />;
  if (status === "Signed off") return <SignoffBadge status={status} />;

  return (
    <div className={compact ? "flex items-center gap-2" : "flex items-center gap-2"}>
      {!compact && <SignoffBadge status={status} />}
      <Button
        size="sm"
        variant="default"
        disabled={!jobActive || act.isPending}
        title={jobActive ? undefined : "Job is not active"}
        onClick={() => act.mutate({ action: "sign_off" })}
        data-testid={`button-signoff-${id}`}
      >
        {act.isPending && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
        Sign off
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={!jobActive || act.isPending}
        onClick={() => setChangesOpen(true)}
        data-testid={`button-request-changes-${id}`}
      >
        Request changes
      </Button>

      <Dialog open={changesOpen} onOpenChange={setChangesOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Request changes</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 py-1">
            <Label>What needs to change?</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="Explain what the crew should correct before sign-off."
              data-testid="input-change-notes"
            />
          </div>
          <DialogFooter>
            <Button
              variant="destructive"
              disabled={act.isPending || notes.trim() === ""}
              onClick={() =>
                act.mutate({ action: "request_changes", change_notes: notes.trim() })
              }
              data-testid="button-submit-changes"
            >
              {act.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Send back for changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
