/**
 * `value.toFixed(2)` rounds an exact tie (x.xx5 exactly representable, e.g.
 * 138.125) up; Python's `f"{value:.2f}"` rounds it to even. Descriptions must
 * match signals-app byte for byte, so ties are resolved the Python way.
 */
export function formatFixed2(value: number): string {
  const magnitude = Math.abs(value);
  const eighths = magnitude * 8;
  const isTie = Number.isInteger(eighths) && Number.isInteger(magnitude * 1000) && (magnitude * 1000) % 10 === 5;
  if (!isTie) return value.toFixed(2);
  const floorHundredths = Math.floor(magnitude * 100);
  const hundredths = floorHundredths % 2 === 0 ? floorHundredths : floorHundredths + 1;
  const text = (hundredths / 100).toFixed(2);
  return value < 0 ? `-${text}` : text;
}
