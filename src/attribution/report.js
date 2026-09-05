/**
 * Attribution diagnostic report printer.
 */
const { formatPct, formatNumber } = require("../meta/metrics");

function printAttributionReport(diag) {
  console.log("WEAR ACTIVE — ATTRIBUTION DIAGNOSTICS");
  console.log(`Capture started: ${diag.capture_started_at}`);
  console.log(`Coverage basis: ${diag.coverage_basis}`);
  console.log(`Shopify orders: ${formatNumber(diag.shopify_orders, 0)}`);
  console.log(
    `Post-capture orders: ${formatNumber(diag.post_capture_orders, 0)}`
  );
  console.log(
    `Usable attribution: ${formatNumber(
      diag.coverage_basis === "post_capture"
        ? diag.post_capture_usable
        : diag.usable_attribution,
      0
    )}`
  );
  console.log(
    `Coverage: ${
      diag.attribution_coverage_pct == null
        ? "—"
        : formatPct(diag.attribution_coverage_pct)
    }`
  );
  const s = diag.status_counts || {};
  console.log(`Meta first-party: ${s.meta_first_party || 0}`);
  console.log(`Organic: ${s.organic || 0}`);
  console.log(`Direct: ${s.direct || 0}`);
  console.log(`Paid non-Meta: ${s.paid_non_meta || 0}`);
  console.log(`Unattributed: ${s.unattributed || 0}`);
  console.log(`Unknown: ${s.unknown || 0}`);
  console.log("Meta evidence");
  const c = diag.confidence_counts || {};
  console.log(`  High confidence: ${c.high || 0}`);
  console.log(`  Medium: ${c.medium || 0}`);
  console.log(`  Low: ${c.low || 0}`);
  console.log(`  None: ${c.none || 0}`);
  console.log("Entity IDs");
  const e = diag.entity_ids || {};
  console.log(
    `  Campaign matched: ${e.campaign_matched || 0}/${e.campaign_present || 0}`
  );
  console.log(
    `  Ad set matched: ${e.adset_matched || 0}/${e.adset_present || 0}`
  );
  console.log(`  Ad matched: ${e.ad_matched || 0}/${e.ad_present || 0}`);
  console.log("Warnings");
  const warnings = Object.entries(diag.warnings || {});
  if (!warnings.length) console.log("  (none)");
  else {
    for (const [code, n] of warnings.sort((a, b) => b[1] - a[1])) {
      console.log(`  ${code}: ${n}`);
    }
  }
  console.log("");
  console.log(
    "Note: Phase 5A is experimental. No attributed profit is computed."
  );
}

module.exports = { printAttributionReport };
