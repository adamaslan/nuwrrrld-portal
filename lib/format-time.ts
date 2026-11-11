/**
 * Deterministic timestamp formatting for server-rendered ops surfaces.
 * toLocaleString() without a timezone renders in the SERVER's zone (UTC on
 * Vercel) with no label, so "Nov 1, 6:45:41 PM" was being read as 6:45 PM
 * Eastern when it was actually 6:45 PM UTC. Always render with an explicit
 * IANA zone and include the zone abbreviation in the output.
 */

const ET = 'America/New_York';

const etFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: ET,
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
  timeZoneName: 'short',
});

/** "Nov 1, 2026, 1:45:41 PM EST" — explicit market-local time with zone label. */
export function formatRunTimeET(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return 'time unknown';
  return etFormatter.format(d);
}
