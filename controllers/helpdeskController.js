// controllers/helpdeskController.js

const Helpdesk = require("../models/Helpdesk");
const { HELPDESK_COLLATION } = require("../models/Helpdesk");
const time = require("../utils/time");
const {
  UNAUTHORIZED_MESSAGE,
  verifyDriverSession,
} = require("../utils/sessionAuth");

// ─────────────────────────────────────────────
// Helpdesk endpoints
// ─────────────────────────────────────────────

// "B2B" / "btob" → "b2b", "B2C" / "btoc" → "b2c", anything else → null
const toType = (value) => {
  const t = String(value ?? "").toLowerCase();
  if (t === "b2b" || t === "btob") return "b2b";
  if (t === "b2c" || t === "btoc") return "b2c";
  return null;
};

// "tier 1" / "Tier1" / "1" → "Tier 1"; "tier 2&3" / "tier2", "3" … → "Tier 2&3"
const toCityType = (value) => {
  const t = String(value ?? "").toLowerCase().replace(/\s/g, "");
  if (["tier1", "1"].includes(t)) return "Tier 1";
  if (["tier2&3", "tier2", "tier3", "2", "3", "2&3"].includes(t)) return "Tier 2&3";
  return null;
};

// "9884823500, 9551515000" or ["9884823500", …] → ["9884823500", "9551515000"]
const toContacts = (value) =>
  (Array.isArray(value) ? value : String(value ?? "").split(","))
    .map((c) => String(c).trim())
    .filter(Boolean);

// GET /get-helpdesk?userid=…&token=…[&type=B2B][&branch=…]
//   userid + token required (driver session check, 401 on mismatch);
//   type and branch are optional filters. branch is a BranchID ("6") or a
//   branch/city name ("Mumbai", case-insensitive).
const getHelpdesk = async (req, res) => {
  try {
    const { type, branch, userid, token } = req.query;

    if (!userid) {
      return res
        .status(400)
        .json({ success: false, message: "userid (vehicle number) is required" });
    }

    // Session check — app's token must be the driver's current token
    const session = await verifyDriverSession(userid, token);
    if (!session.ok) {
      console.warn(`${time.tds()} [HELPDESK] 401 for userid=${userid}: ${session.log}`);
      return res.status(401).json({ success: false, message: UNAUTHORIZED_MESSAGE });
    }

    const filter = { isActive: true };
    if (type !== undefined) {
      const t = toType(type);
      if (!t) {
        return res
          .status(400)
          .json({ success: false, message: 'type must be "B2B" or "B2C"' });
      }
      filter.type = t;
    }
    // branch → BranchID when numeric, otherwise the branch/city name
    const b = branch?.trim();
    if (b) {
      if (/^\d+$/.test(b)) filter.branchId = Number(b);
      else filter.city = b;
    }

    const helpdesks = await Helpdesk.find(filter)
      .collation(HELPDESK_COLLATION)
      .sort({ branchId: 1, type: 1 })
      .lean();

    // Same response fields as before (helpdeskContact as one string, branch =
    // name); branchId / cityType are extra fields only
    return res.status(200).json({
      success: true,
      data: helpdesks.map((h) => ({
        helpdeskContact: Array.isArray(h.helpdeskContact)
          ? h.helpdeskContact.join(", ")
          : h.helpdeskContact,
        branch: h.city ?? h.branch,
        type: h.type.toUpperCase(),
        description: h.description,
        branchId: h.branchId ?? null,
        cityType: h.cityType ?? null,
      })),
    });
  } catch (error) {
    console.error("Helpdesk Fetch Error:", error.message);
    return res
      .status(500)
      .json({ success: false, message: "Internal Server Error" });
  }
};

// POST /create-or-update/helpdesk
// { branchId, city, cityType: "Tier 1" | "Tier 2&3",
//   helpdeskContact: "9884823500, 9551515000" | ["9884823500", …],
//   type: "B2B" | "B2C", description?, isActive? }
// Upserts on branchId + type
const createOrUpdateHelpdesk = async (req, res) => {
  try {
    const { branchId, city, cityType, helpdeskContact, type, description, isActive } =
      req.body;
    const t = toType(type);
    const ct = toCityType(cityType);
    const contacts = toContacts(helpdeskContact);
    const id = Number(branchId);

    if (!Number.isFinite(id) || !city?.trim() || !ct || !t || !contacts.length) {
      return res.status(400).json({
        success: false,
        message:
          'branchId (number), city, cityType ("Tier 1" or "Tier 2&3"), helpdeskContact and type ("B2B" or "B2C") are required',
      });
    }

    const update = {
      branchId: id,
      city: city.trim(),
      cityType: ct,
      helpdeskContact: contacts,
      type: t,
    };
    if (typeof description === "string") update.description = description.trim();
    if (typeof isActive === "boolean") update.isActive = isActive;

    const helpdesk = await Helpdesk.findOneAndUpdate(
      { branchId: id, type: t },
      { $set: update },
      { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true },
    );

    return res.status(200).json({
      success: true,
      message: "Helpdesk saved successfully",
      data: helpdesk,
    });
  } catch (error) {
    console.error("Helpdesk Save Error:", error.message);
    return res
      .status(500)
      .json({ success: false, message: "Internal Server Error" });
  }
};

module.exports = { getHelpdesk, createOrUpdateHelpdesk, toContacts };
