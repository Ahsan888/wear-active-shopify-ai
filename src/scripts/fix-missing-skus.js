require("dotenv").config();
const fs = require("fs");
const { graphql } = require("../shopify/client");
const {
  getSheetsClient,
  requireSpreadsheetId,
} = require("../sheets/client");

const SIZE_NORM = {
  S: "S",
  M: "M",
  L: "L",
  XL: "XL",
  XXL: "XXL",
  "2XL": "XXL",
  "2xl": "XXL",
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
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchAllVariants() {
  const out = [];
  let cursor = null;
  let hasNext = true;
  while (hasNext) {
    const data = await graphql(
      `
      query ($cursor: String) {
        products(first: 50, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            title
            handle
            status
            options { name values }
            variants(first: 100) {
              nodes {
                id
                title
                sku
                selectedOptions { name value }
              }
            }
          }
        }
      }
    `,
      { cursor }
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

async function loadVariantMaster() {
  const sheets = await getSheetsClient();
  const spreadsheetId = requireSpreadsheetId();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "'Variant Master'!A:K",
    valueRenderOption: "FORMATTED_VALUE",
  });
  const rows = (res.data.values || []).slice(1);
  const bySku = new Map();
  const byProductSize = new Map(); // titleNorm|size -> [{sku, color}]
  const byProductColorSize = new Map(); // titleNorm|color|size -> sku
  for (const r of rows) {
    const product = String(r[0] || "").trim();
    const size = normSize(r[2]);
    const color = String(r[9] || "").trim().toUpperCase();
    const sku = String(r[10] || "").trim();
    if (!sku || !product) continue;
    bySku.set(sku, { product, size, color });
    const tn = normTitle(product);
    const k1 = `${tn}|${size}`;
    if (!byProductSize.has(k1)) byProductSize.set(k1, []);
    byProductSize.get(k1).push({ sku, color, product });
    byProductColorSize.set(`${tn}|${color}|${size}`, sku);
  }
  return { bySku, byProductSize, byProductColorSize, rows };
}

function colorFromHandle(handle) {
  const h = String(handle || "").toLowerCase();
  const map = [
    ["-blk", "BLK"],
    ["-black", "BLK"],
    ["-gry", "GRY"],
    ["-gray", "GRY"],
    ["-grey", "GRY"],
    ["-gre", "GRE"],
    ["-green", "GRE"],
    ["-blu", "BLU"],
    ["-navy", "BLU"],
    ["-brw", "BRW"],
    ["-brown", "BRW"],
    ["-mar", "MAR"],
    ["-wht", "WHT"],
    ["-white", "WHT"],
    ["-red", "RED"],
  ];
  for (const [needle, code] of map) {
    if (h.includes(needle)) return code;
  }
  return "";
}

function matchSku(v, vm) {
  const size =
    normSize(v.options.size) ||
    normSize(v.variantTitle.split("/").pop());
  const colorOpt =
    v.options.color ||
    v.options.colour ||
    "";
  let color = String(colorOpt).trim().toUpperCase();
  // map common names
  const colorNameMap = {
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
  if (colorNameMap[color]) color = colorNameMap[color];
  if (!color || color.length > 4) color = colorFromHandle(v.handle) || color;

  const titleCandidates = [
    normTitle(v.productTitle),
    normTitle(v.productTitle.replace(/trousers?/i, "trouser")),
    normTitle(v.productTitle.replace(/tees?/i, "tee")),
    normTitle(v.productTitle.replace(/tops?/i, "tee")),
    normTitle(v.productTitle.replace(/oversized cotton tee/i, "oversized cotton")),
    normTitle(v.productTitle.replace(/ventra performance top/i, "ventra performance tee")),
    normTitle(v.productTitle.replace(/motionfit trousers.*/i, "motionfit trouser")),
    normTitle(v.productTitle.replace(/coreactive trousers.*/i, "coreactive trouser")),
    normTitle(v.productTitle.replace(/flowease women.?s trousers/i, "flowease womens trousers")),
  ];

  for (const tn of titleCandidates) {
    if (color) {
      const hit = vm.byProductColorSize.get(`${tn}|${color}|${size}`);
      if (hit) return { sku: hit, how: `title+color+size (${tn}|${color}|${size})` };
    }
  }
  for (const tn of titleCandidates) {
    const list = vm.byProductSize.get(`${tn}|${size}`) || [];
    if (list.length === 1) {
      return { sku: list[0].sku, how: `title+size unique (${tn}|${size})` };
    }
    if (color && list.length > 1) {
      const c = list.find((x) => x.color === color);
      if (c) return { sku: c.sku, how: `title+size+color filter (${tn}|${color}|${size})` };
    }
  }
  return null;
}

async function main() {
  const apply = process.argv.includes("--apply");
  console.log(`Mode: ${apply ? "APPLY" : "DRY-RUN"}`);

  const [variants, vm] = await Promise.all([fetchAllVariants(), loadVariantMaster()]);
  console.log(`Shopify variants: ${variants.length}`);
  console.log(`Variant Master SKUs: ${vm.bySku.size}`);

  const blank = variants.filter((v) => !v.sku);
  console.log(`Blank SKUs: ${blank.length}`);

  const plan = [];
  const unmatched = [];
  for (const v of blank) {
    const m = matchSku(v, vm);
    if (m) plan.push({ ...v, newSku: m.sku, how: m.how });
    else unmatched.push(v);
  }

  console.log(`Matched from Variant Master: ${plan.length}`);
  console.log(`Unmatched: ${unmatched.length}`);
  for (const p of plan.slice(0, 40)) {
    console.log(
      `  ${p.status} | ${p.productTitle} | ${p.variantTitle} -> ${p.newSku} (${p.how})`
    );
  }
  if (plan.length > 40) console.log(`  … +${plan.length - 40} more`);
  if (unmatched.length) {
    console.log("Unmatched samples:");
    for (const u of unmatched.slice(0, 30)) {
      console.log(
        `  ${u.status} | ${u.productTitle} | ${u.variantTitle} | handle=${u.handle} | opts=${JSON.stringify(u.options)}`
      );
    }
  }

  fs.writeFileSync(
    "/tmp/sku-fix-plan.json",
    JSON.stringify({ plan, unmatched }, null, 2)
  );

  if (!apply) {
    console.log("Dry-run only. Re-run with --apply to write SKUs to Shopify.");
    return;
  }

  // Group by product for bulk update
  const byProduct = new Map();
  for (const p of plan) {
    if (!byProduct.has(p.productId)) byProduct.set(p.productId, []);
    byProduct.get(p.productId).push(p);
  }

  let updated = 0;
  for (const [productId, items] of byProduct) {
    const data = await graphql(
      `
      mutation ($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          productVariants { id sku }
          userErrors { field message }
        }
      }
    `,
      {
        productId,
        variants: items.map((i) => ({ id: i.variantId, inventoryItem: { sku: i.newSku } })),
      }
    );
    // Newer API may use sku directly on variant input
    const errors = data.productVariantsBulkUpdate?.userErrors || [];
    if (errors.length) {
      // retry with top-level sku field
      const data2 = await graphql(
        `
        mutation ($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkUpdate(productId: $productId, variants: $variants) {
            productVariants { id sku }
            userErrors { field message }
          }
        }
      `,
        {
          productId,
          variants: items.map((i) => ({ id: i.variantId, sku: i.newSku })),
        }
      );
      const errors2 = data2.productVariantsBulkUpdate?.userErrors || [];
      if (errors2.length) {
        console.error("Errors for", productId, errors, errors2);
        continue;
      }
      updated += data2.productVariantsBulkUpdate.productVariants.length;
    } else {
      updated += data.productVariantsBulkUpdate.productVariants.length;
    }
    console.log(`Updated ${items.length} variants on ${items[0].productTitle}`);
  }
  console.log(`Done. Updated ${updated} variants.`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exitCode = 1;
});
