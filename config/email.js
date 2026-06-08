import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

const transporter = nodemailer.createTransport({
    pool: true, // <-- Add this for better performance on Render
    host: 'smtp.gmail.com',
    port: 465,
    secure: true, 
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },
    tls: {
        rejectUnauthorized: false 
    }
});

export const sendEmail = async ({ to, subject, html }) => {
    try {
        const info = await transporter.sendMail({
            from: `"Urban Support" <${process.env.EMAIL_USER}>`,
            to,
            subject,
            html,
        });
        return { success: true, messageId: info.messageId };
    } catch (error) {
        console.error("❌ SMTP Subsystem Error:", error.message);
        return { success: false, error: error.message };
    }
};