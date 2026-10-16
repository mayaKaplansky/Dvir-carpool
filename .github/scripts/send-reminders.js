/**
 * WhatsApp carpool reminders (via Twilio) to both parents of every family
 * assigned to the next school Friday.
 *
 * HOW TIMING WORKS
 *   With TWILIO_MESSAGING_SERVICE_SID set, the script SCHEDULES each reminder
 *   inside Twilio for Thursday 17:00 Israel time. Twilio then sends at exactly
 *   that moment, even if GitHub starts this script hours late. The script can
 *   run any time from Monday to Thursday afternoon (Twilio requires scheduling
 *   at least 15 minutes ahead).
 *   If it is already too late to schedule (Thursday after ~16:40) it sends
 *   immediately instead -- this is the safety net.
 *   Without TWILIO_MESSAGING_SERVICE_SID it only does immediate sends,
 *   from Thursday 16:00 on.
 *
 * SAFE TO RUN MANY TIMES
 *   Every scheduled/sent reminder is recorded in .reminders-sent/<date>.json
 *   (committed back by the workflow). A recipient already recorded is skipped.
 *   If the roster changed, a re-run CANCELS scheduled reminders that are no
 *   longer wanted and schedules the new ones.
 *
 * 4 pre-approved templates (no variables), by shift x role:
 *   TWILIO_TEMPLATE_BUS_MORNING / BUS_AFTERNOON / CAR_MORNING / CAR_AFTERNOON
 *
 * Optional controls (workflow "Run workflow" form):
 *   DRY_RUN=true        print the plan, change nothing
 *   SEND_NOW=true       send immediately instead of scheduling
 *   RESEND=true         cancel pending scheduled reminders for that date and
 *                       send to EVERYONE again, immediately
 *   TARGET_DATE         YYYY-MM-DD of the Friday to handle (default: next one)
 *   TEST_TO             phone number: sends each of the 4 templates once to it
 *   TEST_SCHEDULE=true  with TEST_TO: instead SCHEDULE one test message to it,
 *                       16 minutes from now, to prove scheduling works
 *
 * Required environment variables (GitHub repo secrets):
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN
 *   TWILIO_WHATSAPP_FROM            e.g. "+97283762229" (no "whatsapp:")
 *   TWILIO_MESSAGING_SERVICE_SID    "MG..." (enables scheduling)
 *   TWILIO_TEMPLATE_BUS_MORNING, TWILIO_TEMPLATE_BUS_AFTERNOON,
 *   TWILIO_TEMPLATE_CAR_MORNING, TWILIO_TEMPLATE_CAR_AFTERNOON
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const twilio = require('twilio');

const SEND_HOUR = 17;            // Thursday reminder time, Israel
const MIN_LEAD_MIN = 20;         // Twilio needs >= 15 min; keep a margin
const MAX_DAYS_AHEAD = 8;        // only schedule the coming week

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

// ---------- sent / scheduled records ----------
const SENT_DIR = path.join(__dirname, '..', '..', '.reminders-sent');
function loadSent(date) {
  try { return JSON.parse(fs.readFileSync(path.join(SENT_DIR, `${date}.json`), 'utf-8')); }
  catch (e) { return {}; }
}
function saveSent(date, sent) {
  fs.mkdirSync(SENT_DIR, { recursive: true });
  fs.writeFileSync(path.join(SENT_DIR, `${date}.json`), JSON.stringify(sent, null, 2) + '\n');
}

// ---------- data ----------
function loadData() {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf-8');
  const m = html.match(/<script id="schedule-data" type="application\/json">\n([\s\S]*?)\n<\/script>/);
  if (!m) throw new Error('Could not find embedded schedule data in index.html');
  return JSON.parse(m[1]);
}

// ---------- Israel time helpers (DST-safe) ----------
function israelParts(date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date).map(x => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}
function todayInIsrael(now) {
  const p = israelParts(now);
  return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
// Israel wall-clock (date + hour:minute) -> real UTC Date
function israelToDate(dateStr, hour, minute = 0) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d, hour, minute);   // the wall-clock time, as if it were UTC
  let t = wall;
  for (let i = 0; i < 3; i++) {                        // correct by Israel's offset (handles DST)
    const p = israelParts(new Date(t));
    t += wall - Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  }
  return new Date(t);
}

function toE164(rawPhone) {
  const digits = rawPhone.replace(/\D/g, '');
  if (!digits) return null;
  const local = digits.startsWith('0') ? digits.slice(1) : digits;
  return `+972${local}`;
}

function markerKeyFor(to, shift, roleKey) {
  // Hashed, so no phone numbers end up in the repo's record files.
  return crypto.createHash('sha256').update(`${to}|${shift}|${roleKey}`).digest('hex').slice(0, 20);
}

async function main() {
  const env = process.env;
  const dryRun = String(env.DRY_RUN || '').toLowerCase() === 'true';
  const sendNow = String(env.SEND_NOW || '').toLowerCase() === 'true';
  const resend = String(env.RESEND || '').toLowerCase() === 'true';
  const testTo = (env.TEST_TO || '').trim();
  const testSchedule = String(env.TEST_SCHEDULE || '').toLowerCase() === 'true';
  const serviceSid = (env.TWILIO_MESSAGING_SERVICE_SID || '').trim();

  const client = dryRun ? null : twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
  const fromNumber = `whatsapp:${env.TWILIO_WHATSAPP_FROM}`;
  const now = new Date();

  async function sendImmediate(label, to, templateSid) {
    if (dryRun) { console.log(`  [dry run] would SEND NOW -> ${label} (${to}) template ${templateSid}`); return { ok: true }; }
    try {
      const m = await client.messages.create({ from: fromNumber, to: `whatsapp:${to}`, contentSid: templateSid });
      console.log(`  sent -> ${label} (${to})`);
      return { ok: true, sid: m.sid };
    } catch (err) {
      console.error(`  FAILED -> ${label} (${to}): ${err.message}`);
      return { ok: false };
    }
  }
  async function schedule(label, to, templateSid, sendAt) {
    if (dryRun) { console.log(`  [dry run] would SCHEDULE for ${sendAt.toISOString()} -> ${label} (${to}) template ${templateSid}`); return { ok: true }; }
    try {
      const m = await client.messages.create({
        messagingServiceSid: serviceSid, to: `whatsapp:${to}`, contentSid: templateSid,
        scheduleType: 'fixed', sendAt,
      });
      console.log(`  scheduled -> ${label} (${to}) for ${sendAt.toISOString()}`);
      return { ok: true, sid: m.sid };
    } catch (err) {
      console.error(`  FAILED to schedule -> ${label} (${to}): ${err.message}`);
      return { ok: false };
    }
  }
  async function cancel(label, sid) {
    if (dryRun) { console.log(`  [dry run] would CANCEL scheduled message for ${label}`); return true; }
    try {
      await client.messages(sid).update({ status: 'canceled' });
      console.log(`  canceled -> ${label}`);
      return true;
    } catch (err) {
      console.error(`  FAILED to cancel -> ${label}: ${err.message}`);
      return false;
    }
  }

  // ---- TEST MODE ----
  if (testTo) {
    const to = toE164(testTo);
    if (!to) throw new Error(`TEST_TO "${testTo}" is not a usable phone number`);
    if (testSchedule) {
      if (!serviceSid) throw new Error('TEST_SCHEDULE needs the TWILIO_MESSAGING_SERVICE_SID secret');
      const sid = templateSidFor('בוקר', 'bus');
      const at = new Date(now.getTime() + 16 * 60 * 1000);
      console.log(`TEST MODE: scheduling ONE test message to ${to} for ${at.toISOString()} (about 16 minutes from now)${dryRun ? ' (dry run)' : ''}`);
      const r = await schedule('test', to, sid, at);
      if (!r.ok) process.exitCode = 1;
      else console.log('If your phone gets the message in ~16 minutes, scheduling works.');
      return;
    }
    console.log(`TEST MODE: sending each of the 4 templates once to ${to}${dryRun ? ' (dry run)' : ''}`);
    const combos = [['בוקר', 'bus'], ['צהריים', 'bus'], ['בוקר', 'car'], ['צהריים', 'car']];
    let ok = 0, bad = 0;
    for (const [shift, type] of combos) {
      const sid = templateSidFor(shift, type);
      if (!sid) { console.error(`  MISSING secret for ${type}/${shift}`); bad++; continue; }
      (await sendImmediate(`${type}/${shift}`, to, sid)).ok ? ok++ : bad++;
    }
    console.log(`\nTest done. OK: ${ok}, Failed: ${bad}`);
    if (bad) process.exitCode = 1;
    return;
  }

  // ---- NORMAL MODE ----
  const data = loadData();
  const today = todayInIsrael(now);
  const dates = [...new Set(data.schedule.map(r => r.date))].sort();
  const targetDate = (env.TARGET_DATE || '').trim() || dates.find(d => d >= today);
  if (!targetDate) { console.log('No upcoming school Fridays in the schedule. Nothing to do.'); return; }

  const rows = data.schedule.filter(r => r.date === targetDate);
  if (rows.length === 0) { console.log(`No assignments for ${targetDate}. Nothing to send.`); return; }

  // When do reminders go out, and which way can we deliver them right now?
  const sendAt = israelToDate(addDays(targetDate, -1), SEND_HOUR, 0);           // Thursday 17:00
  const scheduleDeadline = new Date(sendAt.getTime() - MIN_LEAD_MIN * 60 * 1000);
  const immediateFrom = serviceSid ? scheduleDeadline : israelToDate(addDays(targetDate, -1), 16, 0);
  const dayStart = israelToDate(targetDate, 0, 0);                              // Friday 00:00

  let mode;
  if (resend || sendNow) {
    mode = now < dayStart ? 'immediate' : 'tooLate';
  } else if (serviceSid && now < scheduleDeadline) {
    const daysAhead = (sendAt - now) / 864e5;
    mode = daysAhead <= MAX_DAYS_AHEAD ? 'schedule' : 'tooEarly';
  } else if (now >= immediateFrom && now < dayStart) {
    mode = 'immediate';
  } else if (now >= dayStart) {
    mode = 'tooLate';
  } else {
    mode = 'tooEarly'; // no messaging service configured, before Thursday 16:00
  }

  console.log(`Target Friday: ${targetDate}. Reminder time: ${sendAt.toISOString()} (Thursday ${SEND_HOUR}:00 Israel). Mode: ${mode}${dryRun ? ' (DRY RUN)' : ''}${resend ? ' (RESEND)' : ''}.`);
  if (mode === 'tooEarly') { console.log('Nothing to do yet - a later run will handle it.'); return; }
  if (mode === 'tooLate') { console.log(`It is already ${targetDate} (or later); not sending reminders now.`); return; }

  // Desired recipients
  const wanted = []; // {markerKey, to, label, templateSid, shift, familyName}
  const skippedNoPhone = [];
  let missingTemplate = 0;
  for (const row of rows) {
    for (const role of ROLES) {
      const familyName = row[role.key];
      if (!familyName) continue;
      const numbers = (data.phones[familyName] || '').split('/').map(s => s.trim()).filter(Boolean);
      if (numbers.length === 0) { skippedNoPhone.push(familyName); continue; }
      const templateSid = templateSidFor(row.shift, role.type);
      if (!templateSid) { console.error(`  MISSING template secret for ${role.type}/${row.shift}`); missingTemplate++; continue; }
      const seen = new Set();
      for (const rawNum of numbers) {
        const to = toE164(rawNum);
        if (!to) { skippedNoPhone.push(`${familyName} (${rawNum})`); continue; }
        if (seen.has(to)) continue;
        seen.add(to);
        wanted.push({
          markerKey: markerKeyFor(to, row.shift, role.key), to, templateSid, familyName,
          label: `${familyName} [${row.shift} / ${role.type}]`,
        });
      }
    }
  }

  let markers = loadSent(targetDate);
  let failed = missingTemplate, sent = 0, scheduled = 0, canceled = 0, already = 0;
  const persist = () => { if (!dryRun) saveSent(targetDate, markers); };

  // RESEND: pull back anything still waiting in Twilio, then send to everyone now.
  if (resend) {
    for (const [k, m] of Object.entries(markers)) {
      if (m.mode === 'scheduled' && m.sendAt && new Date(m.sendAt) > now) {
        if (await cancel(m.family || k, m.sid)) canceled++; else failed++;
      }
    }
    markers = {};
    persist();
  }

  // Roster changed? cancel scheduled reminders nobody should get any more.
  if (mode === 'schedule') {
    const wantedKeys = new Set(wanted.map(w => w.markerKey));
    for (const [k, m] of Object.entries(markers)) {
      if (m.mode === 'scheduled' && !wantedKeys.has(k) && m.sendAt && new Date(m.sendAt) > now) {
        if (await cancel(m.family || k, m.sid)) { delete markers[k]; canceled++; persist(); } else failed++;
      }
    }
  }

  for (const w of wanted) {
    const existing = markers[w.markerKey];
    if (existing) { already++; continue; }
    if (mode === 'schedule') {
      const r = await schedule(w.label, w.to, w.templateSid, sendAt);
      if (r.ok) {
        scheduled++;
        if (!dryRun) { markers[w.markerKey] = { family: w.familyName, mode: 'scheduled', sid: r.sid, sendAt: sendAt.toISOString(), at: now.toISOString() }; persist(); }
      } else failed++;
    } else {
      const r = await sendImmediate(w.label, w.to, w.templateSid);
      if (r.ok) {
        sent++;
        if (!dryRun) { markers[w.markerKey] = { family: w.familyName, mode: 'sent', sid: r.sid, at: new Date().toISOString() }; persist(); }
      } else failed++;
    }
  }

  console.log(`\nDone (${mode}). ${dryRun ? 'Would: ' : ''}scheduled ${scheduled}, sent now ${sent}, canceled ${canceled}, already handled earlier (skipped) ${already}, failed ${failed}`);
  if (skippedNoPhone.length) console.log('Skipped (no usable phone number on file):', skippedNoPhone.join(', '));
  if (failed > 0) process.exitCode = 1;
}

main().catch(err => { console.error('Fatal error:', err); process.exit(1); });
