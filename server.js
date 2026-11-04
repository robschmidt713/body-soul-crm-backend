const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || '';

// Meta
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || 'bodyandsoul_crm_verify';
const PAGE_ACCESS_TOKEN = process.env.META_PAGE_ACCESS_TOKEN || '';

// Twilio
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || '';

// Email
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'admin@bodyandsoulchiro.au';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';

let twilioClient = null;
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
  const twilio = require('twilio');
  twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
}

let db = null;
let contactsCollection = null;

async function connectDB() {
  if (!MONGODB_URI) {
    console.log('No MONGODB_URI set — running without database');
    return;
  }
  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    db = client.db();
    contactsCollection = db.collection('contacts');
    console.log('Connected to MongoDB');
  } catch (err) {
    console.error('MongoDB connection failed:', err.message);
  }
}

async function loadContacts() {
  if (!contactsCollection) return [];
  return await contactsCollection.find({}).toArray();
}

async function saveContact(contact) {
  if (!contactsCollection) return;
  const { _id, ...contactWithoutId } = contact;
  await contactsCollection.updateOne(
    { id: contact.id },
    { $set: contactWithoutId },
    { upsert: true }
  );
}

async function deleteContactById(id) {
  if (!contactsCollection) return;
  await contactsCollection.deleteOne({ id });
}

function findContactByPhone(contacts, phone) {
  if (!phone) return null;
  const clean = phone.replace(/\s+/g, '').replace(/[^\d+]/g, '');
  return contacts.find(c => {
    const cPhone = (c.phone || '').replace(/\s+/g, '').replace(/[^\d+]/g, '');
    if (!cPhone) return false;
    return cPhone === clean ||
           cPhone.endsWith(clean.slice(-9)) ||
           clean.endsWith(cPhone.slice(-9));
  });
}

async function sendLeadEmail(lead) {
  if (!RESEND_API_KEY) {
    console.log('No RESEND_API_KEY — skipping email');
    return;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'CRM <onboarding@resend.dev>',
        to: NOTIFY_EMAIL,
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

app.get('/contacts', async (req, res) => {
  const contacts = await loadContacts();
  res.json(contacts);
});

app.post('/contacts', async (req, res) => {
  const incoming = Array.isArray(req.body) ? req.body : [req.body];
  let added = 0;

  for (const c of incoming) {
    if (!c.id) c.id = Date.now().toString() + Math.random().toString(36).slice(2, 7);
    if (!c.createdAt) c.createdAt = new Date().toISOString();
    if (!c.stage) c.stage = 'New Lead';
    if (!c.source) c.source = 'Manual';
    if (!c.notes) c.notes = [];
    if (!c.tags) c.tags = [];
    if (!c.messages) c.messages = [];

    await saveContact(c);
    added++;
  }

  const total = contactsCollection ? await contactsCollection.countDocuments() : 0;
  res.json({ success: true, added, total });
});

app.put('/contacts/:id', async (req, res) => {
  const contacts = await loadContacts();
  const existing = contacts.find(c => c.id === req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const updated = { ...existing, ...req.body, id: req.params.id };
  await saveContact(updated);
  res.json(updated);
});

app.delete('/contacts/:id', async (req, res) => {
  await deleteContactById(req.params.id);
  res.json({ success: true });
});

app.post('/send', async (req, res) => {
  if (!twilioClient) {
    return res.status(400).json({ error: 'Twilio not configured' });
  }

  const { contactId, to, body, channel = 'sms' } = req.body;
  if (!to || !body) return res.status(400).json({ error: 'to and body required' });

  const toNumber = channel === 'whatsapp' && !to.startsWith('whatsapp:') ? `whatsapp:${to}` : to;

  const messageParams = { to: toNumber, body };

  if (TWILIO_FROM_NUMBER.startsWith('MG')) {
    messageParams.messagingServiceSid = TWILIO_FROM_NUMBER;
  } else {
    messageParams.from = channel === 'whatsapp'
      ? (TWILIO_FROM_NUMBER.startsWith('whatsapp:') ? TWILIO_FROM_NUMBER : `whatsapp:${TWILIO_FROM_NUMBER}`)
      : TWILIO_FROM_NUMBER.replace(/^whatsapp:/, '');
  }

  try {
    const message = await twilioClient.messages.create(messageParams);

    const contacts = await loadContacts();
    const contact = contacts.find(c => c.id === contactId) || findContactByPhone(contacts, to);
    if (contact) {
      if (!contact.messages) contact.messages = [];
      contact.messages.push({
        direction: 'outbound',
        channel,
        body,
        sid: message.sid,
        date: new Date().toISOString(),
        status: message.status
      });
      await saveContact(contact);
    }

    res.json({ success: true, sid: message.sid, status: message.status });
  } catch (err) {
    console.error('Twilio send error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/webhook/twilio', async (req, res) => {
  const from = req.body.From || '';
  const body = req.body.Body || '';
  const channel = from.startsWith('whatsapp:') ? 'whatsapp' : 'sms';
  const cleanFrom = from.replace(/^whatsapp:/, '');

  console.log('Inbound message from', cleanFrom, ':', body);

  const contacts = await loadContacts();
  let contact = findContactByPhone(contacts, cleanFrom);

  if (!contact) {
    console.log('No matching contact found for', cleanFrom, '- creating new');
    contact = {
      id: Date.now().toString() + Math.random().toString(36).slice(2, 7),
      firstName: 'Unknown',
      lastName: cleanFrom.slice(-4),
      phone: cleanFrom,
      source: channel === 'whatsapp' ? 'WhatsApp' : 'SMS',
      stage: 'New Lead',
      tags: ['inbound'],
      notes: [],
      messages: [],
      createdAt: new Date().toISOString()
    };
  } else {
    console.log('Matched to contact:', contact.firstName, contact.phone);
  }

  if (!contact.messages) contact.messages = [];
  contact.messages.push({
    direction: 'inbound',
    channel,
    body,
    date: new Date().toISOString(),
    from
  });

  await saveContact(contact);
  console.log('Saved inbound message. Contact now has', contact.messages.length, 'messages');

  res.set('Content-Type', 'text/xml');
  res.send('<Response></Response>');
});

app.get('/webhook/meta', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Meta webhook verified');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

app.post('/webhook/meta', async (req, res) => {
  res.status(200).send('EVENT_RECEIVED');
