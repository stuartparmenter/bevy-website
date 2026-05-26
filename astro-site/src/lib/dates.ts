// Minimal strftime supporting the formats Zola templates use:
//   %B (full month), %d (zero-padded day), %-d (day), %Y (year), %+ (RFC3339-ish).
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function parts(dateStr: string) {
  const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return { y: +m[1], mo: +m[2], d: +m[3] };
}

export function formatDate(dateStr: string, fmt: string): string {
  const p = parts(dateStr);
  if (!p) return dateStr;
  return fmt
    .replace(/%B/g, MONTHS[p.mo - 1])
    .replace(/%-d/g, String(p.d))
    .replace(/%d/g, String(p.d).padStart(2, "0"))
    .replace(/%Y/g, String(p.y));
}

// RFC3339 for feeds (Zola %+ on a date-only value yields midnight UTC).
export function rfc3339(dateStr: string): string {
  const p = parts(dateStr);
  if (!p) return dateStr;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}T00:00:00+00:00`;
}
