#!/usr/bin/env node
/**
 * Smoke-test Meta Marketing API credentials + ad account insights access.
 *
 * Usage: npm run meta:check
 */
const {
  graphGet,
  getAdAccountId,
  META_API_VERSION,
} = require("../meta/client");
const { hintForMetaError, todayInTimezone, ymd } = require("../meta/cli");

async function main() {
  const actId = getAdAccountId();

  const accountRes = await graphGet(actId, {
    fields:
      "id,name,account_status,currency,timezone_name,business_name,amount_spent",
  });
  const account = accountRes.data;

  // Lightweight insights probe: account-timezone "today" (empty is OK)
  const day = ymd(todayInTimezone(account.timezone_name));

  let insightsOk = false;
  let insightsNote = "";
  try {
    const insightsRes = await graphGet(`${actId}/insights`, {
      fields: "spend,impressions,actions",
      time_range: JSON.stringify({ since: day, until: day }),
      level: "account",
      limit: 1,
    });
    insightsOk = true;
    const rows = insightsRes.data?.data || [];
    insightsNote = rows.length
      ? `OK (${rows.length} row)`
      : "OK (no delivery today — empty insights is fine)";
  } catch (err) {
    insightsNote = err.message || String(err);
    throw err;
  }

  console.log("META ADS CONNECTION OK");
  console.log("");
  console.log(`Account: ${account.name || "(unnamed)"}`);
  console.log(`Account ID: ${account.id || actId}`);
  console.log(`Currency: ${account.currency || "—"}`);
  console.log(`Timezone: ${account.timezone_name || "—"}`);
  if (account.business_name) {
    console.log(`Business: ${account.business_name}`);
  }
  console.log(`Account status: ${account.account_status}`);
  console.log(`API version: ${META_API_VERSION}`);
  console.log(`Insights access: ${insightsOk ? insightsNote : "FAILED"}`);
}

main().catch((err) => {
  console.error("META ADS CONNECTION FAILED");
  console.error(err.message || err);
  const hint = hintForMetaError(err);
  if (hint) console.error(hint);
  process.exitCode = 1;
});
