/**
 * Time rendering: the one place the browser turns a server instant into text.
 *
 * The server sends every instant as ISO-8601 **with an explicit `Z`**
 * (`2026-11-15T18:04:11Z`). That is the whole contract: the browser renders it
 * in the viewer's own locale and zone, so a listener in Berlin sees 19:04 for
 * the same instant a listener in Denver sees at 12:04.
 *
 * Two rules follow, and they are enforced by `time.test.ts`:
 *
 * - Never format a timestamp by hand. `getUTC*`, `toISOString().slice()`, and
 *   `new Date("2026-11-15 18:04")` (zone-less) are all wrong here: the first
 *   two ignore the viewer's zone, the last is interpreted as *local* time and
 *   silently shifts by the viewer's offset.
 * - Durations are numbers of seconds, not instants. They go through
 *   `formatAgeSeconds`, which never constructs a `Date`.
 */

/** Parse an ISO instant from the API. Throws on a zone-less string. */
export function parseInstant(iso: string): Date {
  if (!/[Zz]|[+-]\d{2}:?\d{2}$/.test(iso)) {
    throw new Error(`Instant without a timezone: ${iso}`);
  }
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid instant: ${iso}`);
  }
  return parsed;
}

/**
 * An absolute instant in the viewer's locale and timezone.
 *
 * No `timeZone` option on purpose: overriding it would defeat the whole point
 * of sending a `Z`-anchored instant.
 */
export function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(parseInstant(iso));
}

/** A relative age from a number of elapsed seconds ("30s ago", "5m ago"). */
export function formatAgeSeconds(seconds: number): string {
  const elapsed = Math.max(0, seconds);
  if (elapsed < 60) {
    return `${elapsed.toFixed(0)}s ago`;
  }
  const minutes = Math.floor(elapsed / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return `${Math.floor(hours / 24)}d ago`;
}

/** A relative age for an instant that arrived as an ISO string. */
export function formatAgeSince(iso: string, now: number = Date.now()): string {
  return formatAgeSeconds((now - parseInstant(iso).getTime()) / 1000);
}
