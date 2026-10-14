const mongoose = require("mongoose");

// Case-insensitive matching for branch ("Delhi" == "delhi")
const CI = { locale: "en", strength: 2 };

// One helpdesk contact per branch per business type
const HelpdeskSchema = new mongoose.Schema(
  {
    helpdeskContact: {
      type: String,
      required: true,
      trim: true,
    },
    branch: {
      type: String,
      required: true,
      trim: true,
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

HelpdeskSchema.index({ branch: 1, type: 1 }, { unique: true, collation: CI });

module.exports = mongoose.model("Helpdesk", HelpdeskSchema);
module.exports.HELPDESK_COLLATION = CI;
