/**
 * Fetch sellable Shopify inventory for active product variants.
 * Reuses the low-stock GraphQL surface (inventoryQuantity) without write APIs.
 */
const shopifyClient = require("../shopify/client");

const VARIANTS_QUERY = `#graphql
  query InventoryVariants($cursor: String) {
    productVariants(first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          sku
          title
          displayName
          inventoryQuantity
          product {
            id
            title
            status
            handle
          }
          selectedOptions { name value }
        }
      }
    }
  }
`;

/**
 * @param {{ graphqlFn?: Function, includeDraft?: boolean, maxPages?: number }} opts
 * @returns {Promise<object[]>}
 */
async function fetchShopifyInventory(opts = {}) {
  const runGraphql = opts.graphqlFn || shopifyClient.graphql;
  const includeDraft = Boolean(opts.includeDraft);
  const maxPages = Math.max(1, Number(opts.maxPages) || 200);
  const out = [];
  let cursor = null;

  for (let page = 0; page < maxPages; page += 1) {
    const data = await runGraphql(VARIANTS_QUERY, { cursor });
    const conn = data.productVariants;
    for (const { node } of conn.edges || []) {
      const status = node.product?.status;
      if (!includeDraft && status !== "ACTIVE") continue;
      const optsMap = Object.fromEntries(
        (node.selectedOptions || []).map((o) => [
          String(o.name || "").toLowerCase(),
          o.value,
        ])
      );
      const sku = String(node.sku || "").trim();
      out.push({
        variant_id: node.id || null,
        sku: sku || null,
        product: node.product?.title || null,
        product_handle: node.product?.handle || null,
        product_status: status || null,
        variant: node.title || null,
        display_name: node.displayName || null,
        size: optsMap.size || "",
        color: optsMap.color || optsMap.colour || "",
        current_stock:
          node.inventoryQuantity == null ? null : Number(node.inventoryQuantity),
      });
    }
    if (!conn.pageInfo?.hasNextPage) return out;
    if (page === maxPages - 1) {
      throw new Error(
        `Inventory variant fetch exceeded maxPages=${maxPages}; refusing partial results`
      );
    }
    cursor = conn.pageInfo.endCursor;
  }
  return out;
}

module.exports = {
  fetchShopifyInventory,
  VARIANTS_QUERY,
};
