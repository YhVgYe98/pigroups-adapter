/**
 * One local-time formatter for everything the adapter puts in front of a model.
 *
 * §3.3 and §5.2 both need `YYYY-MM-DD HH:MM` in local time, minute precision. A
 * `toLocaleString` would make the shape depend on the host's locale and ICU build,
 * so the fields are read directly. Tests use the same function to compute their
 * expected strings, which keeps them independent of the machine's timezone.
 */
export function formatLocalMinute(ms: number): string {
  const date = new Date(ms);
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hour}:${minute}`;
}
