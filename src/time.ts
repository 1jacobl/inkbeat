export function fmt(sec: number, withTenths = false): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  const whole = Math.floor(s);
  const base = `${m}:${String(whole).padStart(2, "0")}`;
  return withTenths ? `${base}.${Math.floor((s - whole) * 10)}` : base;
}

/** Accepts "83", "83.5", "1:23", "1:23.4", "1:02:03". Returns null if unparseable. */
export function parseTime(input: string): number | null {
  const t = input.trim();
  if (!t) return null;
  const parts = t.split(":");
  if (parts.length > 3) return null;
  let total = 0;
  for (const p of parts) {
    if (!/^\d+(\.\d+)?$/.test(p)) return null;
    total = total * 60 + parseFloat(p);
  }
  return total;
}

export function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}
