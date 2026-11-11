import { useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { ListChecks, Plus, Loader2 } from "lucide-react";
import { NewTaskDialog, TaskCard, type Meta } from "@/pages/board";
import type { BoardTask } from "@shared/schema";

/**
 * "Board tasks" box for a job page or an asset pop-up: open tasks linked to
 * it, plus an "Add task" button that opens the board's new-task form with the
 * job / asset already filled in.
 */
export default function BoardTasksPanel({
  area,
  jobId,
  assetId,
  label,
  compact,
}: {
  area: string | null | undefined;
  jobId?: string;
  assetId?: string;
  label: string;
  compact?: boolean;
}) {
  const { profile } = useAuth();
  const [, navigate] = useLocation();
  const [creating, setCreating] = useState(false);
  const allowed = !!area && !!profile && profile.role !== "field";
  const { data: meta } = useQuery<Meta>({
    queryKey: [`/api/board/meta?area=${encodeURIComponent(area || "")}`],
    enabled: allowed,
    retry: false,
  });
  const filter = jobId ? `job_id=${jobId}` : `asset_id=${assetId}`;
  const { data: tasks = [], isLoading } = useQuery<BoardTask[]>({
    queryKey: [`/api/board/tasks?area=${encodeURIComponent(area || "")}&view=open&${filter}`],
    enabled: allowed && !!meta,
    retry: false,
  });
  if (!allowed || !meta || meta.area !== area) return null;

  return (
    <div className={compact ? "space-y-2" : "rounded-lg border border-card-border bg-card p-4 space-y-3"} data-testid="panel-board-tasks">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold flex items-center gap-1.5">
          <ListChecks className="h-4 w-4 text-primary" /> Board tasks
          <span className="text-muted-foreground font-normal">({tasks.length} open)</span>
        </h2>
        {meta.can_write && (
          <Button size="sm" variant="outline" className="max-sm:h-10" onClick={() => setCreating(true)} data-testid="button-add-board-task">
            <Plus className="h-4 w-4 mr-1" /> Add task
          </Button>
        )}
      </div>
      {isLoading ? (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      ) : tasks.length === 0 ? (
        <p className="text-xs text-muted-foreground">No open tasks or supply requests for {label}.</p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {tasks.slice(0, 6).map((t) => (
            <TaskCard key={t.id} t={t} onOpen={() => navigate(`/board/task/${t.id}`)} />
          ))}
        </div>
      )}
      {creating && (
        <NewTaskDialog
          meta={meta}
          kind="task"
          allowKindSwitch
          presetJobId={jobId || null}
          presetAssetId={assetId || null}
          presetLabel={label}
          onClose={() => setCreating(false)}
        />
      )}
    </div>
  );
}
