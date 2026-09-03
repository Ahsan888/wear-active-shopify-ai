require("dotenv").config();
const crypto = require("crypto");
const { graphql } = require("../shopify/client");

/**
 * Set absolute available qty via delta adjust.
 * Usage: node src/scripts/set-inventory-batch.js
 * Edit STOCK/MATCH below or pass JSON path later.
 */

const STOCK = {
  "Phantom Flex": {
    White: { S: 4, M: 21, L: 14, XL: 17, XXL: 4 },
    Black: { S: 7, M: 26, L: 16, XL: 15, XXL: 7 },
    Gray: { S: 8, M: 7, L: 17, XL: 10, XXL: 8 },
  },
  "Flow Ease Womens Trouser": {
    Black: { S: 4, M: 9, L: 11, XL: 5, XXL: 6 },
    Green: { S: 5, M: 5, L: 6, XL: 3, XXL: 3 },
    Brown: { S: 6, M: 5, L: 5, XL: 3, XXL: 2 },
  },
  "Essential Cotton Tee": {
    White: { S: 5, M: 11, L: 9, XL: 11, XXL: 3 },
    Gray: { S: 8, M: 7, L: 10, XL: 12, XXL: 9 },
    Blue: { S: 10, M: 16, L: 18, XL: 21, XXL: 15 },
    Maroon: { S: 0, M: 1, L: 2, XL: 4, XXL: 3 },
    Black: { S: 13, M: 14, L: 16, XL: 17, XXL: 12 },
  },
  "Oversized Cotton Tee": {
    Black: { S: 3, M: 7, L: 9, XL: 4, XXL: 1 },
    Gray: { S: 5, M: 7, L: 4, XL: 6, XXL: 4 },
  },
  CoreFlex: {
    Green: { S: 5, M: 6, L: 10, XL: 7, XXL: 5 },
    Brown: { S: 2, M: 9, L: 7, XL: 8, XXL: 5 },
    Black: { S: 7, M: 2, L: 8, XL: 7, XXL: 8 },
  },
  CorePerformance: {
    Black: { S: 6, M: 0, L: 6, XL: 16, XXL: 3 },
    Blue: { S: 2, M: 10, L: 3, XL: 4, XXL: 7 },
    // White line had "XXL12 XXL8" — treated as XL12 XXL8
    White: { S: 5, M: 20, L: 19, XL: 12, XXL: 8 },
  },
};

const MATCH = [
  ["Phantom Flex", "White", "WA-PFT-WHT-"],
  ["Phantom Flex", "Black", "WA-PFT-BLK-"],
  ["Phantom Flex", "Gray", "WA-PFT-GRY-"],
  ["Flow Ease Womens Trouser", "Black", "WA-FLOW-EASE-F-BLK-"],
  ["Flow Ease Womens Trouser", "Green", "WA-FLOW-EASE-GRE-"],
  ["Flow Ease Womens Trouser", "Brown", "WA-FLOW-EASE-BRW-"],
  ["Essential Cotton Tee", "White", "WA-BASIC-COTTON-WHT-"],
  ["Essential Cotton Tee", "Gray", "WA-BASIC-COTTON-GRY-"],
  ["Essential Cotton Tee", "Blue", "WA-BASIC-COTTON-BLU-"],
  ["Essential Cotton Tee", "Maroon", "WA-BASIC-COTTON-MAR-"],
  ["Essential Cotton Tee", "Black", "WA-BASIC-COTTON-BLK-"],
  ["Oversized Cotton Tee", "Black", "WA-COTTON-OVERSIZED-BLK-"],
  ["Oversized Cotton Tee", "Gray", "WA-COTTON-OVERSIZED-GRY-"],
  ["CoreFlex", "Green", "WA-CORE-FLEX-GRE-"],
  ["CoreFlex", "Brown", "WA-CORE-FLEX-BRW-"],
  ["CoreFlex", "Black", "WA-CORE-FLEX-BLK-"],
  ["CorePerformance", "Black", "WA-CORE-BLK-"],
  ["CorePerformance", "Blue", "WA-CORE-BLU-"],
  ["CorePerformance", "White", "WA-CORE-WHT-"],
];

const SIZE_CODE = { S: "1", M: "2", L: "3", XL: "4", XXL: "5" };

async function main() {
  // discover location
  const probe = await graphql(`{
    productVariants(first:1, query:"sku:WA-PFT-BLK-1") {
      edges { node {
        inventoryItem {
          inventoryLevels(first:3) {
            edges { node { location { id } } }
          }
        }
      } }
    }
  }`);
  const locationId =
    probe.productVariants.edges[0]?.node?.inventoryItem?.inventoryLevels
      ?.edges?.[0]?.node?.location?.id;
  if (!locationId) throw new Error("No location");
  console.log("Location", locationId);

  const updates = [];
  for (const [product, color, prefix] of MATCH) {
    for (const [size, qty] of Object.entries(STOCK[product][color])) {
      updates.push({
        product,
        color,
        size,
        sku: prefix + SIZE_CODE[size],
        qty,
      });
    }
  }

  for (const u of updates) {
    const d = await graphql(
      `query ($q: String!) {
        productVariants(first: 5, query: $q) {
          edges {
            node {
              sku
              inventoryQuantity
              inventoryItem { id }
            }
          }
        }
      }`,
      { q: `sku:${u.sku}` }
    );
    const node = d.productVariants.edges.find((e) => e.node.sku === u.sku)?.node;
    if (!node) {
      u.error = "SKU not found";
      continue;
    }
    u.inventoryItemId = node.inventoryItem.id;
    u.before = node.inventoryQuantity;
  }

  const ready = updates.filter((u) => u.inventoryItemId);
  const missing = updates.filter((u) => u.error);
  console.log(`Ready ${ready.length}, missing ${missing.length}`);
  if (missing.length) console.log(missing);

  let adjusted = 0;
  for (let i = 0; i < ready.length; i += 15) {
    const chunk = ready.slice(i, i + 15);
    const changes = chunk
      .map((u) => ({
        inventoryItemId: u.inventoryItemId,
        locationId,
        delta: u.qty - (u.before || 0),
        changeFromQuantity: u.before || 0,
        _u: u,
      }))
      .filter((c) => c.delta !== 0);

    if (!changes.length) {
      chunk.forEach((u) => {
        u.ok = true;
      });
      console.log(`Batch ${i / 15 + 1}: all already correct`);
      continue;
    }

    const idem = crypto.randomUUID();
    const res = await graphql(
      `mutation ($input: InventoryAdjustQuantitiesInput!) {
        inventoryAdjustQuantities(input: $input) @idempotent(key: "${idem}") {
          userErrors { field message }
        }
      }`,
      {
        input: {
          name: "available",
          reason: "correction",
          changes: changes.map(
            ({ inventoryItemId, locationId, delta, changeFromQuantity }) => ({
              inventoryItemId,
              locationId,
              delta,
              changeFromQuantity,
            })
          ),
        },
      }
    );
    const errs = res.inventoryAdjustQuantities?.userErrors || [];
    if (errs.length) {
      console.log("Batch errors", errs);
      for (const c of changes) {
        const oneIdem = crypto.randomUUID();
        const one = await graphql(
          `mutation ($input: InventoryAdjustQuantitiesInput!) {
            inventoryAdjustQuantities(input: $input) @idempotent(key: "${oneIdem}") {
              userErrors { field message }
            }
          }`,
          {
            input: {
              name: "available",
              reason: "correction",
              changes: [
                {
                  inventoryItemId: c.inventoryItemId,
                  locationId: c.locationId,
                  delta: c.delta,
                  changeFromQuantity: c.changeFromQuantity,
                },
              ],
            },
          }
        );
        const e2 = one.inventoryAdjustQuantities?.userErrors || [];
        if (e2.length) {
          c._u.fail = e2;
          console.log("Fail", c._u.sku, e2);
        } else {
          c._u.ok = true;
          adjusted++;
        }
      }
    } else {
      changes.forEach((c) => {
        c._u.ok = true;
      });
      chunk
        .filter((u) => u.qty === u.before)
        .forEach((u) => {
          u.ok = true;
        });
      adjusted += changes.length;
      console.log(
        `Batch ${i / 15 + 1}: adjusted ${changes.length}, unchanged ${
          chunk.length - changes.length
        }`
      );
    }
  }

  // verify
  let ok = 0;
  const bad = [];
  for (const u of ready) {
    const d = await graphql(
      `query ($q: String!) {
        productVariants(first: 3, query: $q) {
          edges { node { sku inventoryQuantity } }
        }
      }`,
      { q: `sku:${u.sku}` }
    );
    const now = d.productVariants.edges.find((e) => e.node.sku === u.sku)?.node
      ?.inventoryQuantity;
    u.after = now;
    if (now === u.qty) ok++;
    else bad.push({ sku: u.sku, before: u.before, target: u.qty, now });
  }
  console.log(`\nVerified ${ok}/${ready.length}`);
  if (bad.length) console.log("Mismatches:\n", bad);
  console.log("Adjusted deltas:", adjusted);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exitCode = 1;
});
