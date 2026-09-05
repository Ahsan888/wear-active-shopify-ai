#!/usr/bin/env node
/**
 * Weekly low-stock alert: variants with exactly 1 unit left (last size/colour).
 *
 * Usage:
 *   npm run stock:low              # dry-run (print report)
 *   npm run stock:low -- --send    # send email
 *
 * Env (see .env.example):
 *   LOW_STOCK_THRESHOLD=1          # alert when 0 < qty <= threshold (default 1)
 *   LOW_STOCK_EMAIL_TO=a@x.com,b@y.com
 *   LOW_STOCK_EMAIL_FROM=alerts@...
 *   RESEND_API_KEY=re_...          # preferred
 *   — or SMTP —
 *   SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS
 */

require("dotenv").config();
const { graphql } = require("../shopify/client");

const THRESHOLD = Math.max(1, Number(process.env.LOW_STOCK_THRESHOLD || 1));
const SEND = process.argv.includes("--send");

async function fetchAllVariants() {
  const out = [];
  let cursor = null;
  let hasNext = true;

  while (hasNext) {
    const data = await graphql(
      `query ($cursor: String) {
        productVariants(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              sku
              title
              displayName
              inventoryQuantity
              product {
                title
                status
                handle
              }
              selectedOptions { name value }
            }
          }
        }
      }`,
      { cursor }
    );

    const conn = data.productVariants;
    for (const { node } of conn.edges) {
      if (node.product?.status !== "ACTIVE") continue;
      const qty = node.inventoryQuantity;
      if (qty == null || qty <= 0 || qty > THRESHOLD) continue;

      const opts = Object.fromEntries(
        (node.selectedOptions || []).map((o) => [o.name.toLowerCase(), o.value])
      );
      out.push({
        product: node.product.title,
        handle: node.product.handle,
        variant: node.title,
        size: opts.size || "",
        color: opts.color || opts.colour || "",
        sku: String(node.sku || "").trim() || "(no sku)",
        qty,
      });
    }

    hasNext = conn.pageInfo.hasNextPage;
    cursor = conn.pageInfo.endCursor;
  }

  out.sort((a, b) =>
    a.product.localeCompare(b.product) ||
    a.color.localeCompare(b.color) ||
    a.size.localeCompare(b.size) ||
    a.sku.localeCompare(b.sku)
  );
  return out;
}

function buildText(items) {
  const shop = String(process.env.SHOPIFY_SHOP || "store").replace(
    /\.myshopify\.com$/i,
    ""
  );
  const lines = [
    `Wear Active — low stock alert`,
    `Threshold: ${THRESHOLD} unit(s) remaining (active products only)`,
    `Generated: ${new Date().toISOString()}`,
    `Store: ${shop}`,
    ``,
    items.length
      ? `${items.length} variant(s) need restock:`
      : `No variants at or below ${THRESHOLD} unit.`,
    ``,
  ];

  let current = "";
  for (const it of items) {
    if (it.product !== current) {
      current = it.product;
      lines.push(`${current}`);
    }
    const bits = [it.color, it.size].filter(Boolean).join(" / ") || it.variant;
    lines.push(`  • ${bits} — qty ${it.qty} — ${it.sku}`);
  }

  lines.push(``, `Admin: https://${shop}.myshopify.com/admin/products`);
  return lines.join("\n");
}

function buildHtml(items) {
  const shop = String(process.env.SHOPIFY_SHOP || "store").replace(
    /\.myshopify\.com$/i,
    ""
  );
  const rows = items
    .map(
      (it) => `<tr>
      <td style="padding:6px 10px;border-bottom:1px solid #eee">${escapeHtml(it.product)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee">${escapeHtml(it.color || "—")}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee">${escapeHtml(it.size || it.variant)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:center"><strong>${it.qty}</strong></td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;font-family:monospace;font-size:12px">${escapeHtml(it.sku)}</td>
    </tr>`
    )
    .join("");

  return `<!doctype html>
<html><body style="font-family:system-ui,-apple-system,sans-serif;color:#111;line-height:1.4">
  <h2 style="margin:0 0 8px">Wear Active — low stock alert</h2>
  <p style="margin:0 0 16px;color:#555">Variants with ${THRESHOLD} unit remaining (last piece of that size). Active products only.</p>
  ${
    items.length
      ? `<table style="border-collapse:collapse;width:100%;max-width:720px;font-size:14px">
    <thead>
      <tr style="text-align:left;background:#f5f5f5">
        <th style="padding:8px 10px">Product</th>
        <th style="padding:8px 10px">Colour</th>
        <th style="padding:8px 10px">Size</th>
        <th style="padding:8px 10px">Qty</th>
        <th style="padding:8px 10px">SKU</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`
      : `<p>No variants at this threshold.</p>`
  }
  <p style="margin-top:20px;font-size:13px"><a href="https://${shop}.myshopify.com/admin/products">Open Shopify Admin</a></p>
</body></html>`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function parseRecipients() {
  const raw = process.env.LOW_STOCK_EMAIL_TO || "";
  return raw
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function sendViaResend({ to, from, subject, text, html }) {
  const { sendViaResend: send } = require("../email/resend");
  const key = process.env.RESEND_API_KEY;
  if (!key) return false;
  try {
    const result = await send({ to, from, subject, text, html, apiKey: key });
    console.log("Sent via Resend:", result.id || "ok");
    return true;
  } catch (err) {
    throw new Error(err.messageRedacted || err.message || String(err));
  }
}

async function sendViaSmtp({ to, from, subject, text, html }) {
  const host = process.env.SMTP_HOST;
  if (!host) return false;

  let nodemailer;
  try {
    nodemailer = require("nodemailer");
  } catch {
    throw new Error(
      "SMTP configured but nodemailer is not installed. Run: npm install nodemailer"
    );
  }

  const port = Number(process.env.SMTP_PORT || 587);
  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth:
      process.env.SMTP_USER && process.env.SMTP_PASS
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
  });

  const info = await transporter.sendMail({
    from,
    to: to.join(", "),
    subject,
    text,
    html,
  });
  console.log("Sent via SMTP:", info.messageId);
  return true;
}

async function sendEmail(items) {
  const to = parseRecipients();
  if (!to.length) {
    throw new Error("Set LOW_STOCK_EMAIL_TO in .env (comma-separated)");
  }
  const from =
    process.env.LOW_STOCK_EMAIL_FROM ||
    process.env.SMTP_FROM ||
    "Wear Active Alerts <onboarding@resend.dev>";
  const subject = items.length
    ? `Low stock: ${items.length} size(s) down to ${THRESHOLD}`
    : `Low stock: none at threshold ${THRESHOLD}`;
  const text = buildText(items);
  const html = buildHtml(items);

  const sent =
    (await sendViaResend({ to, from, subject, text, html })) ||
    (await sendViaSmtp({ to, from, subject, text, html }));

  if (!sent) {
    throw new Error(
      "No email provider configured. Set RESEND_API_KEY (+ LOW_STOCK_EMAIL_FROM) or SMTP_HOST/USER/PASS."
    );
  }
}

async function main() {
  console.log(`Scanning active variants with 1–${THRESHOLD} unit(s)…`);
  const items = await fetchAllVariants();
  console.log(buildText(items));

  if (!SEND) {
    console.log("\nDry-run only. Pass --send to email.");
    return;
  }

  await sendEmail(items);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exitCode = 1;
});
