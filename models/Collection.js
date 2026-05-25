import mongoose from "mongoose";

const collectionSchema = new mongoose.Schema({
    name: { 
        type: String, 
        required: true, 
        unique: true, 
        trim: true 
    },
    image: { 
        type: String 
    },
    path : {
        type: String,
        required: true,
        unique: true,
        trim: true
    },
    featured: [
        {
        isFeatured: { 
            type: Boolean, 
            default: false 
        },
        featuredCategory: { 
            type: mongoose.Schema.Types.ObjectId, 
            ref: 'Category',
            default: null 
        }
    }
]
}, { 
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
});


collectionSchema.virtual('allCategories', {
    ref: 'Category',
    localField: '_id',
    foreignField: 'parentCollection'
});

const Collection = mongoose.model("Collection", collectionSchema);

export default Collection;