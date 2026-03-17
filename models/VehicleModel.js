const mongoose = require("mongoose");

const VehicleSchema = new mongoose.Schema(
  {
    VendorId: {
      type: String,
      trim: true,
    },
    DriverId: {
      type: String,
      default: null,
    },
    ActiveDriver: {
      type: String,
      default: null,
    },
    DriverArray: {
      type: [String], // This indicates an array of strings
      default: [], // You can set a default empty array if needed
    },
    VehicleNumber: {
      type: String,
      trim: true,
    },
    Brand: {
      type: String,
      trim: true,
    },
    FuelType: {
      type: String,
      trim: true,
    },
    InsuranceValidUpto: {
      type: String,
      trim: true,
    },
    RegisterationDate: {
      type: String,
      trim: true,
    },
    CarNumberPhoto: {
      type: String,
      trim: true,
    },
    vehicleCategory: {
      type: String,
      trim: true,
    },
    ModelType: {
      type: String,
      trim: true,
    },
    VehicleOwnership: {
      type: String,
      trim: true,
    },
    InsurancePhoto: {
      type: String,
      trim: true,
    },
    RegistercertificateFrontLink: {
      type: String,
      trim: true,
    },
    RegistercertificateBackLink: {
      type: String,
      trim: true,
    },
    Leasecertificate: {
      type: String,
      trim: true,
    },
    CarStatus: {
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
    CarOccupancy: [
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

    vehiclecurrentstatus: {
      type: Number,
      enum: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
      default: 0,
    },
    currentBookingid: {
      type: String,
      // default:null,
    },
    modify_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AdminAuthModel", // this should match the name of your admin model
      default: null,
    },
    modify_At: {
      type: Date,
      default: null,
    },
    tempVehicle: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true },
);

const Vehicle = mongoose.model("Vehicle", VehicleSchema);

module.exports = { Vehicle };
