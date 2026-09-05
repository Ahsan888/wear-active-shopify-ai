/**
 * Shared Resend email helper (no npm package).
 * Reused by low-stock alerts and Phase 4 daily reporting.
 *
 * Pattern: POST https://api.resend.com/emails with RESEND_API_KEY.
 */
async function sendViaResend({
  to,
  from,
  subject,
  text,
  html,
  apiKey = process.env.RESEND_API_KEY,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!apiKey) {
    const err = new Error("resend_api_key_missing");
    err.code = "resend_api_key_missing";
    throw err;
  }
  if (!from) {
    const err = new Error("resend_from_missing");
    err.code = "resend_from_missing";
    throw err;
  }
  const recipients = Array.isArray(to)
    ? to.filter(Boolean)
    : String(to || "")
        .split(/[,;]/)
        .map((s) => s.trim())
        .filter(Boolean);
  if (!recipients.length) {
    const err = new Error("resend_to_missing");
    err.code = "resend_to_missing";
    throw err;
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch_unavailable");
  }

  const res = await fetchImpl("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: recipients,
      subject,
      text,
      html,
    }),
  });

  const raw = await res.text();
  let parsed = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }

  if (!res.ok) {
    const err = new Error(`resend_http_${res.status}`);
    err.code = `resend_http_${res.status}`;
    err.status = res.status;
    // Never attach raw body (may echo config); keep short.
    err.messageRedacted = `Resend HTTP ${res.status}`;
    throw err;
  }

  return {
    success: true,
    id: parsed?.id || null,
    status: res.status,
  };
}

function redactEmail(addr) {
  if (!addr || typeof addr !== "string") return "";
  const at = addr.indexOf("@");
  if (at <= 0) return "***";
  const local = addr.slice(0, at);
  const domain = addr.slice(at + 1);
  const keep = local.slice(0, 1);
  return `${keep}***@${domain}`;
}

function redactRecipients(to) {
  const list = Array.isArray(to)
    ? to
    : String(to || "")
        .split(/[,;]/)
        .map((s) => s.trim())
        .filter(Boolean);
  return list.map(redactEmail).join(", ");
}

module.exports = {
  sendViaResend,
  redactEmail,
  redactRecipients,
};
