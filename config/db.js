import mongoose from "mongoose";

const connectDB = async () => {
  try {
    // This looks into your .env for MONGO_URI
    const conn = await mongoose.connect(process.env.MONGO_URI);
    
    console.log(`✅ MongoDB Connected: ${conn.connection.host}`);
  } catch (error) {
    console.error(`❌ MongoDB connection error: ${error.message}`);
    process.exit(1); 
  }
};

export default connectDB;