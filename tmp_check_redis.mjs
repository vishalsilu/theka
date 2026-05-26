import 'dotenv/config';
import { createClient } from 'redis';
const client = createClient({ url: process.env.UPSTASH_REDIS_URL });
client.on('error', (err) => console.error('Redis error', err));
await client.connect();
const val = await client.get('collections:all');
console.log('collections:all raw:', val);
await client.quit();
