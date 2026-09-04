require("dotenv").config();

const { graphql } = require("../shopify/client");
const { getValues } = require("../sheets/client");

const APPLY = process.argv.includes("--apply");
const PUBLISH = process.argv.includes("--publish");
const VERBOSE = process.argv.includes("--verbose");
const TAX_DIVISOR = 1.18;
const MIN_BUNDLE_MARGIN = 0.3;

const PACKS = [
  {
    handle: "mens-performance-set-black",
    title: "Men's Performance Set — Black",
    audience: "men",
    kind: "outfit",
    saving: 350,
    components: ["core-performance-tee-blk", "microflex-performance-shorts-blk"],
  },
  {
    handle: "mens-everyday-set",
    title: "Men's Everyday Set",
    audience: "men",
    kind: "outfit",
    saving: 300,
    components: ["elevate-polo-blk", "strideflex-pants"],
  },
  {
    handle: "mens-everyday-pleated-set",
    title: "Men's Everyday Pleated Set",
    audience: "men",
    kind: "outfit",
    saving: 300,
    components: ["elevate-polo-blk", "formflex-pleated-pants-blk"],
  },
  {
    handle: "womens-active-set-black",
    title: "Women's Active Set — Black",
    audience: "women",
    kind: "outfit",
    saving: 300,
    components: ["aura-oversized-performance-tee-blk", "eclipse-relaxed-trousers-blk"],
  },
  {
    handle: "phantom-flex-tee-2-pack",
    title: "Phantom Flex Tee — 2 Pack",
    audience: "men",
    kind: "top-pack",
    saving: 350,
    components: ["phantom-flex-tee-wht", "phantomflex-performance-tee-blk"],
  },
  {
    handle: "phantom-flex-tee-3-pack",
    title: "Phantom Flex Tee — 3 Pack",
    audience: "men",
    kind: "top-pack",
    saving: 600,
    components: ["phantom-flex-tee-wht", "phantomflex-performance-tee-blk", "phantom-flex-tee-gry"],
  },
  {
    handle: "coreflex-performance-tee-2-pack",
    title: "CoreFlex Performance Tee — 2 Pack",
    audience: "men",
    kind: "top-pack",
    saving: 300,
    components: ["coreflex-performance-tee-copy-blk", "coreflex-performance-tee-gre"],
  },
  {
    handle: "coreflex-performance-tee-3-pack",
    title: "CoreFlex Performance Tee — 3 Pack",
    audience: "men",
    kind: "top-pack",
    saving: 550,
    components: ["coreflex-performance-tee-copy-blk", "coreflex-performance-tee-gre", "coreflex-performance-tee-brw"],
  },
  {
    handle: "core-performance-tee-2-pack",
    title: "Core Performance Tee — 2 Pack",
    audience: "men",
    kind: "top-pack",
    saving: 300,
    components: ["core-performance-tee-blk", "core-performance-tee-wht"],
  },
  {
    handle: "core-performance-tee-3-pack",
    title: "Core Performance Tee — 3 Pack",
    audience: "men",
    kind: "top-pack",
    saving: 600,
    components: ["core-performance-tee-blk", "core-performance-tee-wht", "core-performance-tee-blu"],
  },
  {
    handle: "corefit-performance-tee-2-pack",
    title: "CoreFit Women's Performance Tee — 2 Pack",
    audience: "women",
    kind: "top-pack",
    saving: 300,
    components: ["corefit-performance-tee-blk", "corefit-performance-tee-blu"],
  },
  {
    handle: "aura-oversized-performance-tee-2-pack",
    title: "Aura Oversized Performance Tee — 2 Pack",
    audience: "women",
    kind: "top-pack",
    saving: 300,
    components: ["aura-oversized-performance-tee-blk", "aura-oversized-performance-tee-blu"],
  },
  {
    handle: "coreflex-womens-long-sleeve-2-pack",
    title: "CoreFlex Women's Long Sleeve — 2 Pack",
    audience: "women",
    kind: "top-pack",
    saving: 200,
    components: [
      "coreflex-women-s-performance-long-sleeve-blk",
      "coreflex-women-s-performance-long-sleeve-blu",
    ],
  },
  {
    handle: "coreflex-womens-long-sleeve-3-pack",
    title: "CoreFlex Women's Long Sleeve — 3 Pack",
    audience: "women",
    kind: "top-pack",
    saving: 300,
    components: [
      "coreflex-women-s-performance-long-sleeve-blk",
      "coreflex-women-s-performance-long-sleeve-blu",
      "coreflex-women-s-performance-long-sleeve-gry",
    ],
  },
  {
    handle: "velocity-quarter-zip-2-pack",
    title: "Velocity Quarter Zip — 2 Pack",
    audience: "men",
    kind: "top-pack",
    saving: 300,
    components: ["velocity-quarter-zip-blk", "velocity-quarter-zip-blu"],
  },
  {
    handle: "velocity-quarter-zip-3-pack",
    title: "Velocity Quarter Zip — 3 Pack",
    audience: "men",
    kind: "top-pack",
    saving: 550,
    components: ["velocity-quarter-zip-blk", "velocity-quarter-zip-blu", "velocity-quarter-zip-copy"],
  },
  {
    handle: "core-compression-half-sleeve-2-pack",
    title: "Core Compression Half Sleeve — 2 Pack",
    audience: "men",
    kind: "top-pack",
    saving: 300,
    components: ["core-compression-shirt-blk-half", "core-compression-shirt-blu-half"],
  },
  {
    handle: "core-compression-full-sleeve-2-pack",
    title: "Core Compression Full Sleeve — 2 Pack",
    audience: "men",
    kind: "top-pack",
    saving: 200,
    components: ["core-compression-shirt-blk-full", "core-compression-shirt-blu-full"],
  },
  {
    handle: "oversized-cotton-tee-2-pack",
    title: "Oversized Cotton Tee — 2 Pack",
    audience: "men",
    kind: "top-pack",
    saving: 350,
    components: ["oversized-cotton-tee-blk", "oversized-cotton-tee-gry"],
  },
  {
    handle: "microflex-performance-shorts-2-pack",
    title: "MicroFlex Performance Shorts — 2 Pack",
    audience: "men",
    kind: "bottom-pack",
    saving: 250,
    components: ["microflex-performance-shorts-blk", "microflex-performance-shorts-blu"],
  },
  {
    handle: "strideflex-training-shorts-3-pack",
    title: "StrideFlex Training Shorts — 3 Pack",
    audience: "men",
    kind: "bottom-pack",
    saving: 500,
    components: [
      "strideflex-training-shorts-blk",
      "strideflex-training-shorts-gre",
      "strideflex-training-shorts-blu",
    ],
  },
  {
    handle: "flexflow-trouser-2-pack",
    title: "FlexFlow Micro Stretch Trousers — 2 Pack",
    audience: "men",
    kind: "bottom-pack",
    saving: 200,
    components: ["flexflow-micro-stretch-trousers-blk", "flexflow-micro-stretch-trousers-blu"],
  },
  {
    handle: "motionfit-trousers-2-pack",
    title: "MotionFit Trousers — 2 Pack",
    audience: "men",
    kind: "bottom-pack",
    saving: 200,
    components: ["motionfit-trousers-regular-fit-blk", "motionfit-trousers-regular-fit-gre"],
  },
  {
    handle: "coreactive-trousers-2-pack",
    title: "CoreActive Trousers — 2 Pack",
    audience: "men",
    kind: "bottom-pack",
    saving: 150,
    components: ["coreactive-trousers-relaxed-fit", "coreactive-trousers-relaxed-fit-blu"],
  },
  {
    handle: "aeroflex-womens-quarter-zip-2-pack",
    title: "AeroFlex Women's Quarter Zip — 2 Pack",
    audience: "women",
    kind: "top-pack",
    saving: 150,
    components: ["aeroflex-women-s-performance-quarter-zip-blk", "aeroflex-women-s-performance-quarter-zip-blu"],
  },
  {
    handle: "womens-flexflow-trousers-2-pack",
    title: "Women's FlexFlow Trousers — 2 Pack",
    audience: "women",
    kind: "bottom-pack",
    saving: 150,
    components: ["flexflow-micro-stretch-trousers-blk-f", "flexflow-micro-stretch-trousers-blu-f"],
  },
];

function number(value) {
  return Number(String(value ?? "").replace(/,/g, "")) || 0;
}

async function loadSheetMap(range, keyName, valueName) {
  const rows = await getValues(range);
  const header = rows[0] || [];
  const keyIndex = header.indexOf(keyName);
  const valueIndex = header.indexOf(valueName);
  if (keyIndex < 0 || valueIndex < 0) throw new Error(`${range} is missing ${keyName} or ${valueName}`);
  const values = new Map();
  for (const row of rows.slice(1)) {
    const key = String(row[keyIndex] || "").trim();
    if (key) values.set(key, number(row[valueIndex]));
  }
  return values;
}

async function loadSalesUnits() {
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
    if (!sku || ["voided", "refunded", "partially_refunded"].includes(status) || number(row[netIndex]) <= 0) continue;
    units.set(sku, (units.get(sku) || 0) + number(row[quantityIndex]));
  }
  return units;
}

async function fetchProducts() {
  const products = [];
  let cursor = null;
  do {
    const data = await graphql(
      `query ProductPackCandidates($cursor: String) {
        products(first: 100, after: $cursor, query: "status:active", sortKey: TITLE) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id title handle productType tags onlineStoreUrl
            featuredMedia { preview { image { url } } }
            options { id name optionValues { name } }
            variants(first: 100) {
              nodes { id title sku price compareAtPrice inventoryQuantity selectedOptions { name value } }
            }
          }
        }
      }`,
      { cursor }
    );
    products.push(...data.products.nodes);
    cursor = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
  } while (cursor);
  return products;
}

function audience(product) {
  return product.tags
    .filter((tag) => tag === "gender-men" || tag === "gender-women")
    .map((tag) => tag.replace("gender-", ""));
}

function productSummary(product, costs, units) {
  const variants = product.variants.nodes.filter((variant) => number(variant.price) > 0);
  const price = Math.min(...variants.map((variant) => number(variant.price)));
  const costValues = variants.map((variant) => costs.get(String(variant.sku || "").trim())).filter(Boolean);
  const cost = costValues.length ? Math.max(...costValues) : 0;
  const grossMargin = price && cost ? (price / TAX_DIVISOR - cost) / (price / TAX_DIVISOR) : 0;
  const sales = variants.reduce((sum, variant) => sum + (units.get(String(variant.sku || "").trim()) || 0), 0);
  const inventory = variants.reduce((sum, variant) => sum + Math.max(0, Number(variant.inventoryQuantity || 0)), 0);
  const onSale = variants.some((variant) => number(variant.compareAtPrice) > number(variant.price));
  return { price, cost, grossMargin, sales, inventory, onSale };
}

function packSummary(pack, productsByHandle, costs, units) {
  const components = pack.components.map((handle) => productsByHandle.get(handle));
  if (components.some((product) => !product)) {
    const missing = pack.components.filter((handle, index) => !components[index]);
    throw new Error(`${pack.title} is missing component products: ${missing.join(", ")}`);
  }

  const summaries = components.map((product) => productSummary(product, costs, units));
  const compareAtPrice = summaries.reduce((sum, component) => sum + component.price, 0);
  const price = compareAtPrice - pack.saving;
  const cost = summaries.reduce((sum, component) => sum + component.cost, 0);
  const revenueExTax = price / TAX_DIVISOR;
  const margin = revenueExTax > 0 ? (revenueExTax - cost) / revenueExTax : -1;
  const errors = [];
  if (summaries.some((component) => component.onSale)) errors.push("component on sale");
  if (summaries.some((component) => component.inventory <= 0)) errors.push("component out of stock");
  if (summaries.some((component) => component.cost <= 0)) errors.push("missing component cost");
  if (margin < MIN_BUNDLE_MARGIN) errors.push(`margin below ${(MIN_BUNDLE_MARGIN * 100).toFixed(0)}% floor`);
  return { ...pack, components, summaries, compareAtPrice, price, cost, margin, errors };
}

function availableValues(product, optionName) {
  const values = new Set();
  for (const variant of product.variants.nodes) {
    if (Number(variant.inventoryQuantity || 0) <= 0) continue;
    const selected = variant.selectedOptions.find((option) => option.name === optionName);
    if (selected?.value) values.add(selected.value);
  }
  return [...values];
}

function componentInput(product, label) {
  const optionSelections = product.options
    .map((option) => ({ option, values: availableValues(product, option.name) }))
    .filter(({ values }) => values.length > 0)
    .map(({ option, values }) => ({
      componentOptionId: option.id,
      name: `${label} ${option.name.toLowerCase()}`,
      values,
    }));
  return { productId: product.id, quantity: 1, optionSelections };
}

function bundleInput(pack) {
  const input = {
    title: pack.title,
    components: pack.components.map((product, index) => {
      const label = pack.kind === "outfit" ? (index === 0 ? "Top" : "Bottom") : `Item ${index + 1}`;
      return componentInput(product, label);
    }),
  };

  if (pack.kind !== "outfit") {
    const sizeOptions = pack.components.map((product) =>
      product.options.find((option) => option.name.toLowerCase() === "size")
    );
    if (sizeOptions.every(Boolean)) {
      const commonSizes = availableValues(pack.components[0], sizeOptions[0].name).filter((size) =>
        pack.components.every((product, index) => availableValues(product, sizeOptions[index].name).includes(size))
      );
      if (commonSizes.length) {
        input.consolidatedOptions = [
          {
            optionName: "Size",
            optionSelections: commonSizes.map((size) => ({
              optionValue: size,
              components: sizeOptions.map((option) => ({
                componentOptionId: option.id,
                componentOptionValue: size,
              })),
            })),
          },
        ];
      }
    }
  }

  return input;
}

function checkUserErrors(payload, field) {
  const errors = payload?.[field]?.userErrors || [];
  if (errors.length) throw new Error(`${field}: ${errors.map((error) => error.message).join("; ")}`);
  return payload[field];
}

async function withProductRetry(action, label) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      const retryable = /currently being modified|too_many_parallel|throttled/i.test(String(error.message || error));
      if (!retryable || attempt === 7) throw error;
      const delay = 750 * (attempt + 1);
      console.log(`  Waiting ${delay}ms to retry ${label}...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error(`Could not complete ${label}`);
}

async function findPackProduct(pack) {
  const data = await graphql(
    `query ExistingProductPack($query: String!) {
      products(first: 10, query: $query) {
        nodes {
          id title handle status tags totalInventory
          media(first: 10) { nodes { id } }
          variants(first: 250) { nodes { id price compareAtPrice availableForSale requiresComponents } }
        }
      }
    }`,
    { query: `handle:${pack.handle}` }
  );
  return data.products.nodes.find((product) => product.handle === pack.handle) || null;
}

async function startBundleOperation(pack, existing) {
  if (existing) {
    const data = await withProductRetry(() => graphql(
      `mutation UpdateProductPack($input: ProductBundleUpdateInput!) {
        productBundleUpdate(input: $input) {
          productBundleOperation { id status }
          userErrors { field message }
        }
      }`,
      { input: { productId: existing.id, ...bundleInput(pack) } }
    ), `bundle update for ${pack.handle}`);
    return checkUserErrors(data, "productBundleUpdate").productBundleOperation;
  }

  const data = await graphql(
    `mutation CreateProductPack($input: ProductBundleCreateInput!) {
      productBundleCreate(input: $input) {
        productBundleOperation { id status }
        userErrors { field message }
      }
    }`,
    { input: bundleInput(pack) }
  );
  return checkUserErrors(data, "productBundleCreate").productBundleOperation;
}

async function pollBundleOperation(operationId) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const data = await graphql(
      `query ProductPackOperation($id: ID!) {
        productOperation(id: $id) {
          ... on ProductBundleOperation {
            id status
            product {
              id title handle
              media(first: 10) { nodes { id } }
              variants(first: 250) { nodes { id } }
            }
            userErrors { field message code }
          }
        }
      }`,
      { id: operationId }
    );
    const operation = data.productOperation;
    if (!operation) throw new Error(`Bundle operation disappeared: ${operationId}`);
    if (operation.userErrors?.length) {
      throw new Error(operation.userErrors.map((error) => error.message).join("; "));
    }
    if (operation.status === "COMPLETE") return operation.product;
    if (["FAILED", "CANCELLED"].includes(operation.status)) {
      throw new Error(`Bundle operation ${operationId} ended with ${operation.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for bundle operation ${operationId}`);
}

function descriptionHtml(pack) {
  const products = pack.components.map((product) => `<li>${product.title}</li>`).join("");
  return `<p>A coordinated Wear Active bundle with automatic inventory tracking for every included item.</p><ul>${products}</ul><p>Bundle saving: Rs. ${pack.saving.toLocaleString("en-PK")}.</p><p>Select the size for each item before adding the set to your cart.</p>`;
}

async function updatePackMerchandising(pack, product) {
  const update = await withProductRetry(() => graphql(
    `mutation UpdateProductPackDetails($product: ProductUpdateInput!) {
      productUpdate(product: $product) {
        product { id title handle status tags }
        userErrors { field message }
      }
    }`,
    {
      product: {
        id: product.id,
        title: pack.title,
        handle: pack.handle,
        descriptionHtml: descriptionHtml(pack),
        vendor: "Wear Active",
        productType: "Bundles",
        status: PUBLISH ? "ACTIVE" : "DRAFT",
        tags: ["wa-product-pack", `bundle-${pack.kind}`, `gender-${pack.audience}`],
        seo: {
          title: `${pack.title} | Wear Active`,
          description: `Save Rs. ${pack.saving.toLocaleString("en-PK")} with the ${pack.title} bundle.`,
        },
      },
    }
  ), `product details for ${pack.handle}`);
  checkUserErrors(update, "productUpdate");

  const media = product.media.nodes.length
    ? []
    : pack.components
        .map((component) => component.featuredMedia?.preview?.image?.url)
        .filter((url, index, urls) => url && urls.indexOf(url) === index)
        .map((originalSource, index) => ({
          originalSource,
          mediaContentType: "IMAGE",
          alt: `${pack.title} — included item ${index + 1}`,
        }));
  const variants = product.variants.nodes.map((variant) => ({
    id: variant.id,
    price: String(pack.price),
    compareAtPrice: String(pack.compareAtPrice),
    taxable: true,
  }));
  const variantUpdate = await withProductRetry(() => graphql(
    `mutation PriceProductPack($productId: ID!, $variants: [ProductVariantsBulkInput!]!, $media: [CreateMediaInput!]) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants, media: $media) {
        product { id }
        productVariants { id price compareAtPrice }
        userErrors { field message }
      }
    }`,
    { productId: product.id, variants, media }
  ), `prices and media for ${pack.handle}`);
  checkUserErrors(variantUpdate, "productVariantsBulkUpdate");
}

async function applyPack(pack) {
  const existing = await findPackProduct(pack);
  const operation = await startBundleOperation(pack, existing);
  const product = await pollBundleOperation(operation.id);
  await updatePackMerchandising(pack, product);
  console.log(`${existing ? "Updated" : "Created"} draft: ${pack.title} (${pack.handle})`);
}

async function verifyPack(pack) {
  const product = await findPackProduct(pack);
  if (!product) throw new Error(`Verification failed: missing ${pack.handle}`);
  const wrongPrice = product.variants.nodes.filter(
    (variant) => number(variant.price) !== pack.price || number(variant.compareAtPrice) !== pack.compareAtPrice
  );
  const nonBundleVariants = product.variants.nodes.filter((variant) => !variant.requiresComponents);
  const expectedStatus = PUBLISH ? "ACTIVE" : "DRAFT";
  if (product.status !== expectedStatus || wrongPrice.length || nonBundleVariants.length || product.media.nodes.length === 0) {
    throw new Error(
      `Verification failed for ${pack.handle}: status=${product.status}, variants=${product.variants.nodes.length}, ` +
        `wrongPrice=${wrongPrice.length}, nonBundle=${nonBundleVariants.length}, media=${product.media.nodes.length}`
    );
  }
  console.log(
    `Verified ${expectedStatus.toLowerCase()}: ${pack.handle} | variants=${product.variants.nodes.length} | ` +
      `inventory=${product.totalInventory} | media=${product.media.nodes.length}`
  );
  return product;
}

async function onlineStorePublication() {
  const data = await graphql(`query ProductPackPublications { publications(first: 50) { nodes { id name } } }`);
  const publication = data.publications.nodes.find((candidate) => candidate.name === "Online Store");
  if (!publication) throw new Error("Online Store publication was not found");
  return publication;
}

async function publishResource(resourceId, publicationId) {
  const data = await graphql(
    `mutation PublishProductPackResource($id: ID!, $input: [PublicationInput!]!) {
      publishablePublish(id: $id, input: $input) { userErrors { field message } }
    }`,
    { id: resourceId, input: [{ publicationId }] }
  );
  checkUserErrors(data, "publishablePublish");
}

async function findPackCollection() {
  const data = await graphql(
    `query ProductPackCollection($query: String!) {
      collections(first: 10, query: $query) { nodes { id title handle } }
    }`,
    { query: "handle:bundles-packs" }
  );
  return data.collections.nodes.find((collection) => collection.handle === "bundles-packs") || null;
}

async function ensurePackCollection() {
  const existing = await findPackCollection();
  if (existing) return existing;
  const data = await graphql(
    `mutation CreateProductPackCollection($collection: CollectionCreateInput!) {
      collectionCreate(collection: $collection) {
        collection { id title handle }
        userErrors { field message }
      }
    }`,
    {
      collection: {
        title: "Bundles & Packs",
        handle: "bundles-packs",
        sortOrder: "BEST_SELLING",
        descriptionHtml:
          "<p>Build your rotation for less with coordinated outfit sets and value packs. Every bundle tracks the stock of its included Wear Active pieces.</p>",
        seo: {
          title: "Activewear Bundles & Value Packs | Wear Active",
          description: "Shop Wear Active outfit bundles and multi-packs for men and women, with coordinated colours and better value.",
        },
        sources: [
          {
            source: {
              title: "Wear Active product pack tag rule",
              description: "Products tagged wa-product-pack",
              targetType: "PRODUCTS",
              inclusion: {
                matchType: "ALL",
                conditions: [
                  { productTag: { relation: "TAGGED_WITH", values: ["wa-product-pack"], matchType: "ANY" } },
                ],
              },
            },
          },
        ],
      },
    }
  );
  return checkUserErrors(data, "collectionCreate").collection;
}

function menuItemInput(item) {
  const input = {
    id: item.id,
    title: item.title,
    type: item.type,
    items: (item.items || []).map(menuItemInput),
  };
  if (item.url) input.url = item.url;
  if (item.resourceId) input.resourceId = item.resourceId;
  if (item.tags?.length) input.tags = item.tags;
  return input;
}

async function addCollectionToMainMenu(collection) {
  const data = await graphql(`query ProductPackMainMenu {
    menus(first: 50) {
      nodes {
        id title handle
        items {
          id title type url resourceId tags
          items {
            id title type url resourceId tags
            items { id title type url resourceId tags }
          }
        }
      }
    }
  }`);
  const menu = data.menus.nodes.find((candidate) => candidate.handle === "main-menu");
  if (!menu) throw new Error("Main menu (main-menu) was not found");
  const items = menu.items.map(menuItemInput).filter((item) => item.title.toLowerCase() !== "bundles");
  const bundleItem = {
    title: "Bundles",
    type: "COLLECTION",
    resourceId: collection.id,
    url: "/collections/bundles-packs",
    items: [],
  };
  const saleIndex = items.findIndex((item) => item.title.toLowerCase() === "sale");
  if (saleIndex >= 0) items.splice(saleIndex, 0, bundleItem);
  else items.push(bundleItem);

  const update = await graphql(
    `mutation UpdateProductPackMenu($id: ID!, $title: String!, $items: [MenuItemUpdateInput!]!) {
      menuUpdate(id: $id, title: $title, items: $items) {
        menu { id handle items { id title url } }
        userErrors { field message }
      }
    }`,
    { id: menu.id, title: menu.title, items }
  );
  checkUserErrors(update, "menuUpdate");
  console.log("Added Bundles to the main menu.");
}

async function publishPackCatalog(products) {
  const publication = await onlineStorePublication();
  const collection = await ensurePackCollection();
  for (const product of products) await publishResource(product.id, publication.id);
  await publishResource(collection.id, publication.id);
  await addCollectionToMainMenu(collection);
  console.log(`Published ${products.length} bundle products and the Bundles & Packs collection.`);
}

async function main() {
  if (PUBLISH && !APPLY) throw new Error("Use --publish together with --apply");
  console.log(`Mode: ${PUBLISH ? "APPLY + PUBLISH" : APPLY ? "APPLY — DRAFT PRODUCTS" : "DRY-RUN"}`);
  const [products, costs, units, capability] = await Promise.all([
    fetchProducts(),
    loadSheetMap("'Variant Master'!A1:U1000", "SKU", "CostPerItem"),
    loadSalesUnits(),
    graphql(`query ProductPackCapability {
      currentAppInstallation { accessScopes { handle } }
      bundleFeatureType: __type(name: "BundlesFeature") { fields { name } }
      shop { features { bundles { eligibleForBundles ineligibilityReason sellsBundles } } }
    }`),
  ]);

  const scopes = capability.currentAppInstallation.accessScopes.map((scope) => scope.handle);
  console.log(`Bundle eligible: ${capability.shop.features.bundles.eligibleForBundles}`);
  console.log(`Ineligibility reason: ${capability.shop.features.bundles.ineligibilityReason || "none"}`);
  console.log(`Store sells bundles: ${capability.shop.features.bundles.sellsBundles}`);
  console.log(`write_products scope: ${scopes.includes("write_products")}`);
  console.log(`write_online_store_navigation scope: ${scopes.includes("write_online_store_navigation")}`);
  console.log(`Bundle capability fields: ${capability.bundleFeatureType.fields.map((field) => field.name).join(", ")}`);

  const rows = products
    .map((product) => ({ product, ...productSummary(product, costs, units) }))
    .filter((row) => row.product.onlineStoreUrl && ["Shirts", "Hoodies", "Jackets", "Trousers", "Shorts"].includes(row.product.productType))
    .filter((row) => audience(row.product).length && !row.onSale && row.inventory > 0 && row.cost > 0)
    .sort((left, right) => right.sales - left.sales || right.grossMargin - left.grossMargin);

  const productsByHandle = new Map(products.map((product) => [product.handle, product]));
  const proposedPacks = PACKS.map((definition) => packSummary(definition, productsByHandle, costs, units));
  console.log("\nPROPOSED PRODUCT PACKS");
  for (const pack of proposedPacks) {
    console.log(
      `${pack.title} | ${pack.components.map((product) => product.handle).join(" + ")} | ` +
        `Rs.${pack.compareAtPrice.toLocaleString("en-PK")} -> Rs.${pack.price.toLocaleString("en-PK")} | ` +
        `margin=${(pack.margin * 100).toFixed(1)}% | ${pack.errors.length ? pack.errors.join(", ") : "APPROVED"}`
    );
    for (const product of pack.components) {
      console.log(`  ${product.handle}: ${product.options.map((option) => `${option.name}=[${option.optionValues.map((value) => value.name).join(", ")}]`).join("; ")}`);
    }
  }

  if (VERBOSE) {
    console.log("\nFULL-PRICE CANDIDATES");
    for (const row of rows) {
      console.log(
        [
          row.product.handle,
          row.product.productType,
          audience(row.product).join("+"),
          `units=${row.sales}`,
          `stock=${row.inventory}`,
          `price=${row.price}`,
          `margin=${(row.grossMargin * 100).toFixed(1)}%`,
        ].join(" | ")
      );
    }
  }

  const blocked = proposedPacks.filter((pack) => pack.errors.length);
  const approved = proposedPacks.filter((pack) => pack.errors.length === 0);
  if (blocked.length) {
    console.log(`\nBLOCKED BY SAFETY RULES (${blocked.length})`);
    for (const pack of blocked) console.log(`  ${pack.title}: ${pack.errors.join(", ")}`);
  }
  if (!capability.shop.features.bundles.eligibleForBundles) {
    throw new Error(`Store is not eligible for bundles: ${capability.shop.features.bundles.ineligibilityReason}`);
  }
  if (!scopes.includes("write_products")) throw new Error("Shopify app is missing write_products");
  if (PUBLISH && !scopes.includes("write_online_store_navigation")) {
    throw new Error("Shopify app is missing write_online_store_navigation");
  }

  if (!APPLY) {
    console.log("\nDry-run only. Re-run with --apply to create or update these products as drafts.");
    return;
  }

  for (const pack of approved) await applyPack(pack);
  const verifiedProducts = [];
  for (const pack of approved) verifiedProducts.push(await verifyPack(pack));
  if (PUBLISH) await publishPackCatalog(verifiedProducts);
  console.log(
    `\nCreated or updated ${approved.length} native bundle products as ${PUBLISH ? "active" : "drafts"}; ` +
      `${blocked.length} blocked.`
  );
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
