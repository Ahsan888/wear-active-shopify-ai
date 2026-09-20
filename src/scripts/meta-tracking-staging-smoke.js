#!/usr/bin/env node
/**
 * Sends one synthetic web order and one synthetic Draft Order to the isolated
 * staging Worker. Uses fake customer data and never targets the production
 * Meta dataset.
 */
require("dotenv").config({ quiet: true });
const crypto = require("crypto");

const WORKER =
  "https://wear-active-meta-tracking-staging.amsuper870.workers.dev";
const PIXEL_KEY = "wa-staging-ingest-1021212370935578";
const WEBHOOK_SECRET = process.env.SHOPIFY_CLIENT_SECRET;

if (!WEBHOOK_SECRET) throw new Error("Missing SHOPIFY_CLIENT_SECRET");

function signedBody(body) {
  const raw = JSON.stringify(body);
  const hmac = crypto
    .createHmac("sha256", WEBHOOK_SECRET)
    .update(raw, "utf8")
    .digest("base64");
  return { raw, hmac };
}

async function post(path, body, headers = {}) {
  const res = await fetch(`${WORKER}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
  const text = await res.text();
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    result = { raw: text.slice(0, 500) };
  }
  return { status: res.status, result };
}

async function sendWebhook(order) {
  const { raw, hmac } = signedBody(order);
  return post("/v1/shopify/orders-create", raw, {
    "X-Shopify-Hmac-Sha256": hmac,
    "X-Shopify-Topic": "orders/create",
    "X-Shopify-Shop-Domain": "wearactive.pk",
  });
}

async function main() {
  const suffix = String(Date.now()).slice(-9);
  const webOrderId = `90${suffix}`;
  const draftOrderId = `91${suffix}`;
  const now = new Date().toISOString();
  const eventId = `wa_purchase_${webOrderId}`;

  const browser = await post(
    "/v1/browser-event",
    JSON.stringify({
      event_name: "Purchase",
      event_id: eventId,
      order_id: webOrderId,
      event_source_url: "https://wearactive.pk/products/staging-test",
      client_user_agent: "Wear Active staging smoke test",
      external_id: `staging-${webOrderId}`,
      fbp: "",
      fbc: "",
    }),
    {
      Origin: "https://wearactive.pk",
      "X-WA-Pixel-Key": PIXEL_KEY,
    }
  );

  const baseOrder = {
    test: false,
    created_at: now,
    processed_at: now,
    currency: "PKR",
    total_price: "1234.00",
    current_total_price: "1234.00",
    browser_ip: "203.0.113.10",
    client_details: { user_agent: "Wear Active staging smoke test" },
    customer: { id: `staging-${webOrderId}` },
    shipping_address: { country_code: "PK" },
    landing_site: "/products/staging-test",
    note_attributes: [],
    line_items: [
      {
        product_id: 1,
        variant_id: 44391333822600,
        quantity: 1,
        price: "1234.00",
      },
    ],
  };

  const web = await sendWebhook({
    ...baseOrder,
    id: webOrderId,
    source_name: "web",
  });
  const draft = await sendWebhook({
    ...baseOrder,
    id: draftOrderId,
    source_name: "shopify_draft_order",
  });

  console.log(
    JSON.stringify(
      {
        synthetic_ids: { web_order_id: webOrderId, draft_order_id: draftOrderId },
        browser_context: browser,
        web_order: web,
        draft_order: draft,
      },
      null,
      2
    )
  );

  if (browser.status !== 202) throw new Error("Browser context was not staged");
  if (web.status !== 202 || web.result.status !== "queued") {
    throw new Error("Web order was not queued");
  }
  if (draft.status !== 200 || draft.result.status !== "rejected") {
    throw new Error("Draft Order was not rejected");
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
