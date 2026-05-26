import 'dotenv/config';
import { createClient } from 'redis';
const client = createClient({ url: process.env.UPSTASH_REDIS_URL });
client.on('error', (err) => console.error('Redis error', err));
await client.connect();
console.log('deleted', await client.del('collections:all'));
await client.quit();
