/**
 * Append-only JSONL snapshot history with upsert by snapshot_key.
 * Key = `${reporting_date}:${period.days}`
 */
const path = require("path");
const { atomicWriteFile, readTextIfExists, reportsRoot, ensureDir } = require("./files");
const { validateSnapshot } = require("./snapshot");

function historyPath(cwd = process.cwd()) {
  return path.join(reportsRoot(cwd), "snapshots", "history.jsonl");
}

function snapshotDatedPath(reportingDate, cwd = process.cwd()) {
  return path.join(reportsRoot(cwd), "snapshots", `${reportingDate}.json`);
}

function parseHistoryText(text) {
  if (text == null || String(text).trim() === "") return [];
  const lines = String(text).replace(/\n$/, "").split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (err) {
      throw new Error(
        `Malformed history.jsonl at line ${i + 1}: ${err.message}`
      );
    }
    try {
      validateSnapshot(obj);
    } catch (err) {
      throw new Error(
        `Invalid snapshot in history.jsonl at line ${i + 1}: ${err.message}`
      );
    }
    out.push(obj);
  }
  return out;
}

function loadHistory(cwd = process.cwd()) {
  const text = readTextIfExists(historyPath(cwd));
  return parseHistoryText(text);
}

function sortHistory(rows) {
  return [...rows].sort((a, b) => {
    const da = String(a.reporting_date).localeCompare(String(b.reporting_date));
    if (da !== 0) return da;
    return Number(a.period.days) - Number(b.period.days);
  });
}

function upsertSnapshot(history, snapshot) {
  validateSnapshot(snapshot);
  const key = snapshot.snapshot_key;
  const next = (history || []).filter((s) => s.snapshot_key !== key);
  next.push(snapshot);
  return sortHistory(next);
}

function writeHistory(history, cwd = process.cwd()) {
  const rows = sortHistory(history || []);
  for (const s of rows) validateSnapshot(s);
  const body =
    rows.length === 0 ? "" : rows.map((s) => JSON.stringify(s)).join("\n") + "\n";
  atomicWriteFile(historyPath(cwd), body);
  return rows;
}

function writeDatedSnapshot(snapshot, cwd = process.cwd()) {
  validateSnapshot(snapshot);
  atomicWriteFile(
    snapshotDatedPath(snapshot.reporting_date, cwd),
    JSON.stringify(snapshot, null, 2) + "\n"
  );
}

function getPreviousSnapshot(history, snapshot) {
  const sorted = sortHistory(history || []).filter(
    (s) =>
      Number(s.period?.days) === Number(snapshot.period?.days) &&
      s.reporting_date < snapshot.reporting_date
  );
  return sorted.length ? sorted[sorted.length - 1] : null;
}

function getRecentSnapshots(history, { days, limit = 7 } = {}) {
  let rows = sortHistory(history || []);
  if (days != null) {
    rows = rows.filter((s) => Number(s.period?.days) === Number(days));
  }
  return rows.slice(-Math.max(1, Number(limit) || 7));
}

module.exports = {
  historyPath,
  snapshotDatedPath,
  parseHistoryText,
  loadHistory,
  sortHistory,
  upsertSnapshot,
  writeHistory,
  writeDatedSnapshot,
  getPreviousSnapshot,
  getRecentSnapshots,
  ensureDir,
};
