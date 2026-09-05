#!/usr/bin/env node
/**
 * Phase 5A attribution self-tests.
 */
const assert = require("assert");
const {
  sanitizeString,
  sheetSafe,
  parseUrlParams,
} = require("../attribution/sanitize");
const {
  applyVisit,
  touchFromParams,
  isDirectTouch,
  isAttributableTouch,
} = require("../attribution/touch");
const {
  normalizeOrderAttribution,
  classifyStatus,
  confidenceFor,
  parseCartAttributePayload,
} = require("../attribution/normalize");
const { matchMetaIds } = require("../attribution/metaMatch");
const {
  buildAttributionDiagnostics,
  liveSheetAttributionColumns,
} = require("../attribution/coverage");
const { extractWebhookAttribution } = require("../attribution/webhookExtract");
const { renderUnifiedDashboard } = require("../dashboard/html");
const { buildOwnerEmailContent } = require("../operations/ownerEmail");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL ${name}`);
    console.error(err.message || err);
  }
}

test("1. complete Meta UTM", () => {
  const t = touchFromParams({
    utm_source: "facebook",
    utm_medium: "paid",
    utm_campaign: "summer",
    utm_content: "adA",
  });
  assert.strictEqual(classifyStatus(t), "meta_first_party");
});

test("2. fbclid only", () => {
  const t = touchFromParams({ fbclid: "abc123XYZ" });
  assert.strictEqual(classifyStatus(t), "meta_first_party");
  assert.strictEqual(confidenceFor(t, "meta_first_party"), "high");
});

test("3. fbc only", () => {
  const t = touchFromParams({}, { fbc: "fb.1.123.456" });
  assert.strictEqual(classifyStatus(t), "meta_first_party");
});

test("4. Meta UTM + click ID", () => {
  const t = touchFromParams({
    utm_source: "facebook",
    utm_medium: "paid",
    fbclid: "x",
  });
  assert.ok(confidenceFor(t, "meta_first_party") === "high");
});

test("5. organic", () => {
  const t = touchFromParams({
    utm_source: "instagram",
    utm_medium: "social",
    utm_content: "link_in_bio",
  });
  assert.strictEqual(classifyStatus(t), "organic");
});

test("6. direct", () => {
  assert.strictEqual(classifyStatus(touchFromParams({})), "unattributed");
  assert.ok(isDirectTouch(touchFromParams({ utm_source: "direct" })));
});

test("7. paid non-Meta", () => {
  const t = touchFromParams({
    utm_source: "google",
    utm_medium: "cpc",
  });
  assert.strictEqual(classifyStatus(t), "paid_non_meta");
});

test("8. unknown", () => {
  const t = touchFromParams({ utm_source: "newsletter_x", utm_medium: "weird" });
  assert.strictEqual(classifyStatus(t), "unknown");
});

test("9. no evidence", () => {
  const n = normalizeOrderAttribution({});
  assert.strictEqual(n.status, "unattributed");
  assert.strictEqual(n.confidence, "none");
});

test("10. first touch preserved", () => {
  const first = touchFromParams({
    utm_source: "facebook",
    utm_medium: "paid",
    fbclid: "1",
  });
  const state = applyVisit(null, first);
  const next = applyVisit(state, touchFromParams({ utm_source: "google", utm_medium: "cpc" }));
  assert.strictEqual(next.first_touch.fbclid, "1");
});

test("11. last attributable touch updated", () => {
  const a = touchFromParams({ utm_source: "facebook", utm_medium: "paid", fbclid: "1" });
  const b = touchFromParams({ utm_source: "facebook", utm_medium: "paid", fbclid: "2" });
  const s = applyVisit(applyVisit(null, a), b);
  assert.strictEqual(s.last_touch.fbclid, "2");
});

test("12. direct return does not erase paid touch", () => {
  const paid = touchFromParams({
    utm_source: "facebook",
    utm_medium: "paid",
    fbclid: "abc",
  });
  const direct = touchFromParams({ utm_source: "direct" });
  const s = applyVisit(applyVisit(null, paid), direct);
  assert.strictEqual(s.first_touch.fbclid, "abc");
  assert.strictEqual(s.last_touch.fbclid, "abc");
});

test("13. retention expiration", () => {
  const old = touchFromParams(
    { utm_source: "facebook", utm_medium: "paid", fbclid: "old" },
    { timestamp: "2020-01-01T00:00:00.000Z" }
  );
  const state = { version: 1, first_touch: old, last_touch: old };
  const neu = touchFromParams({
    utm_source: "google",
    utm_medium: "cpc",
  });
  const next = applyVisit(state, neu, {
    now: new Date("2026-09-06T00:00:00.000Z"),
    retentionDays: 30,
  });
  assert.strictEqual(next.first_touch.source, "google");
});

test("14. malformed timestamp", () => {
  const n = normalizeOrderAttribution({
    customAttributes: [
      {
        key: "_wa_attr",
        value: JSON.stringify({
          version: 1,
          first_touch: { source: "facebook", medium: "paid", timestamp: "nope" },
        }),
      },
    ],
  });
  assert.ok(n.warnings.includes("timestamp_invalid"));
});

test("15. unsupported version", () => {
  const n = normalizeOrderAttribution({
    customAttributes: [
      { key: "_wa_attr", value: JSON.stringify({ version: 99, first_touch: {} }) },
    ],
  });
  assert.ok(n.warnings.includes("unsupported_version"));
});

test("16. overly long values", () => {
  const s = sanitizeString("x".repeat(1000));
  assert.ok(s.length <= 240);
});

test("17. HTML-like input", () => {
  assert.ok(!sanitizeString("<script>alert(1)</script>evil").includes("<"));
});

test("18. spreadsheet formula input", () => {
  assert.strictEqual(sheetSafe("=1+1"), "'=1+1");
});

test("19. arbitrary params ignored", () => {
  const p = parseUrlParams("?utm_source=facebook&evil=1&email=a@b.com");
  assert.strictEqual(p.utm_source, "facebook");
  assert.ok(!p.evil && !p.email);
});

test("20-22. campaign/adset/ad IDs preserved", () => {
  const t = touchFromParams({
    utm_source: "facebook",
    utm_medium: "paid",
    utm_campaign: "120248947882640622",
    utm_content: "120249318064320622",
    utm_term: "120249318064350622",
  });
  assert.strictEqual(t.campaign_id, "120248947882640622");
  assert.strictEqual(t.ad_id, "120249318064320622");
  assert.strictEqual(t.adset_id, "120249318064350622");
});

test("23. no fuzzy name matching", () => {
  const m = matchMetaIds(
    { campaign_id: "1", ad_id: "2" },
    { campaigns: [{ entity_id: "9", entity_name: "Summer" }], ads: [] }
  );
  assert.strictEqual(m.campaign.matched, false);
});

test("24-27. confidence levels", () => {
  assert.strictEqual(
    confidenceFor(
      touchFromParams({ utm_source: "facebook", utm_medium: "paid", fbclid: "x", campaign_id: "1" }),
      "meta_first_party"
    ),
    "high"
  );
  assert.strictEqual(
    confidenceFor(
      touchFromParams({ utm_source: "facebook", utm_medium: "paid" }),
      "meta_first_party"
    ),
    "medium"
  );
  assert.strictEqual(confidenceFor(touchFromParams({}), "unattributed"), "none");
  assert.ok(["low", "medium"].includes(confidenceFor(touchFromParams({ utm_source: "ig", utm_medium: "social" }), "organic")));
});

test("28. attribution attributes extracted", () => {
  const w = extractWebhookAttribution({
    note_attributes: [
      {
        name: "_wa_attr",
        value: JSON.stringify({
          version: 1,
          first_touch: { source: "facebook", campaign_id: "1" },
          last_touch: { source: "facebook", ad_id: "2" },
        }),
      },
    ],
  });
  assert.strictEqual(w.first_source, "facebook");
  assert.strictEqual(w.first_campaign, "1");
});

test("29-30. missing/malformed payload safe", () => {
  assert.ok(extractWebhookAttribution({}).first_source === "");
  const n = normalizeOrderAttribution({
    customAttributes: [{ key: "_wa_attr", value: "{bad" }],
  });
  assert.ok(n.warnings.includes("malformed_attribution_payload"));
});

test("31. pre-capture order classification", () => {
  const n = normalizeOrderAttribution(
    { createdAt: "2026-08-01T00:00:00Z" },
    { capture_started_at: "2026-09-06" }
  );
  assert.strictEqual(n.phase, "pre_capture");
});

test("32. post-capture missing attribution", () => {
  const n = normalizeOrderAttribution(
    { createdAt: "2026-09-07T00:00:00Z", name: "#1" },
    { capture_started_at: "2026-09-06" }
  );
  assert.strictEqual(n.phase, "post_capture");
  assert.ok(n.warnings.includes("post_capture_order_missing_attribution"));
});

test("33-34. LIVE sheet mapping preserves keys", () => {
  const cols = liveSheetAttributionColumns({
    status: "meta_first_party",
    confidence: "high",
    phase: "post_capture",
    first_touch: { source: "facebook" },
    last_attributable_touch: { source: "facebook" },
    meta_evidence: { click_id: true },
    attribution_version: 1,
  });
  assert.ok(cols["Attribution Status"]);
  assert.ok(Object.keys(cols).length >= 8);
});

test("35-38. accounting unchanged markers", () => {
  // Structural: webhook extract does not expose revenue fields
  const w = extractWebhookAttribution({ note_attributes: [] });
  assert.ok(!("RevenueExTax" in w));
  assert.ok(!("Recognized" in w));
});

test("39-42. coverage calculation", () => {
  const diag = buildAttributionDiagnostics(
    [
      {
        name: "#1",
        createdAt: "2026-09-07T00:00:00Z",
        customerJourneySummary: {
          firstVisit: {
            utmParameters: { source: "facebook", medium: "paid" },
            occurredAt: "2026-09-07T00:00:00Z",
          },
        },
      },
      { name: "#2", createdAt: "2026-09-07T00:00:00Z" },
    ],
    { capture_started_at: "2026-09-06" }
  );
  assert.strictEqual(diag.post_capture_orders, 2);
  assert.ok(diag.attribution_coverage_pct != null);
  assert.ok(diag.status_counts.meta_first_party >= 1);
  assert.ok(diag.status_counts.unattributed >= 1);
});

test("43. confidence counts present", () => {
  const diag = buildAttributionDiagnostics([
    {
      name: "#1",
      customerJourneySummary: {
        firstVisit: {
          utmParameters: { source: "facebook", medium: "paid", campaign: "1" },
        },
      },
    },
  ]);
  assert.ok(diag.confidence_counts);
});

test("44-47. stable id match / unmatched", () => {
  const m = matchMetaIds(
    { campaign_id: "10", adset_id: "20", ad_id: "30" },
    {
      campaigns: [{ entity_id: "10" }],
      adsets: [{ entity_id: "20" }],
      ads: [{ entity_id: "99" }],
    }
  );
  assert.ok(m.campaign.matched);
  assert.ok(m.adset.matched);
  assert.ok(!m.ad.matched);
});

test("48-49. source distribution + first/last", () => {
  const n = normalizeOrderAttribution({
    customerJourneySummary: {
      firstVisit: {
        utmParameters: { source: "facebook", medium: "paid" },
        occurredAt: "2026-09-01T00:00:00Z",
      },
      lastVisit: {
        source: "direct",
        utmParameters: null,
        occurredAt: "2026-09-05T00:00:00Z",
      },
    },
  });
  assert.strictEqual(n.first_touch.source, "facebook");
  assert.strictEqual(n.last_attributable_touch.source, "facebook");
});

test("50. no attributed profit invented", () => {
  const diag = buildAttributionDiagnostics([]);
  assert.ok(!("attributed_profit" in diag));
});

test("51. dashboard experimental label", () => {
  const html = renderUnifiedDashboard({
    attribution: {
      capture_started_at: "2026-09-06",
      coverage_basis: "post_capture",
      attribution_coverage_pct: 40,
      shopify_orders: 10,
      post_capture_orders: 10,
      post_capture_usable: 4,
      usable_attribution: 4,
      status_counts: { meta_first_party: 4, unattributed: 6 },
      confidence_counts: { high: 1, medium: 3, low: 0, none: 6 },
      entity_ids: {},
      warnings: {},
      source_distribution: { facebook: 4 },
    },
    confidence: { attribution: "experimental" },
  });
  assert.ok(/FIRST-PARTY ATTRIBUTION — EXPERIMENTAL/.test(html));
  assert.ok(/view-attribution/.test(html));
});

test("52. Phase 4 email not cluttered", () => {
  const email = buildOwnerEmailContent({
    snapshot: {
      reporting_date: "2026-09-06",
      period: { days: 7 },
      business: { health_status: "strongly_profitable" },
      shopify: {},
      meta: {},
    },
    alertsResult: { alerts: [], attention_summary: { headline: "ok" } },
    previousAlerts: [],
    history: [],
    bundle: { recommendations: [] },
    dashboard_path: "x",
    days: 7,
    attribution: { attribution_coverage_pct: 42 },
  });
  assert.ok(/Attribution coverage still building: 42%/.test(email.text));
  assert.ok(!/fbclid/.test(email.text));
  assert.ok((email.text.match(/Attribution/g) || []).length <= 2);
});

test("cart payload parse", () => {
  const p = parseCartAttributePayload([
    { key: "_wa_attr", value: JSON.stringify({ version: 1, first_touch: { source: "x" } }) },
  ]);
  assert.strictEqual(p.first_touch.source, "x");
});

test("isAttributableTouch", () => {
  assert.ok(isAttributableTouch(touchFromParams({ utm_source: "facebook", utm_medium: "paid" })));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
