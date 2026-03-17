const mongoose = require("mongoose");

const DriverSchema = new mongoose.Schema(
  {
    VendorId: {
      type: String,
      trim: true,
    },
    VehicleId: {
      type: String,
      default: null,
    },
    DriverName: {
      type: String,
      trim: true,
    },
    MobileNumber: {
      type: String,
      trim: true,
    },
    DoB: {
      type: String,
      trim: true,
    },
    Driverphoto: {
      type: String,
      trim: true,
    },
    LicenseIdNumber: {
      type: String,
      trim: true,
    },
    LicensePhotoFront: {
      type: String,
      trim: true,
    },
    LicensePhotoBack: {
      type: String,
      trim: true,
    },
    LicenseExpiryDate: {
      type: String,
      trim: true,
    },
    Idprooftype: {
      type: String,
      trim: true,
    },
    IdproofFrontPhoto: {
      type: String,
      trim: true,
    },
    IdproofBackPhoto: {
      type: String,
      trim: true,
    },
    pccPhoto: {
      type: String,
      trim: true,
    },
    DriverStatus: {
      type: String,
      trim: true,
      default: "Vacant",
    },
    RegisterStatus: {
      type: String,
      trim: true,
      default: "Pending",
    },
    message: {
      type: String,
      default: "",
    },
    DriverOccupancy: [
      {
        reference_number: {
          type: String,
          trim: true,
        },
        startTime: {
          type: String,
          trim: true,
        },
        endTime: {
          type: String,
          trim: true,
        },
      },
    ],
    modify_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AdminAuthModel", // this should match the name of your admin model
      default: null,
    },
    modify_At: {
      type: Date,
      default: null,
    },
    tempDriver:{
      type:Boolean,
      default:false
    }
  },
  { timestamps: true }
);

const Driver = mongoose.model("Driver", DriverSchema);

module.exports = { Driver };
