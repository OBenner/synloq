import type { DatabaseSync } from "node:sqlite";

/** Run inside the caller's transaction, after resetting retryable submissions. */
export function clearReleasedQuarantine(
  database: DatabaseSync,
  project: string,
  recipient: string,
): void {
  // A consumed one-message allowance cannot be retried. Keep its submitted row
  // quarantined: deleting that marker would turn it into a permanent FIFO blocker
  // (#90). Delivered/acked rows need no quarantine and can still be cleaned up.
  database
    .prepare(
      `DELETE FROM delivery_quarantine
       WHERE project = ? AND recipient = ?
         AND NOT EXISTS (
           SELECT 1 FROM messages
           WHERE messages.id = delivery_quarantine.message_id
             AND messages.delivery_state = 'submitted'
             AND messages.acceptance_consumed_generation IS NOT NULL
         )`,
    )
    .run(project, recipient);
}
