# Wear Active — Owner Guide

Short guide for running the business from the dashboard. You do **not** need analytics jargon.

## Daily — about 5 minutes

1. Open **Overview** (the default screen).
2. Read **Do This Today** — start with **P1**, then **P2**.
3. Handle those actions in Meta Ads Manager / Shopify / Books as needed (the dashboard never changes ads or prices for you).
4. Skim the **Watch List** — context, not necessarily urgent.
5. Check **Where we are heading** — labelled **FORECAST — NOT ACTUAL**.

Command:

```bash
npm run reports:owner -- --days=30
```

Opens `reports/dashboard/index.html` and prints an owner brief in the terminal.

## Weekly — about 20 minutes

1. **Marketing** — pause / reduce / hold / careful scale decisions
2. **Inventory** — stockouts, overstock, capital tied up
3. **Pricing** — safe discount floors (accounting-based); never auto-apply
4. **Customers** — repeat rate (observed, not predictive LTV)
5. **Profitability** — Books P&amp;L and Meta-adjusted profit
6. **Data Quality** — trust issues that could mislead decisions

Also glance at **Forecast** for scenarios and spend what-ifs.

## Important words (plain English)

| Term | Meaning |
|------|---------|
| **Recognized order** | A sale that counts in Books accounting |
| **Meta cost per purchase (CPA)** | What Meta says each attributed purchase cost |
| **Ad spend per recognized sale** | Meta spend ÷ all Books orders (business affordability) |
| **Break-even ad cost per sale** | Max you could spend per recognized sale before using up pre-ad profit |
| **Profit after actual Meta spend** | Books profit with booked Ads replaced by real Meta spend |
| **Gross profit / margin** | Revenue left after product cost (COGS), before operating expenses |
| **Shopify contribution after Meta** | Shopify economics minus date-aligned Meta spend (not attributed profit) |
| **First-party attribution** | Our own tracking of which ads led to orders — still maturing |
| **Forecast** | A projection from recent pace — **not** a Books fact |

## Rules that keep you safe

- Do **not** compare Meta CPA to break-even ad cost for affordability.
- Affordability uses **Meta spend ÷ Books recognized orders** vs break-even.
- Forecasts never become accounting facts.
- The system is **advisory only** — no automatic budget or price changes.

## Tabs at a glance

| Tab | When |
|-----|------|
| Overview | Every day |
| Marketing | Ad decisions |
| Profitability | Accounting / economics |
| Sales | Channel mix |
| Inventory | Stock decisions |
| Pricing | Discount review |
| Customers | Behaviour |
| Attribution | Tracking evidence |
| Advertising | Raw Meta numbers |
| Forecast | Planning / scenarios |
| Data Quality | Trust diagnostics |
