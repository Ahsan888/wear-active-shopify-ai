/**
 * Advisory diagnosis per exact ad — relative to account / siblings / Phase 9 gates.
 * No hard-coded external internet benchmarks as facts.
 */
const {
  ENTITY_ZERO_PURCHASE,
  ENTITY_WITH_PURCHASES,
  FUNNEL,
} = require("../decisions/thresholds");
const { diagnoseFunnel, buildAccountFunnelBaselines } = require("../decisions/entities");
const { toNumber, safeDiv } = require("../meta/metrics");
const { buildFunnel } = require("./funnel");

const DIAGNOSES = [
  "INSUFFICIENT_DATA",
  "HEALTHY",
  "EXPENSIVE_DELIVERY",
  "WEAK_ATTENTION",
  "WEAK_CLICK_RESPONSE",
  "CLICK_TO_LANDING_PROBLEM",
  "WEAK_PRODUCT_PAGE_CONVERSION",
  "WEAK_CHECKOUT_CONVERSION",
  "HIGH_CPA",
  "ZERO_PURCHASE_SPEND",
  "CREATIVE_FATIGUE_SIGNAL",
  "STRONG_CREATIVE",
];

function confidenceFromEvidence(ad, diagnosis) {
  const spend = Number(ad.spend) || 0;
  const purchases = Number(ad.purchases) || 0;
  const impressions = Number(ad.impressions) || 0;
  if (diagnosis === "INSUFFICIENT_DATA") return "low";
  if (spend >= 15000 && (purchases >= 5 || impressions >= 20000)) return "high";
  if (spend >= 3000 || purchases >= 2 || impressions >= 5000) return "medium";
  return "low";
}

/**
 * @param {object} ad - enriched audit insight row (+ optional period_compare)
 * @param {object} account - account totals for primary window
 * @param {object} [opts]
 */
function diagnoseAd(ad, account = {}, opts = {}) {
  const spend = Number(ad.spend) || 0;
  const purchases = Number(ad.purchases) || 0;
  const impressions = Number(ad.impressions) || 0;
  const ctr = toNumber(ad.ctr);
  const linkCtr = toNumber(ad.link_ctr) ?? toNumber(ad.inline_link_click_ctr);
  const cpm = toNumber(ad.cpm);
  const frequency = toNumber(ad.frequency);
  const cpa = toNumber(ad.cpa);
  const roas = toNumber(ad.roas);

  const accountCpa = toNumber(account.cpa);
  const accountCtr = toNumber(account.ctr);
  const accountCpm = toNumber(account.cpm);
  const accountFreq = toNumber(account.frequency);
  const accountRoas = toNumber(account.roas);

  const evidence = [];
  const secondary = [];
  let primary = "INSUFFICIENT_DATA";

  const baselines =
    opts.account_funnel_baselines || buildAccountFunnelBaselines(account);
  const funnelDiag = diagnoseFunnel(ad, baselines);
  const funnel = buildFunnel(ad);

  const spendVsAccountCpa =
    accountCpa != null && accountCpa > 0 ? spend / accountCpa : null;

  // --- Evidence gates ---
  if (spend <= 0 && impressions <= 0) {
    return pack("INSUFFICIENT_DATA", ad, evidence, secondary, funnel, {
      note: "No delivery in this window.",
    });
  }

  if (
    accountCpa == null ||
    !(accountCpa > 0) ||
    (spendVsAccountCpa != null &&
      spendVsAccountCpa < ENTITY_ZERO_PURCHASE.INSUFFICIENT_LT &&
      purchases <= 0)
  ) {
    if (purchases <= 0 && (spendVsAccountCpa == null || spendVsAccountCpa < ENTITY_ZERO_PURCHASE.WATCH_LT)) {
      evidence.push({
        code: "low_spend_or_missing_account_cpa",
        spend_vs_account_cpa: spendVsAccountCpa,
      });
      return pack("INSUFFICIENT_DATA", ad, evidence, secondary, funnel, {
        note: "Not enough spend relative to account Meta CPA to diagnose.",
      });
    }
  }

  // Zero purchase with meaningful spend
  if (purchases <= 0 && spendVsAccountCpa != null) {
    if (spendVsAccountCpa >= ENTITY_ZERO_PURCHASE.WATCH_LT) {
      evidence.push({
        code: "zero_purchase_spend",
        spend_vs_account_cpa: round2(spendVsAccountCpa),
        threshold_note: "Phase 9 ENTITY_ZERO_PURCHASE relative to account Meta CPA",
      });
      primary = "ZERO_PURCHASE_SPEND";
    }
  }

  // Funnel stage mapping (Phase 9 relative weakness)
  const byCode = Object.fromEntries(
    (funnelDiag.diagnostics || []).map((d) => [d.code, d])
  );

  if (byCode.landing_page_weak) {
    secondary.push("CLICK_TO_LANDING_PROBLEM");
    evidence.push({ code: "landing_page_weak", ...byCode.landing_page_weak });
  }
  if (byCode.offer_atc_weak) {
    secondary.push("WEAK_PRODUCT_PAGE_CONVERSION");
    evidence.push({ code: "offer_atc_weak", ...byCode.offer_atc_weak });
  }
  if (byCode.checkout_start_weak || byCode.purchase_completion_weak) {
    secondary.push("WEAK_CHECKOUT_CONVERSION");
    evidence.push({
      code: byCode.purchase_completion_weak
        ? "purchase_completion_weak"
        : "checkout_start_weak",
      ...(byCode.purchase_completion_weak || byCode.checkout_start_weak),
    });
  }
  if (byCode.creative_click_weak) {
    secondary.push("WEAK_CLICK_RESPONSE");
    evidence.push({ code: "creative_click_weak", ...byCode.creative_click_weak });
  }

  // Expensive delivery: CPM >> account with volume
  if (
    cpm != null &&
    accountCpm != null &&
    accountCpm > 0 &&
    impressions >= FUNNEL.CTR_MIN_IMPRESSIONS &&
    cpm > accountCpm * 1.5
  ) {
    secondary.push("EXPENSIVE_DELIVERY");
    evidence.push({
      code: "cpm_above_account",
      entity_cpm: cpm,
      account_cpm: accountCpm,
      relative: round2(cpm / accountCpm),
    });
  }

  // Weak attention: very low link CTR or 3s video rate vs impressions
  const effectiveCtr = linkCtr != null ? linkCtr : ctr;
  if (
    effectiveCtr != null &&
    accountCtr != null &&
    accountCtr > 0 &&
    impressions >= FUNNEL.CTR_MIN_IMPRESSIONS &&
    effectiveCtr < accountCtr * FUNNEL.WEAK_RELATIVE_LT
  ) {
    secondary.push("WEAK_ATTENTION");
    evidence.push({
      code: "ctr_below_account",
      entity_ctr: effectiveCtr,
      account_ctr: accountCtr,
      relative: round2(effectiveCtr / accountCtr),
    });
  }

  // Creative fatigue: elevated frequency + declining independent CTR
  const fatigue = detectFatigue(ad, { accountFreq, accountCtr });
  if (fatigue) {
    secondary.push("CREATIVE_FATIGUE_SIGNAL");
    evidence.push(fatigue);
  }

  // High CPA
  if (
    purchases > 0 &&
    cpa != null &&
    accountCpa != null &&
    accountCpa > 0 &&
    cpa / accountCpa > ENTITY_WITH_PURCHASES.HIGH_CPA_GT
  ) {
    secondary.push("HIGH_CPA");
    evidence.push({
      code: "cpa_above_account",
      entity_cpa: cpa,
      account_cpa: accountCpa,
      relative: round2(cpa / accountCpa),
      note: "Meta-reported CPA only — not Books break-even CPA.",
    });
  }

  // Strong creative: strong CTR + healthy/strong CPA/ROAS
  const strongCtr =
    effectiveCtr != null &&
    accountCtr != null &&
    accountCtr > 0 &&
    impressions >= FUNNEL.CTR_MIN_IMPRESSIONS &&
    effectiveCtr >= accountCtr * 1.25;
  const strongEfficiency =
    purchases >= ENTITY_WITH_PURCHASES.STRONG_MIN_PURCHASES &&
    cpa != null &&
    accountCpa != null &&
    accountCpa > 0 &&
    cpa / accountCpa <= ENTITY_WITH_PURCHASES.STRONG_CPA_LTE &&
    (accountRoas == null ||
      roas == null ||
      roas >= accountRoas * ENTITY_WITH_PURCHASES.SCALE_MIN_ROAS_X_ACCOUNT * 0.9);

  if (strongCtr && strongEfficiency) {
    secondary.push("STRONG_CREATIVE");
    evidence.push({
      code: "strong_creative_relative",
      entity_ctr: effectiveCtr,
      account_ctr: accountCtr,
      entity_cpa: cpa,
      account_cpa: accountCpa,
    });
  }

  // Pick primary diagnosis (priority order)
  if (primary !== "ZERO_PURCHASE_SPEND") {
    if (secondary.includes("STRONG_CREATIVE") && !secondary.includes("HIGH_CPA")) {
      primary = "STRONG_CREATIVE";
    } else if (secondary.includes("ZERO_PURCHASE_SPEND")) {
      primary = "ZERO_PURCHASE_SPEND";
    } else if (
      secondary.includes("CLICK_TO_LANDING_PROBLEM") &&
      (byCode.landing_page_weak?.meets_primary_volume ||
        funnelDiag.primary_weak_funnel)
    ) {
      primary = "CLICK_TO_LANDING_PROBLEM";
    } else if (
      secondary.includes("WEAK_PRODUCT_PAGE_CONVERSION") &&
      (byCode.offer_atc_weak?.meets_primary_volume ||
        funnelDiag.primary_weak_funnel)
    ) {
      primary = "WEAK_PRODUCT_PAGE_CONVERSION";
    } else if (
      secondary.includes("WEAK_CHECKOUT_CONVERSION") &&
      funnelDiag.primary_weak_funnel
    ) {
      primary = "WEAK_CHECKOUT_CONVERSION";
    } else if (
      secondary.includes("WEAK_CLICK_RESPONSE") ||
      secondary.includes("WEAK_ATTENTION")
    ) {
      primary = secondary.includes("WEAK_CLICK_RESPONSE")
        ? "WEAK_CLICK_RESPONSE"
        : "WEAK_ATTENTION";
    } else if (secondary.includes("HIGH_CPA")) {
      primary = "HIGH_CPA";
    } else if (secondary.includes("EXPENSIVE_DELIVERY")) {
      primary = "EXPENSIVE_DELIVERY";
    } else if (secondary.includes("CREATIVE_FATIGUE_SIGNAL")) {
      primary = "CREATIVE_FATIGUE_SIGNAL";
    } else if (
      purchases > 0 &&
      (cpa == null ||
        accountCpa == null ||
        cpa / accountCpa <= ENTITY_WITH_PURCHASES.RELATIVELY_WEAK_CPA_GT)
    ) {
      primary = "HEALTHY";
      evidence.push({ code: "healthy_relative_to_account" });
    } else if (purchases > 0) {
      primary = "HEALTHY";
    } else if (spendVsAccountCpa != null && spendVsAccountCpa < ENTITY_ZERO_PURCHASE.WATCH_LT) {
      primary = "INSUFFICIENT_DATA";
    } else {
      primary = "INSUFFICIENT_DATA";
    }
  }

  // Prefer funnel explanation code when it matches and is supported
  if (
    funnel.explanation?.supported &&
    funnel.explanation.code &&
    DIAGNOSES.includes(funnel.explanation.code) &&
    primary === "HEALTHY" &&
    funnelDiag.has_funnel_warning
  ) {
    // keep HEALTHY unless primary_weak_funnel
    if (funnelDiag.primary_weak_funnel) {
      primary = funnel.explanation.code;
    }
  }

  return pack(primary, ad, evidence, [...new Set(secondary)], funnel, {
    funnel_diagnostics: funnelDiag.diagnostics,
    has_funnel_warning: funnelDiag.has_funnel_warning,
  });
}

function detectFatigue(ad, { accountFreq, accountCtr }) {
  const frequency = toNumber(ad.frequency);
  const ctr = toNumber(ad.link_ctr) ?? toNumber(ad.ctr);
  const compare = ad.period_compare || ad.independent_compare || null;

  const highFreq =
    frequency != null &&
    accountFreq != null &&
    accountFreq > 0 &&
    frequency >= accountFreq * 1.4 &&
    frequency >= 2.5;

  const decliningCtr =
    compare?.direction === "declining" &&
    compare?.metric === "ctr" &&
    compare?.sufficient === true;

  if (highFreq && (decliningCtr || (ctr != null && accountCtr != null && ctr < accountCtr * 0.85))) {
    return {
      code: "creative_fatigue_signal",
      frequency,
      account_frequency: accountFreq,
      declining_ctr: Boolean(decliningCtr),
      note: "Relative frequency elevation vs account; not a guaranteed fatigue proof.",
    };
  }
  return null;
}

function pack(primary, ad, evidence, secondary, funnel, extra = {}) {
  return {
    ad_id: ad.ad_id || null,
    primary_diagnosis: primary,
    secondary_diagnoses: secondary.filter((d) => d !== primary),
    confidence: confidenceFromEvidence(ad, primary),
    evidence,
    funnel,
    plain_english: funnel?.explanation?.supported
      ? funnel.explanation.text
      : null,
    attribution_note:
      "Diagnoses use Meta-reported metrics and account-relative Phase 9 thresholds — not Books break-even CPA.",
    ...extra,
  };
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function diagnoseAds(ads, account, opts = {}) {
  return (ads || []).map((ad) => diagnoseAd(ad, account, opts));
}

module.exports = {
  DIAGNOSES,
  diagnoseAd,
  diagnoseAds,
  confidenceFromEvidence,
  detectFatigue,
};
