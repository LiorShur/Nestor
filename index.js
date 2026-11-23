const functions = require('firebase-functions');
const admin     = require('firebase-admin');
admin.initializeApp();

// ── Multi-provider SMS router ──
// Routes SMS to the cheapest provider based on destination country code.
// Configure providers via .env:
//   TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM        — global fallback
//   INFORU_USERNAME, INFORU_TOKEN, INFORU_FROM    — Israel (+972)
//   TELNYX_API_KEY, TELNYX_FROM                   — US/Canada (+1)
//   PLIVO_AUTH_ID, PLIVO_AUTH_TOKEN, PLIVO_FROM   — global alternative

const SMS_PROVIDERS = {
  '+972': 'inforu',
  '+1':   'telnyx',
  '+27':  'clickatell',
  '_default': 'plivo',
};

function _getProviderForPhone(phone) {
  if (!phone) return SMS_PROVIDERS._default;
  for (const [prefix, provider] of Object.entries(SMS_PROVIDERS)) {
    if (prefix !== '_default' && phone.startsWith(prefix)) return provider;
  }
  return SMS_PROVIDERS._default;
}

async function _sendSmsViaProvider(provider, phone, msg) {
  switch (provider) {
    case 'inforu':     return _sendViaInforu(phone, msg);
    case 'telnyx':     return _sendViaTelnyx(phone, msg);
    case 'clickatell': return _sendViaClickatell(phone, msg);
    case 'plivo':      return _sendViaPlivo(phone, msg);
    case 'twilio':     return _sendViaTwilio(phone, msg);
    default:           return _sendViaPlivo(phone, msg);
  }
}

// ── Twilio (global fallback) ──
let _twilioClient = null;
function getTwilio() {
  if (_twilioClient) return _twilioClient;
  const sid = process.env.TWILIO_SID;
  const token = process.env.TWILIO_TOKEN;
  const from = process.env.TWILIO_FROM;
  if (!sid || !token || !from) return null;
  const Twilio = require('twilio');
  _twilioClient = new Twilio(sid, token);
  _twilioClient._from = from;
  return _twilioClient;
}
async function _sendViaTwilio(phone, msg) {
  const twilio = getTwilio();
  if (!twilio) throw new Error('Twilio not configured');
  await twilio.messages.create({ body: msg, from: twilio._from, to: phone });
}

// ── Inforu (Israel — cheapest for +972) ──
async function _sendViaInforu(phone, msg) {
  const username = process.env.INFORU_USERNAME;
  const token = process.env.INFORU_TOKEN;
  const from = process.env.INFORU_FROM || 'CareCall';
  if (!username || !token) {
    console.warn('[Inforu] Not configured — falling back to Twilio');
    return _sendViaTwilio(phone, msg);
  }
  const fetch = (await import('node-fetch')).default;
  const res = await fetch('https://api.inforu.co.il/SendServiceV2/SendSMS', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      User: { Username: username, Token: token },
      Data: { Message: msg, Recipients: [{ Phone: phone }], Settings: { Sender: from } },
    }),
  });
  const data = await res.json();
  if (data.StatusId !== 1) throw new Error('Inforu error: ' + (data.Description || JSON.stringify(data)));
}

// ── Telnyx (US/Canada — cheapest for +1) ──
async function _sendViaTelnyx(phone, msg) {
  const apiKey = process.env.TELNYX_API_KEY;
  const from = process.env.TELNYX_FROM;
  if (!apiKey || !from) {
    console.warn('[Telnyx] Not configured — falling back to Twilio');
    return _sendViaTwilio(phone, msg);
  }
  const fetch = (await import('node-fetch')).default;
  const res = await fetch('https://api.telnyx.com/v2/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ from, to: phone, text: msg }),
  });
  if (!res.ok) {
    let detail;
    try { detail = JSON.stringify(await res.json()); } catch (_) { detail = `status ${res.status}`; }
    console.error(`[Telnyx] API error for ${phone}:`, detail);
    throw new Error('Telnyx error: ' + detail);
  }
}

// ── Plivo (global alternative) ──
async function _sendViaPlivo(phone, msg) {
  const authId = process.env.PLIVO_AUTH_ID;
  const authToken = process.env.PLIVO_AUTH_TOKEN;
  const from = process.env.PLIVO_FROM;
  if (!authId || !authToken || !from) {
    console.warn('[Plivo] Not configured — falling back to Twilio');
    return _sendViaTwilio(phone, msg);
  }
  const fetch = (await import('node-fetch')).default;
  const auth = Buffer.from(`${authId}:${authToken}`).toString('base64');
  const res = await fetch(`https://api.plivo.com/v1/Account/${authId}/Message/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${auth}` },
    body: JSON.stringify({ src: from, dst: phone, text: msg }),
  });
  if (!res.ok) {
    let detail;
    try { detail = JSON.stringify(await res.json()); } catch (_) { detail = `status ${res.status}`; }
    console.error(`[Plivo] API error for ${phone}:`, detail);
    throw new Error('Plivo error: ' + detail);
  }
}

// ── Clickatell (South Africa — cheapest for +27) ──
async function _sendViaClickatell(phone, msg) {
  const apiKey = process.env.CLICKATELL_API_KEY;
  if (!apiKey) {
    console.warn('[Clickatell] Not configured — falling back');
    return _sendViaPlivo(phone, msg);
  }
  const cleanPhone = phone.replace(/[^0-9]/g, '');
  console.log(`[Clickatell] Sending SMS to ${cleanPhone} (original: ${phone})`);
  const fetch = (await import('node-fetch')).default;
  const res = await fetch('https://platform.clickatell.com/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': apiKey },
    body: JSON.stringify({ content: msg, to: [cleanPhone] }),
  });
  let resBody;
  try { resBody = await res.json(); } catch (_) { resBody = null; }
  if (!res.ok) {
    const detail = resBody ? JSON.stringify(resBody) : `status ${res.status}`;
    console.error(`[Clickatell] API error: ${res.status}`, resBody);
    throw new Error(`Clickatell error: ${detail}`);
  }
  if (resBody && resBody.messages) {
    const failed = resBody.messages.filter(m => m.error);
    if (failed.length) {
      console.error('[Clickatell] Message-level errors:', JSON.stringify(failed));
      throw new Error('Clickatell message error: ' + JSON.stringify(failed[0].error));
    }
  }
  console.log(`[Clickatell] SMS accepted for ${cleanPhone}`);
}

async function sendSmsFallback(roomCode, call, membersSnap) {
  const phones = [];
  membersSnap.forEach(child => {
    const m = child.val();
    // Include real carers AND temp-carers (family members with tempCarer flag)
    if ((m.role === 'carer' || m.tempCarer) && m.phone) {
      if (call.targetUid && child.key !== call.targetUid) return;
      phones.push({ phone: m.phone, uid: child.key, name: m.name || 'unknown' });
    }
  });
  if (!phones.length) {
    console.warn(`[SMS] No carer phone numbers in room ${roomCode} — cannot send SMS fallback`);
    return;
  }
  console.log(`[SMS] Sending fallback SMS to ${phones.length} carer(s) in room ${roomCode}: ${phones.map(p => `${p.name}(${p.phone})`).join(', ')}`);
  const isFall = call.type === 'fall';
  const msg = isFall
    ? `🚨 CareCall ALERT: ${call.fromName} — Fall Detected! Open the app to respond.`
    : `🔔 CareCall: ${call.fromName} needs help. Open the app to respond.`;
  let successCount = 0;
  for (const { phone, uid, name } of phones) {
    const provider = _getProviderForPhone(phone);
    try {
      await _sendSmsViaProvider(provider, phone, msg);
      successCount++;
      console.log(`[SMS] Sent to ${name} (${phone}) via ${provider} for room ${roomCode}`);
    } catch (e) {
      console.error(`[SMS] ${provider} failed for ${name} (${phone}):`, e.message, e.stack || '');
      // Fallback chain: preferred → Plivo → Twilio
      const fallbacks = ['plivo', 'twilio'].filter(p => p !== provider);
      let fallbackOk = false;
      for (const fb of fallbacks) {
        try {
          await _sendSmsViaProvider(fb, phone, msg);
          successCount++;
          console.log(`[SMS] Fallback to ${fb} succeeded for ${name} (${phone})`);
          fallbackOk = true;
          break;
        } catch (e2) {
          console.error(`[SMS] ${fb} fallback also failed for ${name} (${phone}):`, e2.message);
        }
      }
      if (!fallbackOk) {
        console.error(`[SMS] ALL providers failed for ${name} (${phone}) in room ${roomCode} — carer will NOT receive SMS`);
      }
    }
  }
  console.log(`[SMS] Fallback complete for room ${roomCode}: ${successCount}/${phones.length} sent successfully`);
}

// ── Triggered the instant a patient writes a new call to the DB ──
exports.notifyCarers = functions.database
  .ref('/carecall/rooms/{roomCode}/calls/{callId}')
  .onCreate(async (snap, context) => {
    const call     = snap.val();
    const roomCode = context.params.roomCode;
    const callId   = context.params.callId;

    if (!call || !call.fromName) return null;
    // Informational entries (e.g. zone-arrival "🏠 Arrived Safely")
    // land in the same /calls path so they render in the carer log,
    // but should NOT wake the phone via FCM — status !== 'active'.
    if (call.status && call.status !== 'active') return null;

    // ── Collect FCM tokens for target carers in this room ──
    const membersSnap = await admin.database()
      .ref(`carecall/rooms/${roomCode}/members`)
      .once('value');

    const isFallOrEmergency = call.type === 'fall';
    const tokens = [];
    membersSnap.forEach(child => {
      const m = child.val();
      // Include real carers AND temp-carers (family members with tempCarer flag)
      if ((m.role !== 'carer' && !m.tempCarer) || !m.fcmToken) return;
      // If patient targeted a specific carer, only notify that carer
      if (call.targetUid && child.key !== call.targetUid) return;
      // Skip busy or off-duty carers unless it's an emergency
      if (!isFallOrEmergency && m.availability && m.availability !== 'available') return;
      tokens.push(m.fcmToken);
    });

    if (!tokens.length) {
      // No FCM tokens — check if any carer is currently online before
      // falling back to SMS. If they're online, the RTDB real-time
      // listener already delivered the call; SMS would be redundant.
      let anyCarerOnline = false;
      membersSnap.forEach(child => {
        const m = child.val();
        if ((m.role === 'carer' || m.tempCarer) && m.online === true) {
          const staleMs = Date.now() - (m.lastSeen || 0);
          if (staleMs < 90000) anyCarerOnline = true; // < 90s = genuinely online
        }
      });
      if (anyCarerOnline) {
        console.log(`No FCM tokens but carer is online in room ${roomCode} — skipping SMS (RTDB listener will deliver)`);
        return null;
      }
      console.warn(`No carer FCM tokens and no carer online in room ${roomCode} — falling back to SMS`);
      await sendSmsFallback(roomCode, call, membersSnap);
      return null;
    }

    // ── Build human-readable need label ──
    const needMap = {
      water:'💧 Water', medication:'💊 Medication', food:'🍽️ Food',
      toilet:'🚽 Toilet', pain:'😣 Pain', custom:'✏️ Message', fall:'🚨 Fall Detected',
      'checkin-missed':'⚠️ Missed Check-in', 'checkin-help':'🆘 Check-in Help',
      'med-missed':'💊 Missed Medication', 'med-taken':'💊 Medication Taken',
      'med-refill':'💊 Refill Needed',
      'zone-arrival':'🏠 Arrived Safely',
      help:'🆘 Help'
    };
    const needLabel = type => {
      if (type && type.includes(','))
        return type.split(',').map(t => needMap[t] || t).join(' · ');
      return needMap[type] || '🆘 Help';
    };

    const isFall = call.type === 'fall';
    const title = isFall
      ? `🚨 ${call.fromName} — Fall Detected!`
      : `${call.fromName} needs help!`;
    const body  = needLabel(call.type) +
      (call.message ? `\n"${call.message}"` : '');

    const APP_URL = 'https://liorshur.github.io/CareCall/';

    // ── Send FCM multicast push ──
    // No top-level `notification` — each platform uses its own block.
    // `webpush.notification` ensures iOS Safari treats the push as a visible
    // notification (iOS drops data-only web pushes). The SW safety-net handler
    // avoids duplicates by checking for existing notifications.
    const message = {
      tokens,
      data: {
        roomCode,
        callId,
        fromName: call.fromName,
        type:     call.type    || 'help',
        message:  call.message || '',
        url:      APP_URL,
        title,
        body,
      },
      webpush: {
        headers: {
          Urgency: 'high',
          TTL:     '86400',
        },
        notification: {
          title,
          body,
          icon:               'https://liorshur.github.io/CareCall/icon-192.svg',
          badge:              'https://liorshur.github.io/CareCall/icon-192.svg',
          vibrate:            [500, 150, 500, 150, 800],
          requireInteraction: true,
          tag:                'carecall-alert',
          renotify:           true,
          data: { roomCode, callId, fromName: call.fromName, url: APP_URL },
          actions: [
            { action: 'ack',     title: "✓ I'm on my way" },
            { action: 'dismiss', title: 'Dismiss' },
          ],
        },
        fcm_options: { link: APP_URL },
      },
      android: {
        priority: 'high',
        notification: {
          title, body,
          channelId:  'carecall_alerts',
          priority:   'max',
          visibility: 'public',
          sound:      'default',
          vibrateTimingsMillis: [0, 500, 150, 500],
        },
      },
      apns: {
        payload: {
          aps: {
            alert: { title, body },
            sound: {
              name: 'default',
              critical: 1,
              volume: 1.0,
            },
            badge: 1,
            'content-available': 1,
            'interruption-level': 'time-sensitive',
            'relevance-score': 1.0,
          },
        },
        headers: {
          'apns-priority': '10',
          'apns-push-type': 'alert',
        },
      },
    };

    try {
      const result = await admin.messaging().sendEachForMulticast(message);
      console.log(`Sent ${result.successCount}/${tokens.length} pushes for room ${roomCode}`);

      // ── Clean up invalid/expired tokens ──
      const removes = [];
      result.responses.forEach((resp, i) => {
        if (!resp.success) {
          const code = resp.error && resp.error.code;
          console.warn(`FCM push ${i} failed:`, code, resp.error && resp.error.message);
          if (code === 'messaging/registration-token-not-registered' ||
              code === 'messaging/invalid-registration-token') {
            // Find and remove stale token from DB
            membersSnap.forEach(child => {
              if (child.val().fcmToken === tokens[i]) {
                removes.push(
                  admin.database()
                    .ref(`carecall/rooms/${roomCode}/members/${child.key}/fcmToken`)
                    .remove()
                );
              }
            });
          }
        }
      });
      if (removes.length) await Promise.all(removes);

      if (result.successCount === 0) {
        console.warn(`All ${tokens.length} FCM pushes failed for room ${roomCode} — sending SMS immediately`);
        await sendSmsFallback(roomCode, call, membersSnap);
      } else {
        // FCM "succeeded" only means Google accepted the message into its
        // queue — it does NOT mean the device received it. If the carer's
        // phone is offline (wifi + data off), the push sits in Google's
        // queue indefinitely while the patient waits. Check presence: if
        // every targeted carer appears offline, send SMS as a supplement.
        let allCarersOffline = true;
        membersSnap.forEach(child => {
          const m = child.val();
          if ((m.role !== 'carer' && !m.tempCarer) || !m.fcmToken) return;
          if (call.targetUid && child.key !== call.targetUid) return;
          if (m.online === true) {
            const staleMs = Date.now() - (m.lastSeen || 0);
            if (staleMs < 90000) allCarersOffline = false;
          }
        });
        if (allCarersOffline) {
          console.warn(`FCM accepted but all carers appear offline in room ${roomCode} — sending supplemental SMS`);
          await sendSmsFallback(roomCode, call, membersSnap);
        }
      }
    } catch (err) {
      console.error(`[notifyCarers] FCM send error for room ${roomCode}, call ${callId}:`, err.message, err.stack || '');
      // FCM completely failed — try SMS as last resort
      console.warn(`[notifyCarers] Attempting SMS fallback after FCM failure for room ${roomCode}`);
      await sendSmsFallback(roomCode, call, membersSnap).catch(e =>
        console.error(`[notifyCarers] SMS fallback also failed for room ${roomCode}:`, e.message, e.stack || '')
      );
    }

    return null;
  });
