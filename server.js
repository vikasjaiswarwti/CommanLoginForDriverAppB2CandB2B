const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const connectDB = require("./config/database");
const authRoutes = require("./routes/authRoutes");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5002;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Connect to Database - make sure this is called
connectDB()
  .then(() => {
    // Routes
    app.use("/0auth/comman-driver-app", authRoutes);

    // Health check
    app.get("/health", (req, res) => {
      res.json({
        status: "OK",
        service: "Auth Service",
        mongodb: "connected",
      });
    });

    app.listen(PORT, () => {
      console.log(`Auth Service running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Failed to connect to MongoDB:", err);
    process.exit(1);
  });
