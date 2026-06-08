import rateLimit from 'express-rate-limit';

// Strict limiter for OTP generation: Max 3 requests per 5 minutes per EMAIL
export const otpLimiter = rateLimit({
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 3, 
    message: {
        error: "Too many OTP requests for this email. Please try again after 5 minutes."
    },
    standardHeaders: true, 
    legacyHeaders: false,  
    
    // Dynamically limit by email instead of IP
    keyGenerator: (req, res) => {
        return req.body.email 
            ? req.body.email.toLowerCase().trim() 
            : 'anonymous_otp_request';
    },
    
    // Only apply rate limit if an email is actually sent
    skip: (req, res) => {
        return !req.body.email;
    },

    // FIX: Using the exact validation key the library expects
    validate: { 
        keyGeneratorIpFallback: false 
    } 
});