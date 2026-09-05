/**
 * Fetch Shopify orders with attribution surfaces (journey + cart attrs).
 */
const { graphql } = require("../shopify/client");
const { trailingWindow, todayYmd } = require("../operations/dates");

const ORDER_ATTR_QUERY = `#graphql
  query OrdersAttribution($query: String!, $cursor: String) {
    orders(first: 50, after: $cursor, sortKey: CREATED_AT, reverse: true, query: $query) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          name
          createdAt
          customAttributes { key value }
          customerJourneySummary {
            ready
            momentsCount { count }
            firstVisit {
              landingPage
              referrerUrl
              source
              utmParameters { source medium campaign content term }
              occurredAt
            }
            lastVisit {
              landingPage
              referrerUrl
              source
              utmParameters { source medium campaign content term }
              occurredAt
            }
          }
        }
      }
    }
  }
`;

async function fetchOrdersForAttribution({ since, until, maxPages = 20 } = {}) {
  const query = `created_at:>=${since} created_at:<=${until}`;
  const orders = [];
  let cursor = null;
  for (let page = 0; page < maxPages; page += 1) {
    const data = await graphql(ORDER_ATTR_QUERY, { query, cursor });
    const conn = data.orders;
    for (const edge of conn.edges || []) {
      orders.push(edge.node);
    }
    if (!conn.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return orders;
}

function resolveAttributionWindow(args = {}) {
  if (args.since && args.until) {
    return { since: args.since, until: args.until };
  }
  const days = Number(args.days || 7);
  const until = args.until || todayYmd();
  return trailingWindow(until, days);
}

module.exports = {
  fetchOrdersForAttribution,
  resolveAttributionWindow,
  ORDER_ATTR_QUERY,
};
