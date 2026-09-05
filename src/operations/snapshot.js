/**
 * Compact daily KPI snapshot — consumes unified reporting bundle fields only.
 * Does not recompute accounting / decision classifiers.
 */
const SCHEMA_VERSION = 1;

function numOrNull(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function countBy(list, pred) {
  return (list || []).filter(pred).length;
}

function buildSnapshotFromBundle(bundle, {
  reporting_date,
  period,
  timezone = "Asia/Karachi",
  generated_at = new Date().toISOString(),
} = {}) {
  if (!bundle || typeof bundle !== "object") {
    throw new Error("buildSnapshotFromBundle requires a reporting bundle");
  }
  if (!reporting_date) throw new Error("reporting_date is required");
  if (!period?.since || !period?.until || !period?.days) {
    throw new Error("period.{since,until,days} is required");
  }

  const books = bundle.books || {};
  const p = bundle.profitability || {};
  const bas = bundle.business_advertising_safety || {};
  const sc = bundle.shopify_context || {};
  const metaTotals = bundle.meta?.totals || {};
  const fb = bundle.meta?.funnel_baselines || {};
  const conc = bundle.revenue_concentration || {};
  const mix = bundle.sales_mix || {};
  const sbc = bundle.sales_by_channel || mix.sales_by_channel || {};
  const recon = bundle.data_quality?.ad_reconciliation || {};
  const conf = bundle.confidence || {};
  const recs = bundle.recommendations || [];
  const ads = bundle.ads || [];
  const products = bundle.products || [];

  const current_day_incomplete = Boolean(
    period.until && reporting_date && period.until === reporting_date
  );

  const snapshot = {
    schema_version: SCHEMA_VERSION,
    snapshot_key: `${reporting_date}:${Number(period.days)}`,
    generated_at,
    reporting_date,
    timezone,
    period: {
      since: period.since,
      until: period.until,
      days: Number(period.days),
      current_day_incomplete,
    },
    business: {
      health_status: bundle.business_health?.status || null,
      net_revenue_ex_tax: numOrNull(books.net_revenue_ex_tax),
      gross_profit: numOrNull(books.gross_profit),
      gross_margin_pct: numOrNull(books.gross_margin_pct),
      books_net_profit: numOrNull(books.books_net_profit),
      books_net_margin_pct: numOrNull(books.books_net_margin_pct),
      meta_adjusted_profit: numOrNull(p.meta_adjusted_profit),
      meta_adjusted_margin_pct: numOrNull(p.meta_adjusted_margin_pct),
      recognized_orders: numOrNull(books.recognized_orders),
      recognized_units: numOrNull(books.recognized_units),
      aov: numOrNull(books.aov_ex_tax),
    },
    advertising_affordability: {
      status: bas.status || null,
      meta_spend: numOrNull(bas.meta_spend ?? metaTotals.spend),
      business_ad_load_per_order: numOrNull(
        bas.business_wide_ad_load_per_recognized_order ??
          bas.blended_ad_cost_per_recognized_order
      ),
      break_even_cpa: numOrNull(bas.break_even_cpa),
      headroom: numOrNull(bas.business_cpa_headroom),
      headroom_pct: numOrNull(bas.business_cpa_headroom_pct),
      ad_spend_utilization_pct: numOrNull(bas.ad_spend_utilization_pct),
    },
    shopify: {
      orders: numOrNull(sc.recognized_orders),
      units: numOrNull(sc.recognized_units),
      gross_revenue: numOrNull(sc.revenue_ex_tax),
      refunds: numOrNull(sc.refunds),
      net_revenue: numOrNull(sc.net_revenue_ex_tax),
      cogs: numOrNull(sc.cogs),
      gross_profit_before_ads: numOrNull(sc.gross_profit_before_ads),
      gross_margin_pct: numOrNull(sc.gross_margin_before_ads_pct),
      meta_spend: numOrNull(sc.meta_spend ?? metaTotals.spend),
      ad_load_per_order: numOrNull(
        sc.ad_load_per_recognized_order ?? sc.shopify_ad_load_per_recognized_order
      ),
      contribution_after_meta: numOrNull(sc.contribution_after_meta),
      contribution_margin_pct: numOrNull(sc.contribution_margin_after_meta_pct),
      contribution_status: sc.contribution_status || null,
    },
    meta: {
      spend: numOrNull(metaTotals.spend),
      impressions: numOrNull(metaTotals.impressions),
      link_clicks: numOrNull(metaTotals.inline_link_clicks ?? metaTotals.clicks),
      landing_page_views: numOrNull(metaTotals.landing_page_views),
      add_to_carts: numOrNull(metaTotals.add_to_carts),
      initiated_checkouts: numOrNull(metaTotals.initiated_checkouts),
      purchases: numOrNull(metaTotals.purchases),
      purchase_value: numOrNull(metaTotals.purchase_value),
      cpa: numOrNull(metaTotals.cpa),
      roas: numOrNull(metaTotals.roas),
      ctr: numOrNull(metaTotals.ctr ?? fb.ctr),
      lpv_to_atc_pct: numOrNull(
        metaTotals.lpv_to_atc_pct ?? fb.lpv_to_atc_pct
      ),
      atc_to_checkout_pct: numOrNull(
        metaTotals.atc_to_checkout_pct ?? fb.atc_to_checkout_pct
      ),
      checkout_to_purchase_pct: numOrNull(
        metaTotals.checkout_to_purchase_pct ?? fb.checkout_to_purchase_pct
      ),
    },
    sales_mix: {
      shopify_net_revenue: numOrNull(sbc.Shopify?.net_revenue_ex_tax),
      manual_net_revenue: numOrNull(sbc.Manual?.net_revenue_ex_tax),
      other_sales_net_revenue: numOrNull(
        sbc["Other Sales"]?.net_revenue_ex_tax
      ),
      dominant_channel: conc.dominant_channel || null,
      dominant_channel_share_pct: numOrNull(
        conc.dominant_channel_revenue_share_pct
      ),
      non_shopify_distortion_risk: Boolean(conc.non_shopify_distortion_risk),
    },
    accounting: {
      ledger_ads_expense: numOrNull(recon.ledger_ads_expense),
      recurring_ads_expense: numOrNull(recon.recurring_ads_expense),
      meta_vs_ledger_variance: numOrNull(recon.meta_vs_ledger_variance),
      reconciliation_status: recon.ad_spend_reconciliation_status || null,
      gift_cogs: numOrNull(books.gift_cogs),
      is_full_calendar_month: Boolean(recon.is_full_calendar_month),
    },
    decisions: {
      high_priority_count: countBy(
        recs,
        (r) => r.priority === "high" || r.priority === "critical"
      ),
      medium_priority_count: countBy(recs, (r) => r.priority === "medium"),
      low_priority_count: countBy(recs, (r) => r.priority === "low"),
      scale_candidate_count: countBy(
        [...ads, ...(bundle.campaigns || [])],
        (e) => e.status === "scale_candidate"
      ),
      ads_needing_attention_count: countBy(ads, (a) =>
        [
          "high_priority_spend_no_purchase",
          "spend_no_purchase",
          "high_cpa",
          "weak_funnel",
          "relatively_weak_cpa",
        ].includes(a.status)
      ),
      product_data_issue_count: countBy(
        products,
        (p) => p.status === "data_issue"
      ),
    },
    confidence: {
      business: conf.business || null,
      advertising: conf.advertising || null,
      entities: conf.entities || null,
      products: conf.products || null,
      attribution: conf.attribution || "unavailable",
    },
  };

  validateSnapshot(snapshot);
  return snapshot;
}

function validateSnapshot(snap) {
  if (!snap || typeof snap !== "object") {
    throw new Error("Invalid snapshot: not an object");
  }
  if (snap.schema_version !== SCHEMA_VERSION) {
    throw new Error(
      `Unsupported snapshot schema_version=${snap.schema_version}`
    );
  }
  if (!snap.reporting_date || !/^\d{4}-\d{2}-\d{2}$/.test(snap.reporting_date)) {
    throw new Error("Invalid snapshot reporting_date");
  }
  if (!snap.period || !snap.period.since || !snap.period.until || !snap.period.days) {
    throw new Error("Invalid snapshot period");
  }
  if (!snap.snapshot_key) {
    throw new Error("Invalid snapshot: missing snapshot_key");
  }
  for (const key of [
    "business",
    "advertising_affordability",
    "shopify",
    "meta",
    "sales_mix",
    "accounting",
    "decisions",
    "confidence",
  ]) {
    if (!snap[key] || typeof snap[key] !== "object") {
      throw new Error(`Invalid snapshot: missing ${key}`);
    }
  }
  return true;
}

module.exports = {
  SCHEMA_VERSION,
  buildSnapshotFromBundle,
  validateSnapshot,
};
