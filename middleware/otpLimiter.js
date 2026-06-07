import rateLimit from 'express-rate-limit';

// Strict limiter for OTP generation: Max 3 requests per 5 minutes per EMAIL
export const otpLimiter = rateLimit({
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 3, 
    message: {
        error: "Too many OTP requests for this email. Please try again after 5 minutes."
    },
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false,  // Disable the `X-RateLimit-*` headers
    
    // Dynamically limit by email instead of IP
    keyGenerator: (req, res) => {
        // Since skip handles empty emails, we can safely return a static string fallback.
        // This keeps express-rate-limit from scanning raw 'req.ip' and crashing on start.
        return req.body.email 
            ? req.body.email.toLowerCase().trim() 
            : 'anonymous_otp_request';
    },
    
    // Only apply rate limit if an email is actually sent
    skip: (req, res) => {
        // If there's no email in the body, skip this limiter completely
        return !req.body.email;
    }
});