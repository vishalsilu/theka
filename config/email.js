import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
    host: 'smtp.resend.com',
    secure: true,
    port: 465,
    auth: {
        user: 'resend', // This stays exactly as the string 'resend'
        pass: process.env.EMAIL_PASS, // Your Resend API Key from Render env
    },
});

export const sendEmail = async ({ to, subject, html }) => {
    try {
        const info = await transporter.sendMail({
            // Free tier restriction: Must use onboarding@resend.dev until domain is verified
            from: "Urban Support <onboarding@resend.dev>", 
            to, // During testing, this must be YOUR personal email registered on Resend
            subject,
            html,
        });
        return { success: true, messageId: info.messageId };
    } catch (error) {
        console.error("❌ SMTP Subsystem Error:", error.message);
        return { success: false, error: error.message };
    }
};

// import nodemailer from 'nodemailer';
// import dotenv from 'dotenv';

// dotenv.config();

// const transporter = nodemailer.createTransport({
//     host: 'smtp.gmail.com',
//     port: 465,
//     secure: true, // Use true for port 465
//     auth: {
//         user: process.env.EMAIL_USER,
//         pass: process.env.EMAIL_PASS,
//     },
//     tls: {
//         // This stops Render/AWS cloud certificates from failing the handshake
//         rejectUnauthorized: false 
//     }
// });

// export const sendEmail = async ({ to, subject, html }) => {
//     try {
//         const info = await transporter.sendMail({
//             from: `"Urban Support" <${process.env.EMAIL_USER}>`,
//             to,
//             subject,
//             html,
//         });
//         return { success: true, messageId: info.messageId };
//     } catch (error) {
//         console.error("❌ SMTP Subsystem Error:", error.message);
//         return { success: false, error: error.message };
//     }
// };