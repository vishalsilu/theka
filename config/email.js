import dotenv from 'dotenv';
dotenv.config();

export const sendEmail = async ({ to, subject, html }) => {
    try {
        const response = await fetch('https://api.brevo.com/v1/smtp/email', {
            method: 'POST',
            headers: {
                'accept': 'application/json',
                'api-key': process.env.BREVO_API_KEY,
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                sender: { 
                    name: "Urban Support", 
                    email: "your-gmail-address@gmail.com" // Your verified Brevo sender email
                },
                to: [{ email: to }],
                subject: subject,
                htmlContent: html
            })
        });

        const data = await response.json();

        if (response.ok) {
            return { success: true, messageId: data.messageId };
        } else {
            console.error("❌ Brevo API Error:", data);
            return { success: false, error: data.message || "Failed to send" };
        }
    } catch (error) {
        console.error("❌ Network Error:", error.message);
        return { success: false, error: error.message };
    }
};