import { supabaseAdmin, supabaseAnon } from "./supabase";
import { UNAVAILABLE_STATUS, type AssetOpenWorkOrder } from "@shared/schema";

// Open (not yet closed-out) work orders by asset id. An asset with an open
// work order is out at the vendor: it shows "Unavailable" and its location is
// where it was sent. Worked out live, so closing/deleting the work order puts
// the asset straight back to "On Job"/"Available" with no extra step.
export async function openWorkOrdersByAsset(
  assetIds: string[],
): Promise<Map<string, AssetOpenWorkOrder>> {
  const out = new Map<string, AssetOpenWorkOrder>();
  const ids = Array.from(new Set(assetIds.filter(Boolean)));
  if (!ids.length) return out;
  const client = supabaseAdmin || supabaseAnon;
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await client
      .from("work_orders")
      .select("id, asset_id, wo_number, vendor, sent_on, due_date, created_at")
      .in("asset_id", ids.slice(i, i + 200))
      .neq("status", "Completed")
      .order("created_at", { ascending: false });
    if (error) return out; // never break the asset list over this
    for (const w of data || []) {
      // Newest open work order wins if there is more than one.
      if (out.has(w.asset_id)) continue;
      out.set(w.asset_id, {
        id: w.id,
        wo_number: w.wo_number,
        vendor: w.vendor ?? null,
        sent_on: w.sent_on ?? null,
        due_date: w.due_date ?? null,
      });
    }
  }
  return out;
}

// Adds open_work_order to each asset and shows its status as "Unavailable"
// while it is out. The stored status column is left untouched.
export async function withOpenWorkOrders<T extends { id: string; status?: string | null }>(
  assets: T[],
): Promise<(T & { open_work_order: AssetOpenWorkOrder | null })[]> {
  const map = await openWorkOrdersByAsset(assets.map((a) => a.id));
  return assets.map((a) => {
    const wo = map.get(a.id) || null;
    return wo
      ? { ...a, status: UNAVAILABLE_STATUS, open_work_order: wo }
      : { ...a, open_work_order: null };
  });
}
