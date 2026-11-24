// @effect-diagnostics globalDate:off -- Log dates retain the host UTC offset.
const pad = (n: number) => String(n).padStart(2, "0");

/** ISO time with this server's offset, like `2026-09-01T10:00:00+05:30`. */
export function localIso(ms: number): string {
  const offset = -new Date(ms).getTimezoneOffset();
  const local = new Date(ms + offset * 60_000).toISOString().slice(0, 19);
  const abs = Math.abs(offset);
  return `${local}${offset < 0 ? "-" : "+"}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

const STORED = /^(\d{4}-\d\d-\d\d)T(\d\d:\d\d)(?::\d\d(?:\.\d+)?)?(Z|[+-]\d\d:\d\d)$/;

/**
 * Render a stored date with the zone in words first, so a small model does not
 * misread the offset, then the stored value. A date without a readable offset is given as stored.
 */
export function spokenDate(stored: string): string {
  const parts = STORED.exec(stored);
  if (!parts) return stored;
  const [, day, time, offset = "Z"] = parts;
  const zone = offset === "Z" || offset.slice(1) === "00:00" ? "UTC" : `UTC${offset}`;
  return `${day} ${time} ${zone} (${stored})`;
}

/** A stored date as the user's clock reads it, like `2026-11-04 13:01 Asia/Kolkata`; one it cannot read, as stored. */
export function zonedDate(stored: string, zone: string): string {
  // Date.parse guesses at loose text like "summer 2025"; only a stored ISO time is read.
  if (!STORED.test(stored)) return stored;
  const ms = Date.parse(stored);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(ms)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${zone}`;
}
