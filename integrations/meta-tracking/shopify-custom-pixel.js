// Production: standard events feed the existing campaign dataset.
const META_PIXEL_ID = "1741415000546640";
const WORKER_ENDPOINT = "https://wear-active-meta-tracking-production.amsuper870.workers.dev/v1/browser-event";
// Routing key only. Browser-visible values are not authentication secrets.
const PIXEL_INGEST_KEY = "wa-production-ingest-1741415000546640";

!function (f, b, e, v, n, t, s) {
  if (f.fbq) return;
  n = f.fbq = function () {
    if (n.callMethod) n.callMethod.apply(n, arguments);
    else n.queue.push(arguments);
  };
  if (!f._fbq) f._fbq = n;
  n.push = n;
  n.loaded = true;
  n.version = "2.0";
  n.queue = [];
  t = b.createElement(e);
  t.async = true;
  t.src = v;
  s = b.getElementsByTagName(e)[0];
  s.parentNode.insertBefore(t, s);
}(window, document, "script", "https://connect.facebook.net/en_US/fbevents.js");

fbq("init", META_PIXEL_ID);

function numericId(value) {
  const match = String(value || "").match(/(\d+)(?:\D*)$/);
  return match ? match[1] : "";
}

function purchaseEventId(orderId) {
  return "wa_purchase_" + numericId(orderId);
}

function moneyAmount(value) {
  return Number(value && value.amount != null ? value.amount : value) || 0;
}

function catalogId(item) {
  const variant = item && item.variant
    ? item.variant
    : (item && item.merchandise ? item.merchandise : {});
  const variantId = numericId(variant.id || (item && item.variantId));
  return variantId;
}

function checkoutContents(checkout) {
  return (checkout.lineItems || []).map(function (item) {
    const quantity = Number(item.quantity) || 0;
    const finalLine = moneyAmount(item.finalLinePrice);
    const fallbackUnit = moneyAmount(item.variant && item.variant.price);
    return {
      id: catalogId(item),
      quantity: quantity,
      item_price: quantity && finalLine ? finalLine / quantity : fallbackUnit
    };
  }).filter(function (item) { return Boolean(item.id); });
}

async function cookie(name) {
  try { return await browser.cookie.get(name) || ""; }
  catch (_error) { return ""; }
}

function eventUrl(event) {
  const location = event.context && event.context.document && event.context.document.location;
  return location && location.href ? location.href : "";
}

function eventUserAgent(event) {
  const nav = event.context && event.context.navigator;
  return nav && nav.userAgent ? nav.userAgent : "";
}

function sendBrowserEvent(name, data, eventId) {
  try { fbq("track", name, data || {}, { eventID: eventId }); }
  catch (error) { console.log("Meta browser event unavailable", name, error); }
}

async function relayBrowserEvent(name, data, event, eventId, orderId) {
  const payload = {
    event_name: name,
    event_id: eventId,
    event_time: event.timestamp ? Math.floor(new Date(event.timestamp).getTime() / 1000) : Math.floor(Date.now() / 1000),
    order_id: orderId || "",
    event_source_url: eventUrl(event),
    client_user_agent: eventUserAgent(event),
    external_id: event.clientId || "",
    fbp: await cookie("_fbp"),
    fbc: await cookie("_fbc"),
    custom_data: data || {}
  };
  try {
    const response = await fetch(WORKER_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-WA-Pixel-Key": PIXEL_INGEST_KEY
      },
      body: JSON.stringify(payload),
      keepalive: true
    });
    if (!response.ok) console.log("Meta production relay failed", name, response.status);
  } catch (error) {
    console.log("Meta production relay unavailable", name, error);
  }
}

function emitEvent(name, data, event, eventId) {
  sendBrowserEvent(name, data, eventId);
  relayBrowserEvent(name, data, event, eventId);
}

analytics.subscribe("page_viewed", function (event) {
  emitEvent("PageView", {}, event, "wa_" + event.id);
});

analytics.subscribe("product_viewed", function (event) {
  const variant = event.data && event.data.productVariant;
  const id = catalogId({ variant: variant });
  emitEvent("ViewContent", {
    content_ids: id ? [id] : [],
    content_type: "product",
    value: moneyAmount(variant && variant.price),
    currency: (variant && variant.price && variant.price.currencyCode) || "PKR"
  }, event, "wa_" + event.id);
});

analytics.subscribe("product_added_to_cart", function (event) {
  const line = event.data && event.data.cartLine;
  const id = catalogId(line || {});
  emitEvent("AddToCart", {
    content_ids: id ? [id] : [],
    content_type: "product",
    value: moneyAmount(line && line.cost && line.cost.totalAmount),
    currency: (line && line.cost && line.cost.totalAmount && line.cost.totalAmount.currencyCode) || "PKR"
  }, event, "wa_" + event.id);
});

analytics.subscribe("search_submitted", function (event) {
  emitEvent("Search", {
    search_string: event.data && event.data.searchResult ? event.data.searchResult.query : ""
  }, event, "wa_" + event.id);
});

analytics.subscribe("checkout_started", function (event) {
  const checkout = event.data && event.data.checkout;
  emitEvent("InitiateCheckout", {
    value: moneyAmount(checkout && checkout.totalPrice),
    currency: (checkout && checkout.currencyCode) || "PKR",
    num_items: checkout ? (checkout.lineItems || []).reduce(function (sum, item) { return sum + (Number(item.quantity) || 0); }, 0) : 0
  }, event, "wa_" + event.id);
});

analytics.subscribe("payment_info_submitted", function (event) {
  const checkout = event.data && event.data.checkout;
  emitEvent("AddPaymentInfo", {
    value: moneyAmount(checkout && checkout.totalPrice),
    currency: (checkout && checkout.currencyCode) || "PKR"
  }, event, "wa_" + event.id);
});

analytics.subscribe("checkout_completed", async function (event) {
  const checkout = event.data && event.data.checkout;
  const orderId = numericId(checkout && checkout.order && checkout.order.id);
  if (!checkout || !orderId) return;

  const eventId = purchaseEventId(orderId);
  const contents = checkoutContents(checkout);
  const purchase = {
    value: moneyAmount(checkout.totalPrice),
    currency: checkout.currencyCode || "PKR",
    order_id: orderId,
    content_type: "product",
    content_ids: contents.map(function (item) { return item.id; }),
    contents: contents,
    num_items: contents.reduce(function (sum, item) { return sum + item.quantity; }, 0)
  };
  sendBrowserEvent("Purchase", purchase, eventId);

  await relayBrowserEvent("Purchase", purchase, event, eventId, orderId);
});
