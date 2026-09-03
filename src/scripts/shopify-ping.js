const { graphql, SHOP } = require("../shopify/client");

async function main() {
  const data = await graphql(`
    query {
      shop { name myshopifyDomain }
      productsCount { count }
    }
  `);
  console.log(`Shop: ${data.shop.name} (${data.shop.myshopifyDomain || SHOP})`);
  console.log(`Products: ${data.productsCount.count}`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exitCode = 1;
});
