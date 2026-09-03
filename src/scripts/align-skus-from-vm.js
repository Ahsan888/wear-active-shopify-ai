require("dotenv").config();
const fs = require("fs");
const { graphql } = require("../shopify/client");
const {
  getSheetsClient,
  requireSpreadsheetId,
} = require("../sheets/client");

const SIZE_NORM = { S: "S", M: "M", L: "L", XL: "XL", XXL: "XXL", "2XL": "XXL" };
const COLOR_NAME = {
  BLACK: "BLK",
  GRAY: "GRY",
  GREY: "GRY",
  GREEN: "GRE",
  "OLIVE GREEN": "GRE",
  BLUE: "BLU",
  NAVY: "BLU",
  BROWN: "BRW",
  WHITE: "WHT",
  MAROON: "MAR",
  RED: "RED",
  "INFERNO RED": "RED",
  "AQUA TEAL": "GRE",
};

function normSize(s) {
  const t = String(s || "").trim();
  return SIZE_NORM[t] || SIZE_NORM[t.toUpperCase()] || t.toUpperCase();
}
function normTitle(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/\(.*?\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(regular|relaxed|slim)\s+fit\b/g, "")
    .replace(/\bwomens?\b/g, "womens")
    .replace(/\btrousers\b/g, "trouser")
    .replace(/\btees?\b/g, "tee")
    .replace(/\btops?\b/g, "tee")
    .replace(/\s+/g, " ")
    .trim();
}
function colorFromHandle(handle) {
  const h = String(handle || "").toLowerCase();
  const map = [
    ["-blk", "BLK"],
    ["-gry", "GRY"],
    ["-gre", "GRE"],
    ["-blu", "BLU"],
    ["-brw", "BRW"],
    ["-mar", "MAR"],
    ["-wht", "WHT"],
    ["-red", "RED"],
  ];
  for (const [n, c] of map) if (h.endsWith(n) || h.includes(`${n}-`) || h.includes(n)) return c;
  // last token
  const m = h.match(/-(blk|gry|gre|blu|brw|mar|wht|red)(?:-|$)/i);
  return m ? m[1].toUpperCase() : "";
}

async function fetchAllVariants() {
  const out = [];
  let cursor = null;
  let hasNext = true;
  while (hasNext) {
    const data = await graphql(
      `query ($c: String) {
        products(first: 50, after: $c) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id title handle status
            variants(first: 100) {
              nodes {
                id title sku
                selectedOptions { name value }
              }
            }
          }
        }
      }`,
      { c: cursor }
    );
    for (const p of data.products.nodes) {
      for (const v of p.variants.nodes) {
        out.push({
          productId: p.id,
          productTitle: p.title,
          handle: p.handle,
          status: p.status,
          variantId: v.id,
          variantTitle: v.title,
          sku: String(v.sku || "").trim(),
          options: Object.fromEntries(
            (v.selectedOptions || []).map((o) => [
              String(o.name).toLowerCase(),
              o.value,
            ])
          ),
        });
      }
    }
    hasNext = data.products.pageInfo.hasNextPage;
    cursor = data.products.pageInfo.endCursor;
  }
  return out;
}

async function loadVm() {
  const sheets = await getSheetsClient();
  const spreadsheetId = requireSpreadsheetId();
  const rows = (
    await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "'Variant Master'!A:K",
    })
  ).data.values
    .slice(1)
    .map((r) => ({
      product: String(r[0] || "").trim(),
      size: normSize(r[2]),
      color: String(r[9] || "").trim().toUpperCase(),
      sku: String(r[10] || "").trim(),
    }))
    .filter((r) => r.sku);
  const bySku = new Set(rows.map((r) => r.sku));
  const byPCS = new Map();
  const byPS = new Map();
  for (const r of rows) {
    const tn = normTitle(r.product);
    byPCS.set(`${tn}|${r.color}|${r.size}`, r.sku);
    const k = `${tn}|${r.size}`;
    if (!byPS.has(k)) byPS.set(k, []);
    byPS.get(k).push(r);
  }
  // aliases for known title drift
  const aliases = [
    ["motionfit trousers", "motionfit trouser"],
    ["coreactive trousers", "coreactive trouser"],
    ["oversized cotton tee", "oversized cotton"],
    ["ventra performance tee", "ventra performance tee"],
    ["flowease womens trouser", "flowease womens trousers"],
    ["ease flow trouser", "ease flow trouser"],
  ];
  return { bySku, byPCS, byPS, aliases, rows };
}

function titleKeys(productTitle) {
  const base = normTitle(productTitle);
  const keys = new Set([base]);
  keys.add(base.replace(/\btrouser\b/, "trousers"));
  keys.add(base.replace(/\btrousers\b/, "trouser"));
  keys.add(base.replace(/\bperformance tee\b/, "performance top"));
  keys.add(base.replace(/\bperformance top\b/, "performance tee"));
  keys.add(base.replace(/\boversized cotton tee\b/, "oversized cotton"));
  keys.add(base.replace(/^motionfit trousers/, "motionfit trouser"));
  keys.add(base.replace(/^coreactive trousers/, "coreactive trouser"));
  if (base.includes("flowease")) {
    keys.add("flowease womens trousers");
    keys.add("flowease womens trouser");
  }
  return [...keys];
}

function resolveColor(v) {
  let color = String(v.options.color || v.options.colour || "").trim().toUpperCase();
  if (COLOR_NAME[color]) color = COLOR_NAME[color];
  if (!color || color.length > 5) color = colorFromHandle(v.handle);
  // Destiny / single-color products sometimes encode color only in SKU
  if (!color && v.sku) {
    const m = v.sku.match(/-(BLK|GRY|GRE|BLU|BRW|MAR|WHT|RED)-/i);
    if (m) color = m[1].toUpperCase();
  }
  return color;
}

function skuColorSize(sku) {
  const s = String(sku || "");
  // Prefer last COLOR-SIZE pair (handles WA-FOO-BAR-BLK-1 and WA-FOO-BLU-HALF-1)
  const m = s.match(/-([A-Z]{2,4})-(\d+)$/i);
  if (!m) return { color: "", sizeCode: "" };
  return { color: m[1].toUpperCase(), sizeCode: m[2] };
}

function matchVmSku(v, vm) {
  const size =
    normSize(v.options.size) ||
    normSize(String(v.variantTitle).split("/").pop());
  let color = resolveColor(v);
  const fromSku = skuColorSize(v.sku);
  if (fromSku.color) color = fromSku.color;

  for (const tn of titleKeys(v.productTitle)) {
    if (color) {
      const hit = vm.byPCS.get(`${tn}|${color}|${size}`);
      if (hit) {
        // Refuse remaps that change color code or trailing size digit
        if (v.sku) {
          const want = skuColorSize(hit);
          if (fromSku.color && want.color && fromSku.color !== want.color) continue;
          if (fromSku.sizeCode && want.sizeCode && fromSku.sizeCode !== want.sizeCode) continue;
        }
        return hit;
      }
    }
  }
  return null;
}

async function main() {
  const apply = process.argv.includes("--apply");
  console.log(`Mode: ${apply ? "APPLY" : "DRY-RUN"}`);

  const [variants, vm] = await Promise.all([fetchAllVariants(), loadVm()]);
  const blank = variants.filter((v) => !v.sku);
  const mismatched = variants.filter((v) => v.sku && !vm.bySku.has(v.sku));

  console.log(
    `Variants ${variants.length} | blank ${blank.length} | SKU not in VM ${mismatched.length}`
  );

  const plan = [];
  const unmatched = [];
  for (const v of [...blank, ...mismatched]) {
    const newSku = matchVmSku(v, vm);
    if (!newSku) {
      unmatched.push(v);
      continue;
    }
    if (newSku === v.sku) continue;
    plan.push({ ...v, newSku });
  }

  console.log(`Updates planned: ${plan.length}`);
  console.log(`Still unmatched: ${unmatched.length}`);
  const byProduct = {};
  for (const p of plan) {
    byProduct[p.productTitle] = (byProduct[p.productTitle] || 0) + 1;
  }
  Object.entries(byProduct)
    .sort((a, b) => b[1] - a[1])
    .forEach(([k, n]) => console.log(`  ${n}  ${k}`));

  for (const p of plan.slice(0, 25)) {
    console.log(`  ${p.sku || "(blank)"} -> ${p.newSku} | ${p.productTitle} ${p.variantTitle}`);
  }
  if (unmatched.length) {
    console.log("Unmatched:");
    unmatched.forEach((u) =>
      console.log(
        `  ${u.sku || "(blank)"} | ${u.productTitle} | ${u.variantTitle} | ${u.handle}`
      )
    );
  }

  fs.writeFileSync("/tmp/sku-align-plan.json", JSON.stringify({ plan, unmatched }, null, 2));

  if (!apply) {
    console.log("Dry-run only. Re-run with --apply to update Shopify SKUs.");
    return;
  }

  const groups = new Map();
  for (const p of plan) {
    if (!groups.has(p.productId)) groups.set(p.productId, []);
    groups.get(p.productId).push(p);
  }

  let ok = 0;
  for (const [productId, items] of groups) {
    const data = await graphql(
      `mutation ($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          productVariants { id sku }
          userErrors { field message }
        }
      }`,
      {
        productId,
        variants: items.map((i) => ({
          id: i.variantId,
          inventoryItem: { sku: i.newSku },
        })),
      }
    );
    const errors = data.productVariantsBulkUpdate.userErrors || [];
    if (errors.length) {
      console.error("FAIL", items[0].productTitle, errors);
      continue;
    }
    ok += data.productVariantsBulkUpdate.productVariants.length;
    console.log(`Updated ${items.length}: ${items[0].productTitle}`);
  }
  console.log(`Done. ${ok} variants updated.`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exitCode = 1;
});
