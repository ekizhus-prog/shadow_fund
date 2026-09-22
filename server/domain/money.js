export const UNIT_SCALE = 100_000_000;

export function usdToCents(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new Error(`Invalid USD amount: ${value}`);
  const [whole, fraction = ''] = text.split('.');
  return Number(BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2)));
}

export function centsToUsd(cents) {
  return (Number(cents) / 100).toFixed(2);
}

export function unitsToNumber(units) {
  return Number(units) / UNIT_SCALE;
}

export function unitsForNotional(notionalCents, priceCents) {
  if (!priceCents || notionalCents <= 0) return 0;
  return Math.floor((notionalCents * UNIT_SCALE) / priceCents);
}

export function notionalForUnits(units, priceCents) {
  return Math.floor((units * priceCents) / UNIT_SCALE);
}

export function feeForNotional(notionalCents) {
  return Math.floor(notionalCents * 0.001);
}

export function roundWeight(value) {
  return Math.round(value * 10000) / 10000;
}
