import { createClient } from '@supabase/supabase-js';
import { buildPushPayload } from '@block65/webcrypto-web-push';

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduler(env));
  }
};

async function handleRequest(request, env) {
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders() });
  }

  if (url.pathname === '/api/health') {
    return json({ ok: true, app: 'kalkulator-zywienia-pwa' });
  }

  if (url.pathname === '/api/push/public-key') {
    return json({ publicKey: env.VAPID_PUBLIC_KEY || '' });
  }

  if (url.pathname === '/api/push/subscribe' && request.method === 'POST') {
    return handlePushSubscribe(request, env);
  }

  if (url.pathname === '/api/drugs/update' && request.method === 'POST') {
    return handleDrugsUpdate(request, env);
  }

  if (url.pathname === '/api/push/test' && request.method === 'POST') {
    return handlePushTest(request, env);
  }

  if (url.pathname === '/api/devices/unregister' && request.method === 'POST') {
    return handleDeviceUnregister(request, env);
  }

  return env.ASSETS.fetch(request);
}

function getSupabase(env) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

async function handlePushSubscribe(request, env) {
  const supabase = getSupabase(env);
  const body = await request.json().catch(() => null);

  if (!body?.deviceId || !body?.subscription?.endpoint || !body?.subscription?.keys?.p256dh || !body?.subscription?.keys?.auth) {
    return json({ error: 'Nieprawidłowe dane subskrypcji.' }, 400);
  }

  const device = {
    id: String(body.deviceId),
    timezone: sanitizeTimezone(body.timezone) || env.APP_TIMEZONE_DEFAULT || 'Europe/Warsaw',
    user_agent: request.headers.get('user-agent') || null,
    updated_at: new Date().toISOString()
  };

  const { error: deviceError } = await supabase
    .from('devices')
    .upsert(device, { onConflict: 'id' });

  if (deviceError) {
    return json({ error: deviceError.message }, 500);
  }

  const sub = body.subscription;
  const subscriptionRow = {
    device_id: device.id,
    endpoint: sub.endpoint,
    p256dh: sub.keys.p256dh,
    auth: sub.keys.auth,
    active: true,
    updated_at: new Date().toISOString()
  };

  const { error: subError } = await supabase
    .from('push_subscriptions')
    .upsert(subscriptionRow, { onConflict: 'endpoint' });

  if (subError) {
    return json({ error: subError.message }, 500);
  }

  return json({ ok: true });
}

async function handleDrugsUpdate(request, env) {
  const supabase = getSupabase(env);
  const body = await request.json().catch(() => null);

  if (!body?.deviceId || !Array.isArray(body?.drugs)) {
    return json({ error: 'Brakuje deviceId albo listy leków.' }, 400);
  }

  const deviceId = String(body.deviceId);
  const timezone = sanitizeTimezone(body.timezone) || env.APP_TIMEZONE_DEFAULT || 'Europe/Warsaw';

  const { error: deviceError } = await supabase
    .from('devices')
    .upsert({
      id: deviceId,
      timezone,
      user_agent: request.headers.get('user-agent') || null,
      updated_at: new Date().toISOString()
    }, { onConflict: 'id' });

  if (deviceError) {
    return json({ error: deviceError.message }, 500);
  }

  const cleaned = body.drugs
    .filter((item) => item && typeof item.name === 'string' && typeof item.time === 'string')
    .map((item) => ({
      device_id: deviceId,
      name: item.name.trim(),
      dose: typeof item.dose === 'string' ? item.dose.trim() : '',
      time: normalizeTime(item.time),
      timezone,
      enabled: true
    }))
    .filter((item) => item.name && /^\d{2}:\d{2}$/.test(item.time));

  const { error: deleteError } = await supabase
    .from('drugs')
    .delete()
    .eq('device_id', deviceId);

  if (deleteError) {
    return json({ error: deleteError.message }, 500);
  }

  if (cleaned.length) {
    const { error: insertError } = await supabase
      .from('drugs')
      .insert(cleaned);

    if (insertError) {
      return json({ error: insertError.message }, 500);
    }
  }

  return json({ ok: true, count: cleaned.length });
}

async function handlePushTest(request, env) {
  const supabase = getSupabase(env);
  const body = await request.json().catch(() => null);
  const deviceId = body?.deviceId ? String(body.deviceId) : null;

  if (!deviceId) {
    return json({ error: 'Brakuje deviceId.' }, 400);
  }

  const { data: subscriptions, error } = await supabase
    .from('push_subscriptions')
    .select('endpoint,p256dh,auth')
    .eq('device_id', deviceId)
    .eq('active', true);

  if (error) {
    return json({ error: error.message }, 500);
  }

  if (!subscriptions?.length) {
    return json({ error: 'To urządzenie nie ma aktywnej subskrypcji push.' }, 400);
  }

  const payload = {
    title: 'Test powiadomienia',
    body: 'Jeśli to widzisz, push działa poprawnie.',
    url: env.APP_BASE_URL || '/',
    tag: 'test-notification'
  };

  const result = await sendPushToSubscriptions(subscriptions, payload, env, supabase);
  return json({ ok: true, sent: result.sent, removed: result.removed });
}

async function handleDeviceUnregister(request, env) {
  const supabase = getSupabase(env);
  const body = await request.json().catch(() => null);
  const deviceId = body?.deviceId ? String(body.deviceId) : null;

  if (!deviceId) {
    return json({ error: 'Brakuje deviceId.' }, 400);
  }

  const { error } = await supabase
    .from('push_subscriptions')
    .update({ active: false, updated_at: new Date().toISOString() })
    .eq('device_id', deviceId);

  if (error) {
    return json({ error: error.message }, 500);
  }

  return json({ ok: true });
}

async function runScheduler(env) {
  const supabase = getSupabase(env);

  const { data: drugs, error: drugsError } = await supabase
    .from('drugs')
    .select('id,device_id,name,dose,time,timezone,enabled')
    .eq('enabled', true);

  if (drugsError) {
    console.error('Scheduler drugs error:', drugsError.message);
    return;
  }

  if (!drugs?.length) {
    return;
  }

  const dueDrugs = [];

  for (const drug of drugs) {
    const timezone = sanitizeTimezone(drug.timezone) || env.APP_TIMEZONE_DEFAULT || 'Europe/Warsaw';
    const localNow = getLocalDateParts(timezone);

    if (drug.time === localNow.hhmm) {
      dueDrugs.push({
        ...drug,
        timezone,
        scheduledMinute: `${localNow.date} ${localNow.hhmm}`
      });
    }
  }

  if (!dueDrugs.length) {
    return;
  }

  const deviceIds = [...new Set(dueDrugs.map((item) => item.device_id))];

  const { data: subscriptions, error: subError } = await supabase
    .from('push_subscriptions')
    .select('device_id,endpoint,p256dh,auth')
    .in('device_id', deviceIds)
    .eq('active', true);

  if (subError) {
    console.error('Scheduler subscriptions error:', subError.message);
    return;
  }

  const subsByDevice = new Map();
  for (const sub of subscriptions || []) {
    const list = subsByDevice.get(sub.device_id) || [];
    list.push(sub);
    subsByDevice.set(sub.device_id, list);
  }

  for (const drug of dueDrugs) {
    const alreadySent = await hasNotificationLog(supabase, drug.device_id, drug.id, drug.scheduledMinute);
    if (alreadySent) {
      continue;
    }

    const deviceSubscriptions = subsByDevice.get(drug.device_id) || [];
    if (!deviceSubscriptions.length) {
      continue;
    }

    const payload = {
      title: drug.name,
      body: drug.dose
        ? `Godzina podania: ${drug.time}. Dawka: ${drug.dose}`
        : `Godzina podania: ${drug.time}`,
      url: env.APP_BASE_URL || '/',
      tag: `drug-${drug.id}-${drug.scheduledMinute}`
    };

    const result = await sendPushToSubscriptions(deviceSubscriptions, payload, env, supabase);

    if (result.sent > 0) {
      await supabase.from('notification_log').insert({
        device_id: drug.device_id,
        drug_id: drug.id,
        scheduled_minute: drug.scheduledMinute,
        sent_at: new Date().toISOString()
      });
    }
  }
}

async function hasNotificationLog(supabase, deviceId, drugId, scheduledMinute) {
  const { data, error } = await supabase
    .from('notification_log')
    .select('id')
    .eq('device_id', deviceId)
    .eq('drug_id', drugId)
    .eq('scheduled_minute', scheduledMinute)
    .limit(1);

  if (error) {
    console.error('Notification log check error:', error.message);
    return false;
  }

  return Boolean(data?.length);
}

async function sendPushToSubscriptions(subscriptions, payload, env, supabase) {
  let sent = 0;
  let removed = 0;

  for (const sub of subscriptions) {
    try {
      const requestInit = await buildPushPayload(
        {
          data: JSON.stringify(payload),
          options: {
            ttl: 60,
            topic: payload.tag || 'medication-reminder',
            urgency: 'high'
          }
        },
        {
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.p256dh,
            auth: sub.auth
          }
        },
        {
          subject: env.VAPID_CONTACT_EMAIL || 'mailto:admin@example.com',
          publicKey: env.VAPID_PUBLIC_KEY,
          privateKey: env.VAPID_PRIVATE_KEY
        }
      );

      const response = await fetch(sub.endpoint, requestInit);

      if (response.ok || response.status === 201) {
        sent += 1;
        continue;
      }

      if (response.status === 404 || response.status === 410) {
        removed += 1;
        await deactivateSubscription(supabase, sub.endpoint);
        continue;
      }

      const text = await response.text();
      console.error('Push failed:', response.status, text);
    } catch (error) {
      console.error('Push exception:', error);
    }
  }

  return { sent, removed };
}

async function deactivateSubscription(supabase, endpoint) {
  await supabase
    .from('push_subscriptions')
    .update({ active: false, updated_at: new Date().toISOString() })
    .eq('endpoint', endpoint);
}

function getLocalDateParts(timezone) {
  const formatter = new Intl.DateTimeFormat('pl-PL', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });

  const parts = formatter.formatToParts(new Date());
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return {
    date: `${byType.year}-${byType.month}-${byType.day}`,
    hhmm: `${byType.hour}:${byType.minute}`
  };
}

function normalizeTime(value) {
  const [hh = '', mm = ''] = String(value).split(':');
  const h = hh.padStart(2, '0').slice(0, 2);
  const m = mm.padStart(2, '0').slice(0, 2);
  return `${h}:${m}`;
}

function sanitizeTimezone(value) {
  if (!value || typeof value !== 'string') {
    return null;
  }

  try {
    new Intl.DateTimeFormat('pl-PL', { timeZone: value }).format(new Date());
    return value;
  } catch {
    return null;
  }
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...corsHeaders()
    }
  });
}
