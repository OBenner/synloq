export const NUDGE_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function requireNudgeIds(...ids: string[]): void {
  if (!ids.length || ids.some((id) => !NUDGE_UUID.test(id)))
    throw new Error("invalid reminder identifiers");
}
