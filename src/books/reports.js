const { parseMoney, round2 } = require("./tax");

const PNL_HEADERS = [
  "Month", "Year", "Gross collected", "Output tax", "Revenue ex-tax", "Refunds",
  "Net revenue ex-tax", "COGS", "Gross profit", "Gross margin %",
  "Delivery expense", "Other opex", "Total opex", "Net profit",
  "Net margin %", "Orders", "Units", "AOV (ex-tax)",
  "Revenue MoM delta", "Revenue MoM %",
];

function monthKey(value) {
  if (typeof value === "number" && value > 20000) {
    const date = new Date(Date.UTC(1899, 11, 30) + value * 86400000);
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  }
  const s = String(value || "").trim();
  const m = s.match(/^(\d{4})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}`;
  const d = new Date(s);
  if (isNaN(d)) return "unknown";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function saleUid(ref) {
  const s = String(ref || "").trim();
  if (s.startsWith("SALE:")) return s.slice(5);
  if (s.startsWith("GIFT:")) return s.slice(5);
  // Legacy Other Sales refs: OTHER:yyyy-mm-dd:row:SALE → OTHER:yyyy-mm-dd:row
  const other = s.match(/^(OTHER:\d{4}-\d{2}-\d{2}:\d+):SALE$/i);
  if (other) return other[1];
  return "";
}

function orderKeyFromRef(ref) {
  const uid = saleUid(ref);
  if (!uid) return "";
  let match = uid.match(/^SHOPIFY\|([^|]+)\|/i);
  if (match) return `SHOPIFY|${match[1]}`;
  match = uid.match(/^(SHOPIFY:#?[^:]+):/i);
  if (match) return match[1].toUpperCase();
  return uid;
}

function cleanProductName(value) {
  return String(value || "")
    .replace(/^COGS\s+/i, "")
    .replace(/\s+\(#?\d+\)\s*$/, "")
    .trim();
}

function saleChannel(source, ref) {
  const sourceName = String(source || "").trim().toLowerCase();
  if (/^SALE:SHOPIFY(?:\||:)/i.test(String(ref || "")) || sourceName.includes("shopify")) {
    return "Shopify";
  }
  if (sourceName === "other sales") return "Other Sales";
  return "Manual";
}

function shopifyDeliveryRoute(notes) {
  const s = String(notes || "");
  if (/delivery:gift|wa:gift|wa:pr/i.test(s)) return "Gift / PR";
  const match = s.match(/delivery:(courier|self|walkin)/i);
  if (!match) return "Legacy / unclassified";
  return match[1].toLowerCase() === "courier" ? "Courier" : "Booked ourselves";
}

function sum(items, getter) {
  return items.reduce((total, item) => total + (Number(getter(item)) || 0), 0);
}

function pct(numerator, denominator) {
  return denominator ? numerator / denominator : 0;
}

function makeMonth(month) {
  return {
    month, grossCollected: 0, outputTax: 0, revenueExTax: 0, refunds: 0,
    cogs: 0, deliveryExp: 0, otherExp: 0, units: 0, orders: new Set(),
    courierOrders: new Set(), taxableRevenue: 0, untrackedRevenue: 0,
    expenseByCategory: {},
  };
}

function finalizeMonth(month) {
  const netRevenue = month.revenueExTax - month.refunds;
  const grossProfit = netRevenue - month.cogs;
  const totalOpex = month.deliveryExp + month.otherExp;
  const netProfit = grossProfit - totalOpex;
  return {
    ...month, netRevenue, grossProfit,
    grossMargin: pct(grossProfit, netRevenue), totalOpex, netProfit,
    netMargin: pct(netProfit, netRevenue), orderCount: month.orders.size,
    courierOrderCount: month.courierOrders.size,
    aov: pct(netRevenue, month.orders.size),
  };
}

function ensureProduct(productStats, sku, description, catalogBySku) {
  const catalog = catalogBySku[sku] || {};
  const label = catalog.product || cleanProductName(description) || sku || "Unknown";
  const key = sku || label;
  if (!productStats[key]) {
    productStats[key] = {
      key, sku, label, family: catalog.product || label,
      category: catalog.category || "",
      inVariantMaster: Boolean(sku && catalogBySku[sku]),
      byMonth: {},
    };
  }
  return productStats[key];
}

function ensureProductMonth(product, month) {
  if (!product.byMonth[month]) {
    product.byMonth[month] = { revenue: 0, cogs: 0, units: 0 };
  }
  return product.byMonth[month];
}

function ensureSalesBucket(stats, key, month) {
  if (!stats[key]) stats[key] = { byMonth: {} };
  if (!stats[key].byMonth[month]) {
    stats[key].byMonth[month] = {
      revenue: 0, tax: 0, cogs: 0, units: 0, transactions: 0,
      orders: new Set(), items: {},
    };
  }
  return stats[key].byMonth[month];
}

function addSaleToBucket(bucket, orderKey, itemKey, itemLabel, revenue, units) {
  bucket.revenue += revenue;
  bucket.units += units;
  bucket.transactions += 1;
  if (orderKey) bucket.orders.add(orderKey);
  if (!bucket.items[itemKey]) {
    bucket.items[itemKey] = { label: itemLabel, revenue: 0, cogs: 0, units: 0 };
  }
  bucket.items[itemKey].revenue += revenue;
  bucket.items[itemKey].units += units;
}

function addCogsToBucket(bucket, itemKey, itemLabel, cogs) {
  bucket.cogs += cogs;
  if (!bucket.items[itemKey]) {
    bucket.items[itemKey] = { label: itemLabel, revenue: 0, cogs: 0, units: 0 };
  }
  bucket.items[itemKey].cogs += cogs;
}

/** Roll up Ledger into monthly P&L and decision-focused analytics structures. */
function rollupLedger(rows, header, catalogBySku = {}) {
  const col = (name) => header.findIndex(
    (h) => String(h).toLowerCase() === name.toLowerCase()
  );
  const iDate = col("Date");
  const iType = col("Entry Type");
  const iSource = col("Source");
  const iCat = col("Category");
  const iDesc = col("Description");
  const iSku = col("SKU");
  const iQty = col("Qty");
  const iDebit = col("Debit");
  const iCredit = col("Credit");
  const iRef = col("Ref Key");
  const iNotes = col("Notes");

  const taxUids = new Set();
  for (const row of rows) {
    const ref = String(row[iRef] || "");
    if (ref.startsWith("TAX:")) taxUids.add(ref.slice(4));
  }

  const rawMonths = {};
  const productStats = {};
  const channelStats = {};
  const deliveryRouteStats = {};
  const ensureMonth = (key) => {
    if (!rawMonths[key]) rawMonths[key] = makeMonth(key);
    return rawMonths[key];
  };

  for (const row of rows) {
    const month = monthKey(row[iDate]);
    if (month === "unknown") continue;
    const bucket = ensureMonth(month);
    const type = String(row[iType] || "").trim().toLowerCase();
    const category = String(row[iCat] || "").trim();
    const debit = parseMoney(row[iDebit]);
    const credit = parseMoney(row[iCredit]);
    const qty = parseMoney(row[iQty]);
    const sku = String(row[iSku] || "").trim();
    const description = String(row[iDesc] || "").trim();
    const ref = String(row[iRef] || "").trim();
    const source = String(row[iSource] || "").trim();
    const notes = String(row[iNotes] || "").trim();

    if (type === "sale") {
      bucket.revenueExTax += credit;
      bucket.grossCollected += credit;
      bucket.units += qty;
      const orderKey = orderKeyFromRef(ref);
      if (orderKey) bucket.orders.add(orderKey);
      const channel = saleChannel(source, ref);
      const catalog = catalogBySku[sku] || {};
      const itemLabel = catalog.product
        ? `${catalog.product} (${sku})`
        : cleanProductName(description) || sku || "Unknown";
      const itemKey = sku || itemLabel;
      addSaleToBucket(
        ensureSalesBucket(channelStats, channel, month),
        orderKey,
        itemKey,
        itemLabel,
        credit,
        qty
      );
      if (channel === "Shopify") {
        const route = shopifyDeliveryRoute(notes);
        addSaleToBucket(
          ensureSalesBucket(deliveryRouteStats, route, month),
          orderKey,
          itemKey,
          itemLabel,
          credit,
          qty
        );
      }
      const uid = saleUid(ref);
      if (uid && taxUids.has(uid)) {
        bucket.taxableRevenue += credit;
        if (orderKey) bucket.courierOrders.add(orderKey);
      } else {
        bucket.untrackedRevenue += credit;
      }
      const product = ensureProduct(productStats, sku, description, catalogBySku);
      const productMonth = ensureProductMonth(product, month);
      productMonth.revenue += credit;
      productMonth.units += qty;
    } else if (type === "tax") {
      bucket.outputTax += credit;
      bucket.grossCollected += credit;
      ensureSalesBucket(channelStats, saleChannel(source, ref), month).tax += credit;
    } else if (type === "cogs") {
      bucket.cogs += debit;
      const product = ensureProduct(productStats, sku, description, catalogBySku);
      ensureProductMonth(product, month).cogs += debit;
      const channel = saleChannel(source, ref);
      const catalog = catalogBySku[sku] || {};
      const itemLabel = catalog.product
        ? `${catalog.product} (${sku})`
        : cleanProductName(description) || sku || "Unknown";
      addCogsToBucket(
        ensureSalesBucket(channelStats, channel, month),
        sku || itemLabel,
        itemLabel,
        debit
      );
    } else if (type === "gift") {
      // Gift / PR: stock out with no revenue (COGS still booked as COGS rows)
      bucket.units += qty;
      const product = ensureProduct(productStats, sku, description, catalogBySku);
      ensureProductMonth(product, month).units += qty;
      const orderKey = orderKeyFromRef(ref);
      if (orderKey) bucket.orders.add(orderKey);
      if (saleChannel(source, ref) === "Shopify") {
        addSaleToBucket(
          ensureSalesBucket(deliveryRouteStats, "Gift / PR", month),
          orderKey,
          sku || cleanProductName(description) || "Gift",
          cleanProductName(description) || sku || "Gift",
          0,
          qty
        );
      }
    } else if (type === "expense") {
      if (category.toLowerCase() === "delivery") bucket.deliveryExp += debit;
      else bucket.otherExp += debit;
      const name = category || "Other";
      bucket.expenseByCategory[name] = (bucket.expenseByCategory[name] || 0) + debit;
    } else if (type === "refund" || /refund/i.test(type)) {
      bucket.refunds += debit || credit;
    }
  }

  const monthly = Object.keys(rawMonths).sort().map((key) => finalizeMonth(rawMonths[key]));
  const monthlyRows = monthly.map((m, index) => {
    const prior = monthly[index - 1];
    const revenueDelta = prior ? m.netRevenue - prior.netRevenue : "";
    const revenueDeltaPct = prior?.netRevenue ? revenueDelta / prior.netRevenue : "";
    return [
      m.month, Number(m.month.slice(0, 4)), round2(m.grossCollected), round2(m.outputTax),
      round2(m.revenueExTax), round2(m.refunds), round2(m.netRevenue),
      round2(m.cogs), round2(m.grossProfit), m.grossMargin,
      round2(m.deliveryExp), round2(m.otherExp), round2(m.totalOpex),
      round2(m.netProfit), m.netMargin, m.orderCount, round2(m.units),
      round2(m.aov), revenueDelta === "" ? "" : round2(revenueDelta),
      revenueDeltaPct,
    ];
  });

  return {
    months: rawMonths, monthly, monthlyRows, productStats, channelStats,
    deliveryRouteStats, taxUids,
    latestMonth: monthly.at(-1)?.month || "",
  };
}

function periodSummary(months) {
  const netRevenue = sum(months, (m) => m.netRevenue);
  const grossProfit = sum(months, (m) => m.grossProfit);
  const netProfit = sum(months, (m) => m.netProfit);
  const orders = sum(months, (m) => m.orderCount);
  return {
    grossCollected: sum(months, (m) => m.grossCollected),
    outputTax: sum(months, (m) => m.outputTax),
    revenueExTax: sum(months, (m) => m.revenueExTax),
    refunds: sum(months, (m) => m.refunds), netRevenue,
    cogs: sum(months, (m) => m.cogs), grossProfit,
    grossMargin: pct(grossProfit, netRevenue),
    deliveryExp: sum(months, (m) => m.deliveryExp),
    otherExp: sum(months, (m) => m.otherExp),
    totalOpex: sum(months, (m) => m.totalOpex), netProfit,
    netMargin: pct(netProfit, netRevenue), orders, orderCount: orders,
    units: sum(months, (m) => m.units), aov: pct(netRevenue, orders),
    courierOrders: sum(months, (m) => m.courierOrderCount),
    taxableRevenue: sum(months, (m) => m.taxableRevenue),
    untrackedRevenue: sum(months, (m) => m.untrackedRevenue),
  };
}

function buildDashboardValues(rollup, pipeline, alerts = []) {
  const monthly = rollup.monthly || [];
  const current = monthly.at(-1) || finalizeMonth(makeMonth("No data"));
  const prior = monthly.at(-2) || null;
  const year = String(current.month).slice(0, 4);
  const ytd = periodSummary(monthly.filter((m) => m.month.startsWith(`${year}-`)));
  const metric = (label, key, type = "money") => {
    const now = Number(current[key]) || 0;
    const before = prior ? Number(prior[key]) || 0 : 0;
    const delta = prior ? now - before : "";
    const deltaPct = prior && before ? delta / Math.abs(before) : "";
    return [label, round2(now), prior ? round2(before) : "",
      delta === "" ? "" : round2(delta), type === "percent" ? "" : deltaPct,
      round2(Number(ytd[key]) || 0)];
  };

  return [
    ["WA BUSINESS DASHBOARD — MONTHLY HEALTH CHECK"],
    [`Latest ledger month: ${current.month}`, "", "", "", "", `YTD ${year}`],
    [],
    ["Metric", "This month", "Last month", "MoM delta", "MoM %", `YTD ${year}`],
    metric("Gross collected (before refunds)", "grossCollected"),
    metric("Output tax accrued*", "outputTax"),
    metric("Revenue ex-tax", "revenueExTax"),
    metric("Refunds", "refunds"),
    metric("Net revenue ex-tax", "netRevenue"),
    metric("COGS", "cogs"),
    metric("Gross profit", "grossProfit"),
    metric("Gross margin %", "grossMargin", "percent"),
    metric("Delivery expense", "deliveryExp"),
    metric("Other opex", "otherExp"),
    metric("Net profit", "netProfit"),
    metric("Net margin %", "netMargin", "percent"),
    metric("Orders", "orderCount", "count"),
    metric("Units", "units", "count"),
    metric("AOV (net revenue / orders)", "aov"),
    [],
    ["OPEN PIPELINE — RISK, NOT REVENUE"],
    ["Metric", "Open now", "Interpretation"],
    ["Orders", pipeline.orders || 0, "Unrecognized and not posted"],
    ["Gross", round2(pipeline.gross || 0), "Customer value; not in Ledger"],
    ["Units", pipeline.units || 0, "Awaiting recognition"],
    [],
    ["ATTENTION"],
    ...(alerts.length ? alerts.map((alert) => [alert]) : [["No open report alerts"]]),
    ["* Output tax is accrued on tax-aware posts; older gross-booked history may show zero."],
  ];
}

function aggregateProducts(productStats, months) {
  const monthSet = new Set(months);
  return Object.values(productStats).map((product) => {
    const selected = Object.entries(product.byMonth)
      .filter(([month]) => monthSet.has(month)).map(([, values]) => values);
    const revenue = sum(selected, (v) => v.revenue);
    const cogs = sum(selected, (v) => v.cogs);
    const units = sum(selected, (v) => v.units);
    const grossProfit = revenue - cogs;
    return { ...product, revenue, cogs, units, grossProfit,
      grossMargin: pct(grossProfit, revenue) };
  });
}

function aggregateSalesStats(stats, months) {
  const monthSet = new Set(months);
  const result = {};
  for (const [key, value] of Object.entries(stats || {})) {
    const selected = Object.entries(value.byMonth)
      .filter(([month]) => monthSet.has(month))
      .map(([, month]) => month);
    const items = {};
    for (const month of selected) {
      for (const [itemKey, item] of Object.entries(month.items)) {
        if (!items[itemKey]) {
          items[itemKey] = { label: item.label, revenue: 0, cogs: 0, units: 0 };
        }
        items[itemKey].revenue += item.revenue;
        items[itemKey].cogs += item.cogs;
        items[itemKey].units += item.units;
      }
    }
    const revenue = sum(selected, (m) => m.revenue);
    const cogs = sum(selected, (m) => m.cogs);
    result[key] = {
      revenue,
      tax: sum(selected, (m) => m.tax),
      grossCollected: revenue + sum(selected, (m) => m.tax),
      cogs,
      grossProfit: revenue - cogs,
      grossMargin: pct(revenue - cogs, revenue),
      units: sum(selected, (m) => m.units),
      transactions: sum(selected, (m) => m.transactions),
      orders: sum(selected, (m) => m.orders.size),
      items: Object.values(items).map((item) => ({
        ...item,
        grossProfit: item.revenue - item.cogs,
        grossMargin: pct(item.revenue - item.cogs, item.revenue),
      })).sort((a, b) => b.revenue - a.revenue),
    };
  }
  return result;
}

function buildChannelTopSalesRows(channel, items = [], year) {
  const title = channel === "OTHER SALES"
    ? `TOP OTHER SALES — YTD ${year}`
    : `TOP ${channel} SALES — YTD ${year}`;
  return [
    [title],
    ["Item", "Revenue ex-tax", "COGS", "Gross profit", "Gross margin %", "Units"],
    ...items.slice(0, 10).map((item, index) => [
      `${index + 1}. ${item.label}`,
      round2(item.revenue),
      round2(item.cogs),
      round2(item.grossProfit),
      item.grossMargin,
      round2(item.units),
    ]),
  ];
}

function buildChannelAnalyticsValues(rollup, channel) {
  const monthly = rollup.monthly || [];
  const years = [...new Set(monthly.map((m) => m.month.slice(0, 4)))].sort();
  const countLabel = channel === "Shopify" ? "Orders" : "Sale entries";
  const annual = years.map((year) => ({
    year,
    summary: aggregateSalesStats(
      rollup.channelStats,
      monthly.filter((m) => m.month.startsWith(`${year}-`)).map((m) => m.month)
    )[channel] || {},
  }));
  const rows = [
    [`${channel.toUpperCase()} ANALYTICS — YEAR OVER YEAR`],
    [
      channel === "Shopify"
        ? "Future delivery:* tags split Courier from Booked ourselves; older sales remain Legacy / unclassified."
        : `${countLabel} are derived from Ledger rows with Source grouped as ${channel}.`,
    ],
    ["Operating expenses are company-level; channel profit shown here is gross profit after product COGS."],
    [],
    ["YEAR-OVER-YEAR PERFORMANCE"],
    ["Year", "Gross collected", "Output tax", "Revenue ex-tax", "COGS", "Gross profit", "Gross margin %", countLabel, "Units", "AOV"],
    ...annual.map(({ year, summary }) => [
      Number(year),
      round2(summary.grossCollected || 0),
      round2(summary.tax || 0),
      round2(summary.revenue || 0),
      round2(summary.cogs || 0),
      round2(summary.grossProfit || 0),
      summary.grossMargin || 0,
      channel === "Shopify" ? summary.orders || 0 : summary.transactions || 0,
      round2(summary.units || 0),
      round2(pct(summary.revenue || 0, channel === "Shopify" ? summary.orders : summary.transactions)),
    ]),
  ];

  if (channel === "Shopify") {
    rows.push(
      [],
      ["DELIVERY ROUTE BY YEAR"],
      ["Year", "Route", "Revenue ex-tax", "Orders", "Units", "Revenue mix %"]
    );
    for (const year of years) {
      const monthKeys = monthly.filter((m) => m.month.startsWith(`${year}-`)).map((m) => m.month);
      const routes = aggregateSalesStats(rollup.deliveryRouteStats, monthKeys);
      const totalRevenue = sum(Object.values(routes), (route) => route.revenue);
      for (const route of ["Courier", "Booked ourselves", "Gift / PR", "Legacy / unclassified"]) {
        const value = routes[route] || {};
        rows.push([
          Number(year), route, round2(value.revenue || 0), value.orders || 0,
          round2(value.units || 0), pct(value.revenue || 0, totalRevenue),
        ]);
      }
    }
  }

  rows.push(
    [],
    ["TOP ITEMS BY YEAR"],
    ["Year", "Rank", "Item", "Revenue ex-tax", "COGS", "Gross profit", "Gross margin %", "Units"]
  );
  for (const { year, summary } of annual) {
    for (const [index, item] of (summary.items || []).slice(0, 10).entries()) {
      rows.push([
        Number(year), index + 1, item.label, round2(item.revenue),
        round2(item.cogs), round2(item.grossProfit), item.grossMargin,
        round2(item.units),
      ]);
    }
  }
  return rows;
}

function buildAnalyticsValues(rollup, pipeline) {
  const monthly = rollup.monthly || [];
  const latest = monthly.at(-1)?.month || "No ledger data";
  const year = latest.slice(0, 4);
  const ytdMonths = monthly.filter((m) => m.month.startsWith(`${year}-`));
  const ytd = periodSummary(ytdMonths);
  const allTime = periodSummary(monthly);
  const annual = [...new Set(monthly.map((m) => m.month.slice(0, 4)))].sort()
    .map((reportYear) => ({
      year: Number(reportYear),
      ...periodSummary(monthly.filter((m) => m.month.startsWith(`${reportYear}-`))),
    }));
  const ytdMonthKeys = ytdMonths.map((m) => m.month);
  const allMonthKeys = monthly.map((m) => m.month);
  const channelsYtd = aggregateSalesStats(rollup.channelStats, ytdMonthKeys);
  const channelsAll = aggregateSalesStats(rollup.channelStats, allMonthKeys);
  const deliveryYtd = aggregateSalesStats(rollup.deliveryRouteStats, ytdMonthKeys);
  const deliveryAll = aggregateSalesStats(rollup.deliveryRouteStats, allMonthKeys);
  const products = aggregateProducts(
    rollup.productStats || {}, ytdMonthKeys
  ).filter((p) => p.inVariantMaster && (p.revenue || p.cogs || p.units));

  const expenseMap = {};
  for (const month of ytdMonths) {
    for (const [category, value] of Object.entries(month.expenseByCategory)) {
      expenseMap[category] = (expenseMap[category] || 0) + value;
    }
  }
  const expenses = Object.entries(expenseMap).sort((a, b) => b[1] - a[1]);

  const familyMap = {};
  for (const product of products) {
    const key = product.family || product.label;
    if (!familyMap[key]) familyMap[key] = { revenue: 0, cogs: 0, units: 0 };
    familyMap[key].revenue += product.revenue;
    familyMap[key].cogs += product.cogs;
    familyMap[key].units += product.units;
  }
  const families = Object.entries(familyMap).map(([name, value]) => ({
    name, ...value, grossProfit: value.revenue - value.cogs,
    grossMargin: pct(value.revenue - value.cogs, value.revenue),
  })).sort((a, b) => b.revenue - a.revenue).slice(0, 10);

  const byRevenue = [...products].sort((a, b) => b.revenue - a.revenue).slice(0, 10);
  const byUnits = [...products].sort((a, b) => b.units - a.units).slice(0, 10);
  const lowMargin = products.filter((p) => p.sku && p.revenue > 0)
    .sort((a, b) => a.grossMargin - b.grossMargin || a.grossProfit - b.grossProfit)
    .slice(0, 10);

  const rows = [
    ["WA ANALYTICS — WHERE TO FOCUS"],
    [`Reporting period: YTD ${year} through ${latest}`], [],
    ["OPEN PIPELINE — RISK, NOT REVENUE"],
    ["Metric", "Now", "Interpretation"],
    ["Orders", pipeline.orders || 0, "Unrecognized and not posted"],
    ["Gross", round2(pipeline.gross || 0), "Potential customer value"],
    ["Units", pipeline.units || 0, "Awaiting recognition"], [],
    ["YEAR-OVER-YEAR SUMMARY"],
    ["Year", "Revenue ex-tax", "Output tax", "Gross profit", "Gross margin %", "Net profit", "Net margin %", "Orders", "AOV"],
    ...annual.map((summary) => [
      summary.year,
      round2(summary.netRevenue),
      round2(summary.outputTax),
      round2(summary.grossProfit),
      summary.grossMargin,
      round2(summary.netProfit),
      summary.netMargin,
      summary.orders,
      round2(summary.aov),
    ]),
    [],
    ["SALES CHANNEL MIX"],
    ["Channel", `YTD ${year} revenue`, `YTD orders / entries`, "All-time revenue", "All-time orders / entries", "YTD mix %"],
    ...["Shopify", "Manual", "Other Sales"].map((channel) => [
      channel,
      round2(channelsYtd[channel]?.revenue || 0),
      channel === "Shopify"
        ? channelsYtd[channel]?.orders || 0
        : channelsYtd[channel]?.transactions || 0,
      round2(channelsAll[channel]?.revenue || 0),
      channel === "Shopify"
        ? channelsAll[channel]?.orders || 0
        : channelsAll[channel]?.transactions || 0,
      pct(channelsYtd[channel]?.revenue || 0, ytd.revenueExTax),
    ]),
    ["Count basis: Shopify = distinct order references; Manual / Other Sales = Ledger sale entries."],
    [], ["SHOPIFY DELIVERY ROUTE — TRACKED FROM NEW POSTS"],
    ["Route", `YTD ${year} revenue`, `YTD ${year} orders`, "All-time revenue", "All-time orders", "Notes"],
    ...["Courier", "Booked ourselves", "Gift / PR", "Legacy / unclassified"].map((route) => [
      route,
      round2(deliveryYtd[route]?.revenue || 0),
      deliveryYtd[route]?.orders || 0,
      round2(deliveryAll[route]?.revenue || 0),
      deliveryAll[route]?.orders || 0,
      route === "Legacy / unclassified"
        ? "Historical Shopify sales without delivery tags in Ledger"
        : route === "Gift / PR"
          ? "wa:gift / wa:pr — no revenue, tax exempt"
          : "Recorded from delivery:* on new posts",
    ]),
    [],
    ...buildChannelTopSalesRows("SHOPIFY", channelsYtd.Shopify?.items, year),
    [],
    ...buildChannelTopSalesRows("MANUAL", channelsYtd.Manual?.items, year),
    [],
    ...buildChannelTopSalesRows("OTHER SALES", channelsYtd["Other Sales"]?.items, year),
    [],
    [`EXPENSE MIX — YTD ${year}`], ["Category", "PKR", "% of opex"],
    ...expenses.map(([category, value]) => [category, round2(value), pct(value, ytd.totalOpex)]),
    [], ["TAX MIX"], ["Metric", `YTD ${year}`, "All time", "Notes"],
    ["Output tax accrued", round2(ytd.outputTax), round2(allTime.outputTax), "Tax-aware posts only"],
    ["Taxable revenue ex-tax", round2(ytd.taxableRevenue), round2(allTime.taxableRevenue), "Sale has matching Tax row"],
    ["Exempt / legacy-untracked revenue", round2(ytd.untrackedRevenue), round2(allTime.untrackedRevenue), "Includes non-Shopify and legacy gross history"],
    [
      "Taxable mix %",
      pct(ytd.taxableRevenue, ytd.taxableRevenue + ytd.untrackedRevenue),
      pct(allTime.taxableRevenue, allTime.taxableRevenue + allTime.untrackedRevenue),
      "Shopify tax coverage versus all recognized revenue",
    ],
    [], [`DELIVERY — YTD ${year}`], ["Metric", "Value", "Notes"],
    ["Courier orders", ytd.courierOrders, "Distinct tax-linked order references"],
    ["Delivery expense", round2(ytd.deliveryExp), "Ledger Expense / Delivery"],
    ["Delivery cost / courier order", round2(pct(ytd.deliveryExp, ytd.courierOrders)), "Directional while older orders lack tax links"],
    [], [`PRODUCT FAMILY ECONOMICS — TOP 10 BY REVENUE, YTD ${year}`],
    ["Product family", "Revenue ex-tax", "COGS", "Gross profit", "Gross margin %"],
    ...families.map((p) => [p.name, round2(p.revenue), round2(p.cogs), round2(p.grossProfit), p.grossMargin]),
    [], [`BESTSELLERS — YTD ${year}`],
    ["By revenue", "Revenue", "Units", "GM %", "", "By units", "Units", "Revenue", "GM %"],
  ];

  for (let i = 0; i < Math.max(byRevenue.length, byUnits.length); i++) {
    const r = byRevenue[i];
    const u = byUnits[i];
    rows.push([
      r ? `${i + 1}. ${r.label}${r.sku ? ` (${r.sku})` : ""}` : "",
      r ? round2(r.revenue) : "", r ? round2(r.units) : "", r ? r.grossMargin : "", "",
      u ? `${i + 1}. ${u.label}${u.sku ? ` (${u.sku})` : ""}` : "",
      u ? round2(u.units) : "", u ? round2(u.revenue) : "", u ? u.grossMargin : "",
    ]);
  }

  rows.push(
    [], [`LOWEST-MARGIN SKUs — YTD ${year}`],
    ["SKU", "Product", "Revenue ex-tax", "Gross profit", "Gross margin %"],
    ...lowMargin.map((p) => [p.sku, p.label, round2(p.revenue), round2(p.grossProfit), p.grossMargin]),
    [], ["12-MONTH TREND"],
    ["Month", "Net revenue ex-tax", "Net profit", "Gross margin %", "Net margin %"],
    ...monthly.slice(-12).map((m) => [m.month, round2(m.netRevenue), round2(m.netProfit), m.grossMargin, m.netMargin])
  );
  return rows;
}

module.exports = {
  PNL_HEADERS, rollupLedger, buildDashboardValues, buildAnalyticsValues,
  buildChannelAnalyticsValues,
  monthKey, orderKeyFromRef, periodSummary,
};
