import cron from 'node-cron';
import Product from '../models/Product.js';
import { redisClient } from '../config/redis.js';

const JOB_HASH_KEY = 'name-propagation:jobs';

const buildJobKey = (type, id) => `${type}:${id}`;

export const enqueueNamePropagationJob = async ({ type, id, newName }) => {
    if (!type || !id || !newName) return;

    const payload = JSON.stringify({ type, id, newName });
    await redisClient.hSet(JOB_HASH_KEY, buildJobKey(type, id), payload);
};

const processPropagationJob = async (jobKey, jobValue) => {
    let job;
    try {
        job = JSON.parse(jobValue);
    } catch (error) {
        console.warn('Invalid name propagation job payload:', jobKey, error?.message || error);
        await redisClient.hDel(JOB_HASH_KEY, jobKey);
        return;
    }

    const { type, id, newName } = job;
    if (!type || !id || !newName) {
        await redisClient.hDel(JOB_HASH_KEY, jobKey);
        return;
    }

    try {
        if (type === 'collection') {
            await Product.updateMany(
                { 'collectionInfo.id': id },
                { $set: { 'collectionInfo.name': newName } }
            );
        } else if (type === 'category') {
            await Product.updateMany(
                { 'categoryInfo.id': id },
                { $set: { 'categoryInfo.name': newName } }
            );
        } else {
            console.warn('Unsupported name propagation job type:', type);
        }

        await redisClient.hDel(JOB_HASH_KEY, jobKey);
    } catch (error) {
        console.error(`Name propagation failed for job ${jobKey}:`, error?.message || error);
    }
};

const startNamePropagation = () => {

    cron.schedule('*/30 * * * * *', async () => {
        try {
            const jobs = await redisClient.hGetAll(JOB_HASH_KEY);
            if (!jobs || Object.keys(jobs).length === 0) return;

            console.log(`🔄 Processing ${Object.keys(jobs).length} name propagation job(s)...`);

            for (const [jobKey, jobValue] of Object.entries(jobs)) {
                await processPropagationJob(jobKey, jobValue);
            }
        } catch (error) {
            console.error('❌ Name propagation scheduler error:', error?.message || error);
        }
    });
};

export default startNamePropagation;
