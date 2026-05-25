import dotenv from 'dotenv';
import { createClient } from 'redis';

dotenv.config();

const redisUrl = process.env.UPSTASH_REDIS_URL;

if (!redisUrl) {
  console.error('Missing UPSTASH_REDIS_URL in .env');
  process.exit(1);
}

const client = createClient({ url: redisUrl });

client.on('error', (err) => {
  console.error('Redis error:', err);
  process.exit(1);
});

const runCheck = async () => {
  try {
    await client.connect();
    console.log('✅ Connected to Redis');

    await client.set('check-redis', 'ok');
    const value = await client.get('check-redis');

    console.log('✅ Redis set/get successful:', value);
  } catch (error) {
    console.error('❌ Redis check failed:', error);
    process.exit(1);
  } finally {
    await client.disconnect();
  }
};

runCheck();
