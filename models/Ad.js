import mongoose from "mongoose";

const AdSchema = new mongoose.Schema({
    title: {
        type: String
    },
    description: {
        type: String
    },
    code: {
        type: String
    },
    buttonText: {
        type: String
    },
    buttonUrl: {
        type: String
    },
    textPosition : {
        type : String
    },
    image: {
        type: String
    },
    collectionInfo: {
        id: { type: mongoose.Schema.Types.ObjectId, ref: 'Collection', required: true },
        name: { type: String, required: true }
    },
    categoryInfo: {
        id: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', required: true },
        name: { type: String, required: true }
    }
})
AdSchema.index({ "collectionInfo.name": 1 }); 
AdSchema.index({ "categoryInfo.name": 1 }); 



const Ad = mongoose.model("Ad", AdSchema)
export default Ad