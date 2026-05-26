import { v2 as cloudinary } from 'cloudinary';
import { CloudinaryStorage } from 'multer-storage-cloudinary';
import multer from 'multer';
import dotenv from 'dotenv';

dotenv.config();

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

const storage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: 'ecommerce_assets',
        allowed_formats: ['jpg', 'png', 'jpeg', 'webp'],
        transformation: [{ width: 1000, height: 1000, crop: 'limit' }] // Optimize on upload
    }
});

export const deleteFromCloudinary = async (fileUrl) => {
    try {
        if (!fileUrl || typeof fileUrl !== 'string') return;

        const urlWithoutQuery = fileUrl.split('?')[0];
        const uploadIndex = urlWithoutQuery.lastIndexOf('/upload/');
        let publicIdPath = uploadIndex >= 0
            ? urlWithoutQuery.substring(uploadIndex + '/upload/'.length)
            : urlWithoutQuery.substring(urlWithoutQuery.lastIndexOf('/') + 1);

        publicIdPath = publicIdPath.replace(/^v\d+\//, '');
        const publicId = publicIdPath.replace(/\.[^/.]+$/, '');
        if (!publicId) return;

        await cloudinary.uploader.destroy(publicId, { resource_type: 'image' });
    } catch (error) {
        console.error("Cloudinary Delete Error:", error);
    }
};

const upload = multer({ storage });
export default upload;