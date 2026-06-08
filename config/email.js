import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

import dns from 'dns'; // Import Node's native DNS module

const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false, 
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },
    // FORCE NODE TO ONLY LOOK UP IPV4 ADDRESSES
    lookup: (hostname, options, callback) => {
        options.family = 4; // Hard overrides the lookup to IPv4 only
        return dns.lookup(hostname, options, callback);
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
