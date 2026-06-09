import mongoose from "mongoose";

// --- Sub-Schemas ---

// Tracks inventory for a specific size within a specific color
const sizeVariantSchema = new mongoose.Schema({
    size: { type: String, required: true },
    stock: { type: Number, required: true, default: 0 }
}, { _id: false });

// Groups images and sizes by color (Flexible for products without colors)
const variantSchema = new mongoose.Schema({
    id: { 
      type: Number, 
      required: true, 
      unique: false // Unique is tricky on sub-docs, handle uniqueness in logic
    },
    color: { type: String, default: null }, 
    images: [{ type: String, required: true }],
    isDefault: { type: Boolean, default: false },
    sizes: [sizeVariantSchema] 
}, { _id: false });

// --- Main Product Schema ---
const productSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true }, 
    name: { type: String, required: true, trim: true },
    description: { type: String, required: true },
    price: { type: Number, required: true },
    
    // --- Marketing & Sorting ---
    isFeatured: { type: Boolean, default: false },
    isTrending: { type: Boolean, default: false },
    salesCount: { type: Number, default: 0 }, 
    deal: { type: String, default: null }, 

    // --- Attributes for Filtering ---
    fabric: { type: String, required: true },   // e.g., "Linen"
    pattern: { type: String, required: true },  // e.g., "Striped"
    fit: { 
        type: String, 
        required: true
    },
    sizeType: { 
        type: String, 
        required: true
    },

    // --- Inventory Structure ---
    variants: [variantSchema],

    discount: {
        value: { type: Number, default: 0 },
        type: { 
            type: String, 
            default: 'none' 
        }
    },

    collectionInfo: {
        id: { type: mongoose.Schema.Types.ObjectId, ref: 'Collection', required: true },
        name: { type: String, required: true }
    },
    categoryInfo: {
        id: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', required: true },
        name: { type: String, required: true }
    },

    reviews: [{
        user: String,
        userId: String,
        orderId: String,
        productId: String,
        variant: String,
        title: String,
        comment: String,
        images: [{ type: String }],
        rating: Number,
        date: { type: String, default: () => new Date().toISOString().split('T')[0] }
    }]
    ,
    // Optional timeline entries to track product lifecycle or important events
    timeline: [{
        title: { type: String },
        when: { type: String },
        note: { type: String }
    }]
}, { 
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
});

// --- Virtuals ---

// Final Price Calculation
productSchema.virtual('salePrice').get(function() {
    const originalPrice = this.price || 0;
    const discValue = this.discount?.value || 0;
    const discType = this.discount?.type || 'none';

    if (discType === 'percentage' && discValue > 0) {
        return originalPrice - (originalPrice * (discValue / 100));
    } 
    if (discType === 'amount' && discValue > 0) {
        return Math.max(0, originalPrice - discValue);
    }
    return originalPrice;
});

// Formatting Discount Badge
productSchema.virtual('discountDisplay').get(function() {
    const discValue = this.discount?.value || 0;
    const discType = this.discount?.type || 'none';

    if (discType === 'percentage' && discValue > 0) return `-${discValue}%`;
    if (discType === 'amount' && discValue > 0) return `-₹${discValue.toLocaleString('en-IN')}`; 
    return null;
});

// Real-time Stock Status
productSchema.virtual('inStock').get(function() {
    return this.variants.some(v => v.sizes.some(s => s.stock > 0));
});

// --- Indexes ---
productSchema.index({ "collectionInfo.name": 1 }); 
productSchema.index({ fit: 1 }); // Indexing fit for faster filtering
productSchema.index({ salesCount: -1 });

const Product = mongoose.model("Product", productSchema);

export default Product;
// import mongoose from "mongoose";

// // --- Sub-Schemas ---
// const sizeVariantSchema = new mongoose.Schema({
//     size: { type: String, required: true },
//     stock: { type: Number, required: true, default: 0 }
// }, { _id: false });

// // --- Main Schema ---
// const productSchema = new mongoose.Schema({
//     id: { type: String, required: true, unique: true },
//     name: { type: String, required: true, trim: true },
//     description: { type: String, required: true },
//     price: { type: Number, required: true },
//     isFeatured: { type: Boolean, default: false },

//     discount: {
//         value: { type: Number, default: 0 },
//         type: { 
//             type: String, 
//             enum: ['percentage', 'amount', 'none'], 
//             default: 'none' 
//         }
//     },

//     collectionInfo: {
//         id: { type: mongoose.Schema.Types.ObjectId, ref: 'Collection', required: true },
//         name: { type: String, required: true }
//     },

//     categoryInfo: {
//         id: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', required: true },
//         name: { type: String, required: true }
//     },

//     sizeType: { 
//         type: String, 
//         required: true, 
//         enum: ['Numeric', 'Alpha', 'FreeSize'] 
//     },

//     sizes: [sizeVariantSchema],
//     images: [String],
    
//     reviews: [{
//         user: String,
//         rating: Number,
//         comment: String,
//         date: { type: String, default: () => new Date().toISOString().split('T')[0] }
//     }]
// }, { 
//     timestamps: true,
//     toJSON: { virtuals: true },
//     toObject: { virtuals: true }
// });

// // --- Virtuals (Defined before Model) ---

// // Calculates final price after discount
// // Calculates final price after discount
// // Always returns a number. If no discount, returns the original price.
// productSchema.virtual('salePrice').get(function() {
//     const originalPrice = this.price || 0;
//     const discValue = this.discount?.value || 0;
//     const discType = this.discount?.type || 'none';

//     if (discType === 'percentage' && discValue > 0) {
//         return originalPrice - (originalPrice * (discValue / 100));
//     } 
    
//     if (discType === 'amount' && discValue > 0) {
//         return Math.max(0, originalPrice - discValue);
//     }

//     return originalPrice;
// });

// // Returns a formatted discount string for the UI
// // Returns a string if a discount exists, otherwise returns null or an empty string
// productSchema.virtual('discountDisplay').get(function() {
//     const discValue = this.discount?.value || 0;
//     const discType = this.discount?.type || 'none';

//     if (discType === 'percentage' && discValue > 0) {
//         return `-${discValue}%`;
//     } 
    
//     if (discType === 'amount' && discValue > 0) {
//         // Changed to omit '$' to keep it currency-agnostic, 
//         // or match your 'amount' logic
//         return `-₹${discValue.toLocaleString('en-IN')}`; 
//     }

//     return null;
// });

// // --- Indexes ---
// productSchema.index({ "categoryInfo.id": 1 });
// productSchema.index({ "collectionInfo.id": 1 });
// productSchema.index({ isFeatured: 1 });

// const Product = mongoose.model("Product", productSchema);

// export default Product;