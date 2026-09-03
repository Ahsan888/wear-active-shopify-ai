require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
const DEFAULT_GID = process.env.GOOGLE_SHEETS_DEFAULT_GID || "1188625380";
const KEY_FILE =
  process.env.GOOGLE_SERVICE_ACCOUNT_FILE ||
  path.join(process.cwd(), "google-service-account.json");

const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];

function requireKeyFile() {
  const resolved = path.resolve(KEY_FILE);
  if (!fs.existsSync(resolved)) {
    throw new Error(
      `Missing Google service account file at ${resolved}. Copy the JSON key to google-service-account.json and set GOOGLE_SERVICE_ACCOUNT_FILE in .env.`
    );
  }
  return resolved;
}

function loadServiceAccountMeta() {
  const resolved = requireKeyFile();
  const parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
  if (parsed.type !== "service_account") {
    throw new Error(
      'Google key file is not a service account (expected "type": "service_account").'
    );
  }
  return {
    type: parsed.type,
    projectId: parsed.project_id || null,
    clientEmail: parsed.client_email || null,
    keyFile: resolved,
  };
}

function requireSpreadsheetId() {
  if (!SPREADSHEET_ID) {
    throw new Error("Missing GOOGLE_SHEETS_SPREADSHEET_ID in .env");
  }
  return SPREADSHEET_ID;
}

function getAuth() {
  return new google.auth.GoogleAuth({
    keyFile: requireKeyFile(),
    scopes: SCOPES,
  });
}

async function getSheetsClient() {
  const auth = getAuth();
  return google.sheets({ version: "v4", auth });
}

function formatSheetsError(error) {
  const status = error.response?.status || error.code;
  const message =
    error.response?.data?.error?.message || error.message || String(error);
  return { status, message };
}

function shareHint(clientEmail) {
  return [
    "Share the spreadsheet with the service account as Editor:",
    `  ${clientEmail || "(client_email from google-service-account.json)"}`,
    "Google Sheets → Share → paste that email → Editor → uncheck Notify → Share.",
  ].join("\n");
}

async function getSpreadsheet(fields) {
  const sheets = await getSheetsClient();
  const spreadsheetId = requireSpreadsheetId();
  try {
    const response = await sheets.spreadsheets.get({
      spreadsheetId,
      fields:
        fields ||
        "spreadsheetId,properties(title),sheets(properties(sheetId,title,index,gridProperties(rowCount,columnCount)))",
    });
    return response.data;
  } catch (error) {
    const { status, message } = formatSheetsError(error);
    if (status === 403 || status === 404) {
      const meta = loadServiceAccountMeta();
      const extra = status === 403 ? `\n\n${shareHint(meta.clientEmail)}` : "";
      throw new Error(`Sheets API ${status}: ${message}${extra}`);
    }
    throw new Error(`Sheets API ${status || "error"}: ${message}`);
  }
}

function sheetByGid(spreadsheet, gid) {
  const target = String(gid);
  return (spreadsheet.sheets || []).find(
    (sheet) => String(sheet.properties?.sheetId) === target
  );
}

function a1SheetName(title) {
  if (/^[A-Za-z0-9_]+$/.test(title)) return title;
  return `'${String(title).replace(/'/g, "''")}'`;
}

async function getValues(range) {
  const sheets = await getSheetsClient();
  const spreadsheetId = requireSpreadsheetId();
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range,
      majorDimension: "ROWS",
    });
    return response.data.values || [];
  } catch (error) {
    const { status, message } = formatSheetsError(error);
    if (status === 403) {
      const meta = loadServiceAccountMeta();
      throw new Error(`Sheets API 403: ${message}\n\n${shareHint(meta.clientEmail)}`);
    }
    throw new Error(`Sheets API ${status || "error"}: ${message}`);
  }
}

async function updateValues(range, values, { apply = false } = {}) {
  const current = await getValues(range);
  const plan = { range, current, proposed: values, apply: Boolean(apply) };
  if (!apply) return plan;

  const sheets = await getSheetsClient();
  const spreadsheetId = requireSpreadsheetId();
  const response = await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: "USER_ENTERED",
    requestBody: { values, majorDimension: "ROWS" },
  });
  return { ...plan, updated: response.data };
}

async function appendValues(range, values, { apply = false } = {}) {
  const plan = { range, proposed: values, apply: Boolean(apply), mode: "append" };
  if (!apply) return plan;

  const sheets = await getSheetsClient();
  const spreadsheetId = requireSpreadsheetId();
  const response = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values, majorDimension: "ROWS" },
  });
  return { ...plan, updated: response.data };
}

module.exports = {
  SPREADSHEET_ID,
  DEFAULT_GID,
  KEY_FILE,
  loadServiceAccountMeta,
  requireSpreadsheetId,
  getAuth,
  getSheetsClient,
  getSpreadsheet,
  sheetByGid,
  a1SheetName,
  getValues,
  updateValues,
  appendValues,
  shareHint,
  formatSheetsError,
};
