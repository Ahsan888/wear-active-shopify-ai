/**
 * Fetch Shopify orders with attribution surfaces (journey + cart attrs).
 * Pagination is bounded and fails loudly if results would be truncated.
 */
const shopifyClient = require("../shopify/client");
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
          email
          customer {
            id
          }
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

const DEFAULT_MAX_PAGES = 20;

/**
 * @param {{ since: string, until: string, maxPages?: number, graphqlFn?: Function }} opts
 */
async function fetchOrdersForAttribution({
  since,
  until,
  maxPages = DEFAULT_MAX_PAGES,
  graphqlFn,
} = {}) {
  const runGraphql = graphqlFn || shopifyClient.graphql;
  const query = `created_at:>=${since} created_at:<=${until}`;
  const orders = [];
  let cursor = null;
  const pages = Math.max(1, Number(maxPages) || DEFAULT_MAX_PAGES);

  for (let page = 0; page < pages; page += 1) {
    const data = await runGraphql(ORDER_ATTR_QUERY, { query, cursor });
    const conn = data.orders;
    for (const edge of conn.edges || []) {
      orders.push(edge.node);
    }
    if (!conn.pageInfo?.hasNextPage) {
      return orders;
    }
    if (page === pages - 1) {
      throw new Error(
        `Attribution order fetch exceeded maxPages=${pages}; refusing partial results`
      );
    }
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
  DEFAULT_MAX_PAGES,
};
