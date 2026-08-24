export function Placeholder({ title, note }: { title: string; note: string }) {
  return (
    <div className="p-6 max-w-3xl">
      <h1 className="text-xl font-semibold mb-1">{title}</h1>
      <p className="text-sm text-muted-foreground">{note}</p>
      <div className="mt-6 rounded-lg border border-dashed border-card-border bg-muted/30 p-10 text-center text-sm text-muted-foreground">
        Coming in the next milestone.
      </div>
    </div>
  );
}
