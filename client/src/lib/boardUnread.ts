import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";

export type BoardUnread = {
  total: number;
  by_area: Record<string, { count: number; posts?: number; tasks?: number; comments?: number; seen_at: string }>;
};

/**
 * How many posts / new tasks from other people are waiting on my area's board
 * since I last opened it. Also puts the number on the Home Screen app icon
 * (phones that support it).
 */
export function useBoardUnread(role: string | undefined): number {
  const enabled = role === "admin" || role === "area" || role === "super";
  const { data } = useQuery<BoardUnread>({
    queryKey: ["/api/board/unread"],
    enabled,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    retry: false,
  });
  const total = enabled ? data?.total ?? 0 : 0;
  useEffect(() => {
    const nav = navigator as any;
    try {
      if (total > 0 && nav.setAppBadge) nav.setAppBadge(total).catch(() => {});
      else if (nav.clearAppBadge) nav.clearAppBadge().catch(() => {});
    } catch {
      /* not supported */
    }
  }, [total]);
  return total;
}
