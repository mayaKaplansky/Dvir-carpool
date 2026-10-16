/**
 * Returns the saved replies to the private status page.
 * Protected by the REPLIES_PASSWORD environment variable.
 */
const crypto = require('crypto');
const { redis } = require('./_lib');

function passwordOk(given, expected) {
  const h = s => crypto.createHash('sha256').update(String(s)).digest();
  return crypto.timingSafeEqual(h(given), h(expected));
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');

  const expected = process.env.REPLIES_PASSWORD;
  if (!expected) return res.status(500).json({ error: 'REPLIES_PASSWORD is not set' });

  const auth = String(req.headers.authorization || '');
  const given = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!given || !passwordOk(given, expected)) {
    await new Promise(r => setTimeout(r, 800)); // slow down guessing
    return res.status(401).json({ error: 'Wrong password' });
  }

  try {
    const rows = await redis(['LRANGE', 'replies', '0', '4999']);
    const replies = (rows || []).map(s => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);
    return res.status(200).json({ replies, now: new Date().toISOString() });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: String(e.message || e) });
  }
};
