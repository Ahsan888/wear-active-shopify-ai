require("dotenv").config();

const { graphql } = require("../shopify/client");
const { getValues } = require("../sheets/client");

const APPLY = process.argv.includes("--apply");
const TAX_DIVISOR = 1.18;
const MIN_POST_DISCOUNT_MARGIN = 0.3;

const OFFERS = {
  tee: {
    tag: "bundle-tee",
    collectionTitle: "Bundle Eligible Tees",
    collectionHandle: "bundle-eligible-tees",
    maximumPerUnitSaving: 134,
    productTitles: new Set([
      "Aura Oversized Performance Tee",
      "Core Compression Shirt Full Sleeve",
      "Core Compression Shirt Half Sleeve",
      "Core Performance Tee",
      "CoreFit Performance Tee",
      "CoreFlex Performance Tee",
      "Elevate Essential Tee",
      "Inferno Performance Tee",
      "Oversized Cotton Tee",
      "Phantom Flex Tee",
      "Phantom Graphic Tee",
      "Pulse Performance Tee",
      "StormStrike Performance Tee",
      "Velocity Quarter Zip",
      "Ventra Performance Top",
    ]),
  },
  bottom: {
    tag: "bundle-bottom",
    collectionTitle: "Bundle Eligible Bottoms",
    collectionHandle: "bundle-eligible-bottoms",
    maximumPerUnitSaving: 75,
    productTitles: new Set([
      "Eclipse Relaxed Trousers",
      "FlexFlow Micro Stretch Trousers",
      "MicroFlex Performance Shorts",
      "MotionFlex Performance Joggers",
      "Phantom Trousers",
      "StrideFlex Training Shorts",
    ]),
  },
};

const DISCOUNTS = [
  { title: "2 Tees Bundle", offer: "tee", quantity: 2, amount: 200 },
  { title: "3 Tees Bundle", offer: "tee", quantity: 3, amount: 400 },
  { title: "2 Trousers Bundle", offer: "bottom", quantity: 2, amount: 150 },
];

function money(value) {
  return `Rs. ${Number(value || 0).toLocaleString("en-PK", { maximumFractionDigits: 0 })}`;
}

function percent(value) {
  return `${(Number(value || 0) * 100).toFixed(1)}%`;
}

function parseNumber(value) {
  return Number(String(value ?? "").replace(/,/g, "")) || 0;
}

function userErrors(result, field) {
  const errors = result?.[field]?.userErrors || [];
  if (errors.length) {
    throw new Error(`${field}: ${errors.map((error) => error.message).join("; ")}`);
  }
  return result[field];
}

async function loadCostBySku() {
  const rows = await getValues("'Variant Master'!A1:U1000");
  const header = rows[0] || [];
  const skuIndex = header.indexOf("SKU");
  const costIndex = header.indexOf("CostPerItem");
  if (skuIndex < 0 || costIndex < 0) {
    throw new Error("Variant Master must contain SKU and CostPerItem columns");
  }

  const costs = new Map();
  for (const row of rows.slice(1)) {
    const sku = String(row[skuIndex] || "").trim();
    const cost = parseNumber(row[costIndex]);
    if (sku && cost > 0) costs.set(sku, cost);
  }
  return costs;
}

async function fetchProducts() {
  const query = `
    query BundleProducts($cursor: String) {
      products(first: 100, after: $cursor, sortKey: TITLE) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id title handle tags onlineStoreUrl
          variants(first: 100) {
            nodes { id sku price inventoryQuantity }
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

function evaluateProduct(product, offer, costs) {
  const matched = product.variants.nodes
    .map((variant) => ({
      price: parseNumber(variant.price),
      cost: costs.get(String(variant.sku || "").trim()) || 0,
      inventory: Number(variant.inventoryQuantity || 0),
    }))
    .filter((variant) => variant.price > 0 && variant.cost > 0);

  if (!product.onlineStoreUrl || !offer.productTitles.has(product.title) || matched.length === 0) {
    return { eligible: false, margin: null, reason: "not approved or missing price/cost" };
  }

  const inStock = matched.some((variant) => variant.inventory > 0);
  const margins = matched.map((variant) => {
    const revenueExTax = (variant.price - offer.maximumPerUnitSaving) / TAX_DIVISOR;
    return revenueExTax > 0 ? (revenueExTax - variant.cost) / revenueExTax : -1;
  });
  const margin = Math.min(...margins);
  return {
    eligible: inStock && margin >= MIN_POST_DISCOUNT_MARGIN,
    margin,
    reason: !inStock ? "out of stock" : margin < MIN_POST_DISCOUNT_MARGIN ? "margin below floor" : "approved",
  };
}

async function mutateTags(productId, add, remove) {
  if (remove.length) {
    const data = await graphql(
      `mutation RemoveBundleTags($id: ID!, $tags: [String!]!) {
        tagsRemove(id: $id, tags: $tags) { userErrors { field message } }
      }`,
      { id: productId, tags: remove }
    );
    userErrors(data, "tagsRemove");
  }
  if (add.length) {
    const data = await graphql(
      `mutation AddBundleTags($id: ID!, $tags: [String!]!) {
        tagsAdd(id: $id, tags: $tags) { userErrors { field message } }
      }`,
      { id: productId, tags: add }
    );
    userErrors(data, "tagsAdd");
  }
}

async function findCollection(handle) {
  const data = await graphql(
    `query BundleCollection($query: String!) {
      collections(first: 10, query: $query) { nodes { id title handle } }
    }`,
    { query: `handle:${handle}` }
  );
  return data.collections.nodes.find((collection) => collection.handle === handle) || null;
}

async function createCollection(offer) {
  const data = await graphql(
    `mutation CreateBundleCollection($collection: CollectionCreateInput!) {
      collectionCreate(collection: $collection) {
        collection { id title handle }
        userErrors { field message }
      }
    }`,
    {
      collection: {
        title: offer.collectionTitle,
        handle: offer.collectionHandle,
        sortOrder: "BEST_SELLING",
        descriptionHtml: "Eligible full-margin products used by Wear Active quantity bundle offers.",
        sources: [
          {
            source: {
              title: `${offer.collectionTitle} tag rule`,
              description: `Products tagged ${offer.tag}`,
              targetType: "PRODUCTS",
              inclusion: {
                matchType: "ALL",
                conditions: [
                  { productTag: { relation: "TAGGED_WITH", values: [offer.tag], matchType: "ANY" } },
                ],
              },
            },
          },
        ],
      },
    }
  );
  return userErrors(data, "collectionCreate").collection;
}

async function publishCollection(collectionId) {
  const publications = await graphql(
    `query BundlePublications { publications(first: 50) { nodes { id name } } }`
  );
  const onlineStore = publications.publications.nodes.find((publication) => publication.name === "Online Store");
  if (!onlineStore) throw new Error("Online Store publication was not found");

  const data = await graphql(
    `mutation PublishBundleCollection($id: ID!, $input: [PublicationInput!]!) {
      publishablePublish(id: $id, input: $input) { userErrors { field message } }
    }`,
    { id: collectionId, input: [{ publicationId: onlineStore.id }] }
  );
  userErrors(data, "publishablePublish");
}

async function fetchBundleDiscounts() {
  const data = await graphql(`
    query BundleDiscounts {
      discountNodes(first: 100) {
        nodes {
          id
          discount {
            __typename
            ... on DiscountAutomaticBasic {
              title
              customerGets {
                items {
                  ... on DiscountCollections { collections(first: 20) { nodes { id title handle } } }
                }
              }
            }
          }
        }
      }
    }
  `);
  return data.discountNodes.nodes.filter((node) => node.discount.__typename === "DiscountAutomaticBasic");
}

async function updateDiscount(node, definition, collectionId) {
  const currentIds = node.discount.customerGets.items?.collections?.nodes?.map((collection) => collection.id) || [];
  const data = await graphql(
    `mutation UpdateBundleDiscount($id: ID!, $discount: DiscountAutomaticBasicInput!) {
      discountAutomaticBasicUpdate(id: $id, automaticBasicDiscount: $discount) {
        automaticDiscountNode { id }
        userErrors { field message }
      }
    }`,
    {
      id: node.id,
      discount: {
        title: definition.title,
        combinesWith: { orderDiscounts: false, productDiscounts: false, shippingDiscounts: false },
        minimumRequirement: { quantity: { greaterThanOrEqualToQuantity: String(definition.quantity) } },
        customerGets: {
          value: { discountAmount: { amount: String(definition.amount), appliesOnEachItem: false } },
          items: {
            collections: {
              add: [collectionId],
              remove: currentIds.filter((id) => id !== collectionId),
            },
          },
        },
      },
    }
  );
  userErrors(data, "discountAutomaticBasicUpdate");
}

async function main() {
  console.log(`Mode: ${APPLY ? "APPLY" : "DRY-RUN"}`);
  const [costs, products, discountNodes] = await Promise.all([
    loadCostBySku(),
    fetchProducts(),
    fetchBundleDiscounts(),
  ]);

  const eligibility = { tee: [], bottom: [] };
  const tagChanges = [];
  for (const product of products) {
    const desired = [];
    for (const [key, offer] of Object.entries(OFFERS)) {
      const result = evaluateProduct(product, offer, costs);
      if (result.eligible) {
        desired.push(offer.tag);
        eligibility[key].push({ product, ...result });
      }
    }

    const existingBundleTags = product.tags.filter((tag) =>
      ["bundle-tee", "bundle-bottom", "bundle-trouser"].includes(tag)
    );
    const add = desired.filter((tag) => !product.tags.includes(tag));
    const remove = existingBundleTags.filter((tag) => !desired.includes(tag));
    if (add.length || remove.length) tagChanges.push({ product, add, remove });
  }

  for (const [key, rows] of Object.entries(eligibility)) {
    console.log(`\n${key.toUpperCase()} ELIGIBLE (${rows.length})`);
    for (const row of rows) console.log(`  ${row.product.title} / ${row.product.handle} — ${percent(row.margin)}`);
  }

  console.log(`\nTag changes: ${tagChanges.length}`);
  for (const change of tagChanges) {
    console.log(`  ${change.product.handle}: +[${change.add.join(", ")}] -[${change.remove.join(", ")}]`);
  }
  console.log("\nDiscount plan:");
  for (const discount of DISCOUNTS) {
    console.log(`  ${discount.title}: ${money(discount.amount)} at ${discount.quantity} items`);
  }

  if (!APPLY) {
    console.log("\nDry-run only. Re-run with --apply after review.");
    return;
  }

  for (const change of tagChanges) {
    await mutateTags(change.product.id, change.add, change.remove);
  }

  const collections = {};
  for (const [key, offer] of Object.entries(OFFERS)) {
    let collection = await findCollection(offer.collectionHandle);
    if (!collection) collection = await createCollection(offer);
    await publishCollection(collection.id);
    collections[key] = collection;
    console.log(`Published ${collection.title} (${collection.handle})`);
  }

  for (const definition of DISCOUNTS) {
    const node = discountNodes.find((candidate) => candidate.discount.title === definition.title);
    if (!node) throw new Error(`Automatic discount not found: ${definition.title}`);
    await updateDiscount(node, definition, collections[definition.offer].id);
    console.log(`Updated ${definition.title}`);
  }

  console.log("Bundle eligibility and discounts updated successfully.");
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
