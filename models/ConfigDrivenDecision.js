const mongoose = require("mongoose");

const ConfigDrivenDecision = new mongoose.Schema(
  {
    _id: {
      type: String,
      default: "GLOBAL_CONFIG",
    },
    isConfigDrivenSwitchForB2bonly: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model("ConfigDrivenDecision", ConfigDrivenDecision);
