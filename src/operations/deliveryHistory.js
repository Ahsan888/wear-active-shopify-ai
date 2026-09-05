/**
 * Delivery history JSONL — upsert by delivery_key.
 * Source of truth for duplicate-send protection across periods.
 */
const path = require("path");
const { atomicWriteFile, readTextIfExists, reportsRoot } = require("./files");

function deliveryHistoryPath(cwd = process.cwd()) {
  return path.join(reportsRoot(cwd), "delivery", "history.jsonl");
}

function validateDeliveryRecord(row, lineNo) {
  if (!row || typeof row !== "object") {
    throw new Error(`Invalid delivery history record at line ${lineNo}`);
  }
  if (!row.delivery_key || typeof row.delivery_key !== "string") {
    throw new Error(
      `Invalid delivery history at line ${lineNo}: missing delivery_key`
    );
  }
  if (!row.reporting_date) {
    throw new Error(
      `Invalid delivery history at line ${lineNo}: missing reporting_date`
    );
  }
  if (row.days == null) {
    throw new Error(
      `Invalid delivery history at line ${lineNo}: missing days`
    );
  }
  return true;
}

function parseDeliveryHistoryText(text) {
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
        `Malformed delivery/history.jsonl at line ${i + 1}: ${err.message}`
      );
    }
    validateDeliveryRecord(obj, i + 1);
    out.push(obj);
  }
  return out;
}

function loadDeliveryHistory(cwd = process.cwd()) {
  return parseDeliveryHistoryText(readTextIfExists(deliveryHistoryPath(cwd)));
}

function sortDeliveryHistory(rows) {
  return [...rows].sort((a, b) => {
    const da = String(a.reporting_date).localeCompare(String(b.reporting_date));
    if (da !== 0) return da;
    const dd = Number(a.days) - Number(b.days);
    if (dd !== 0) return dd;
    return String(a.delivery_key).localeCompare(String(b.delivery_key));
  });
}

function upsertDeliveryRecord(history, record) {
  validateDeliveryRecord(record, "?");
  const next = (history || []).filter(
    (r) => r.delivery_key !== record.delivery_key
  );
  next.push(record);
  return sortDeliveryHistory(next);
}

function writeDeliveryHistory(history, cwd = process.cwd()) {
  const rows = sortDeliveryHistory(history || []);
  for (const r of rows) validateDeliveryRecord(r, "?");
  const body =
    rows.length === 0
      ? ""
      : rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  atomicWriteFile(deliveryHistoryPath(cwd), body);
  return rows;
}

/**
 * True only when a prior successful delivery exists for this key.
 * Failed attempts do not block retry.
 */
function wasAlreadyDelivered(deliveryKey, cwd = process.cwd()) {
  const history = loadDeliveryHistory(cwd);
  const row = history.find((r) => r.delivery_key === deliveryKey);
  return Boolean(row && row.success === true);
}

function findDeliveryRecord(deliveryKey, cwd = process.cwd()) {
  return (
    loadDeliveryHistory(cwd).find((r) => r.delivery_key === deliveryKey) ||
    null
  );
}

module.exports = {
  deliveryHistoryPath,
  parseDeliveryHistoryText,
  loadDeliveryHistory,
  sortDeliveryHistory,
  upsertDeliveryRecord,
  writeDeliveryHistory,
  wasAlreadyDelivered,
  findDeliveryRecord,
  validateDeliveryRecord,
};
