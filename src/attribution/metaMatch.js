/**
 * Match first-party Meta IDs to Meta entity metadata.
 * Stable ID only — no fuzzy name matching.
 */
function indexMetaEntities(entities = []) {
  const byId = new Map();
  for (const e of entities || []) {
    const id = String(
      e.entity_id ||
        e.id ||
        e.ad_id ||
        e.adset_id ||
        e.campaign_id ||
        ""
    );
    if (id) byId.set(id, e);
  }
  return byId;
}

function matchMetaIds(metaEvidence, { campaigns = [], adsets = [], ads = [] } = {}) {
  const campIdx = indexMetaEntities(campaigns);
  const adsetIdx = indexMetaEntities(adsets);
  const adIdx = indexMetaEntities(ads);

  const campaign_id = metaEvidence?.campaign_id
    ? String(metaEvidence.campaign_id)
    : null;
  const adset_id = metaEvidence?.adset_id
    ? String(metaEvidence.adset_id)
    : null;
  const ad_id = metaEvidence?.ad_id ? String(metaEvidence.ad_id) : null;

  return {
    campaign: campaign_id
      ? {
          id: campaign_id,
          matched: campIdx.has(campaign_id),
          entity: campIdx.get(campaign_id) || null,
        }
      : { id: null, matched: false, entity: null },
    adset: adset_id
      ? {
          id: adset_id,
          matched: adsetIdx.has(adset_id),
          entity: adsetIdx.get(adset_id) || null,
        }
      : { id: null, matched: false, entity: null },
    ad: ad_id
      ? {
          id: ad_id,
          matched: adIdx.has(ad_id),
          entity: adIdx.get(ad_id) || null,
        }
      : { id: null, matched: false, entity: null },
  };
}

module.exports = {
  indexMetaEntities,
  matchMetaIds,
};
