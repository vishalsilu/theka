import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import dotenv from "dotenv";

dotenv.config();


const addressSchema = new mongoose.Schema({
    type: { 
        type: String, 
        enum: ['Home', 'Work', 'Other'], 
        default: 'Home' 
    },
    firstName: { type: String, required: true },
    lastName: { type: String, required: true },
    street: { type: String, required: true },
    apartment: { type: String },
    address: { type: String, required: true },
    city: { type: String, required: true },
    state: { type: String, required: true },
    zip: { type: String, required: true },
    country: { type: String, default: 'India' },
    mobile: { type: String, required: true },
    isDefault: { type: Boolean, default: false }
});

const cartItemSchema = new mongoose.Schema({
    productId: { type: String, required: true },
    quantity: { type: Number, default: 1 },
    size: { type: String, required: true },
    variantId: { type: String, required: true }
}, { _id: false });


const userSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true },
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String,  trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true },
    phone: { type: String, required: true, unique: true, trim: true },
    role: { type: String, enum: ['Customer', 'Admin'], default: process.env.NEW_USER_ROLE },
    addresses: [addressSchema],
    cart: [cartItemSchema]
}, {
    timestamps: true,
    toJSON: { virtuals: true, versionKey: false },
    toObject: { virtuals: true }
});

userSchema.virtual('fullName').get(function() {
    return `${this.firstName} ${this.lastName || ''}`.trim();
});


userSchema.pre('save', async function () {
  // If password isn't modified, just exit the function
  if (!this.isModified('password')) {
    return; 
  }

  // Hash the password
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  
  // No next() needed!
});

userSchema.pre('save', async function () {
    const user = this;

    // Check if the addresses array was touched
    if (user.isModified('addresses')) {
        
        // Find the address the user INTENDS to be the default
        // We look for the first one marked true in the current document state
        const defaultCount = user.addresses.filter(addr => addr.isDefault).length;

        if (defaultCount > 1) {
            // Logic: Keep the one that was most recently set to true
            // If you're passing the whole array from frontend, 
            // find the one that didn't used to be the default.
            
            // Simpler approach: Find the first 'true' and set all others to 'false'
            let defaultFound = false;
            
            user.addresses.forEach((addr) => {
                if (addr.isDefault) {
                    if (!defaultFound) {
                        defaultFound = true; // Keep the first true one we find
                    } else {
                        addr.isDefault = false; // Set any subsequent trues to false
                    }
                }
            });
        }
    }
});
userSchema.methods.comparePassword = async function(enteredPassword) {
    return await bcrypt.compare(enteredPassword, this.password);
};


userSchema.index({ 'addresses.zip': 1 });

const User = mongoose.model('User', userSchema);

export default User;