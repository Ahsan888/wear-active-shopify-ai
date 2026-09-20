import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMetaPurchase,
  classifyOrder,
  numericId,
  purchaseEventId,
} from "../src/core.mjs";

const webOrder = {
  id: 6123456789,
  source_name: "web",
  test: false,
  created_at: "2026-09-21T12:00:00+05:00",
  currency: "PKR",
  total_price: "4990.00",
  email: "Buyer@Example.com",
  phone: "+92 300 1234567",
  browser_ip: "203.0.113.5",
  client_details: { user_agent: "Shopify test browser" },
  customer: { id: 9988 },
  shipping_address: {
    first_name: "Ahsan",
    last_name: "Buyer",
    city: "Lahore",
    province_code: "PB",
    zip: "54000",
    country_code: "PK",
  },
  line_items: [
    { product_id: 111, variant_id: 222, quantity: 2, price: "2495.00" },
  ],
};

test("extracts numeric Shopify IDs and constructs stable Purchase IDs", () => {
  assert.equal(numericId("gid://shopify/Order/6123456789"), "6123456789");
  assert.equal(purchaseEventId("gid://shopify/Order/6123456789"), "wa_purchase_6123456789");
});

test("allows genuine web orders", () => {
  assert.deepEqual(classifyOrder(webOrder), {
    eligible: true,
    reason: "storefront_web_order",
    sourceName: "web",
  });
});

for (const source_name of ["shopify_draft_order", "pos", "mobile_app", ""]) {
  test(`rejects ${source_name || "missing"} order sources`, () => {
    assert.equal(classifyOrder({ ...webOrder, source_name }).eligible, false);
  });
}

test("rejects Shopify test orders", () => {
  assert.equal(classifyOrder({ ...webOrder, test: true }).reason, "test_order");
});

test("builds a standard Meta Purchase with rich matching and catalog context", async () => {
  const event = await buildMetaPurchase(
    webOrder,
    {
      event_source_url: "https://wearactive.pk/products/test?fbclid=abc",
      fbp: "fb.1.123.456",
      fbc: "fb.1.123.abc",
      client_user_agent: "Browser context UA",
      external_id: "client-1",
    },
    { META_CATALOG_COUNTRY: "PK" }
  );
  assert.equal(event.event_name, "Purchase");
  assert.equal(event.event_id, "wa_purchase_6123456789");
  assert.equal(event.custom_data.value, 4990);
  assert.equal(event.custom_data.currency, "PKR");
  assert.deepEqual(event.custom_data.content_ids, ["222"]);
  assert.equal(event.custom_data.num_items, 2);
  assert.equal(event.user_data.fbp, "fb.1.123.456");
  assert.equal(event.user_data.fbc, "fb.1.123.abc");
  assert.equal(event.user_data.client_ip_address, "203.0.113.5");
  assert.equal(event.user_data.client_user_agent, "Browser context UA");
  assert.match(event.user_data.em[0], /^[a-f0-9]{64}$/);
  assert.notEqual(event.user_data.em[0], "Buyer@Example.com");
});

test("refuses to construct Purchase for a Draft Order", async () => {
  await assert.rejects(
    () => buildMetaPurchase({ ...webOrder, source_name: "shopify_draft_order" }),
    /Ineligible order: source_not_allowed:shopify_draft_order/
  );
});
