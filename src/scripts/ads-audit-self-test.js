#!/usr/bin/env node
/**
 * Unit tests for Meta ads deep audit (no network / no mutations).
 * Usage: npm run ads:audit:test
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const {
  enrichAuditInsightRow,
  extractVideoMetrics,
  firstActionListValue,
} = require("../ads-audit/enrich");
const { buildFunnel, explainFunnel } = require("../ads-audit/funnel");
const { diagnoseAd, DIAGNOSES } = require("../ads-audit/diagnose");
const {
  normalizeCreative,
  buildCreativeEvidence,
  groupByCreative,
} = require("../ads-audit/creative");
const { summarizeTargeting } = require("../ads-audit/targeting");
const {
  compareIndependentSnapshots,
  indexAdsById,
} = require("../ads-audit/compare");
const { joinAds, findDuplicateNames } = require("../ads-audit/build");
const { renderAdsAuditHtml } = require("../ads-audit/html");
const fetchMod = require("../ads-audit/fetch");

function actions(...pairs) {
  return pairs.map(([action_type, value]) => ({ action_type, value }));
}

function test(name, fn) {
  try {
    fn();
    console.log(`ok  ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}`);
    console.error(err.stack || err.message || err);
    process.exitCode = 1;
  }
}

test("action metric extraction preserves purchase provenance", () => {
  const row = enrichAuditInsightRow({
    spend: "1000",
    impressions: "10000",
    clicks: "200",
    inline_link_clicks: "150",
    actions: actions(
      ["purchase", 3],
      ["omni_purchase", 3],
      ["landing_page_view", 80],
      ["add_to_cart", 12],
      ["initiate_checkout", 5]
    ),
    action_values: actions(["purchase", 9000]),
    cost_per_action_type: actions(
      ["purchase", 333.33],
      ["landing_page_view", 12.5]
    ),
  });
  assert.strictEqual(row.purchases, 3);
  assert.strictEqual(row.purchase_action_type, "purchase");
  assert.strictEqual(row.landing_page_views, 80);
  assert.strictEqual(row.add_to_carts, 12);
  assert.strictEqual(row.initiated_checkouts, 5);
  assert.strictEqual(row.cost_per_landing_page_view_source, "cost_per_action_type");
  assert.strictEqual(row.cost_per_landing_page_view_action_type, "landing_page_view");
});

test("video metric extraction from dedicated fields", () => {
  const video = extractVideoMetrics({
    video_play_actions: actions(["video_view", 500]),
    video_thruplay_watched_actions: actions(["video_view", 40]),
    video_continuous_2_sec_watched_actions: actions(["video_view", 200]),
    video_p25_watched_actions: actions(["video_view", 120]),
    video_p50_watched_actions: actions(["video_view", 80]),
    video_p75_watched_actions: actions(["video_view", 50]),
    video_p95_watched_actions: actions(["video_view", 30]),
    video_p100_watched_actions: actions(["video_view", 20]),
    video_avg_time_watched_actions: [{ value: 7.5 }],
  });
  assert.strictEqual(video.plays, 500);
  assert.strictEqual(video.thruplays, 40);
  assert.strictEqual(video.three_sec_plays, 200);
  assert.strictEqual(video.p25, 120);
  assert.strictEqual(video.p100, 20);
  assert.strictEqual(video.avg_watch_time_sec, 7.5);
});

test("video metrics null when unavailable — no fabrication", () => {
  const video = extractVideoMetrics({ spend: "10", impressions: "100" });
  assert.strictEqual(video.plays, null);
  assert.strictEqual(video.thruplays, null);
  assert.strictEqual(video.p25, null);
  assert.strictEqual(video.avg_watch_time_sec, null);
});

test("outbound clicks from action array", () => {
  const row = enrichAuditInsightRow({
    impressions: "1000",
    outbound_clicks: actions(["outbound_click", 42]),
  });
  assert.strictEqual(row.outbound_clicks, 42);
  assert.strictEqual(row.outbound_clicks_action_type, "outbound_click");
});

test("null handling on empty insight row", () => {
  const row = enrichAuditInsightRow({});
  assert.strictEqual(row.spend, 0);
  assert.strictEqual(row.ctr, null);
  assert.strictEqual(row.cpc, null);
  assert.strictEqual(row.roas, null);
  assert.strictEqual(row.outbound_clicks, null);
  assert.strictEqual(row.video.plays, null);
});

test("zero denominator funnel rates return null", () => {
  const funnel = buildFunnel({
    impressions: 0,
    inline_link_clicks: 0,
    landing_page_views: 0,
    add_to_carts: 0,
    initiated_checkouts: 0,
    purchases: 0,
  });
  assert.strictEqual(funnel.rates.impression_to_link_click_pct, null);
  assert.strictEqual(funnel.rates.link_click_to_lpv_pct, null);
  assert.strictEqual(funnel.rates.lpv_to_atc_pct, null);
  assert.strictEqual(funnel.rates.checkout_to_purchase_pct, null);
});

test("funnel calculations with valid denominators", () => {
  const funnel = buildFunnel({
    impressions: 10000,
    inline_link_clicks: 200,
    landing_page_views: 100,
    add_to_carts: 20,
    initiated_checkouts: 10,
    purchases: 5,
  });
  assert.strictEqual(funnel.rates.impression_to_link_click_pct, 2);
  assert.strictEqual(funnel.rates.link_click_to_lpv_pct, 50);
  assert.strictEqual(funnel.rates.lpv_to_atc_pct, 20);
  assert.strictEqual(funnel.rates.atc_to_checkout_pct, 50);
  assert.strictEqual(funnel.rates.checkout_to_purchase_pct, 50);
  assert.strictEqual(funnel.rates.lpv_to_purchase_pct, 5);
  assert.ok(funnel.attribution_note.includes("Meta-reported"));
});

test("exact ID hierarchy join does not infer from names", () => {
  const structure = {
    campaigns: [
      { campaign_id: "c1", name: "Camp A" },
      { campaign_id: "c2", name: "Camp B" },
    ],
    adsets: [
      { adset_id: "s1", campaign_id: "c1", name: "Set A" },
      { adset_id: "s2", campaign_id: "c2", name: "Set B" },
    ],
    adsCatalog: [
      {
        ad_id: "a1",
        ad_name: "Same Name",
        campaign_id: "c1",
        adset_id: "s1",
        status: "ACTIVE",
        effective_status: "ACTIVE",
        creative_id: "cr1",
        creative: normalizeCreative({ id: "cr1", title: "H1" }),
      },
      {
        ad_id: "a2",
        ad_name: "Same Name",
        campaign_id: "c2",
        adset_id: "s2",
        status: "ACTIVE",
        effective_status: "ACTIVE",
        creative_id: "cr2",
        creative: normalizeCreative({ id: "cr2", title: "H2" }),
      },
    ],
  };
  const insights = [
    {
      ad_id: "a1",
      ad_name: "Same Name",
      campaign_id: "c1",
      adset_id: "s1",
      spend: 100,
      purchases: 1,
    },
    {
      ad_id: "a2",
      ad_name: "Same Name",
      campaign_id: "c2",
      adset_id: "s2",
      spend: 200,
      purchases: 0,
    },
  ];
  const joined = joinAds(structure, insights);
  assert.strictEqual(joined.length, 2);
  const a1 = joined.find((x) => x.ad_id === "a1");
  const a2 = joined.find((x) => x.ad_id === "a2");
  assert.strictEqual(a1.campaign_name, "Camp A");
  assert.strictEqual(a2.campaign_name, "Camp B");
  assert.strictEqual(a1.adset_name, "Set A");
  assert.strictEqual(a2.adset_name, "Set B");
  assert.notStrictEqual(a1.ad_id, a2.ad_id);
});

test("duplicate ad names remain separate", () => {
  const dupes = findDuplicateNames([
    { ad_id: "1", ad_name: "Dup" },
    { ad_id: "2", ad_name: "Dup" },
    { ad_id: "3", ad_name: "Unique" },
  ]);
  assert.strictEqual(dupes.length, 1);
  assert.strictEqual(dupes[0].count, 2);
  assert.deepStrictEqual(dupes[0].ad_ids, ["1", "2"]);
});

test("independent period comparison does not treat overlap as independence", () => {
  const recent = { spend: 5000, impressions: 20000, purchases: 4, cpa: 1250, ctr: 1.2 };
  const previous = { spend: 5000, impressions: 20000, purchases: 8, cpa: 625, ctr: 1.5 };
  const cmp = compareIndependentSnapshots(recent, previous, { metric: "cpa" });
  assert.strictEqual(cmp.sufficient, true);
  assert.strictEqual(cmp.direction, "declining"); // CPA rose
  assert.ok(cmp.note.includes("Independent"));
});

test("independent comparison insufficient when volume low", () => {
  const cmp = compareIndependentSnapshots(
    { spend: 10, impressions: 50, purchases: 0, ctr: 2 },
    { spend: 10, impressions: 50, purchases: 0, ctr: 1 },
    { metric: "ctr" }
  );
  assert.strictEqual(cmp.sufficient, false);
  assert.strictEqual(cmp.direction, "insufficient");
});

test("diagnosis ZERO_PURCHASE_SPEND with relative evidence", () => {
  const account = {
    spend: 50000,
    purchases: 20,
    cpa: 2500,
    ctr: 1.5,
    cpm: 400,
    impressions: 100000,
    landing_page_views: 2000,
    add_to_carts: 200,
    initiated_checkouts: 80,
    inline_link_clicks: 3000,
  };
  const ad = {
    ad_id: "x",
    spend: 4000, // 1.6× account CPA
    purchases: 0,
    impressions: 8000,
    ctr: 1.4,
    cpm: 500,
    inline_link_clicks: 100,
    landing_page_views: 80,
    add_to_carts: 5,
    initiated_checkouts: 1,
  };
  const d = diagnoseAd(ad, account);
  assert.strictEqual(d.primary_diagnosis, "ZERO_PURCHASE_SPEND");
  assert.ok(DIAGNOSES.includes(d.primary_diagnosis));
  assert.ok(d.attribution_note.includes("Books break-even"));
});

test("diagnosis INSUFFICIENT_DATA for tiny spend", () => {
  const account = { cpa: 2500, ctr: 1.5, cpm: 400, impressions: 100000 };
  const ad = {
    ad_id: "y",
    spend: 100, // << 0.25 × CPA
    purchases: 0,
    impressions: 200,
    ctr: 0.5,
  };
  const d = diagnoseAd(ad, account);
  assert.strictEqual(d.primary_diagnosis, "INSUFFICIENT_DATA");
});

test("diagnosis STRONG_CREATIVE with relative CTR + CPA", () => {
  const account = {
    spend: 50000,
    purchases: 25,
    cpa: 2000,
    roas: 2,
    ctr: 1.0,
    cpm: 300,
    impressions: 200000,
    landing_page_views: 5000,
    add_to_carts: 500,
    initiated_checkouts: 200,
    inline_link_clicks: 8000,
    clicks: 8000,
  };
  const ad = {
    ad_id: "strong",
    spend: 8000,
    purchases: 8,
    purchase_value: 24000,
    cpa: 1000,
    roas: 3,
    impressions: 20000,
    clicks: 400,
    ctr: 2.0,
    link_ctr: 1.8,
    cpm: 280,
    inline_link_clicks: 350,
    landing_page_views: 280,
    add_to_carts: 40,
    initiated_checkouts: 20,
  };
  const d = diagnoseAd(ad, account);
  assert.strictEqual(d.primary_diagnosis, "STRONG_CREATIVE");
  assert.ok(["high", "medium"].includes(d.confidence));
});

test("missing creative fields recorded", () => {
  const c = normalizeCreative({ id: "99" });
  assert.strictEqual(c.creative_id, "99");
  assert.ok(c.missing_fields.includes("primary_text"));
  assert.ok(c.missing_fields.includes("headline"));
  assert.ok(c.missing_fields.includes("destination_url"));
});

test("creative evidence + group by creative id", () => {
  const ads = [
    {
      ad_id: "a1",
      ad_name: "Ad 1",
      spend: 100,
      purchases: 1,
      cpa: 100,
      roas: 2,
      creative: normalizeCreative({
        id: "cr1",
        body: "Hook",
        title: "Title",
        call_to_action_type: "SHOP_NOW",
        link_url: "https://example.com/p",
        image_url: "https://example.com/i.jpg",
      }),
    },
    {
      ad_id: "a2",
      ad_name: "Ad 2",
      spend: 200,
      purchases: 2,
      cpa: 100,
      roas: 2.5,
      creative: normalizeCreative({
        id: "cr1",
        body: "Hook",
        title: "Title",
        call_to_action_type: "SHOP_NOW",
        link_url: "https://example.com/p",
      }),
    },
  ];
  const evidence = ads.map((a) => buildCreativeEvidence(a, { primary_diagnosis: "HEALTHY", confidence: "medium" }));
  const groups = groupByCreative(evidence);
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].ad_count, 2);
  assert.strictEqual(groups[0].spend, 300);
  assert.strictEqual(groups[0].purchases, 3);
});

test("targeting summary beginner-friendly without guessing", () => {
  const s = summarizeTargeting({
    geo_locations: { countries: ["PK"] },
    age_min: 18,
    age_max: 34,
    genders: [1],
  });
  assert.ok(s.beginner_summary.includes("Pakistan") || s.beginner_summary.includes("PK"));
  assert.ok(s.beginner_summary.includes("Age 18–34"));
  assert.ok(s.beginner_summary.includes("Men"));
  assert.ok(s.beginner_summary.includes("Broad") || s.detailed_targeting.length === 0);
});

test("targeting missing object does not invent settings", () => {
  const s = summarizeTargeting(null);
  assert.strictEqual(s.available, false);
  assert.ok(s.beginner_summary.includes("not available"));
});

test("plain English funnel only when supported", () => {
  const weakLanding = explainFunnel(
    {
      impressions: 10000,
      link_clicks: 100,
      landing_page_views: 5,
      add_to_carts: 0,
      checkouts: 0,
      purchases: 0,
    },
    { link_click_to_lpv_pct: 5 }
  );
  assert.strictEqual(weakLanding.supported, true);
  assert.ok(weakLanding.text.includes("reaching the product page"));

  const unsupported = explainFunnel(
    {
      impressions: 10,
      link_clicks: 1,
      landing_page_views: 0,
      add_to_carts: 0,
      checkouts: 0,
      purchases: 0,
    },
    { link_click_to_lpv_pct: 0 }
  );
  assert.strictEqual(unsupported.supported, false);
});

test("HTML report contains required sections", () => {
  const html = renderAdsAuditHtml({
    generated_at: "2026-09-06T00:00:00.000Z",
    account: { id: "act_4074524202691358", name: "Wear Active", currency: "PKR" },
    date_range: { since: "2026-08-08", until: "2026-09-06", days: 30 },
    summary: {
      spend: 1000,
      purchases: 2,
      purchase_value: 5000,
      roas: 5,
      cpa: 500,
      ctr: 1.2,
      cpc: 20,
      landing_page_views: 50,
    },
    structure: { counts: { active_campaigns: 1, active_adsets: 1, active_ads: 1, campaigns: 1, adsets: 1, ads: 1 } },
    highlights: {
      what_is_working: [{ ad_id: "1", ad_name: "Good", spend: 100, purchases: 1, diagnosis: "HEALTHY" }],
      what_needs_attention: [],
      what_does_not_have_enough_data: [],
    },
    ad_table: [
      {
        ad_id: "1",
        ad_name: "Good",
        campaign_name: "C",
        adset_name: "S",
        status: "ACTIVE",
        spend: 100,
        impressions: 1000,
        ctr: 1,
        cpc: 10,
        lpv: 20,
        atc: 2,
        checkout: 1,
        purchases: 1,
        cpa: 100,
        roas: 2,
        diagnosis: "HEALTHY",
        confidence: "medium",
      },
    ],
    funnels: [],
    creative_groups: [],
    audiences: [],
    periods: { trailing_note: "overlap", trailing: {}, independent: {} },
    data_quality: { mutations: false },
    creative_formats_running: ["image"],
    placements_observed: ["Advantage+"],
  });
  assert.ok(html.includes("WEAR ACTIVE — META ADS AUDIT"));
  assert.ok(html.includes("What is working"));
  assert.ok(html.includes("What needs attention"));
  assert.ok(html.includes("What does not have enough data"));
  assert.ok(html.includes("Exact ad table"));
  assert.ok(html.includes("ID 1"));
  assert.ok(html.includes("Data quality"));
});

test("indexAdsById keeps exact ids", () => {
  const map = indexAdsById([
    { ad_id: "10", spend: 1 },
    { ad_id: 10, spend: 2 },
  ]);
  assert.strictEqual(map.get("10").spend, 2);
});

test("firstActionListValue ignores empty", () => {
  assert.strictEqual(firstActionListValue(null), null);
  assert.strictEqual(firstActionListValue([]), null);
  assert.deepStrictEqual(firstActionListValue([{ action_type: "x", value: "3" }]), {
    action_type: "x",
    value: 3,
  });
});

test("no Meta mutations — fetch module is GET-only surface", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "../ads-audit/fetch.js"),
    "utf8"
  );
  assert.ok(!/\bgraphPost\b/.test(src));
  assert.ok(!/\bmethod:\s*["']POST["']/.test(src));
  assert.ok(!/\bmethod:\s*["']DELETE["']/.test(src));
  assert.ok(src.includes("graphGet"));
  assert.ok(typeof fetchMod.fetchAuditStructure === "function");
  assert.ok(typeof fetchMod.emptyDataQuality === "function");
  const dq = fetchMod.emptyDataQuality();
  assert.strictEqual(dq.mutations, false);
});

test("client graphGet is GET-only (sanity)", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "../meta/client.js"),
    "utf8"
  );
  assert.ok(src.includes('method: "GET"'));
  assert.ok(!/method:\s*"POST"/.test(src));
});

if (!process.exitCode) {
  console.log("\nAll ads-audit self-tests passed.");
}
