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
 * Safe to run many times: every successful send is recorded in
 * .reminders-sent/<date>.json (committed back to the repo by the workflow),
 * and a recipient already recorded for that date + shift + role is skipped.
 * So the workflow can fire several times on Thursday (GitHub often delays
 * scheduled runs) and nobody gets a duplicate; a later run only retries
 * what failed or was missed.
 *
 * Optional test controls (set from the workflow's "Run workflow" form):
 *   DRY_RUN=true      print what would be sent, send nothing
 *   TARGET_DATE       YYYY-MM-DD, act as if that were "tomorrow"
 *   RESEND=true       ignore the sent-markers and send to everyone again
 *   TEST_TO           a phone number; sends ONE message per template (4 total)
 *                     to that number only, ignoring the schedule and parents
 *
 * Required environment variables (set as GitHub repo secrets):
 *   TWILIO_ACCOUNT_SID
 *   TWILIO_AUTH_TOKEN
 *   TWILIO_WHATSAPP_FROM         e.g. "+97283762229" (no "whatsapp:" prefix)
 *   TWILIO_TEMPLATE_BUS_MORNING
 *   TWILIO_TEMPLATE_BUS_AFTERNOON
 *   TWILIO_TEMPLATE_CAR_MORNING
 *   TWILIO_TEMPLATE_CAR_AFTERNOON
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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

const SENT_DIR = path.join(__dirname, '..', '..', '.reminders-sent');

function loadSent(date) {
  try {
    return JSON.parse(fs.readFileSync(path.join(SENT_DIR, `${date}.json`), 'utf-8'));
  } catch (e) {
    return {};
  }
}

function saveSent(date, sent) {
  fs.mkdirSync(SENT_DIR, { recursive: true });
  fs.writeFileSync(path.join(SENT_DIR, `${date}.json`), JSON.stringify(sent, null, 2) + '\n');
}

function israelHour() {
  return Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jerusalem', hour: '2-digit', hour12: false,
  }).format(new Date())) % 24;
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
  const dryRun = String(process.env.DRY_RUN || '').toLowerCase() === 'true';
  const testTo = (process.env.TEST_TO || '').trim();
  const resend = String(process.env.RESEND || '').toLowerCase() === 'true';
  const isScheduled = process.env.EVENT_NAME === 'schedule';
  const targetDate = (process.env.TARGET_DATE || '').trim() || tomorrowInIsrael();

  // The workflow has several scheduled attempts spread over Thursday. Don't
  // send in the small hours or too early in the day, whenever GitHub fires.
  if (isScheduled && israelHour() < 16) {
    console.log(`Israel time is before 16:00 (hour ${israelHour()}). Too early - a later attempt will send. Nothing done.`);
    return;
  }

  const client = dryRun ? null : twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  const fromNumber = `whatsapp:${process.env.TWILIO_WHATSAPP_FROM}`;

  async function deliver(label, to, templateSid) {
    if (dryRun) {
      console.log(`  [dry run] would send -> ${label} (${to}) template ${templateSid}`);
      return true;
    }
    try {
      await client.messages.create({ from: fromNumber, to: `whatsapp:${to}`, contentSid: templateSid });
      console.log(`  sent -> ${label} (${to})`);
      return true;
    } catch (err) {
      console.error(`  FAILED -> ${label} (${to}): ${err.message}`);
      return false;
    }
  }

  // ---- TEST MODE: one message per template to a single number ----
  if (testTo) {
    const to = toE164(testTo);
    if (!to) throw new Error(`TEST_TO "${testTo}" is not a usable phone number`);
    console.log(`TEST MODE: sending each of the 4 templates once to ${to}${dryRun ? ' (dry run)' : ''}`);
    const combos = [['בוקר', 'bus'], ['צהריים', 'bus'], ['בוקר', 'car'], ['צהריים', 'car']];
    let ok = 0, bad = 0;
    for (const [shift, type] of combos) {
      const sid = templateSidFor(shift, type);
      if (!sid) { console.error(`  MISSING secret for ${type}/${shift}`); bad++; continue; }
      (await deliver(`${type}/${shift}`, to, sid)) ? ok++ : bad++;
    }
    console.log(`\nTest done. OK: ${ok}, Failed: ${bad}`);
    return;
  }

  // ---- NORMAL MODE ----
  const data = loadData();
  const rows = data.schedule.filter(r => r.date === targetDate);

  if (rows.length === 0) {
    console.log(`No school-day assignments for ${targetDate}. Nothing to send.`);
    return;
  }

  console.log(`${targetDate}: sending reminders for ${rows.length} shift(s)${dryRun ? ' (DRY RUN)' : ''}${resend ? ' (RESEND: ignoring sent-markers)' : ''}...`);

  const sentMarkers = resend ? {} : loadSent(targetDate);
  let sent = 0, failed = 0, alreadySent = 0;
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
      if (!templateSid) { console.error(`  MISSING template secret for ${role.type}/${row.shift}`); failed++; continue; }

      // Some families have the same number recorded for both parents --
      // message each distinct number only once.
      const seen = new Set();
      for (const rawNum of numbers) {
        const to = toE164(rawNum);
        if (!to) { skippedNoPhone.push(`${familyName} (${rawNum})`); continue; }
        if (seen.has(to)) continue;
        seen.add(to);

        // Hashed, so no phone numbers end up in the repo's record files.
        const markerKey = crypto.createHash('sha256').update(`${to}|${row.shift}|${role.key}`).digest('hex').slice(0, 20);
        if (sentMarkers[markerKey]) { alreadySent++; continue; }

        const ok = await deliver(`${familyName} [${row.shift} / ${role.type}]`, to, templateSid);
        if (ok) {
          sent++;
          if (!dryRun) {
            sentMarkers[markerKey] = { family: familyName, at: new Date().toISOString() };
            saveSent(targetDate, sentMarkers); // save after every send, in case the run dies midway
          }
        } else {
          failed++;
        }
      }
    }
  }

  console.log(`\nDone. ${dryRun ? 'Would send' : 'Sent'}: ${sent}, Already sent earlier (skipped): ${alreadySent}, Failed: ${failed}`);
  if (skippedNoPhone.length) {
    console.log('Skipped (no usable phone number on file):', skippedNoPhone.join(', '));
  }
  // A non-zero exit marks the run red so you notice; the next scheduled
  // attempt retries only the ones that failed.
  if (failed > 0) process.exitCode = 1;
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
