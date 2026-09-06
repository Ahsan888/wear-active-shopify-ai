/**
 * Explicit Meta entity → product/SKU mapping only.
 * No fuzzy name matching. Missing map → inventory UNKNOWN.
 */
const fs = require("fs");
const path = require("path");

/**
 * @typedef {{ entity_type: string, entity_id: string, sku?: string, product?: string }} EntityProductMapRow
 */

/**
 * Load optional config/marketing-entity-product-map.json
 * Shape: [{ "entity_type":"ad"|"adset"|"campaign", "entity_id":"...", "sku":"...", "product":"..." }]
 */
function loadEntityProductMap(filePath) {
  const p =
    filePath ||
    path.join(process.cwd(), "config", "marketing-entity-product-map.json");
  if (!fs.existsSync(p)) {
    return { rows: [], source: null, note: "no_mapping_file" };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    const rows = Array.isArray(raw) ? raw : raw.mappings || [];
    const cleaned = rows
      .filter((r) => r && r.entity_id && r.entity_type)
      .map((r) => ({
        entity_type: String(r.entity_type).toLowerCase(),
        entity_id: String(r.entity_id),
        sku: r.sku ? String(r.sku).trim() : null,
        product: r.product ? String(r.product).trim() : null,
      }));
    return { rows: cleaned, source: p, note: "explicit_id_map" };
  } catch (err) {
    return {
      rows: [],
      source: p,
      note: `mapping_load_error:${err.message || err}`,
    };
  }
}

function indexEntityProductMap(rows = []) {
  const byKey = new Map();
  for (const r of rows) {
    byKey.set(`${r.entity_type}:${r.entity_id}`, r);
  }
  return byKey;
}

function lookupEntityProduct(entity, mapIndex) {
  if (!entity?.entity_id || !mapIndex || mapIndex.size === 0) return null;
  return (
    mapIndex.get(`${entity.entity_type}:${entity.entity_id}`) ||
    mapIndex.get(`ad:${entity.entity_id}`) ||
    null
  );
}

module.exports = {
  loadEntityProductMap,
  indexEntityProductMap,
  lookupEntityProduct,
};
