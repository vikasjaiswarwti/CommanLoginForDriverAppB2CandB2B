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

// GET /get-helpdesk?userid=…&token=…&type=B2B&branch=Delhi
//   userid + token required (driver session check, 401 on mismatch);
//   type and branch are optional filters
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
    if (branch?.trim()) filter.branch = branch.trim();

    const helpdesks = await Helpdesk.find(filter)
      .collation(HELPDESK_COLLATION)
      .sort({ branch: 1, type: 1 })
      .lean();

    return res.status(200).json({
      success: true,
      data: helpdesks.map((h) => ({
        helpdeskContact: h.helpdeskContact,
        branch: h.branch,
        type: h.type.toUpperCase(),
        description: h.description,
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
// { helpdeskContact, branch, type: "B2B" | "B2C", description?, isActive? }
// Upserts on branch + type (branch matched case-insensitively)
const createOrUpdateHelpdesk = async (req, res) => {
  try {
    const { helpdeskContact, branch, type, description, isActive } = req.body;
    const t = toType(type);

    if (!helpdeskContact?.toString().trim() || !branch?.trim() || !t) {
      return res.status(400).json({
        success: false,
        message: 'helpdeskContact, branch and type ("B2B" or "B2C") are required',
      });
    }

    const update = {
      helpdeskContact: helpdeskContact.toString().trim(),
      branch: branch.trim(),
      type: t,
    };
    if (typeof description === "string") update.description = description.trim();
    if (typeof isActive === "boolean") update.isActive = isActive;

    const helpdesk = await Helpdesk.findOneAndUpdate(
      { branch: update.branch, type: t },
      { $set: update },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true,
        runValidators: true,
        collation: HELPDESK_COLLATION,
      },
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

module.exports = { getHelpdesk, createOrUpdateHelpdesk };
