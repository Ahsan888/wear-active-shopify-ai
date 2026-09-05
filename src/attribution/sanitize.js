/**
 * Sanitize attribution strings for storage / Sheets.
 */
const { MAX_STRING, MAX_URL, ALLOWED_QUERY_PARAMS } = require("./constants");

function stripHtml(s) {
  return String(s ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/[<>]/g, "");
}

function truncate(s, max) {
  const t = String(s ?? "");
  if (t.length <= max) return t;
  return t.slice(0, max);
}

/** Prevent Sheets formula injection when values reach LIVE. */
function sheetSafe(value) {
  if (value == null || value === "") return "";
  const s = String(value);
  if (/^[=+\-@]/.test(s)) return `'${s}`;
  return s;
}

function sanitizeString(value, { max = MAX_STRING, url = false } = {}) {
  if (value == null || value === "") return null;
  let s = stripHtml(String(value)).trim();
  if (!s) return null;
  try {
    s = decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    // keep raw
  }
  s = stripHtml(s).trim();
  if (!s) return null;
  return truncate(s, url ? MAX_URL : max) || null;
}

function sanitizeTimestamp(value) {
  if (value == null || value === "") return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function pickAllowedParams(searchParams) {
  const out = {};
  if (!searchParams) return out;
  const entries =
    typeof searchParams.entries === "function"
      ? [...searchParams.entries()]
      : Object.entries(searchParams);
  for (const [k, v] of entries) {
    const key = String(k).toLowerCase();
    if (!ALLOWED_QUERY_PARAMS.has(key)) continue;
    const cleaned = sanitizeString(v, {
      max: key === "fbclid" ? 200 : MAX_STRING,
    });
    if (cleaned) out[key] = cleaned;
  }
  return out;
}

function parseUrlParams(urlOrQuery) {
  if (!urlOrQuery) return {};
  try {
    const s = String(urlOrQuery);
    if (s.includes("://")) {
      const u = new URL(s);
      return pickAllowedParams(u.searchParams);
    }
    const q = s.startsWith("?") ? s.slice(1) : s;
    return pickAllowedParams(new URLSearchParams(q));
  } catch {
    return {};
  }
}

module.exports = {
  stripHtml,
  truncate,
  sheetSafe,
  sanitizeString,
  sanitizeTimestamp,
  pickAllowedParams,
  parseUrlParams,
};
