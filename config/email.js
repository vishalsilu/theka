import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,            
    secure: false,        
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },
    // This tells the underlying connection socket to only use IPv4 lookup rules
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 10000,
    dns: {
        family: 4 // Forces IPv4 resolution
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
