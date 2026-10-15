// Replaced by FieldTicketDialog (field ticket workflow). Kept as a thin
// wrapper so older imports keep working.
import type { ReactNode } from "react";
import { FieldTicketDialog } from "@/components/FieldTicketDialog";

interface Props {
  trigger: ReactNode;
  onCreated?: () => void;
}

export function CreateFieldTicketDialog({ trigger }: Props) {
  return <FieldTicketDialog trigger={trigger} />;
}
