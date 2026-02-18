//utils.js
export function uuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function nowISO() {
  return new Date().toISOString();
}

export function parseAnyISOish(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;

  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }

  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:\s*(?:T|\s)\s*(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    const y = +m[1], mo = +m[2], d = +m[3];
    const hh = m[4] ? +m[4] : 0;
    const mm = m[5] ? +m[5] : 0;
    const ss = m[6] ? +m[6] : 0;
    const dt = new Date(y, mo - 1, d, hh, mm, ss);
    return isNaN(dt.getTime()) ? null : dt;
  }

  return null;
}

export function dayKeyLocal(dateOrISO) {
  const dt = (dateOrISO instanceof Date) ? dateOrISO : new Date(dateOrISO);
  if (isNaN(dt.getTime())) return null;
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const d = String(dt.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function clampText(s, max=70) {
  const t = String(s || "").trim();
  if (t.length <= max) return t;
  return t.slice(0, max-1) + "…";
}

export function startOfMonth(d) {
  const dt = new Date(d.getFullYear(), d.getMonth(), 1);
  dt.setHours(0,0,0,0);
  return dt;
}

export function endOfMonth(d) {
  const dt = new Date(d.getFullYear(), d.getMonth()+1, 0);
  dt.setHours(0,0,0,0);
  return dt;
}

export function addDays(d, n) {
  const dt = new Date(d);
  dt.setDate(dt.getDate() + n);
  return dt;
}

export function stableHash(str) {
  let h = 0x811c9dc5;
  const s = String(str ?? "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return ("00000000" + h.toString(16)).slice(-8);
}
