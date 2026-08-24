import { useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Bell, Wrench, ClipboardCheck, Mail, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

type NotificationType =
  | "maintenance_due"
  | "signoff_overdue"
  | "signoff_pending"
  | "new_report";

interface Notification {
  id: string;
  type: NotificationType;
  severity: "warning" | "info";
  title: string;
  detail: string;
  href: string;
  ts: string | null;
}

interface NotificationsResponse {
  count: number;
  warning_count: number;
  items: Notification[];
}

const ICONS: Record<NotificationType, typeof Wrench> = {
  maintenance_due: Wrench,
  signoff_overdue: AlertTriangle,
  signoff_pending: ClipboardCheck,
  new_report: Mail,
};

function relTime(ts: string | null): string {
  if (!ts) return "";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "";
  const diff = Date.now() - d.getTime();
  const day = 24 * 60 * 60 * 1000;
  if (diff < day) return "today";
  const days = Math.floor(diff / day);
  return `${days}d ago`;
}

export default function NotificationBell() {
  const [, navigate] = useLocation();
  const [open, setOpen] = useState(false);

  // Poll every 60s so the bell stays reasonably fresh without hammering the API.
  const { data } = useQuery<NotificationsResponse>({
    queryKey: ["/api/notifications"],
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });

  const items = data?.items ?? [];
  const count = data?.count ?? 0;
  const hasWarning = (data?.warning_count ?? 0) > 0;

  const go = (href: string) => {
    setOpen(false);
    navigate(href);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative h-9 w-9"
          aria-label="Notifications"
          data-testid="button-notifications"
        >
          <Bell className="h-5 w-5" />
          {count > 0 && (
            <span
              className={`absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold text-white ${
                hasWarning ? "bg-rose-600" : "bg-primary"
              }`}
              data-testid="badge-notification-count"
            >
              {count > 99 ? "99+" : count}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-80 p-0"
        data-testid="popover-notifications"
      >
        <div className="flex items-center justify-between border-b border-card-border px-4 py-2.5">
          <span className="text-sm font-semibold">Notifications</span>
          {count > 0 && (
            <span className="text-xs text-muted-foreground">{count} active</span>
          )}
        </div>
        {items.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            You're all caught up.
          </div>
        ) : (
          <ul className="max-h-96 overflow-y-auto">
            {items.map((n) => {
              const Icon = ICONS[n.type] ?? Bell;
              return (
                <li key={n.id}>
                  <button
                    onClick={() => go(n.href)}
                    className="flex w-full items-start gap-3 border-b border-card-border px-4 py-3 text-left hover:bg-muted/50"
                    data-testid={`notification-${n.id}`}
                  >
                    <span
                      className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
                        n.severity === "warning"
                          ? "bg-rose-500/15 text-rose-600 dark:text-rose-400"
                          : "bg-primary/10 text-primary"
                      }`}
                    >
                      <Icon className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {n.title}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {n.detail}
                      </span>
                    </span>
                    {n.ts && (
                      <span className="shrink-0 whitespace-nowrap text-[11px] text-muted-foreground">
                        {relTime(n.ts)}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
