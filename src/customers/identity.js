/**
 * Privacy-safe customer identity for cohort economics.
 * Never persist or display raw email / name / phone / address.
 */
const crypto = require("crypto");

function shopifyCustomerIdFromGid(id) {
  const s = String(id || "");
  const m = s.match(/\/Customer\/(\d+)/i) || s.match(/^(\d+)$/);
  return m ? m[1] : null;
}

function hashEmail(email) {
  const normalized = String(email || "")
    .trim()
    .toLowerCase();
  if (!normalized || !normalized.includes("@")) return null;
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

/**
 * Resolve customer key from a Shopify order node.
 * Priority: customer.id → email hash (internal match only) → guest:{orderId}
 *
 * @returns {{ customer_key: string, identity_type: 'shopify_customer'|'email_hash'|'guest', shopify_customer_id: string|null }}
 */
function resolveCustomerIdentity(order = {}) {
  const orderId =
    String(order.id || "")
      .match(/\/Order\/(\d+)/i)?.[1] ||
    String(order.name || "")
      .replace(/^#/, "")
      .trim() ||
    "unknown";

  const custId = shopifyCustomerIdFromGid(order.customer?.id);
  if (custId) {
    return {
      customer_key: `shopify_customer:${custId}`,
      identity_type: "shopify_customer",
      shopify_customer_id: custId,
    };
  }

  // Order-level email only hashed — never stored raw on the returned object
  const emailHash = hashEmail(order.email);
  if (emailHash) {
    return {
      customer_key: `email_hash:${emailHash}`,
      identity_type: "email_hash",
      shopify_customer_id: null,
    };
  }

  return {
    customer_key: `guest:${orderId}`,
    identity_type: "guest",
    shopify_customer_id: null,
  };
}

function isIdentifiedCustomer(identityType) {
  return identityType === "shopify_customer" || identityType === "email_hash";
}

function assertNoRawPii(value) {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  // crude guard for tests / sanitization
  if (/@[a-z0-9.-]+\.[a-z]{2,}/i.test(s) && /email_hash:/.test(s) === false) {
    // Allow strings that are clearly not emails in keys — flag obvious emails
    if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(s)) {
      throw new Error("Raw email must not appear in customer economics output");
    }
  }
}

module.exports = {
  shopifyCustomerIdFromGid,
  hashEmail,
  resolveCustomerIdentity,
  isIdentifiedCustomer,
  assertNoRawPii,
};
