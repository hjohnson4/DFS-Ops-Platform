// Replaced by FieldTicketDialog (field ticket workflow). Kept as a thin
// wrapper so older imports keep working.
import type { ReactNode } from "react";
import type { FieldTicket, FieldTicketWithJob, JobWithCustomer } from "@shared/schema";
import { FieldTicketDialog } from "@/components/FieldTicketDialog";

interface Props {
  trigger: ReactNode;
  job: JobWithCustomer;
  ticket?: FieldTicket | FieldTicketWithJob;
  onSaved?: () => void;
}

export function FieldTicketFormDialog({ trigger, job, ticket }: Props) {
  return <FieldTicketDialog trigger={trigger} job={job} ticket={ticket} />;
}
