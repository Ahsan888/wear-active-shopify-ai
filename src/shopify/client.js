require("dotenv").config();

const SHOP = String(process.env.SHOPIFY_SHOP || "")
  .replace(/\.myshopify\.com$/i, "")
  .trim();
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-07";

if (!SHOP) throw new Error("Missing SHOPIFY_SHOP in .env");
if (!CLIENT_ID || !CLIENT_SECRET) {
  throw new Error("Missing SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET in .env");
}

let cachedToken = null;
let cachedExpiresAt = 0;

async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < cachedExpiresAt - 60_000) return cachedToken;

  const url = `https://${SHOP}.myshopify.com/admin/oauth/access_token`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: "client_credentials",
    }),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Shopify token non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok || !data.access_token) {
    throw new Error(
      `Shopify token error (${res.status}): ${data.error_description || data.error || text}`
    );
  }
  cachedToken = data.access_token;
  const expiresIn = Number(data.expires_in || 86399);
  cachedExpiresAt = now + expiresIn * 1000;
  return cachedToken;
}

async function graphql(query, variables = {}) {
  const token = await getAccessToken();
  const url = `https://${SHOP}.myshopify.com/admin/api/${API_VERSION}/graphql.json`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`Shopify GraphQL HTTP ${res.status}: ${JSON.stringify(json)}`);
  }
  if (json.errors?.length) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

module.exports = {
  SHOP,
  API_VERSION,
  getAccessToken,
  graphql,
};
