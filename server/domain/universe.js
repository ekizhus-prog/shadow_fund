export const MARKET_CAP_RANGE = Object.freeze({ min: 1, max: 250, defaultMin: 1, defaultMax: 50 });

const LEGACY_UNIVERSES = Object.freeze({
  top50: [1, 50],
  rank51_100: [51, 100],
  top100: [1, 100]
});

export function getAssetUniverse(value) {
  const legacy = LEGACY_UNIVERSES[String(value || '').toLowerCase()];
  const match = String(value || '').match(/^(\d+):(\d+)$/);
  const requestedMin = legacy?.[0] ?? (match ? Number(match[1]) : MARKET_CAP_RANGE.defaultMin);
  const requestedMax = legacy?.[1] ?? (match ? Number(match[2]) : MARKET_CAP_RANGE.defaultMax);
  const minRank = Math.max(MARKET_CAP_RANGE.min, Math.min(MARKET_CAP_RANGE.max, Math.min(requestedMin, requestedMax)));
  const maxRank = Math.max(minRank, Math.min(MARKET_CAP_RANGE.max, Math.max(requestedMin, requestedMax)));
  return {
    id: `${minRank}:${maxRank}`,
    label: `Market-cap ranks ${minRank}–${maxRank}`,
    minRank,
    maxRank,
    description: `Ranks ${minRank} through ${maxRank} in the selected chain scope.`
  };
}
