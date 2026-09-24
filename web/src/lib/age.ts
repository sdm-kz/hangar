/**
 * How long ago a timestamp was, coarsely — "5m", "3h", "12d", "4mo". The point is "hours or days",
 * not precision, which is why it rounds and stops at months. Empty for a time it cannot read, or
 * one in the future (a clock that disagrees with GitHub's is not worth saying "-2m" about).
 */
export function age(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const minutes = ms / 60000;
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))}m`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h`;
  const days = Math.round(minutes / 1440);
  return days < 60 ? `${days}d` : `${Math.round(days / 30)}mo`;
}
