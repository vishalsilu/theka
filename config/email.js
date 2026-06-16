// import nodemailer from 'nodemailer';

// // Create a transporter using Brevo's SMTP server
// const transporter = nodemailer.createTransport({
//     service: 'gmail',
//     port: 587,
//     secure: false, // true for 465, false for other ports
//     auth: {
//         user: "7649shelly@gmail.com", // Your Brevo login email
//         pass: "krfw ugoq tfyi djex",    // Your Brevo API Key (SMTP Key)
//     },
// });

// export const sendEmail = async ({ to, subject, html }) => {
//     try {
//         const info = await transporter.sendMail({
//             from: {
//                 name:  "Urban Royalty Support",
//                 address: "7649shelly@gmail.com"
//             },
//             to: to,
//             subject: subject,
//             html: html,
//         });

//         return { success: true, messageId: info.messageId };
//     } catch (error) {
//         console.error("❌ Nodemailer/Brevo Error:", error.message);
//         return { success: false, error: error.message };
//     }
// };

import dotenv from 'dotenv';
dotenv.config();

const BREVO_API_KEY = process.env.BREVO_API_KEY;
const BREVO_EMAIL_USER = process.env.BREVO_EMAIL_USER;
const BREVO_SENDER_NAME = process.env.BREVO_SENDER_NAME || 'Urban Royalty Support';

if (!BREVO_API_KEY || !BREVO_EMAIL_USER) {
    console.warn('⚠️ Brevo config missing: BREVO_API_KEY or BREVO_EMAIL_USER not set. Emails will fail if not configured.');
}

export const sendEmail = async ({ to, subject, html, replyTo }) => {
    try {
        const payload = {
            sender: {
                name: BREVO_SENDER_NAME,
                email: BREVO_EMAIL_USER
            },
            to: [{ email: to, name: 'Valued User' }],
            subject,
            htmlContent: html
        };

        if (replyTo) {
            // Brevo accepts a "replyTo" object
            payload.replyTo = { email: replyTo };
        }

        // Diagnostic log to help determine if requests reach Brevo
        console.log('📨 Sending email via Brevo:', { to, subject, sender: BREVO_EMAIL_USER, replyTo });

        const response = await fetch('https://api.brevo.com/v3/smtp/email', {
            method: 'POST',
            headers: {
                accept: 'application/json',
                'api-key': BREVO_API_KEY,
                'content-type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        const responseText = await response.text();
        let data = {};
        if (responseText) {
            try { data = JSON.parse(responseText); } catch (e) { data = { raw: responseText }; }
        }

        console.log('📬 Brevo responded with status', response.status, 'and body', data);

        if (response.ok) {
            return { success: true, status: response.status, data };
        }

        console.error('❌ Brevo rejected payload:', { status: response.status, body: data });
        return { success: false, status: response.status, error: data?.message || JSON.stringify(data) };

    } catch (error) {
        console.error('❌ Network/Error sending to Brevo:', error?.message || error);
        return { success: false, error: error?.message || String(error) };
    }
};

