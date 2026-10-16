/**
 * Twilio calls this URL every time someone replies on the WhatsApp number.
 * We verify the request really came from Twilio, then save the reply.
 *
 * Vercel environment variables needed:
 *   TWILIO_AUTH_TOKEN                (same value as the GitHub secret)
 *   KV_REST_API_URL / KV_REST_API_TOKEN   (added automatically by the Upstash integration)
 * Optional:
 *   PUBLIC_WEBHOOK_URL   exact URL entered in Twilio, only if signature checks fail behind a proxy
 */
const crypto = require('crypto');
const { redis } = require('./_lib');

async function readParams(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  let raw = '';
  if (typeof req.body === 'string') raw = req.body;
  else if (Buffer.isBuffer(req.body)) raw = req.body.toString('utf8');
  else {
    for await (const chunk of req) raw += chunk;
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

function validSignature(url, params, signature, authToken) {
  if (!signature) return false;
  const data = url + Object.keys(params).sort().map(k => k + params[k]).join('');
  const expected = crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf-8')).digest('base64');
  const a = Buffer.from(expected), b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).send('POST only');

  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) return res.status(500).send('TWILIO_AUTH_TOKEN is not set');

  const params = await readParams(req);

  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const url = process.env.PUBLIC_WEBHOOK_URL || `${proto}://${host}${req.url}`;

  if (!validSignature(url, params, req.headers['x-twilio-signature'], authToken)) {
    return res.status(403).send('Invalid signature');
  }

  const sid = params.MessageSid || params.SmsMessageSid;
  const from = String(params.From || '').replace(/^whatsapp:/, '');
  // Quick-reply buttons arrive as ButtonText; normal replies as Body.
  const body = (params.Body || params.ButtonText || '').trim() ||
    (Number(params.NumMedia) > 0 ? '[קובץ / תמונה]' : '');

  try {
    // Twilio retries on timeouts; only store each message once.
    const fresh = sid ? await redis(['SET', `reply:${sid}`, '1', 'NX', 'EX', '2592000']) : 'OK';
    if (fresh) {
      await redis(['LPUSH', 'replies', JSON.stringify({
        sid: sid || null,
        from,
        name: params.ProfileName || '',
        body,
        at: new Date().toISOString(),
      })]);
      await redis(['LTRIM', 'replies', '0', '4999']);
    }
  } catch (e) {
    console.error(e);
    return res.status(500).send('Storage error'); // Twilio will retry
  }

  // Empty TwiML = no automatic answer to the parent.
  res.setHeader('Content-Type', 'text/xml');
  return res.status(200).send('<Response></Response>');
};
