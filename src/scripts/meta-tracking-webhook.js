#!/usr/bin/env node
/**
 * Idempotently inspects or creates an ORDERS_CREATE webhook.
 * Default is staging and dry-run. Pass --production and --apply for production,
 * or --delete to remove the matching environment webhook.
 */
const { graphql } = require("../shopify/client");

const apply = process.argv.includes("--apply");
const remove = process.argv.includes("--delete");
const production = process.argv.includes("--production");
const environment = production ? "production" : "staging";
const workerName = `wear-active-meta-tracking-${environment}`;
const CALLBACK_URL = `https://${workerName}.amsuper870.workers.dev/v1/shopify/orders-create`;

async function list() {
  const data = await graphql(`
    query {
      webhookSubscriptions(first: 100, topics: [ORDERS_CREATE]) {
        nodes {
          id
          topic
          endpoint {
            __typename
            ... on WebhookHttpEndpoint { callbackUrl }
          }
        }
      }
    }
  `);
  return data.webhookSubscriptions.nodes || [];
}

async function main() {
  const existing = (await list()).find(
    (item) => item.endpoint?.callbackUrl === CALLBACK_URL
  );
  if (remove) {
    if (!existing) {
      console.log(`${environment} ORDERS_CREATE webhook is already absent.`);
      return;
    }
    const data = await graphql(
      `mutation DeleteWebhook($id: ID!) {
        webhookSubscriptionDelete(id: $id) {
          deletedWebhookSubscriptionId
          userErrors { field message }
        }
      }`,
      { id: existing.id }
    );
    const result = data.webhookSubscriptionDelete;
    if (result.userErrors?.length) {
      throw new Error(JSON.stringify(result.userErrors));
    }
    console.log(`Deleted ${environment} ORDERS_CREATE webhook: ${result.deletedWebhookSubscriptionId}`);
    console.log(CALLBACK_URL);
    return;
  }
  if (existing) {
    console.log(`${environment} ORDERS_CREATE webhook already exists: ${existing.id}`);
    console.log(CALLBACK_URL);
    return;
  }
  if (!apply) {
    console.log(`Dry run: ${environment} ORDERS_CREATE webhook is not registered.`);
    console.log(`Would create: ${CALLBACK_URL}`);
    return;
  }

  const data = await graphql(
    `mutation CreateWebhook($subscription: WebhookSubscriptionInput!) {
      webhookSubscriptionCreate(
        topic: ORDERS_CREATE
        webhookSubscription: $subscription
      ) {
        webhookSubscription { id topic endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } } }
        userErrors { field message }
      }
    }`,
    { subscription: { uri: CALLBACK_URL, format: "JSON" } }
  );
  const result = data.webhookSubscriptionCreate;
  if (result.userErrors?.length) {
    throw new Error(JSON.stringify(result.userErrors));
  }
  console.log(`Created ${environment} ORDERS_CREATE webhook: ${result.webhookSubscription.id}`);
  console.log(result.webhookSubscription.endpoint.callbackUrl);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
