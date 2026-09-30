const mongoose = require("mongoose");

async function connectDB() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is missing in .env");
  mongoose.connection.on("disconnected", () => console.warn("[db] disconnected — driver will retry"));
  mongoose.connection.on("reconnected", () => console.log("[db] reconnected"));
  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 8000,
    // URI me database naam na ho to "test" DB me data jaata tha
    dbName: process.env.MONGODB_DB || undefined,
    maxPoolSize: 20,
  });
  console.log(`[db] Connected to MongoDB (${mongoose.connection.name})`);
}

module.exports = connectDB;
