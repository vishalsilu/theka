import dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

export const validateRecaptchaToken = async (recaptchaToken) => {
    if (!recaptchaToken || typeof recaptchaToken !== 'string') {
        throw new Error('Security validation token missing or corrupted.');
    }

    const secretKey = process.env.RECAPTCHA_SECRET_KEY;
    if (!secretKey) {
        throw new Error('Internal security configuration error.');
    }

    const params = new URLSearchParams();
    params.append('secret', secretKey.trim());
    params.append('response', recaptchaToken.trim());

    const verifyUrl = 'https://www.google.com/recaptcha/api/siteverify';
    const response = await axios.post(verifyUrl, params.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    const { success, score } = response.data;
    if (success && score >= 0.5) {
        return true;
    }

    throw new Error('Bot detection verification failed. Request blocked.');
};

export const verifyRecaptcha = async (req, res, next) => {
    try {
        await validateRecaptchaToken(req.body.recaptchaToken);
        return next();
    } catch (error) {
        console.error('❌ reCAPTCHA middleware handshake crashed:', error.message);
        return res.status(403).json({ error: error.message || 'Internal server security handshake failure.' });
    }
};