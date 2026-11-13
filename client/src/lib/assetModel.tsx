// The first line of an asset's description is usually its model (e.g.
// "HH-5500 with backdrive", "United SS2000 with backdrive"). Asset pickers show
// it as a small gray second line under the tag + category so people can tell
// units apart while choosing.
//
// Inside a <Select>, the line is hidden in the closed box (see
// [data-asset-sub] in components/ui/select.tsx) and only shows in the open list.

export function assetModel(a: { description?: string | null; category?: string | null } | null | undefined): string | null {
  const first = (a?.description ?? "")
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .find((l) => l.length > 0);
  if (!first) return null;
  // Skip a description that just repeats the type (e.g. "Excavator").
  const cat = (a?.category ?? "").trim().toLowerCase();
  if (cat && (first.toLowerCase() === cat || cat.endsWith(" " + first.toLowerCase()))) return null;
  return first.length > 60 ? first.slice(0, 59).trimEnd() + "…" : first;
}

export function AssetModelLine({
  asset,
  className = "",
}: {
  asset: { description?: string | null; category?: string | null } | null | undefined;
  className?: string;
}) {
  const m = assetModel(asset);
  if (!m) return null;
  return (
    <span
      data-asset-sub=""
      className={"block text-xs font-normal text-muted-foreground truncate " + className}
      data-testid="text-asset-model"
    >
      {m}
    </span>
  );
}
