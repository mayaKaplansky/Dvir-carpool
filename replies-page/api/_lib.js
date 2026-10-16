// Shared helpers for the reply-tracking functions. (Files starting with "_"
// are not exposed as URLs by Vercel.)

// Upstash Redis REST access. The Vercel "Upstash Redis" integration sets
// either the KV_REST_API_* or the UPSTASH_REDIS_REST_* variables.
function redisConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis is not connected (missing KV_REST_API_URL / KV_REST_API_TOKEN)');
  return { url, token };
}

async function redis(command) {
  const { url, token } = redisConfig();
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(`Redis error: ${j.error || r.status}`);
  return j.result;
}

module.exports = { redis };
