import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { ListChecks, ChevronRight, Package, Calendar } from "lucide-react";
import type { BoardTask } from "@shared/schema";

type MyTasks = { assigned: BoardTask[]; requested: BoardTask[]; today: string };

function shortDate(iso: string) {
  return new Date(iso.slice(0, 10) + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Dashboard card: open Area Board tasks assigned to me, and my open requests. */
export default function MyTasksCard() {
  const { data, isLoading } = useQuery<MyTasks>({ queryKey: ["/api/board/my-tasks"], refetchInterval: 60_000, retry: false });
  if (isLoading || !data) return null;
  const { assigned, requested, today } = data;
  const shown = assigned.slice(0, 5);
  return (
    <div className="mb-4 rounded-lg border border-card-border bg-card" data-testid="card-my-tasks">
      <div className="flex items-center justify-between gap-2 px-4 pt-3.5 pb-2">
        <h2 className="text-sm font-semibold flex items-center gap-1.5">
          <ListChecks className="h-4 w-4 text-primary" /> My tasks
          <span className="text-muted-foreground font-normal tabular-nums">({assigned.length})</span>
        </h2>
        <Link href="/board" className="text-sm text-primary hover:underline font-medium" data-testid="link-my-tasks-board">
          Open the board
        </Link>
      </div>
      {shown.length === 0 ? (
        <p className="px-4 pb-3.5 text-sm text-muted-foreground">Nothing assigned to you right now.</p>
      ) : (
        <div className="divide-y border-t">
          {shown.map((t) => {
            const overdue = !!t.due_date && t.due_date < today;
            return (
              <Link
                key={t.id}
                href={`/board/task/${t.id}`}
                className="group flex items-center gap-3 px-4 py-2.5 hover:bg-accent/40"
                data-testid={`my-task-${t.id}`}
              >
                <span className="font-mono text-xs text-muted-foreground shrink-0">T-{t.number}</span>
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-medium truncate">
                    {t.kind === "supply" && <Package className="inline h-3.5 w-3.5 mr-1 -mt-0.5 text-muted-foreground" />}
                    {t.title}
                  </span>
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>{t.status}</span>
                    {t.due_date && (
                      <span className={`flex items-center gap-1 ${overdue ? "text-red-600 dark:text-red-400 font-medium" : ""}`}>
                        <Calendar className="h-3 w-3" /> {overdue ? "Overdue " : "Due "}
                        {shortDate(t.due_date)}
                      </span>
                    )}
                    {t.created_by_name && <span className="truncate">from {t.created_by_name}</span>}
                  </span>
                </span>
                {(t.priority === "Urgent" || t.priority === "High") && (
                  <Badge
                    className={`text-[11px] shrink-0 ${
                      t.priority === "Urgent"
                        ? "bg-red-100 text-red-900 border-red-200 dark:bg-red-900/30 dark:text-red-200 dark:border-red-800"
                        : "bg-amber-100 text-amber-900 border-amber-200 dark:bg-amber-900/30 dark:text-amber-200 dark:border-amber-800"
                    }`}
                  >
                    {t.priority}
                  </Badge>
                )}
                <ChevronRight className="h-4 w-4 opacity-40 group-hover:opacity-70 shrink-0" />
              </Link>
            );
          })}
          {assigned.length > shown.length && (
            <Link href="/board" className="block px-4 py-2 text-xs text-muted-foreground hover:text-foreground">
              + {assigned.length - shown.length} more on the board
            </Link>
          )}
        </div>
      )}
      {requested.length > 0 && (
        <div className="border-t px-4 py-2.5 text-xs text-muted-foreground" data-testid="my-requests-open">
          You asked for {requested.length} thing{requested.length > 1 ? "s" : ""} that {requested.length > 1 ? "are" : "is"} still open
          {requested[0] ? (
            <>
              {" — latest: "}
              <Link href={`/board/task/${requested[0].id}`} className="text-foreground hover:underline">
                T-{requested[0].number} {requested[0].title}
              </Link>
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
