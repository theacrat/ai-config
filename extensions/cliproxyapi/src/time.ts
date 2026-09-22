export function formatTime({
  timestamp,
  timeZone,
  locale,
}: {
  timestamp: number;
  timeZone: string;
  locale?: string;
}): string {
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
    timeZoneName: "shortOffset",
  }).format(timestamp);
}
