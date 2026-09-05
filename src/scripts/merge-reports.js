#!/usr/bin/env node
/**
 * Conservative merge layer for Meta (+ optional future Shopify) reports.
 * Does NOT attribute Meta spend to Shopify orders.
 *
 * Usage:
 *   npm run reports:merge -- --meta=reports/meta/2026-09-01_to_2026-09-06/summary.json
 *   npm run reports:merge -- --meta=.../summary.json --shopify=path/to/orders.json
 */
const fs = require("fs");
const path = require("path");
const { parseArgs } = require("../meta/cli");

function readJson(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }
  const text = fs.readFileSync(resolved, "utf8");
  try {
    return { path: resolved, data: JSON.parse(text) };
  } catch (err) {
    throw new Error(`Invalid JSON at ${resolved}: ${err.message}`);
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function normalizeMeta(input) {
  const data = input.data;
  const account = data.account || {};
  const dateRange = data.date_range || data.dateRange || null;
  const totals = data.totals || null;

  return {
    source: "meta",
    file: input.path,
    generated_at: data.generated_at || null,
    account: {
      id: account.id || null,
      name: account.name || null,
      currency: account.currency || null,
      timezone_name: account.timezone_name || null,
    },
    date_range: dateRange,
    totals,
    counts: data.counts || null,
    // Preserve nested file pointers from full exports without inventing joins
    files: data.files || null,
    level: data.level || null,
    row_count: Array.isArray(data.rows) ? data.rows.length : null,
  };
}

function normalizeShopify(input) {
  if (!input) return null;
  const data = input.data;
  return {
    source: "shopify",
    file: input.path,
    generated_at: data.generated_at || data.generatedAt || null,
    note:
      "Passthrough only — no Meta↔Shopify attribution is applied in v1.",
    summary: data.summary || data.totals || null,
    order_count:
      data.order_count ??
      data.orders_count ??
      (Array.isArray(data.orders) ? data.orders.length : null),
    raw_keys: Object.keys(data),
  };
}

function buildMerged({ meta, shopify, outPath }) {
  return {
    generated_at: new Date().toISOString(),
    schema_version: 1,
    purpose:
      "Conservative consolidation for future Wear Active Meta + Shopify + Books analysis. No attribution joins yet.",
    caveats: [
      "Meta purchase metrics use Meta attribution windows — not Shopify order counts.",
      "Do not treat Meta purchase_value as Books revenue.",
      "Product/SKU profitability and contribution margin are placeholders until reliable cost joins exist.",
    ],
    inputs: {
      meta: meta.file,
      shopify: shopify?.file || null,
    },
    sections: {
      meta_performance: meta,
      shopify_sales: shopify || {
        source: "shopify",
        status: "not_provided",
        note: "Pass --shopify=path/to/report.json when available.",
      },
      product_sku_profitability: {
        status: "placeholder",
        note: "Future: Variant Master cost × Shopify line items × optional Meta campaign mapping.",
      },
      contribution_margin: {
        status: "placeholder",
        note: "Future: recognized Books revenue − COGS − delivery − Meta spend (date-aligned, not click-attributed).",
      },
    },
    output: outPath,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.meta) {
    throw new Error(
      "Required: --meta=path/to/meta-summary.json (from meta:report --json or meta:report:full)"
    );
  }

  const metaFile = readJson(args.meta);
  const shopifyFile = args.shopify ? readJson(args.shopify) : null;

  const meta = normalizeMeta(metaFile);
  const shopify = normalizeShopify(shopifyFile);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const range =
    meta.date_range?.since && meta.date_range?.until
      ? `${meta.date_range.since}_to_${meta.date_range.until}`
      : "unknown-range";
  const defaultOut = path.join(
    process.cwd(),
    "reports",
    "merged",
    `merged-${range}-${stamp}.json`
  );
  const outPath = path.resolve(args.out || defaultOut);
  ensureDir(path.dirname(outPath));

  const merged = buildMerged({ meta, shopify, outPath });
  fs.writeFileSync(outPath, JSON.stringify(merged, null, 2));

  console.log("MERGED REPORT WRITTEN");
  console.log(`  ${outPath}`);
  console.log(`  meta account: ${meta.account?.name || "—"} (${meta.account?.id || "—"})`);
  console.log(`  shopify input: ${shopify ? "yes" : "no"}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
