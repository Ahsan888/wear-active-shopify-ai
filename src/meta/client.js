/**
 * Meta Marketing API client (read-only Graph GET helpers).
 * Never logs META_ACCESS_TOKEN.
 */
require("dotenv").config({ quiet: true });

const DEFAULT_API_VERSION = "v21.0";

const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const META_API_VERSION = String(
  process.env.META_API_VERSION || DEFAULT_API_VERSION
).trim();

function requireToken() {
  if (!META_ACCESS_TOKEN || !String(META_ACCESS_TOKEN).trim()) {
    throw new Error("Missing META_ACCESS_TOKEN in .env");
  }
  return String(META_ACCESS_TOKEN).trim();
}

function normalizeAdAccountId(raw) {
  const value = String(raw || "").trim();
  if (!value) {
    throw new Error(
      "Missing META_AD_ACCOUNT_ID in .env (digits only, or act_<id>)"
    );
  }
  if (/^act_\d+$/i.test(value)) return `act_${value.slice(4)}`;
  if (/^\d+$/.test(value)) return `act_${value}`;
  throw new Error(
    `Invalid META_AD_ACCOUNT_ID "${value}". Expected digits or act_<digits>.`
  );
}

function getAdAccountId() {
  return normalizeAdAccountId(process.env.META_AD_ACCOUNT_ID);
}

function buildUrl(path, params = {}) {
  const cleanPath = String(path || "").replace(/^\//, "");
  const url = new URL(
    `https://graph.facebook.com/${META_API_VERSION}/${cleanPath}`
  );
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(
      key,
      typeof value === "object" ? JSON.stringify(value) : String(value)
    );
  }
  return url;
}

function formatMetaError(payload, httpStatus) {
  const err = payload?.error || {};
  const parts = [
    err.message || payload?.message || `Meta Graph HTTP ${httpStatus}`,
  ];
  if (err.code != null) parts.push(`code=${err.code}`);
  if (err.error_subcode != null) parts.push(`subcode=${err.error_subcode}`);
  if (err.type) parts.push(`type=${err.type}`);
  if (err.fbtrace_id) parts.push(`fbtrace=${err.fbtrace_id}`);
  const message = parts.join(" | ");
  const e = new Error(message);
  e.meta = {
    httpStatus,
    code: err.code ?? null,
    subcode: err.error_subcode ?? null,
    type: err.type ?? null,
    fbtrace_id: err.fbtrace_id ?? null,
    is_transient: Boolean(err.is_transient),
  };
  return e;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * GET a Graph API path. Pass absolute next-page URLs via { absoluteUrl }.
 * Retries a few times on transient / rate-limit responses.
 */
async function graphGet(path, params = {}, options = {}) {
  const token = requireToken();
  const maxAttempts = options.maxAttempts ?? 4;
  let absoluteUrl = options.absoluteUrl || null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const url = absoluteUrl
      ? new URL(absoluteUrl)
      : buildUrl(path, { ...params, access_token: token });

    // If paging.next already includes access_token, do not append again.
    if (absoluteUrl && !url.searchParams.has("access_token")) {
      url.searchParams.set("access_token", token);
    }

    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(
        `Meta Graph non-JSON (${res.status}): ${text.slice(0, 200)}`
      );
    }

    if (res.ok && !json.error) {
      return {
        data: json,
        headers: {
          usage: res.headers.get("x-business-use-case-usage"),
          appUsage: res.headers.get("x-app-usage"),
          adAccountUsage: res.headers.get("x-ad-account-usage"),
        },
      };
    }

    const metaErr = formatMetaError(json, res.status);
    const code = metaErr.meta?.code;
    const transient =
      metaErr.meta?.is_transient ||
      code === 17 ||
      code === 4 ||
      code === 613 ||
      res.status === 429;

    if (transient && attempt < maxAttempts) {
      const backoff = Math.min(30_000, 500 * 2 ** (attempt - 1));
      await sleep(backoff);
      continue;
    }

    throw metaErr;
  }

  throw new Error("Meta Graph request failed after retries");
}

/**
 * Paginate Graph list endpoints via paging.next until exhausted.
 * Returns concatenated `data` arrays (or single object if no list).
 */
async function graphGetAll(path, params = {}, options = {}) {
  const limit = options.pageLimit ?? 500;
  const first = await graphGet(path, { limit, ...params }, options);
  const payload = first.data;

  if (!Array.isArray(payload.data)) {
    return payload;
  }

  const rows = [...payload.data];
  let next = payload.paging?.next || null;
  let pages = 1;
  const maxPages = options.maxPages ?? 100;

  while (next && pages < maxPages) {
    const page = await graphGet(null, {}, { absoluteUrl: next });
    const body = page.data;
    if (Array.isArray(body.data)) rows.push(...body.data);
    next = body.paging?.next || null;
    pages += 1;
  }

  // Do not return a silently truncated report (and never log paging.next —
  // it may embed the access token).
  if (next) {
    const label = path ? String(path) : "(absolute paging URL)";
    throw new Error(
      `Meta pagination exceeded maxPages=${maxPages}; refusing to return a potentially incomplete report (path=${label}, pages=${pages})`
    );
  }

  return { data: rows, paging: { pages } };
}

module.exports = {
  META_API_VERSION,
  DEFAULT_API_VERSION,
  getAdAccountId,
  normalizeAdAccountId,
  graphGet,
  graphGetAll,
};
