# Wear Active books — how to use (full guide)

## What changed (big picture)

Your Google Sheet is now a **thin operating system**:

| You look at | Purpose |
|---|---|
| **Dashboard** | This month / last month / MoM / YTD health check + open pipeline |
| **Monthly P&L** | One clean month-by-month operating table |
| **Analytics** | Focus areas: pipeline, expenses, tax, delivery, products, trends |
| **Shopify Analytics** | Shopify year-over-year economics, delivery routes, and annual top items |
| **Manual Analytics** | Manual-entry year-over-year economics and annual top items |
| **Other Sales Analytics** | Other Sales year-over-year economics and annual top items |
| **Shopify Orders (LIVE)** | Incoming Shopify lines (pipeline + posted) |
| **Ledger** | Official journal — do not edit casually |
| **Variant Master** | SKUs + cost (stock sync later) |
| **Recurring Expenses** | Ads, Delivery, Ops, etc. |
| **Other Sales** | Rare non-Shopify sales only |
| **Restocks / Factory Payments / Partners** | Same as before |

Old duplicate Shopify/P&L/costing tabs are hidden as `_ARCHIVE_*` (recoverable).

**Money rule:** Shopify is where sales happen. The sheet only **records** what already happened, once you’re sure payment/delivery is real.

---

## How money flows

```
Shopify order created/updated
        ↓ (webhook — optional but recommended)
Shopify Orders (LIVE)   ← always lands here first
        ↓ (you run books:sync weekly)
Ledger                  ← only if “Recognized”
        ↓ (same sync)
Dashboard / Monthly P&L / Analytics
```

Webhook **does not** write the Ledger. That is intentional (COD / undelivered would fake revenue).

---

## Day-to-day: recording sales

### A) Website / courier order (taxable)

1. Customer orders on the site (or you create the order in Admin).
2. Optional tag: `delivery:courier` (untagged website orders already default to courier/taxable).
3. Ship via Orio/courier; when delivered and paid → Shopify shows **fulfilled + paid**.
4. Line sits on **LIVE** until you sync.
5. After sync: Ledger gets **Sale** (ex-tax) + **Tax** (18% of inclusive) + **COGS**.

Tax math (prices are inclusive):
`Tax = Gross × 18/118` · `Revenue = Gross − Tax`

### B) Walk-in (no tax)

1. Shopify Admin → **Orders → Create order**.
2. Add product(s).
3. Add tag: **`delivery:walkin`**.
4. Mark **Paid** (Cash / JazzCash).
5. Fulfill when stock leaves.
6. Sync later → Ledger **Sale** only (no Tax row). Full amount = revenue.

### C) You deliver yourself nearby (no tax)

Same as walk-in, but tag **`delivery:self`**.

### D) Gift / PR (no tax, no revenue)

1. Shopify Admin → **Orders → Create order**.
2. Add product(s). Prefer **$0** line price (or 100% discount).
3. Tag: **`wa:gift`** or **`wa:pr`** (alias: `delivery:gift`).
4. Mark paid/fulfilled when the piece leaves stock.
5. Sync → Ledger **Gift** (Rs 0) + **COGS** only. No Tax row. Catalog price on
   the order is ignored for revenue.

### E) Stuck / special cases

| Tag | Meaning |
|---|---|
| `wa:hold` | Never book until you remove the tag |
| `wa:recognized` | Force book even if fulfillment status is lagging (cash already in hand) |

### F) Other Sales sheet

Only if it never touches Shopify. Fill the row and tick **Tax Chargeable** when
tax applies (prices are tax-inclusive; sync splits 18/118 into Sale + Tax). The
checkbox stores `Y` when checked and `N` when unchecked. `npm run books:sync:apply`
posts new Other Sales rows and backfills tax for older taxable rows that were
booked as full gross before this column was wired in.

### G) Quick Manual Sale

Archived/hidden. Don’t use for normal sales anymore.

---

## Day-to-day: expenses

On **Recurring Expenses**:

- Courier bills → category **`Delivery`**
- Ads, Platform fees, Ops, etc. → those category names

Those feed Ledger (via your existing expense posting / future sync) and show on Dashboard as Delivery vs Other expenses.

---

## Weekly ritual (the important command)

On your Mac, in the project folder:

```bash
cd /Users/ahsanmehmood/wear-active-development/wear-active-shopify-ai
npm run books:sync          # dry-run: see what would post
npm run books:sync:apply    # actually post + rebuild reports
```

### What sync does

1. Pulls latest **payment / fulfillment / tags** from Shopify onto LIVE
2. Fills **DeliveryMode, TaxChargeable, TaxAmount, RevenueExTax, Recognized, Posted**
3. Posts only lines where **Recognized = Y** and **Posted = N**
4. Rebuilds **Dashboard**, **Monthly P&L**, **Analytics**
5. Clears old Dashboard charts so numbers stay visible

### When a LIVE line is “Recognized”

- Courier: **fulfilled + paid**
- Walk-in/self: tag + **paid**
- Or `wa:recognized`
- Never if `wa:hold` / cancelled / refunded

**Open pipeline** on Dashboard = orders still waiting (undelivered / unpaid). Visible, not booked.

---

## How to read the sheets

### Dashboard

- **KPI block:** This month | Last month | MoM delta | MoM % | YTD. The latest
  month can be partial, so compare it with care before month-end.
- **Gross collected** = recognized revenue ex-tax + output tax, before refunds.
- **Net revenue ex-tax** is the margin denominator after refunds.
- **Gross margin** shows product economics before delivery and other operating costs.
- **Net margin** includes Delivery and Other opex.
- **Orders** are distinct order references where available; older/manual sales without
  an order-level reference are treated as individual transactions.
- **AOV** = net revenue ex-tax / orders.
- **Open pipeline** is unrecognized, unposted LIVE demand. It is risk/opportunity,
  not revenue. Cancelled/refunded and already-posted lines are excluded.

### Monthly P&L

One row per month in operating order: collected cash, tax, revenue/refunds, COGS,
gross profit, Delivery vs Other opex, net profit, orders/units/AOV, then revenue MoM.
Money is PKR (`#,##0.00`) and margin/rate columns are percentages (`0.0%`).
Use the filter dropdown in the **Year** column to show one year or multiple years;
all historical monthly rows remain available.

### Analytics

Use the sections as a short action list:

- **Pipeline:** demand still waiting for recognition.
- **Year-over-year summary:** one row per available year for revenue, output tax,
  gross/net profit, margins, orders, and AOV. Use the **Year** filter dropdown on
  this table to isolate or compare years. Detailed action sections below continue
  to use the latest Ledger year.
- **Sales channel mix:** separates Shopify, Manual (Quick Manual Sale + Manual
  Tracker), and Other Sales revenue and order/transaction counts for YTD and all
  time.
- **Shopify delivery route:** new Shopify Ledger posts are marked from the existing
  `delivery:*` tag as Courier or Booked ourselves (walk-in/self). Historical Shopify
  entries without a stored route remain clearly labeled Legacy / unclassified.
- **Top sales by channel:** separate YTD top-10 item tables for Shopify, Manual, and
  Other Sales, including revenue, COGS, gross profit, gross margin, and units. These
  do not feed or dilute the Variant Master-only bestseller tables.
- **Expense mix:** where YTD operating spend is concentrated.
- **Tax mix:** YTD and all-time taxable revenue and output tax from tax-aware posts. “Exempt /
  legacy-untracked” intentionally combines true exempt sales with older history that
  was posted gross before the current tax model; do not read it as confirmed exempt.
- **Delivery:** Ledger Delivery spend and directional cost per courier order. Courier
  orders require matching tax-linked sale references, so old history can undercount.
- **Product family economics:** top 10 YTD families by revenue. Only Ledger lines
  whose SKU exists in Variant Master are included, so Other Sales and uncatalogued
  items cannot enter product rankings. Gross profit is revenue less product COGS;
  Delivery remains an operating expense and is not allocated to products.
- **Bestsellers / lowest-margin SKUs:** two top-10 rankings plus the catalog SKUs
  that need pricing, discount, or cost review. All three sections are restricted to
  Variant Master SKUs.
- **12-month trend:** net revenue, net profit, gross margin, and net margin without
  extra chart clutter.

### Channel analytics sheets

`Shopify Analytics`, `Manual Analytics`, and `Other Sales Analytics` use the same
layout so channels can be compared consistently:

- **Year-over-year performance:** gross collected, output tax, revenue ex-tax,
  COGS, gross profit, gross margin, orders/sale entries, units, and AOV.
- **Top items by year:** up to 10 items per year with a native Year filter plus
  revenue, COGS, gross profit, gross margin, and units.
- **Shopify delivery route:** an additional yearly Courier / Booked ourselves /
  Legacy-unclassified split. New `delivery:*` tags flow into this automatically.

Net profit is intentionally not allocated to a channel because Delivery and other
operating expenses are recorded at company level. Channel profitability therefore
means gross profit after product COGS.

### LIVE (useful columns)

| Column | Meaning |
|---|---|
| Recognized | Ready to book? |
| Posted | Already in Ledger? |
| DeliveryMode | courier / self / walkin |
| TaxChargeable | Y/N |
| TaxAmount / RevenueExTax | Split of Net Line |
| Payment / Fulfillment Status | From Shopify |

Filter: `Recognized=Y` and `Posted=N` → next sync will book these.

---

## One-time setup still on you (webhooks)

So LIVE stays fresh without waiting for weekly pull:

1. Open the sheet → **Extensions → Apps Script**
2. Replace the webhook file with
   `wear-active-shopify-ai/apps-script/shopify-webhook.js`
   (or Downloads `shopify-webhook-wa-v2.js`)
3. Deploy → **Web app** (execute as you, access: anyone)
4. Copy the web app URL
5. Shopify Admin → Settings → Notifications → Webhooks:

| Event | URL suffix |
|---|---|
| Order creation | `YOUR_URL?topic=orders_create` |
| Order updated | `YOUR_URL?topic=orders_updated` |
| Order cancellation | `YOUR_URL?topic=orders_cancelled` |

Until this is done, weekly `books:sync:apply` still works (it pulls Shopify itself).

---

## Mental model cheat sheet

| Question | Answer |
|---|---|
| Where do I create a walk-in? | Shopify Create order + tag `delivery:walkin` |
| When do I pay tax in the books? | Courier only (18% from inclusive price) |
| When does revenue hit Dashboard? | After sync, and only if recognized |
| Where is truth? | **Ledger** |
| What if COD not delivered? | Stays on LIVE pipeline — not booked |
| How often do I sync? | Weekly is enough; more often if you want fresher Dashboard |

---

## If something looks wrong

- **Dashboard empty / covered:** re-run `npm run books:sync:apply` (sync now deletes charts).
- **Order not posting:** check LIVE → Payment, Fulfillment, Recognized, tags.
- **Wrong tax:** fix Shopify tag, re-sync (already Posted lines won’t re-post; ask for a correction entry if needed).
- **Need old tabs:** look for `_ARCHIVE_...` (hidden). Unhide from the sheet tab list.
