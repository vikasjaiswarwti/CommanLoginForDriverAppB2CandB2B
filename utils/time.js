// utils/time.js

// ─────────────────────────────────────────────────────────────────────────────
// tds() → "time-date-stamp" prefix for server console logs, in IST:
//   [2026-10-06 14:32:10.123 IST]
// ─────────────────────────────────────────────────────────────────────────────

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

const tds = (date = new Date()) => {
  const ist = new Date(date.getTime() + IST_OFFSET_MS).toISOString();
  return `[${ist.slice(0, 10)} ${ist.slice(11, 23)} IST]`;
};

module.exports = { tds };
