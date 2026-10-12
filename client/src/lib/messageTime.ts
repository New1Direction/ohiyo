// How a message's time is shown. (Placeholder: the old behaviour, to be replaced.)
export type TimeOptions = { locale?: string; timeZone?: string };

export function formatClockTime(at: number, opts: TimeOptions = {}): string {
  return new Date(at).toLocaleTimeString(opts.locale, { hour: "2-digit", minute: "2-digit", timeZone: opts.timeZone });
}

export function formatMessageTime(at: number, now: number = Date.now(), opts: TimeOptions = {}): string {
  const d = new Date(at);
  if (d.toDateString() === new Date(now).toDateString()) return formatClockTime(at, opts);
  return d.toLocaleDateString(opts.locale, { timeZone: opts.timeZone }) + " " + formatClockTime(at, opts);
}

export function formatFullTime(at: number, opts: TimeOptions = {}): string {
  return new Date(at).toLocaleString(opts.locale, { timeZone: opts.timeZone });
}
