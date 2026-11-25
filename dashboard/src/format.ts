const dateFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });
const timeFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

export function formatDate(value: string): string {
  const parsed = Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value);

  return Number.isFinite(parsed) ? dateFormat.format(parsed) : value;
}

export function formatTime(value: string | null): string {
  if (!value) {
    return "";
  }

  const parsed = Date.parse(value);

  return Number.isFinite(parsed) ? timeFormat.format(parsed) : value;
}

export function formatUsd(amount: number): string {
  return `${amount.toFixed(2)} USDC`;
}
