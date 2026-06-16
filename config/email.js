import nodemailer from 'nodemailer';

// Create a transporter using Brevo's SMTP server
const transporter = nodemailer.createTransport({
    service: 'gmail',
    port: 587,
    secure: false, // true for 465, false for other ports
    auth: {
        user: "7649shelly@gmail.com", // Your Brevo login email
        pass: "krfw ugoq tfyi djex",    // Your Brevo API Key (SMTP Key)
    },
});

export const sendEmail = async ({ to, subject, html }) => {
    try {
        const info = await transporter.sendMail({
            from: {
                name:  "Urban Royalty Support",
                address: "7649shelly@gmail.com"
            },
            to: to,
            subject: subject,
            html: html,
        });

        return { success: true, messageId: info.messageId };
    } catch (error) {
        console.error("❌ Nodemailer/Brevo Error:", error.message);
        return { success: false, error: error.message };
    }
};

// import dotenv from 'dotenv';
// dotenv.config();

// export const sendEmail = async ({ to, subject, html }) => {
//     try {
//         // 1. CHANGED: Updated URL endpoint strictly to v3
//         const response = await fetch('https://api.brevo.com/v3/smtp/email', {
//             method: 'POST',
//             headers: {
//                 'accept': 'application/json',
//                 'api-key': process.env.BREVO_API_KEY,
//                 'content-type': 'application/json'
//             },
//             body: JSON.stringify({
//                 sender: { 
//                     name: process.env.BREVO_SENDER_NAME || "Urban Royalty Support", // Fallback name if not set
//                     email: process.env.BREVO_EMAIL_USER // Double-check this is listed under Senders in Brevo!
//                 },
//                 // 2. CHANGED: Passing an explicit 'name' string along with the email
//                 to: [{ 
//                     email: to,
//                     name: "Valued User" 
//                 }],
//                 subject: subject,
//                 htmlContent: html
//             })
//         });

//         const responseText = await response.text(); 
        
//         let data = {};
//         if (responseText) {
//             try {
//                 data = JSON.parse(responseText);
//             } catch (e) {
//                 data = { message: responseText };
//             }
//         }

//         if (response.ok) {
//             // Brevo returns a 201 Created with a messageId string upon a successful send
//             return { success: true, messageId: data.messageId || "Dispatched successfully" };
//         } else {
//             console.error("❌ Brevo Rejected Payload. Details:", data);
//             return { success: false, error: data.message || "Failed to send" };
//         }
//     } catch (error) {
//         console.error("❌ Underlying Network Error:", error.message);
//         return { success: false, error: error.message };
//     }
// };

