const bdFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Dhaka',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

export function formatBangladeshTime(ms: number): string {
  return `${bdFormatter.format(new Date(ms))} (Asia/Dhaka)`;
}

export function toDurationSeconds(startMs: number, endMs: number): number {
  return Number(((endMs - startMs) / 1000).toFixed(2));
}
