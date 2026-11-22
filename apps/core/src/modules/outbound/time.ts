/** Hour of day in the tenant's timezone. */
export function localHour(timezone: string, at = new Date()): number {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', hourCycle: 'h23' }).format(at));
}
/** YYYY-MM-DD in the tenant's timezone. */
export function localDate(timezone: string, at = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}
