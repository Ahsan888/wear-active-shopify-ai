const ALLOWED_PURCHASE_SOURCE = "web";

export function numericId(value) {
  const match = String(value || "").match(/(\d+)(?:\D*)$/);
  return match ? match[1] : "";
}

export function purchaseEventId(orderId) {
  const id = numericId(orderId);
  if (!id) throw new Error("Missing Shopify order ID");
  return `wa_purchase_${id}`;
}

export function classifyOrder(order) {
  const sourceName = String(order?.source_name || "").trim().toLowerCase();
  if (order?.test) return { eligible: false, reason: "test_order", sourceName };
  if (sourceName !== ALLOWED_PURCHASE_SOURCE) {
    return {
      eligible: false,
      reason: sourceName ? `source_not_allowed:${sourceName}` : "missing_source_name",
      sourceName,
    };
  }
  if (!numericId(order?.id)) {
    return { eligible: false, reason: "missing_order_id", sourceName };
  }
  const value = Number(order?.current_total_price ?? order?.total_price);
  if (!Number.isFinite(value) || value < 0) {
    return { eligible: false, reason: "invalid_order_value", sourceName };
  }
  return { eligible: true, reason: "storefront_web_order", sourceName };
}

export function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

export function normalizePhone(value, defaultCountryCode = "92") {
  let digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0") && defaultCountryCode) {
    digits = `${defaultCountryCode}${digits.slice(1)}`;
  }
  return digits;
}

export function normalizeText(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, "");
}

export async function sha256(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

async function addHashed(userData, key, value, normalizer = normalizeText) {
  const normalized = normalizer(value);
  if (normalized) userData[key] = [await sha256(normalized)];
}

function noteAttributeMap(order) {
  const result = {};
  for (const item of order?.note_attributes || []) {
    if (item?.name) result[String(item.name)] = item.value;
  }
  return result;
}

function attributionFromOrder(order) {
  const notes = noteAttributeMap(order);
  let stored = {};
  try {
    stored = notes._wa_attr ? JSON.parse(String(notes._wa_attr)) : {};
  } catch {
    stored = {};
  }
  const first = stored.first_touch || {};
  const last = stored.last_touch || {};
  return {
    fbc: last.fbc || first.fbc || notes.wa_fbc || "",
    fbp: last.fbp || first.fbp || notes.wa_fbp || "",
  };
}

export function catalogContentId(lineItem, env = {}) {
  const variantId = numericId(lineItem?.variant_id || lineItem?.variant?.id);
  const productId = numericId(lineItem?.product_id || lineItem?.product?.id);
  const mode = String(env.META_CONTENT_ID_MODE || "variant_id");
  if (mode === "variant_id") return variantId;
  if (mode === "product_id") return productId;
  const country = String(env.META_CATALOG_COUNTRY || "PK").toUpperCase();
  return productId && variantId ? `shopify_${country}_${productId}_${variantId}` : variantId || productId;
}

export function buildCommerceData(order, env = {}) {
  const contents = (order?.line_items || [])
    .map((item) => {
      const id = catalogContentId(item, env);
      if (!id) return null;
      return {
        id,
        quantity: Number(item.quantity) || 0,
        item_price: Number(item.price) || 0,
      };
    })
    .filter(Boolean);
  return {
    value: Number(order?.current_total_price ?? order?.total_price) || 0,
    currency: String(order?.currency || order?.presentment_currency || "PKR").toUpperCase(),
    order_id: numericId(order?.id),
    content_type: "product",
    content_ids: contents.map((item) => item.id),
    contents,
    num_items: contents.reduce((sum, item) => sum + item.quantity, 0),
  };
}

function sourceUrl(order, browserContext, env) {
  if (browserContext?.event_source_url) return browserContext.event_source_url;
  const landing = String(order?.landing_site || "");
  if (/^https?:\/\//i.test(landing)) return landing;
  const domain = String(env.STOREFRONT_DOMAIN || "wearactive.pk").replace(/^https?:\/\//i, "").replace(/\/$/, "");
  return landing ? `https://${domain}${landing.startsWith("/") ? "" : "/"}${landing}` : `https://${domain}/`;
}

export async function buildMetaPurchase(order, browserContext = {}, env = {}) {
  const classification = classifyOrder(order);
  if (!classification.eligible) throw new Error(`Ineligible order: ${classification.reason}`);

  const shipping = order.shipping_address || {};
  const billing = order.billing_address || {};
  const customer = order.customer || {};
  const client = order.client_details || {};
  const storedAttribution = attributionFromOrder(order);
  const userData = {};

  await addHashed(userData, "em", order.email || customer.email, normalizeEmail);
  await addHashed(
    userData,
    "ph",
    order.phone || shipping.phone || billing.phone || customer.phone,
    (value) => normalizePhone(value, env.DEFAULT_PHONE_COUNTRY_CODE || "92")
  );
  await addHashed(userData, "fn", shipping.first_name || billing.first_name || customer.first_name);
  await addHashed(userData, "ln", shipping.last_name || billing.last_name || customer.last_name);
  await addHashed(userData, "ct", shipping.city || billing.city);
  await addHashed(userData, "st", shipping.province_code || shipping.province || billing.province_code || billing.province);
  await addHashed(userData, "zp", shipping.zip || billing.zip);
  await addHashed(userData, "country", shipping.country_code || billing.country_code || "PK");
  await addHashed(userData, "external_id", customer.id || browserContext.external_id, String);

  const fbp = browserContext.fbp || storedAttribution.fbp;
  const fbc = browserContext.fbc || storedAttribution.fbc;
  if (fbp) userData.fbp = fbp;
  if (fbc) userData.fbc = fbc;

  const browserIp = order.browser_ip || client.browser_ip;
  const userAgent = browserContext.client_user_agent || client.user_agent;
  if (browserIp) userData.client_ip_address = browserIp;
  if (userAgent) userData.client_user_agent = userAgent;

  const timestamp = Date.parse(order.processed_at || order.created_at || "");
  return {
    event_name: "Purchase",
    event_time: Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : Math.floor(Date.now() / 1000),
    event_id: purchaseEventId(order.id),
    event_source_url: sourceUrl(order, browserContext, env),
    action_source: "website",
    user_data: userData,
    custom_data: buildCommerceData(order, env),
  };
}
