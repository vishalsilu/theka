import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

const transporter = nodemailer.createTransport({
    service: 'gmail', // Use the internal "gmail" preset driver instead of manual ports
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS, // Your 16-character app password (NO SPACES)
    },
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