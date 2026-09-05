#!/usr/bin/env node
/**
 * Attribution diagnostics CLI.
 *
 *   npm run attribution:report -- --days=7
 *   npm run attribution:report -- --since=2026-08-01 --until=2026-09-06 --json
 */
require("dotenv").config();
const { hintForMetaError } = require("../meta/cli");
const {
  fetchOrdersForAttribution,
  resolveAttributionWindow,
} = require("../attribution/fetchOrders");
const { buildAttributionDiagnostics } = require("../attribution/coverage");
const { printAttributionReport } = require("../attribution/report");
const { loadDecisionInputs } = require("../decisions/loadInputs");

function parseArgs(argv) {
  const out = { json: false, days: null, since: null, until: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--json") {
      out.json = true;
      continue;
    }
    if (a.startsWith("--days=")) {
      out.days = Number(a.slice(7));
      continue;
    }
    if (a === "--days") {
      out.days = Number(argv[++i]);
      continue;
    }
    if (a.startsWith("--since=")) {
      out.since = a.slice(8);
      continue;
    }
    if (a === "--since") {
      out.since = argv[++i];
      continue;
    }
    if (a.startsWith("--until=")) {
      out.until = a.slice(8);
      continue;
    }
    if (a === "--until") {
      out.until = argv[++i];
      continue;
    }
    throw new Error(`Unknown argument: ${a}`);
  }
  if (out.days != null && (!Number.isInteger(out.days) || out.days < 1)) {
    throw new Error("Invalid --days");
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const window = resolveAttributionWindow(args);
  const orders = await fetchOrdersForAttribution(window);

  let metaEntities = {};
  try {
    const inputs = await loadDecisionInputs(window.since, window.until);
    metaEntities = {
      campaigns: inputs.decisionReport?.campaigns || inputs.campaigns || [],
      adsets: inputs.decisionReport?.adsets || inputs.adsets || [],
      ads: inputs.decisionReport?.ads || inputs.ads || [],
    };
  } catch {
    // Meta optional for diagnostics
  }

  const diag = buildAttributionDiagnostics(orders, {
    metaEntities,
  });
  diag.period = window;

  if (args.json) {
    const { orders: _omit, ...rest } = diag;
    console.log(
      JSON.stringify(
        {
          ...rest,
          order_summaries: diag.orders.map((o) => ({
            order_name: o.order_name,
            status: o.status,
            confidence: o.confidence,
            phase: o.phase,
            source: o.source,
            warnings: o.warnings,
            meta_evidence: o.meta_evidence,
            match: {
              campaign: o.match?.campaign?.matched,
              adset: o.match?.adset?.matched,
              ad: o.match?.ad?.matched,
            },
          })),
        },
        null,
        2
      )
    );
  } else {
    printAttributionReport(diag);
  }
}

main().catch((err) => {
  console.error("Attribution report failed:", err.message || err);
  const hint = hintForMetaError(err);
  if (hint) console.error(hint);
  process.exitCode = 1;
});
