// utils/documentExpiry.js
//
// "How many days are left?" for every expiring document in a profile payload.
//
// The Wise and MMT payloads are not identical (and the Wise one is not fixed
// yet), so this does not hard-code field names. It walks the payload and treats
// any key that looks like an expiry date (InsuranceValidUpto, LicenseExpiryDate,
// PermitValidTill, FitnessExpiry …) as a document expiry. Dates that are not
// expiries (RegisterationDate, DoB …) never match.
//
// Days are counted in IST calendar days, the same clock the rest of the service uses.

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DEPTH = 8;

// "expiry", "expires", "expiredon", "validupto", "valid_till", "validity", "validto"
const EXPIRY_KEY = /expir|valid_?(upto|till|to|ity)/i;

// default: warn when 30 days or fewer are left
const warnDays = () => Number(process.env.DOC_EXPIRY_WARN_DAYS) || 30;

const istDayNumber = (ms) => Math.floor((ms + IST_OFFSET_MS) / DAY_MS);

// string / Date → Date, or null when it is not a real date.
// Handles ISO and JS date strings, .NET "/Date(1700000000000)/", and dd-mm-yyyy / dd/mm/yyyy.
// Placeholder years (< 2000, e.g. .NET's 0001-01-01 "no date") count as "not set".
const parseDate = (v) => {
  let d = null;
  if (v instanceof Date) d = v;
  else if (typeof v === "string" && v.trim()) {
    const s = v.trim();
    let m;
    if ((m = /^\/Date\((-?\d+)/.exec(s))) {
      d = new Date(Number(m[1]));
    } else if ((m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})(?!\d)/.exec(s))) {
      // day-first, taken as an IST calendar date
      d = new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])) - IST_OFFSET_MS);
    } else if (/\d{4}/.test(s)) {
      d = new Date(s);
    }
  }
  if (!d || Number.isNaN(d.getTime()) || d.getUTCFullYear() < 2000) return null;
  return d;
};

const humanize = (key) =>
  String(key)
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();

const describe = (daysLeft) =>
  daysLeft < 0
    ? `Expired ${-daysLeft} day${daysLeft === -1 ? "" : "s"} ago`
    : daysLeft === 0
      ? "Expires today"
      : `Expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`;

const toItem = (system, path, key, date, now, warn) => {
  const daysLeft = istDayNumber(date.getTime()) - istDayNumber(now);
  return {
    system,
    field: key,
    path,
    label: humanize(key),
    expiryDate: date.toISOString(),
    daysLeft,
    status: daysLeft < 0 ? "expired" : daysLeft <= warn ? "expiring" : "valid",
    message: describe(daysLeft),
  };
};

// Returns a deep copy of `node` where every expiry field also has a sibling
// "<field>DaysLeft", and pushes one item per expiry field into `items`.
const walk = (node, system, path, depth, now, warn, items) => {
  if (Array.isArray(node)) {
    return node.map((n, i) => walk(n, system, `${path}[${i}]`, depth + 1, now, warn, items));
  }
  if (!node || typeof node !== "object" || node instanceof Date || depth > MAX_DEPTH) {
    return node;
  }
  // plain objects only (the payloads come from JSON)
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    const here = path ? `${path}.${key}` : key;
    out[key] = walk(value, system, here, depth + 1, now, warn, items);
    if (EXPIRY_KEY.test(key)) {
      const date = parseDate(value);
      if (date) {
        const item = toItem(system, here, key, date, now, warn);
        items.push(item);
        out[`${key}DaysLeft`] = item.daysLeft;
      }
    }
  }
  return out;
};

// → { data: <copy of payload with *DaysLeft fields>, items: [...] }
const addExpiryInfo = (payload, system, now = Date.now()) => {
  const items = [];
  const data = walk(payload, system, "", 0, now, warnDays(), items);
  return { data, items };
};

// Combined summary over the items of every system, soonest expiry first
const summarize = (items) => {
  const sorted = [...items].sort((a, b) => a.daysLeft - b.daysLeft);
  return {
    warnDays: warnDays(),
    expiredCount: sorted.filter((i) => i.status === "expired").length,
    expiringCount: sorted.filter((i) => i.status === "expiring").length,
    // only what needs attention (expired or inside the warning window)
    attention: sorted.filter((i) => i.status !== "valid"),
    // every expiry date found, with days left
    items: sorted,
  };
};

module.exports = { addExpiryInfo, summarize, parseDate };
