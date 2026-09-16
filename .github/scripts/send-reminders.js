/**
 * Sends WhatsApp reminders (via Twilio) to both parents of every family
 * assigned to tomorrow's carpool duty, if tomorrow is a school Friday.
 *
 * There are 4 pre-approved templates (no content variables -- each one's
 * wording is fully static), picked by shift (morning/afternoon) x role
 * (bus/car):
 *   TWILIO_TEMPLATE_BUS_MORNING, TWILIO_TEMPLATE_BUS_AFTERNOON,
 *   TWILIO_TEMPLATE_CAR_MORNING, TWILIO_TEMPLATE_CAR_AFTERNOON
 *
 * Runs from a GitHub Action on a daily cron -- this script itself decides
 * whether there's anything to do today, so the workflow doesn't need any
 * day-of-week or timezone/DST logic.
 *
 * Required environment variables (set as GitHub repo secrets):
 *   TWILIO_ACCOUNT_SID
 *   TWILIO_AUTH_TOKEN
 *   TWILIO_WHATSAPP_FROM         e.g. "+972837622229" (no "whatsapp:" prefix)
 *   TWILIO_TEMPLATE_BUS_MORNING
 *   TWILIO_TEMPLATE_BUS_AFTERNOON
 *   TWILIO_TEMPLATE_CAR_MORNING
 *   TWILIO_TEMPLATE_CAR_AFTERNOON
 */
const fs = require('fs');
const path = require('path');
const twilio = require('twilio');

const ROLES = [
  { key: 'bus1', type: 'bus' },
  { key: 'bus2', type: 'bus' },
  { key: 'bus3', type: 'bus' },
  { key: 'car',  type: 'car' },
];

function templateSidFor(shift, roleType) {
  const isMorning = shift === 'בוקר';
  if (roleType === 'bus') {
    return isMorning ? process.env.TWILIO_TEMPLATE_BUS_MORNING : process.env.TWILIO_TEMPLATE_BUS_AFTERNOON;
  }
  return isMorning ? process.env.TWILIO_TEMPLATE_CAR_MORNING : process.env.TWILIO_TEMPLATE_CAR_AFTERNOON;
}

function loadData() {
  const htmlPath = path.join(__dirname, '..', '..', 'index.html');
  const html = fs.readFileSync(htmlPath, 'utf-8');
  const m = html.match(/<script id="schedule-data" type="application\/json">\n([\s\S]*?)\n<\/script>/);
  if (!m) throw new Error('Could not find embedded schedule data in index.html');
  return JSON.parse(m[1]);
}

function tomorrowInIsrael() {
  // Compute "tomorrow" as a Y-M-D string in Asia/Jerusalem, independent of
  // whatever timezone the GitHub Actions runner itself is in (always UTC).
  const now = new Date();
  const israelNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
  israelNow.setDate(israelNow.getDate() + 1);
  const y = israelNow.getFullYear();
  const m = String(israelNow.getMonth() + 1).padStart(2, '0');
  const d = String(israelNow.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function toE164(rawPhone) {
  // Israeli local format "050-1234567" -> "+972501234567"
  const digits = rawPhone.replace(/\D/g, '');
  if (!digits) return null;
  const local = digits.startsWith('0') ? digits.slice(1) : digits;
  return `+972${local}`;
}

async function main() {
  const data = loadData();
  const targetDate = tomorrowInIsrael();
  const rows = data.schedule.filter(r => r.date === targetDate);

  if (rows.length === 0) {
    console.log(`No school-day assignments for ${targetDate} (tomorrow). Nothing to send.`);
    return;
  }

  console.log(`Tomorrow (${targetDate}) is a school Friday. Sending reminders for ${rows.length} shift(s)...`);

  const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  const fromNumber = `whatsapp:${process.env.TWILIO_WHATSAPP_FROM}`;

  let sent = 0, failed = 0;
  const skippedNoPhone = [];

  for (const row of rows) {
    for (const role of ROLES) {
      const familyName = row[role.key];
      if (!familyName) continue;
      const phoneStr = data.phones[familyName] || '';
      const numbers = phoneStr.split('/').map(s => s.trim()).filter(Boolean);

      if (numbers.length === 0) {
        skippedNoPhone.push(familyName);
        continue;
      }

      const templateSid = templateSidFor(row.shift, role.type);

      for (const rawNum of numbers) {
        const to = toE164(rawNum);
        if (!to) { skippedNoPhone.push(`${familyName} (${rawNum})`); continue; }

        try {
          await client.messages.create({
            from: fromNumber,
            to: `whatsapp:${to}`,
            contentSid: templateSid,
          });
          sent++;
          console.log(`  sent -> ${familyName} (${to}) [${row.shift} / ${role.type}]`);
        } catch (err) {
          failed++;
          console.error(`  FAILED -> ${familyName} (${to}): ${err.message}`);
        }
      }
    }
  }

  console.log(`\nDone. Sent: ${sent}, Failed: ${failed}`);
  if (skippedNoPhone.length) {
    console.log('Skipped (no usable phone number on file):', skippedNoPhone.join(', '));
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
