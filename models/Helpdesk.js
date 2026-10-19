const mongoose = require("mongoose");

// Case-insensitive matching for city ("Pune" == "pune")
const CI = { locale: "en", strength: 2 };

const CITY_TYPES = ["Tier 1", "Tier 2&3"];

// One helpdesk entry per branch per business type
const HelpdeskSchema = new mongoose.Schema(
  {
    // Wise BranchID
    branchId: {
      type: Number,
      required: true,
    },
    // BranchName, e.g. "Gurugram"
    city: {
      type: String,
      required: true,
      trim: true,
    },
    // "Tier 1" → city has its own helpdesk numbers,
    // "Tier 2&3" → served by the shared Tier 2&3 helpdesk numbers
    cityType: {
      type: String,
      enum: CITY_TYPES,
      required: true,
    },
    // One or more numbers, e.g. ["9643318412", "9266627730"]
    helpdeskContact: {
      type: [{ type: String, trim: true }],
      validate: {
        validator: (v) => Array.isArray(v) && v.length > 0,
        message: "At least one helpdesk contact is required",
      },
    },
    // "b2b" → Wise drivers, "b2c" → MMT drivers
    type: {
      type: String,
      enum: ["b2b", "b2c"],
      required: true,
    },
    description: {
      type: String,
      trim: true,
      default: "",
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true, collection: "helpdesks" },
);

HelpdeskSchema.index({ branchId: 1, type: 1 }, { unique: true });
HelpdeskSchema.index({ city: 1 }, { collation: CI });

module.exports = mongoose.model("Helpdesk", HelpdeskSchema);
module.exports.HELPDESK_COLLATION = CI;
module.exports.CITY_TYPES = CITY_TYPES;
