import mongoose from "mongoose";

const categorySchema = new mongoose.Schema({
    name: { 
        type: String, 
        required: true, 
        trim: true 
    },
    path: { 
        type: String, 
        required: true, 
        unique: true 
    },
    wearType: { 
        type: String, 
        enum: ['TopWear', 'FootWear', 'Accessories' , 'BottomWear', 'Outerwear', 'Underwear', 'Activewear', 'Sleepwear', 'Swimwear'], 
        required: true 
    },
    image: { 
        type: String, 
        required: true 
    },
    description: { 
        type: String 
    },
    metaTitle: { 
        type: String 
    },
    isActive: { 
        type: Boolean, 
        default: true 
    },
    parentCollection: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'Collection', 
        required: true 
    }
}, { 
    timestamps: true 
});


categorySchema.index({ parentCollection: 1 });

const Category = mongoose.model("Category", categorySchema);

export default Category;