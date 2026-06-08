import { Resend } from 'resend';

// The Resend SDK automatically looks for an environment variable named RESEND_API_KEY.
// If you name it exactly RESEND_API_KEY on Render, you can leave the constructor empty:
const resend = new Resend(process.env.EMAIL_PASS);

export const sendEmail = async ({ to, subject, html }) => {
    try {
        const { data, error } = await resend.emails.send({
            // Free tier restriction: Must use onboarding@resend.dev until your custom domain is verified
            from: 'Urban Support <onboarding@resend.dev>', 
            to, // For testing, this must be your registered email (vishalsainisilu@gmail.com)
            subject,
            html,
        });

        if (error) {
            console.error("❌ Resend API Error:", error.message);
            return { success: false, error: error.message };
        }

        return { success: true, messageId: data.id };
    } catch (error) {
        console.error("❌ Resend Subsystem Crash:", error.message);
        return { success: false, error: error.message };
    }
};