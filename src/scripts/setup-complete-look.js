require("dotenv").config();

const { graphql } = require("../shopify/client");
const { getValues } = require("../sheets/client");

const APPLY = process.argv.includes("--apply");
const MAX_RECOMMENDATIONS = 3;
const TOP_TYPES = new Set(["Shirts", "Hoodies", "Jackets"]);
const BOTTOM_TYPES = new Set(["Trousers", "Shorts"]);

function parseNumber(value) {
  return Number(String(value ?? "").replace(/,/g, "")) || 0;
}

function audience(product) {
  return product.tags.filter((tag) => tag === "gender-men" || tag === "gender-women");
}

function category(product) {
  if (TOP_TYPES.has(product.productType)) return "top";
  if (BOTTOM_TYPES.has(product.productType)) return "bottom";
  return null;
}

function audiencesOverlap(left, right) {
  const wanted = new Set(audience(left));
  return audience(right).some((tag) => wanted.has(tag));
}

function isOnSale(product) {
  return product.variants.nodes.some(
    (variant) => parseNumber(variant.compareAtPrice) > parseNumber(variant.price)
  );
}

function inStock(product) {
  return product.variants.nodes.some((variant) => Number(variant.inventoryQuantity || 0) > 0);
}

async function fetchProducts() {
  const query = `
    query CompleteLookProducts($cursor: String) {
      products(first: 100, after: $cursor, query: "status:active", sortKey: TITLE) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id title handle productType tags onlineStoreUrl
          completeTheLook: metafield(namespace: "custom", key: "complete_the_look") { value }
          variants(first: 100) {
            nodes { sku price compareAtPrice inventoryQuantity }
          }
        }
      }
    }
  `;

  const products = [];
  let cursor = null;
  do {
    const data = await graphql(query, { cursor });
    products.push(...data.products.nodes);
    cursor = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
  } while (cursor);
  return products;
}

async function loadUnitsBySku() {
  const rows = await getValues("'Shopify Orders (LIVE)'!A1:AZ");
  const header = rows[0] || [];
  const skuIndex = header.indexOf("SKU");
  const quantityIndex = header.indexOf("Qty");
  const paymentIndex = header.indexOf("Payment Status");
  const netIndex = header.indexOf("Net Line");
  if ([skuIndex, quantityIndex, paymentIndex, netIndex].some((index) => index < 0)) {
    throw new Error("Shopify Orders (LIVE) is missing SKU, Qty, Payment Status, or Net Line");
  }

  const units = new Map();
  for (const row of rows.slice(1)) {
    const sku = String(row[skuIndex] || "").trim();
    const status = String(row[paymentIndex] || "").trim().toLowerCase();
    const excluded = ["voided", "refunded", "partially_refunded"].includes(status);
    if (!sku || excluded || parseNumber(row[netIndex]) <= 0) continue;
    units.set(sku, (units.get(sku) || 0) + parseNumber(row[quantityIndex]));
  }
  return units;
}

function salesUnits(product, unitsBySku) {
  return product.variants.nodes.reduce(
    (sum, variant) => sum + (unitsBySku.get(String(variant.sku || "").trim()) || 0),
    0
  );
}

function selectRecommendations(product, candidates, unitsBySku) {
  const targetCategory = category(product) === "top" ? "bottom" : "top";
  const ranked = candidates
    .filter((candidate) => candidate.id !== product.id)
    .filter((candidate) => category(candidate) === targetCategory)
    .filter((candidate) => audiencesOverlap(product, candidate))
    .sort((left, right) => {
      const salesDifference = salesUnits(right, unitsBySku) - salesUnits(left, unitsBySku);
      if (salesDifference) return salesDifference;
      const inventoryLeft = left.variants.nodes.reduce((sum, variant) => sum + Number(variant.inventoryQuantity || 0), 0);
      const inventoryRight = right.variants.nodes.reduce((sum, variant) => sum + Number(variant.inventoryQuantity || 0), 0);
      return inventoryRight - inventoryLeft;
    });

  const selected = [];
  const usedTitles = new Set();
  for (const candidate of ranked) {
    if (usedTitles.has(candidate.title)) continue;
    selected.push(candidate);
    usedTitles.add(candidate.title);
    if (selected.length === MAX_RECOMMENDATIONS) break;
  }
  if (selected.length < MAX_RECOMMENDATIONS) {
    for (const candidate of ranked) {
      if (selected.some((item) => item.id === candidate.id)) continue;
      selected.push(candidate);
      if (selected.length >= MAX_RECOMMENDATIONS) break;
    }
  }
  return selected;
}

function currentIds(product) {
  try {
    return JSON.parse(product.completeTheLook?.value || "[]");
  } catch (_error) {
    return [];
  }
}

async function writeMetafields(changes) {
  const mutation = `
    mutation SetCompleteLook($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id ownerType namespace key value }
        userErrors { field message code }
      }
    }
  `;

  for (let index = 0; index < changes.length; index += 25) {
    const batch = changes.slice(index, index + 25).map((change) => ({
      ownerId: change.product.id,
      namespace: "custom",
      key: "complete_the_look",
      type: "list.product_reference",
      value: JSON.stringify(change.recommendations.map((item) => item.id)),
    }));
    const data = await graphql(mutation, { metafields: batch });
    const errors = data.metafieldsSet.userErrors || [];
    if (errors.length) throw new Error(errors.map((error) => error.message).join("; "));
  }
}

async function main() {
  console.log(`Mode: ${APPLY ? "APPLY" : "DRY-RUN"}`);
  const [products, unitsBySku] = await Promise.all([fetchProducts(), loadUnitsBySku()]);
  const apparel = products.filter((product) => product.onlineStoreUrl && category(product) && audience(product).length);
  const candidates = apparel.filter((product) => !isOnSale(product) && inStock(product));
  const changes = [];

  for (const product of apparel) {
    const recommendations = selectRecommendations(product, candidates, unitsBySku);
    const before = currentIds(product);
    const after = recommendations.map((item) => item.id);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      changes.push({ product, recommendations });
    }
  }

  console.log(`Eligible recommendation pool: ${candidates.length}`);
  console.log(`Products evaluated: ${apparel.length}`);
  console.log(`Metafields to update: ${changes.length}`);
  for (const change of changes) {
    console.log(`  ${change.product.handle} -> ${change.recommendations.map((item) => item.handle).join(", ")}`);
  }

  if (!APPLY) {
    console.log("Dry-run only. Re-run with --apply after review.");
    return;
  }

  await writeMetafields(changes);
  console.log(`Updated Complete Your Look on ${changes.length} products.`);
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
