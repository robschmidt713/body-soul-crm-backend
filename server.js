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

  try {
    const body = req.body;
    if (body.object !== 'page') return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field === 'leadgen') {
          const leadgenId = change.value.leadgen_id;
          const formId = change.value.form_id;
          const createdTime = change.value.created_time;

          console.log('New Meta lead:', leadgenId);

          let leadData = {
            id: leadgenId,
            source: 'Facebook / Meta',
            stage: 'New Lead',
            tags: ['ad-lead', 'meta'],
            notes: [{ date: new Date().toISOString(), text: `Lead from Meta form ${formId}` }],
            messages: [],
            createdAt: new Date(createdTime * 1000).toISOString(),
            firstName: '',
            lastName: '',
            email: '',
            phone: '',
            condition: ''
          };

          if (PAGE_ACCESS_TOKEN) {
            try {
              const url = `https://graph.facebook.com/v21.0/${leadgenId}?access_token=${PAGE_ACCESS_TOKEN}`;
              const response = await fetch(url);
              const data = await response.json();

              if (data.field_data) {
                const fields = {};
                data.field_data.forEach(f => {
                  fields[f.name] = (f.values && f.values[0]) || '';
                });

                const fullName = fields.full_name || fields.name || '';
                const nameParts = fullName.trim().split(' ');
                leadData.firstName = nameParts[0] || fields.first_name || '';
                leadData.lastName = nameParts.slice(1).join(' ') || fields.last_name || '';
                leadData.email = fields.email || '';
                leadData.phone = fields.phone_number || fields.phone || '';
                leadData.condition = fields.condition || fields.message || fields.comments || '';
              }
            } catch (err) {
              console.error('Failed to fetch lead details:', err.message);
            }
          }

          const contacts = await loadContacts();
          const exists = contacts.find(c => c.id === leadgenId);
          if (!exists) {
            await saveContact(leadData);
            console.log('Saved new Meta lead:', leadData.firstName, leadData.email || leadData.phone);
            await sendLeadEmail(leadData);
          }
        }
      }
    }
  } catch (err) {
    console.error('Webhook error:', err);
  }
});

app.get('/', async (req, res) => {
  const count = contactsCollection ? await contactsCollection.countDocuments() : 0;
  res.json({
    status: 'Body & Soul CRM Backend running',
    contacts: count,
    twilio: !!twilioClient,
    mongodb: !!contactsCollection,
    webhook: '/webhook/meta',
    twilioWebhook: '/webhook/twilio'
  });
});

app.listen(PORT, async () => {
  await connectDB();
  console.log(`CRM Backend listening on port ${PORT}`);
  console.log(`Meta verify token: ${VERIFY_TOKEN}`);
  console.log(`Page Access Token set: ${!!PAGE_ACCESS_TOKEN}`);
  console.log(`Twilio configured: ${!!twilioClient}`);
});
