#!/usr/bin/env node
/**
 * Generate a local HTML decision dashboard (Phase 3.5).
 *
 * Usage:
 *   npm run decisions:dashboard -- --days=7
 *   npm run decisions:dashboard -- --since=2026-08-01 --until=2026-08-31
 *   npm run decisions:dashboard -- --days=7 --open
 */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const {
  parseArgs,
  resolveDateRange,
  hintForMetaError,
} = require("../meta/cli");
const { loadDecisionInputs, TIMEZONE } = require("../decisions/loadInputs");
const { buildDecisionReport } = require("../decisions/report");
const { renderDecisionDashboard } = require("../dashboard/html");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function maybeOpen(filePath, shouldOpen) {
  if (!shouldOpen) return;
  if (process.platform === "darwin") {
    spawn("open", [filePath], { detached: true, stdio: "ignore" }).unref();
  } else if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", filePath], {
      detached: true,
      stdio: "ignore",
    }).unref();
  } else {
    spawn("xdg-open", [filePath], { detached: true, stdio: "ignore" }).unref();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dateRange = resolveDateRange(args, TIMEZONE);
  const inputs = await loadDecisionInputs(dateRange.since, dateRange.until);
  const report = buildDecisionReport(inputs);
  const html = renderDecisionDashboard(report);

  const outDir = path.join(process.cwd(), "reports", "decisions");
  ensureDir(outDir);
  const latestPath = path.join(outDir, "dashboard.html");
  const datedName = `decision-${dateRange.since}-to-${dateRange.until}.html`;
  const datedPath = path.join(outDir, datedName);

  fs.writeFileSync(latestPath, html, "utf8");
  fs.writeFileSync(datedPath, html, "utf8");

  console.log("Wear Active decision dashboard generated.");
  console.log(`Period: ${dateRange.since} → ${dateRange.until}`);
  console.log(`Open: ${latestPath}`);
  console.log(`Also: ${datedPath}`);

  maybeOpen(latestPath, Boolean(args.open));
}

main().catch((err) => {
  console.error("Decision dashboard failed:", err.message || err);
  const hint = hintForMetaError(err);
  if (hint) console.error(hint);
  process.exitCode = 1;
});
