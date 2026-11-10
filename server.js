const express = require('express');
const cors = require('cors');
const twilio = require('twilio');
const { MongoClient } = require('mongodb');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

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

async function saveContact(contact) {
  if (!contactsCollection) return;
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

app.get('/', (req, res) => {
  res.json({ status: 'Body & Soul CRM backend running' });
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
          await saveContact(leadData);
          await sendLeadEmail(leadData);
          console.log('New Meta lead saved:', leadData.firstName);
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
