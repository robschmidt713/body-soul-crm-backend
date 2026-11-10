const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const twilio = require('twilio');
const { MongoClient } = require('mongodb');

const app = express();
app.use(cors({
  origin: true,
  allowedHeaders: ['Content-Type', 'x-crm-key', 'Authorization'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
}));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

function extractCrmKey(req) {
  const headerKey = req.get('x-crm-key');
  if (headerKey) return headerKey;
  const auth = req.get('authorization') || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : '';
}

function crmKeyMatches(provided) {
  const expected = process.env.CRM_PASSWORD;
  if (!expected) return null;
  const given = typeof provided === 'string' ? provided : '';
  const a = crypto.createHash('sha256').update(expected, 'utf8').digest();
  const b = crypto.createHash('sha256').update(given, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

function isPublicRoute(req) {
  if (req.method === 'OPTIONS') return true;
  const path = req.path;
  if (req.method === 'GET' && path === '/') return true;
  if (path === '/webhook/meta' && (req.method === 'GET' || req.method === 'POST')) return true;
  if (path === '/webhook/sms' && req.method === 'POST') return true;
  return false;
}

app.use((req, res, next) => {
  if (isPublicRoute(req)) return next();
  if (!process.env.CRM_PASSWORD) {
    return res.status(503).json({ error: 'CRM password not configured' });
  }
  if (!crmKeyMatches(extractCrmKey(req))) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

const PORT = process.env.PORT || 3000;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE = process.env.TWILIO_PHONE;
const MONGODB_URI = process.env.MONGODB_URI;
const PAGE_ACCESS_TOKEN = process.env.META_PAGE_ACCESS_TOKEN || '';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'admin@bodyandsoulchiro.au';

let db;
let contactsCollection;

async function connectDB() {
  if (!MONGODB_URI) {
    console.log('No MONGODB_URI set — using in-memory storage');
    return;
  }
  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    db = client.db('crm');
    contactsCollection = db.collection('contacts');
    console.log('Connected to MongoDB');
  } catch (err) {
    console.error('MongoDB connection failed:', err.message);
  }
}

async function getContacts() {
  if (!contactsCollection) return [];
  return await contactsCollection.find({}).toArray();
}

function messageKey(m) {
  if (m && m.sid) return 'sid:' + m.sid;
  return 'body:' + (m && m.direction ? m.direction : '') + '|' + (m && m.body ? m.body : '');
}

function mergeMessages(existing, incoming) {
  const map = new Map();
  for (const m of [...(existing || []), ...(incoming || [])]) {
    if (!m) continue;
    const k = messageKey(m);
    const prev = map.get(k);
    if (!prev || (m.sid && !prev.sid)) map.set(k, m);
  }
  return Array.from(map.values()).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
}

async function saveContact(contact) {
  if (!contactsCollection) return;
  const existing = await contactsCollection.findOne({ id: contact.id });
  if (existing) {
    contact.messages = mergeMessages(existing.messages, contact.messages);
    if (existing.welcomeSentAt && !contact.welcomeSentAt) {
      contact.welcomeSentAt = existing.welcomeSentAt;
    }
  }
  const { _id, ...contactWithoutId } = contact;
  await contactsCollection.updateOne(
    { id: contact.id },
    { $set: contactWithoutId },
    { upsert: true }
  );
}

async function deleteContact(id) {
  if (!contactsCollection) return;
  await contactsCollection.deleteOne({ id });
}

function getTwilioClient() {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) return null;
  return twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
}

async function sendLeadEmail(lead) {
  if (!RESEND_API_KEY) {
    console.log('No RESEND_API_KEY — skipping email');
    return;
  }
  try {
    const toEmails = NOTIFY_EMAIL.split(',').map(e => e.trim()).filter(Boolean);
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Body & Soul Leads <leads@bodyandsoulchiro.au>',
        to: toEmails,
        subject: `New lead: ${lead.firstName || 'Unknown'} ${lead.lastName || ''}`.trim(),
        text: `New lead from ${lead.source}\n\nName: ${lead.firstName || ''} ${lead.lastName || ''}\nPhone: ${lead.phone || '-'}\nEmail: ${lead.email || '-'}\nCondition: ${lead.condition || '-'}\n\nView in CRM.`
      })
    });
    if (res.ok) console.log('Lead email sent');
    else console.error('Email failed:', await res.text());
  } catch (err) {
    console.error('Email error:', err.message);
  }
}

const DEFAULT_WELCOME_SMS_TEMPLATE = "Hi {firstName}, thanks for your enquiry with Body & Soul Chiropractic! We'll call you as soon as possible to help get you booked in for your $79 initial consult. We'll be calling from (07) 3608 8814. Alternatively, book online at https://bodyandsoulchiro.au/book-now/ and use code ONLINEOFFER to receive your $30 discount. Reply STOP to opt out.";

function normaliseAuPhone(phone) {
  if (!phone) return '';
  let p = String(phone).replace(/[^\d+]/g, '');
  if (!p) return '';
  if (p.startsWith('00')) p = '+' + p.slice(2);
  if (p.startsWith('+')) {
    if (p.startsWith('+610')) p = '+61' + p.slice(4);
    return p;
  }
  if (p.startsWith('61')) {
    if (p.startsWith('610')) p = '61' + p.slice(3);
    return '+' + p;
  }
  if (p.startsWith('0')) return '+61' + p.slice(1);
  return '+61' + p;
}

function buildWelcomeSms(contact) {
  const template = process.env.WELCOME_SMS_TEMPLATE || DEFAULT_WELCOME_SMS_TEMPLATE;
  const raw = String(contact && contact.firstName ? contact.firstName : '').trim();
  const useThere = !raw || raw.toLowerCase() === 'meta lead';
  if (useThere) {
    return template.replace(/Hi \{firstName\},/g, 'Hi there,').replace(/\{firstName\}/g, 'there');
  }
  return template.replace(/\{firstName\}/g, raw);
}

async function sendWelcomeSms(contact) {
  try {
    if (contact.welcomeSentAt) return;
    const client = getTwilioClient();
    const phone = normaliseAuPhone(contact.phone);
    if (!client || !phone || !TWILIO_PHONE) return;

    const body = buildWelcomeSms(contact);
    const message = await client.messages.create({
      body,
      from: TWILIO_PHONE,
      to: phone
    });

    if (!contact.messages) contact.messages = [];
    contact.messages.push({
      direction: 'outbound',
      channel: 'sms',
      body,
      date: new Date().toISOString(),
      sid: message.sid
    });
    contact.welcomeSentAt = new Date().toISOString();
    await saveContact(contact);
    console.log('Welcome SMS sent to', contact.firstName);
  } catch (err) {
    console.error('Welcome SMS failed:', err.message);
  }
}

app.get('/', (req, res) => {
  res.json({ status: 'Body & Soul CRM backend running' });
});

app.post('/auth/check', (req, res) => {
  res.json({ ok: true });
});

app.get('/contacts', async (req, res) => {
  try {
    const contacts = await getContacts();
    res.json(contacts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/contacts', async (req, res) => {
  try {
    const contact = req.body;
    if (!contact.id) contact.id = Date.now().toString();
    if (!contact.createdAt) contact.createdAt = new Date().toISOString();
    await saveContact(contact);
    res.json(contact);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/contacts/:id', async (req, res) => {
  try {
    await deleteContact(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/send', async (req, res) => {
  const { to, body, channel, contactId } = req.body;
  const client = getTwilioClient();
  if (!client) return res.status(500).json({ error: 'Twilio not configured' });
  if (!to || !body) return res.status(400).json({ error: 'Missing to or body' });

  try {
    const fromNumber = channel === 'whatsapp' ? `whatsapp:${TWILIO_PHONE}` : TWILIO_PHONE;
    const toNumber = channel === 'whatsapp' ? (to.startsWith('whatsapp:') ? to : `whatsapp:${to}`) : to;

    const message = await client.messages.create({
      body,
      from: fromNumber,
      to: toNumber
    });

    if (contactId && contactsCollection) {
      const contact = await contactsCollection.findOne({ id: contactId });
      if (contact) {
        if (!contact.messages) contact.messages = [];
        contact.messages.push({
          direction: 'outbound',
          channel: channel || 'sms',
          body,
          date: new Date().toISOString(),
          sid: message.sid
        });
        await saveContact(contact);
      }
    }

    res.json({ success: true, sid: message.sid });
  } catch (err) {
    console.error('Send error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/webhook/sms', async (req, res) => {
  const from = req.body.From || '';
  const body = req.body.Body || '';
  const phone = from.replace('whatsapp:', '').replace('+', '');

  try {
    if (contactsCollection) {
      const contacts = await contactsCollection.find({
        phone: { $regex: phone.slice(-9) }
      }).toArray();

      for (const contact of contacts) {
        if (!contact.messages) contact.messages = [];
        contact.messages.push({
          direction: 'inbound',
          channel: from.startsWith('whatsapp:') ? 'whatsapp' : 'sms',
          body,
          date: new Date().toISOString()
        });
        await saveContact(contact);
      }
    }
  } catch (err) {
    console.error('Webhook error:', err.message);
  }

  res.type('text/xml').send('<Response></Response>');
});

app.get('/webhook/meta', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === 'bodyandsoul_crm_verify') {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook/meta', async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;
    if (body.object !== 'page') return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field === 'leadgen') {
          const leadgenId = change.value?.leadgen_id;
          if (!leadgenId) continue;

          let leadData = { source: 'Facebook / Meta', stage: 'New Lead', tags: ['ad-lead'], notes: [], messages: [], createdAt: new Date().toISOString() };

          if (PAGE_ACCESS_TOKEN) {
            try {
              const leadRes = await fetch(`https://graph.facebook.com/v21.0/${leadgenId}?access_token=${PAGE_ACCESS_TOKEN}`);
              const leadJson = await leadRes.json();
              const fieldData = leadJson.field_data || [];
              for (const field of fieldData) {
                const name = field.name?.toLowerCase() || '';
                const value = field.values?.[0] || '';
                if (name.includes('first') || name === 'full_name') leadData.firstName = value.split(' ')[0];
                if (name.includes('last') || name === 'full_name') leadData.lastName = value.split(' ').slice(1).join(' ') || leadData.lastName || '';
                if (name.includes('email')) leadData.email = value;
                if (name.includes('phone')) leadData.phone = value;
                if (name.includes('condition') || name.includes('message') || name.includes('pain')) leadData.condition = value;
              }
              if (!leadData.firstName && fieldData.length) {
                leadData.firstName = fieldData[0]?.values?.[0] || 'Unknown';
              }
            } catch (err) {
              console.error('Lead fetch error:', err.message);
            }
          }

          leadData.id = leadgenId;
          leadData.firstName = leadData.firstName || 'Meta Lead';
          leadData.lastName = leadData.lastName || '';

          const existing = contactsCollection
            ? await contactsCollection.findOne({ id: leadgenId })
            : null;
          if (existing) {
            leadData.messages = existing.messages || [];
            leadData.welcomeSentAt = existing.welcomeSentAt;
            leadData.createdAt = existing.createdAt || leadData.createdAt;
          }

          await saveContact(leadData);
          await sendLeadEmail(leadData);
          console.log('New Meta lead saved:', leadData.firstName);
          if (!leadData.welcomeSentAt) await sendWelcomeSms(leadData);
        }
      }
    }
  } catch (err) {
    console.error('Meta webhook error:', err.message);
  }
});

connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(`CRM backend running on port ${PORT}`);
  });
});
