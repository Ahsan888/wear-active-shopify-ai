import { buildMetaPurchase, classifyOrder, numericId, purchaseEventId, sha256 } from "./core.mjs";

const JSON_HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store" };

function response(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...headers } });
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = String(env.PIXEL_ALLOWED_ORIGINS || "https://wearactive.pk,https://www.wearactive.pk,null")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const allowOrigin = allowed.includes(origin) ? origin : allowed[0] || "https://wearactive.pk";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-WA-Pixel-Key",
    Vary: "Origin",
  };
}

async function hmacIsValid(rawBody, supplied, secret) {
  if (!supplied || !secret) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody)));
  const expected = btoa(String.fromCharCode(...signature));
  if (expected.length !== supplied.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i += 1) mismatch |= expected.charCodeAt(i) ^ supplied.charCodeAt(i);
  return mismatch === 0;
}

async function stageBrowserPurchase(request, env) {
  const headers = corsHeaders(request, env);
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > 32_000) return response({ success: false, error: "Payload too large" }, 413, headers);
  if (env.PIXEL_INGEST_KEY && request.headers.get("X-WA-Pixel-Key") !== env.PIXEL_INGEST_KEY) {
    return response({ success: false, error: "Invalid ingest key" }, 401, headers);
  }
  const body = await request.json();
  const eventName = String(body.event_name || "");
  const allowedEvents = new Set([
    "PageView",
    "ViewContent",
    "Search",
    "AddToCart",
    "InitiateCheckout",
    "AddPaymentInfo",
    "Purchase",
  ]);
  if (!allowedEvents.has(eventName) || !body.event_id) {
    return response({ success: false, error: "Invalid browser event" }, 400, headers);
  }

  if (eventName !== "Purchase") {
    const userData = {};
    const clientIp = request.headers.get("CF-Connecting-IP");
    if (body.fbp) userData.fbp = String(body.fbp).slice(0, 255);
    if (body.fbc) userData.fbc = String(body.fbc).slice(0, 255);
    if (clientIp) userData.client_ip_address = clientIp;
    if (body.client_user_agent) {
      userData.client_user_agent = String(body.client_user_agent).slice(0, 1024);
    }
    if (body.external_id) {
      userData.external_id = [await sha256(String(body.external_id))];
    }

    const metaEvent = {
      event_name: eventName,
      event_time: Number(body.event_time) || Math.floor(Date.now() / 1000),
      event_id: String(body.event_id).slice(0, 255),
      event_source_url: String(body.event_source_url || `https://${env.STOREFRONT_DOMAIN || "wearactive.pk"}/`).slice(0, 2048),
      action_source: "website",
      user_data: userData,
      custom_data: sanitizeCustomData(body.custom_data),
    };
    const meta = await sendToMeta(metaEvent, env);
    await env.TRACKING_DB.prepare(`
      INSERT INTO browser_events (event_id, event_name, state, meta_status, meta_trace_id, updated_at)
      VALUES (?, ?, 'SENT', 200, ?, datetime('now'))
      ON CONFLICT(event_id) DO UPDATE SET
        state='SENT', meta_status=200, meta_trace_id=excluded.meta_trace_id, updated_at=datetime('now')
    `).bind(metaEvent.event_id, eventName, meta.fbtrace_id || "").run();
    return response(
      { success: true, status: "browser_event_sent", event_name: eventName, event_id: metaEvent.event_id },
      200,
      headers
    );
  }

  const orderId = numericId(body.order_id);
  if (!orderId || body.event_id !== purchaseEventId(orderId)) {
    return response({ success: false, error: "Invalid Purchase identity" }, 400, headers);
  }
  await env.TRACKING_DB.prepare(`
    INSERT INTO browser_context
      (order_id, event_id, event_source_url, fbp, fbc, client_user_agent, external_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(order_id) DO UPDATE SET
      event_id=excluded.event_id,
      event_source_url=excluded.event_source_url,
      fbp=excluded.fbp,
      fbc=excluded.fbc,
      client_user_agent=excluded.client_user_agent,
      external_id=excluded.external_id,
      updated_at=datetime('now')
  `).bind(
    orderId,
    body.event_id,
    String(body.event_source_url || "").slice(0, 2048),
    String(body.fbp || "").slice(0, 255),
    String(body.fbc || "").slice(0, 255),
    String(body.client_user_agent || "").slice(0, 1024),
    String(body.external_id || "").slice(0, 255)
  ).run();
  return response({ success: true, status: "purchase_context_staged", event_id: body.event_id }, 202, headers);
}

function sanitizeCustomData(input) {
  const source = input && typeof input === "object" ? input : {};
  const result = {};
  for (const key of ["currency", "content_type", "search_string", "order_id"]) {
    if (source[key] != null && source[key] !== "") result[key] = String(source[key]).slice(0, 500);
  }
  for (const key of ["value", "num_items"]) {
    const number = Number(source[key]);
    if (Number.isFinite(number) && number >= 0) result[key] = number;
  }
  if (Array.isArray(source.content_ids)) {
    result.content_ids = source.content_ids.slice(0, 100).map((id) => String(id).slice(0, 255));
  }
  if (Array.isArray(source.contents)) {
    result.contents = source.contents.slice(0, 100).map((item) => ({
      id: String(item?.id || "").slice(0, 255),
      quantity: Math.max(0, Number(item?.quantity) || 0),
      item_price: Math.max(0, Number(item?.item_price) || 0),
    })).filter((item) => item.id);
  }
  return result;
}

async function acceptShopifyOrder(request, env) {
  const rawBody = await request.text();
  const valid = await hmacIsValid(rawBody, request.headers.get("X-Shopify-Hmac-Sha256"), env.SHOPIFY_WEBHOOK_SECRET);
  if (!valid) return response({ success: false, error: "Invalid Shopify HMAC" }, 401);

  const order = JSON.parse(rawBody);
  const classification = classifyOrder(order);
  const orderId = numericId(order.id);
  if (!classification.eligible) {
    if (env.TRACKING_DB && orderId) {
      await env.TRACKING_DB.prepare(`
        INSERT INTO meta_events (event_id, order_id, source_name, state, reason, updated_at)
        VALUES (?, ?, ?, 'REJECTED', ?, datetime('now'))
        ON CONFLICT(event_id) DO UPDATE SET state='REJECTED', reason=excluded.reason, updated_at=datetime('now')
      `).bind(`wa_rejected_${orderId}`, orderId, classification.sourceName, classification.reason).run();
    }
    return response({ success: true, status: "rejected", reason: classification.reason });
  }

  const eventId = purchaseEventId(orderId);
  const inserted = await env.TRACKING_DB.prepare(`
    INSERT INTO meta_events (event_id, order_id, source_name, state, reason, updated_at)
    VALUES (?, ?, ?, 'QUEUED', 'storefront_web_order', datetime('now'))
    ON CONFLICT(event_id) DO NOTHING
  `).bind(eventId, orderId, classification.sourceName).run();
  if (!inserted.meta?.changes) {
    const existing = await env.TRACKING_DB.prepare(
      "SELECT state FROM meta_events WHERE event_id = ?"
    ).bind(eventId).first();
    if (existing?.state === "SENT" || existing?.state === "QUEUED" || existing?.state === "SENDING") {
      return response({ success: true, status: "duplicate_suppressed", event_id: eventId }, 200);
    }
    await env.TRACKING_DB.prepare(`
      UPDATE meta_events SET state='QUEUED', reason='webhook_retry', updated_at=datetime('now')
      WHERE event_id=?
    `).bind(eventId).run();
  }
  try {
    await env.PURCHASE_QUEUE.send({ order }, { delaySeconds: Number(env.PURCHASE_QUEUE_DELAY_SECONDS || 20) });
  } catch (error) {
    await env.TRACKING_DB.prepare(`
      UPDATE meta_events SET state='FAILED', reason='queue_send_failed', updated_at=datetime('now')
      WHERE event_id=?
    `).bind(eventId).run();
    throw error;
  }
  return response({ success: true, status: "queued", event_id: eventId }, 202);
}

async function sendToMeta(metaEvent, env) {
  const version = String(env.META_API_VERSION || "v23.0");
  const url = `https://graph.facebook.com/${version}/${env.META_PIXEL_ID}/events?access_token=${encodeURIComponent(env.META_ACCESS_TOKEN)}`;
  const payload = {
    data: [metaEvent],
    ...(env.META_TEST_EVENT_CODE ? { test_event_code: env.META_TEST_EVENT_CODE } : {}),
  };
  const result = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await result.json().catch(() => ({}));
  if (!result.ok || Number(data.events_received || 0) !== 1) {
    throw new Error(`Meta CAPI ${result.status}: ${JSON.stringify(data).slice(0, 1000)}`);
  }
  return data;
}

async function processPurchase(message, env) {
  const order = message.body?.order;
  const orderId = numericId(order?.id);
  const eventId = purchaseEventId(orderId);
  const claim = await env.TRACKING_DB.prepare(`
    UPDATE meta_events SET state='SENDING', updated_at=datetime('now')
    WHERE event_id=? AND state IN ('QUEUED', 'FAILED')
  `).bind(eventId).run();
  if (!claim.meta?.changes) {
    const existing = await env.TRACKING_DB.prepare(
      "SELECT state FROM meta_events WHERE event_id = ?"
    ).bind(eventId).first();
    if (existing?.state === "SENT") return;
    throw new Error(`Purchase event cannot be claimed from state ${existing?.state || "missing"}`);
  }

  const browserContext = await env.TRACKING_DB.prepare(
    "SELECT * FROM browser_context WHERE order_id = ?"
  ).bind(orderId).first() || {};
  const metaEvent = await buildMetaPurchase(order, browserContext, env);
  try {
    const meta = await sendToMeta(metaEvent, env);
    await env.TRACKING_DB.prepare(`
      UPDATE meta_events
      SET state='SENT', attempts=attempts+1, meta_status=200, meta_trace_id=?, sent_at=datetime('now'), updated_at=datetime('now')
      WHERE event_id=?
    `).bind(meta.fbtrace_id || "", eventId).run();
  } catch (error) {
    await env.TRACKING_DB.prepare(`
      UPDATE meta_events
      SET state='FAILED', attempts=attempts+1, reason=?, updated_at=datetime('now')
      WHERE event_id=?
    `).bind(String(error.message || error).slice(0, 1000), eventId).run();
    throw error;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      return response({ ok: true, service: "wear-active-meta-tracking" });
    }
    if (url.pathname === "/v1/browser-event" && request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }
    if (url.pathname === "/v1/browser-event" && request.method === "POST") {
      return stageBrowserPurchase(request, env);
    }
    if (url.pathname === "/v1/shopify/orders-create" && request.method === "POST") {
      return acceptShopifyOrder(request, env);
    }
    return response({ success: false, error: "Not found" }, 404);
  },

  async queue(batch, env) {
    for (const message of batch.messages) {
      try {
        await processPurchase(message, env);
        message.ack();
      } catch (error) {
        console.error("PURCHASE_QUEUE_ERROR", String(error.message || error));
        message.retry({ delaySeconds: 60 });
      }
    }
  },

  async scheduled(_controller, env) {
    await env.TRACKING_DB.prepare("DELETE FROM browser_context WHERE updated_at < datetime('now', '-14 days')").run();
  },
};
