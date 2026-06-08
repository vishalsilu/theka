import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
import dns from 'dns'; // Import Node's native DNS module

dotenv.config();

const transporter = nodemailer.createTransport({
    // Direct IPv4 address for Google's SMTP server
    host: '74.125.142.108', 
    port: 587,
    secure: false, 
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },
    tls: {
        // CRITICAL: Because the SSL certificate belongs to "smtp.gmail.com" 
        // and not the raw IP numbers, we must disable hostname verification 
        // to prevent an "SSL Hostname Mismatch" error.
        rejectUnauthorized: false,
        checkServerIdentity: () => undefined
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
