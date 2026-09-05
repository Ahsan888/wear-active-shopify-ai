/**
 * Campaign / ad (Meta-attributed) classifiers + baseline-relative funnel diagnostics.
 */
const { safeDiv } = require("../meta/metrics");
const { round2 } = require("../books/tax");
const {
  ENTITY_ZERO_PURCHASE,
  ENTITY_WITH_PURCHASES,
  FUNNEL,
} = require("./thresholds");

function buildAccountFunnelBaselines(account = {}) {
  const impressions = Number(account.impressions || 0);
  const clicks = Number(account.clicks || 0);
  const linkClicks = Number(
    account.inline_link_clicks != null
      ? account.inline_link_clicks
      : clicks
  );
  const lpv = Number(account.landing_page_views || 0);
  const atc = Number(account.add_to_carts || 0);
  const ic = Number(account.initiated_checkouts || 0);
  const purchases = Number(account.purchases || 0);

  return {
    ctr: account.ctr != null ? Number(account.ctr) : pct(clicks, impressions),
    click_to_lpv_pct: pct(lpv, linkClicks),
    lpv_to_atc_pct:
      account.lpv_to_atc_pct != null
        ? Number(account.lpv_to_atc_pct)
        : pct(atc, lpv),
    atc_to_checkout_pct:
      account.atc_to_checkout_pct != null
        ? Number(account.atc_to_checkout_pct)
        : pct(ic, atc),
    checkout_to_purchase_pct:
      account.checkout_to_purchase_pct != null
        ? Number(account.checkout_to_purchase_pct)
        : pct(purchases, ic),
  };
}

function pct(num, den) {
  const r = safeDiv(num, den);
  return r == null ? null : r * 100;
}

function entityFunnelRates(row = {}) {
  const impressions = Number(row.impressions || 0);
  const clicks = Number(row.clicks || 0);
  const linkClicks = Number(
    row.inline_link_clicks != null ? row.inline_link_clicks : clicks
  );
  const lpv = Number(row.landing_page_views || 0);
  const atc = Number(row.add_to_carts || 0);
  const ic = Number(row.initiated_checkouts || 0);
  const purchases = Number(row.purchases || 0);
  return {
    impressions,
    clicks,
    inline_link_clicks: linkClicks,
    landing_page_views: lpv,
    add_to_carts: atc,
    initiated_checkouts: ic,
    purchases,
    ctr: row.ctr != null ? Number(row.ctr) : pct(clicks, impressions),
    click_to_lpv_pct: pct(lpv, linkClicks),
    lpv_to_atc_pct:
      row.lpv_to_atc_pct != null ? Number(row.lpv_to_atc_pct) : pct(atc, lpv),
    atc_to_checkout_pct:
      row.atc_to_checkout_pct != null
        ? Number(row.atc_to_checkout_pct)
        : pct(ic, atc),
    checkout_to_purchase_pct:
      row.checkout_to_purchase_pct != null
        ? Number(row.checkout_to_purchase_pct)
        : pct(purchases, ic),
  };
}

/**
 * Baseline-relative funnel diagnostics. Volume gates prevent noisy labels.
 *
 * has_funnel_warning: any weak stage that cleared its min volume gate
 * primary_weak_funnel: ≥2 weak stages OR one weak stage at ≥2× its min gate
 * has_material_weak_funnel: alias for has_funnel_warning (blocks scale)
 */
function diagnoseFunnel(entityRow, accountBaselines) {
  const diagnostics = [];
  const rates = entityFunnelRates(entityRow);
  const acc = accountBaselines || {};

  function maybeWeak(code, entityRate, accountRate, volume, minGate) {
    if (!(volume >= minGate)) return;
    if (entityRate == null || accountRate == null || !(accountRate > 0)) return;
    if (entityRate < FUNNEL.WEAK_RELATIVE_LT * accountRate) {
      diagnostics.push({
        code,
        entity_rate: entityRate,
        account_rate: accountRate,
        relative: round2(entityRate / accountRate),
        volume,
        min_gate: minGate,
        primary_volume_gate: minGate * FUNNEL.PRIMARY_VOLUME_MULTIPLIER,
        meets_primary_volume:
          volume >= minGate * FUNNEL.PRIMARY_VOLUME_MULTIPLIER,
      });
    }
  }

  maybeWeak(
    "creative_click_weak",
    rates.ctr,
    acc.ctr,
    rates.impressions,
    FUNNEL.CTR_MIN_IMPRESSIONS
  );
  maybeWeak(
    "landing_page_weak",
    rates.click_to_lpv_pct,
    acc.click_to_lpv_pct,
    rates.inline_link_clicks,
    FUNNEL.CLICK_LPV_MIN_LINK_CLICKS
  );
  maybeWeak(
    "offer_atc_weak",
    rates.lpv_to_atc_pct,
    acc.lpv_to_atc_pct,
    rates.landing_page_views,
    FUNNEL.LPV_ATC_MIN_LPV
  );
  maybeWeak(
    "checkout_start_weak",
    rates.atc_to_checkout_pct,
    acc.atc_to_checkout_pct,
    rates.add_to_carts,
    FUNNEL.ATC_IC_MIN_ATC
  );
  maybeWeak(
    "purchase_completion_weak",
    rates.checkout_to_purchase_pct,
    acc.checkout_to_purchase_pct,
    rates.initiated_checkouts,
    FUNNEL.IC_PURCH_MIN_IC
  );

  const has_funnel_warning = diagnostics.length > 0;
  const primary_weak_funnel =
    diagnostics.length >= 2 ||
    diagnostics.some((d) => d.meets_primary_volume);

  return {
    rates,
    diagnostics,
    has_funnel_warning,
    primary_weak_funnel,
    // Any funnel warning blocks scale (conservative)
    has_material_weak_funnel: has_funnel_warning,
  };
}

/**
 * Classify one Meta campaign or ad row against account Meta baselines.
 */
function classifyMetaEntity(row, accountMeta, options = {}) {
  const entity_type = options.entity_type || "ad";
  const spend = Number(row.spend || 0);
  const purchases = Number(row.purchases || 0);
  const entityCpa = row.cpa == null ? null : Number(row.cpa);
  const entityRoas = row.roas == null ? null : Number(row.roas);
  const accountCpa =
    accountMeta?.cpa == null || !(Number(accountMeta.cpa) > 0)
      ? null
      : Number(accountMeta.cpa);
  const accountRoas =
    accountMeta?.roas == null || !(Number(accountMeta.roas) > 0)
      ? null
      : Number(accountMeta.roas);

  const funnel = diagnoseFunnel(
    row,
    options.account_funnel_baselines || buildAccountFunnelBaselines(accountMeta)
  );

  const id =
    entity_type === "campaign"
      ? row.campaign_id
      : entity_type === "adset"
        ? row.adset_id
        : row.ad_id;
  const name =
    entity_type === "campaign"
      ? row.campaign_name
      : entity_type === "adset"
        ? row.adset_name
        : row.ad_name;

  const base = {
    entity_type,
    entity_id: id || null,
    entity_name: name || null,
    spend: round2(spend),
    purchases,
    meta_attributed_cpa: entityCpa,
    meta_attributed_roas: entityRoas,
    spend_vs_account_cpa:
      accountCpa != null && accountCpa > 0
        ? round2(spend / accountCpa)
        : null,
    entity_cpa_vs_account_ratio:
      entityCpa != null && accountCpa != null && accountCpa > 0
        ? round2(entityCpa / accountCpa)
        : null,
    entity_roas_vs_account_ratio:
      entityRoas != null && accountRoas != null && accountRoas > 0
        ? round2(entityRoas / accountRoas)
        : null,
    funnel_diagnostics: funnel.diagnostics,
    has_funnel_warning: funnel.has_funnel_warning,
    primary_weak_funnel: funnel.primary_weak_funnel,
    attribution_note: "meta_attributed_only",
  };

  if (accountCpa == null) {
    return {
      ...base,
      status: "insufficient_data",
      reason_code: "account_meta_cpa_unavailable",
      reason: "Account Meta CPA unavailable — cannot score entity evidence",
      scale_eligible: false,
    };
  }

  // Zero-purchase path
  if (!(purchases > 0)) {
    const sx = spend / accountCpa;
    let status;
    let reason_code;
    if (sx < ENTITY_ZERO_PURCHASE.INSUFFICIENT_LT) {
      status = "insufficient_data";
      reason_code = "zero_purchase_low_spend";
    } else if (sx < ENTITY_ZERO_PURCHASE.WATCH_LT) {
      status = "watch";
      reason_code = "zero_purchase_watch_spend";
    } else if (sx < ENTITY_ZERO_PURCHASE.SPEND_NO_PURCHASE_LT) {
      status = "spend_no_purchase";
      reason_code = "zero_purchase_meaningful_spend";
    } else {
      status = "high_priority_spend_no_purchase";
      reason_code = "zero_purchase_high_spend";
    }
    return {
      ...base,
      status,
      reason_code,
      reason: `Zero Meta purchases with spend ${round2(sx)}× account Meta CPA`,
      scale_eligible: false,
    };
  }

  // With purchases
  const cpaRatio = entityCpa != null && accountCpa > 0 ? entityCpa / accountCpa : null;
  const roasRatio =
    entityRoas != null && accountRoas != null && accountRoas > 0
      ? entityRoas / accountRoas
      : null;

  let status = "healthy";
  let reason_code = "cpa_at_or_below_account";

  if (cpaRatio != null && cpaRatio > ENTITY_WITH_PURCHASES.HIGH_CPA_GT) {
    status = "high_cpa";
    reason_code = "entity_cpa_above_account";
  } else if (
    cpaRatio != null &&
    cpaRatio > ENTITY_WITH_PURCHASES.RELATIVELY_WEAK_CPA_GT
  ) {
    status = "relatively_weak_cpa";
    reason_code = "entity_cpa_slightly_above_account";
  } else if (funnel.primary_weak_funnel) {
    // Primary status only with escalated funnel evidence
    status = "weak_funnel";
    reason_code = "material_funnel_weakness";
  } else if (
    cpaRatio != null &&
    cpaRatio <= ENTITY_WITH_PURCHASES.STRONG_CPA_LTE &&
    purchases >= ENTITY_WITH_PURCHASES.STRONG_MIN_PURCHASES
  ) {
    status = "strong";
    reason_code = "entity_cpa_strong_vs_account";
  } else if (cpaRatio != null && cpaRatio <= 1) {
    status = "healthy";
    reason_code = "cpa_at_or_below_account";
  }

  // Scale candidate — any funnel warning blocks scale (conservative)
  const scaleChecks = {
    purchases_ok: purchases >= ENTITY_WITH_PURCHASES.SCALE_MIN_PURCHASES,
    spend_ok:
      spend >=
      ENTITY_WITH_PURCHASES.SCALE_MIN_SPEND_X_ACCOUNT_CPA * accountCpa,
    cpa_ok:
      entityCpa != null &&
      entityCpa <=
        ENTITY_WITH_PURCHASES.SCALE_MAX_CPA_X_ACCOUNT * accountCpa,
    roas_ok:
      roasRatio != null &&
      roasRatio >= ENTITY_WITH_PURCHASES.SCALE_MIN_ROAS_X_ACCOUNT,
    funnel_ok: !funnel.has_funnel_warning,
    business_health_ok: options.business_health_ok === true,
    business_ads_ok: options.business_ads_ok === true,
    confidence_ok: options.confidence_ok === true,
    accounting_ok: options.accounting_scale_ok !== false,
  };

  const scale_eligible = Object.values(scaleChecks).every(Boolean);
  if (scale_eligible) {
    status = "scale_candidate";
    reason_code = "controlled_scale_candidate";
  }

  return {
    ...base,
    status,
    reason_code,
    reason:
      status === "scale_candidate"
        ? "Meets Meta efficiency + business safety gates for controlled budget increase review"
        : `Meta entity status ${status} (CPA ratio ${
            cpaRatio == null ? "—" : round2(cpaRatio)
          }× account)`,
    scale_eligible,
    scale_checks: scaleChecks,
    roas_confirmation_ratio: roasRatio == null ? null : round2(roasRatio),
  };
}

function classifyMetaEntities(rows, accountMeta, options = {}) {
  const baselines =
    options.account_funnel_baselines ||
    buildAccountFunnelBaselines(accountMeta);
  return (rows || [])
    .map((row) =>
      classifyMetaEntity(row, accountMeta, {
        ...options,
        account_funnel_baselines: baselines,
      })
    )
    .sort((a, b) => (b.spend || 0) - (a.spend || 0));
}

module.exports = {
  buildAccountFunnelBaselines,
  diagnoseFunnel,
  classifyMetaEntity,
  classifyMetaEntities,
  entityFunnelRates,
};
