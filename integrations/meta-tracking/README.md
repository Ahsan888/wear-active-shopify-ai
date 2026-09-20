# Wear Active Meta tracking

Staged replacement for Shopify-managed Meta event delivery. It keeps the live
campaign contract unchanged: dataset `1741415000546640`, standard `Purchase`.

## Safety invariant

Only Shopify orders whose webhook payload has `source_name: "web"` can produce
a server-side Meta `Purchase`. Draft/Admin (`shopify_draft_order`), POS, app,
test, missing, and unknown sources fail closed.

## Flow

1. Shopify Customer Events sends standard browser events.
2. `checkout_completed` uses `wa_purchase_<order-id>` for browser `Purchase`
   and stages `_fbp`, `_fbc`, URL, browser client ID, and user agent.
3. Shopify sends `orders/create` directly to the Worker.
4. The Worker verifies Shopify HMAC and checks `source_name`.
5. Eligible web orders enter a short delayed queue so browser context can arrive.
6. The queue consumer merges canonical order data with browser context, hashes
   customer matching fields, and sends standard CAPI `Purchase` with the same ID.
7. D1 records accepted, rejected, retried, and sent events without raw PII.

## Production cutover

The staging acceptance suite passed on 2026-09-21 with a genuine storefront
order accepted and a genuine Draft/Admin order rejected. The live Meta catalog
was inspected on 2026-09-21 and its `retailer_id`
uses raw Shopify variant IDs, so `META_CONTENT_ID_MODE` is `variant_id`.

Production was activated on 2026-09-21. Shopify-managed Meta data sharing was
disabled, the custom pixel was switched to dataset `1741415000546640`, and the
production `ORDERS_CREATE` webhook was registered. The staging webhook was
removed so live orders are not copied into the test dataset.

Use `worker/wrangler.production.toml` for production. It targets the existing
live dataset `1741415000546640`, so campaigns and ad sets do not need edits.

Cut over in this order to avoid duplicate standard events:

1. Deploy the production Worker and install its encrypted secrets.
2. Disable Shopify's existing Meta/Facebook customer data sharing.
3. Change the connected custom pixel to the production constants and save it.
4. Register the production `ORDERS_CREATE` webhook.
5. Verify a storefront order is `SENT` and a manual order is `REJECTED`.
6. Keep staging resources for rollback until production has been healthy for
   at least seven days.

## Required Worker secrets

- `META_ACCESS_TOKEN`
- `SHOPIFY_WEBHOOK_SECRET`
- `PIXEL_INGEST_KEY` (routing/abuse-control key; browser-visible, not a true secret)
- `META_TEST_EVENT_CODE` (staging only)

Copy `worker/wrangler.toml.example` to `worker/wrangler.toml`, fill the staging
resource IDs, apply `worker/schema.sql`, then deploy to staging.

Staging targets dataset `1021212370935578`; production targets the existing
campaign dataset `1741415000546640`. Never configure `META_TEST_EVENT_CODE` on
the production Worker.

## Local tests

```sh
npm run meta:tracking:test
```
