/**
 * Beginner-friendly targeting summaries from Meta ad set targeting objects.
 * Never guesses missing settings. Never exposes private customer lists —
 * custom audiences / lookalikes are labelled by type + id only.
 */

function numOrNull(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const COUNTRY_LABELS = {
  PK: "Pakistan",
  US: "United States",
  GB: "United Kingdom",
  AE: "United Arab Emirates",
  SA: "Saudi Arabia",
  IN: "India",
};

function labelCountry(code) {
  const c = String(code || "").toUpperCase();
  return COUNTRY_LABELS[c] || code;
}

function locationSummary(geo) {
  if (!geo || typeof geo !== "object") return null;
  const parts = [];
  for (const key of ["countries", "country_groups"]) {
    if (Array.isArray(geo[key]) && geo[key].length) {
      parts.push(geo[key].map(labelCountry).join(", "));
    }
  }
  for (const key of ["regions", "cities", "zips", "geo_markets", "electoral_districts"]) {
    if (Array.isArray(geo[key]) && geo[key].length) {
      const names = geo[key]
        .map((x) => x?.name || x?.key || x?.country || null)
        .filter(Boolean);
      if (names.length) parts.push(names.join(", "));
      else parts.push(`${geo[key].length} ${key}`);
    }
  }
  if (!parts.length) return null;
  return parts.join("; ");
}

function ageSummary(targeting) {
  const min = numOrNull(targeting?.age_min);
  const max = numOrNull(targeting?.age_max);
  if (min == null && max == null) return null;
  if (min != null && max != null) return `Age ${min}–${max}`;
  if (min != null) return `Age ${min}+`;
  return `Age up to ${max}`;
}

function genderSummary(genders) {
  if (!Array.isArray(genders) || !genders.length) return null;
  // Meta: 1=male, 2=female (0/all often omitted)
  const set = new Set(genders.map(Number));
  if (set.has(1) && set.has(2)) return "All genders";
  if (set.size === 1 && set.has(1)) return "Men";
  if (set.size === 1 && set.has(2)) return "Women";
  return `Genders: ${[...set].join(",")}`;
}

function interestLabels(spec) {
  if (!spec || typeof spec !== "object") return [];
  const out = [];
  for (const key of [
    "interests",
    "behaviors",
    "life_events",
    "industries",
    "income",
    "family_statuses",
    "education_statuses",
    "relationship_statuses",
  ]) {
    if (Array.isArray(spec[key]) && spec[key].length) {
      const names = spec[key]
        .map((x) => x?.name || x?.id || null)
        .filter(Boolean)
        .slice(0, 8);
      if (names.length) out.push(`${key}: ${names.join(", ")}`);
    }
  }
  return out;
}

function audienceLabels(targeting) {
  const out = [];
  const customs = targeting?.custom_audiences;
  if (Array.isArray(customs) && customs.length) {
    out.push(
      `${customs.length} custom audience${customs.length === 1 ? "" : "s"} (ids only)`
    );
  }
  const excluded = targeting?.excluded_custom_audiences;
  if (Array.isArray(excluded) && excluded.length) {
    out.push(
      `${excluded.length} excluded custom audience${excluded.length === 1 ? "" : "s"}`
    );
  }
  // Lookalikes often appear as custom audiences with lookalike origin —
  // we only report presence, not member PII.
  return out;
}

function placementSummary(targeting) {
  const parts = [];
  if (targeting?.publisher_platforms?.length) {
    parts.push(`Platforms: ${targeting.publisher_platforms.join(", ")}`);
  }
  if (targeting?.facebook_positions?.length) {
    parts.push(`Facebook: ${targeting.facebook_positions.join(", ")}`);
  }
  if (targeting?.instagram_positions?.length) {
    parts.push(`Instagram: ${targeting.instagram_positions.join(", ")}`);
  }
  if (targeting?.messenger_positions?.length) {
    parts.push(`Messenger: ${targeting.messenger_positions.join(", ")}`);
  }
  if (targeting?.audience_network_positions?.length) {
    parts.push(
      `Audience Network: ${targeting.audience_network_positions.join(", ")}`
    );
  }
  if (targeting?.device_platforms?.length) {
    parts.push(`Devices: ${targeting.device_platforms.join(", ")}`);
  }
  if (!parts.length) {
    // Empty publisher/position arrays often mean Advantage+ / automatic placements
    return {
      text: "Advantage+ / automatic placements (no manual placement list returned)",
      advantage_plus_likely: true,
      details: [],
    };
  }
  return {
    text: parts.join(" · "),
    advantage_plus_likely: false,
    details: parts,
  };
}

/**
 * Build structured + beginner summary for one ad set targeting blob.
 */
function summarizeTargeting(targeting, opts = {}) {
  const t = targeting && typeof targeting === "object" ? targeting : null;
  const missing = [];
  if (!t) {
    return {
      available: false,
      summary_lines: [],
      beginner_summary: "Targeting details not available from Meta for this ad set.",
      locations: null,
      age: null,
      gender: null,
      detailed_targeting: [],
      audiences: [],
      placements: null,
      optimization_goal: opts.optimization_goal || null,
      advantage_audience: null,
      raw_keys: [],
      notes: ["targeting_object_missing"],
    };
  }

  const locations = locationSummary(t.geo_locations);
  const age = ageSummary(t);
  const gender = genderSummary(t.genders);
  const detailed = [
    ...interestLabels(t),
    ...interestLabels(t.flexible_spec?.[0]),
  ];
  // flexible_spec can be an array of OR groups
  if (Array.isArray(t.flexible_spec)) {
    for (let i = 0; i < t.flexible_spec.length; i += 1) {
      for (const line of interestLabels(t.flexible_spec[i])) {
        if (!detailed.includes(line)) detailed.push(line);
      }
    }
  }
  const audiences = audienceLabels(t);
  const placements = placementSummary(t);

  const advantageAudience =
    t.targeting_automation?.advantage_audience != null
      ? Boolean(t.targeting_automation.advantage_audience)
      : t.targeting_optimization != null
        ? String(t.targeting_optimization)
        : null;

  if (!locations) missing.push("locations");
  if (!age) missing.push("age");
  if (!gender) missing.push("gender");

  const lines = [];
  if (locations) lines.push(locations);
  if (age) lines.push(age);
  if (gender) lines.push(gender);
  if (detailed.length) lines.push(...detailed.slice(0, 6));
  else lines.push("Broad / no detailed interests returned");
  if (audiences.length) lines.push(...audiences);
  if (placements?.text) lines.push(placements.text);
  if (advantageAudience === true) lines.push("Advantage audience on");
  else if (advantageAudience === false) lines.push("Advantage audience off");
  if (opts.optimization_goal) {
    lines.push(`Optimization: ${opts.optimization_goal}`);
  }

  return {
    available: true,
    summary_lines: lines,
    beginner_summary: lines.join(" · "),
    locations,
    age,
    gender,
    detailed_targeting: detailed,
    audiences,
    placements,
    optimization_goal: opts.optimization_goal || null,
    advantage_audience: advantageAudience,
    raw_keys: Object.keys(t),
    notes: missing.length ? [`missing_fields:${missing.join(",")}`] : [],
  };
}

module.exports = {
  summarizeTargeting,
  locationSummary,
  ageSummary,
  genderSummary,
  placementSummary,
  audienceLabels,
  interestLabels,
};
