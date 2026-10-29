const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const DATA_FILE = path.join(__dirname, 'contacts.json');
const PORT = process.env.PORT || 3000;

// Meta
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || 'bodyandsoul_crm_verify';
const PAGE_ACCESS_TOKEN = process.env.META_PAGE_ACCESS_TOKEN || '';

// Twilio
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || '';

let twilioClient = null;
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
  const twilio = require('twilio');
  twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
}

function loadContacts() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (e) {}
  return [];
}

function saveContacts(contacts) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(contacts, null, 2));
}

function findContactByPhone(phone) {
  if (!phone) return null;
  const clean = phone.replace(/\s+/g, '').replace(/[^\d+]/g, '');
  return loadContacts().find(c => {
    const cPhone = (c.phone || '').replace(/\s+/g, '').replace(/[^\d+]/g, '');
    return cPhone && (cPhone === clean || cPhone.endsWith(clean.slice(-9)) || clean.endsWith(cPhone.slice(-9)));
  });
}

app.get('/contacts', (req, res) => {
  res.json(loadContacts());
});

app.post('/contacts', (req, res) => {
  const contacts = loadContacts();
  const incoming = Array.isArray(req.body) ? req.body : [req.body];
  let added = 0;

  incoming.forEach(c => {
    if (!c.id) c.id = Date.now().toString() + Math.random().toString(36).slice(2, 7);
    if (!c.createdAt) c.createdAt = new Date().toISOString();
    if (!c.stage) c.stage = 'New Lead';
    if (!c.source) c.source = 'Manual';
    if (!c.notes) c.notes = [];
    if (!c.tags) c.tags = [];
    if (!c.messages) c.messages = [];

    const exists = contacts.find(x =>
      x.id === c.id ||
      (c.email && x.email && x.email === c.email) ||
      (c.phone && x.phone && x.phone === c.phone)
    );
    if (!exists) {
      contacts.push(c);
      added++;
    } else {
      Object.assign(exists, c);
    }
  });

  saveContacts(contacts);
  res.json({ success: true, added, total: contacts.length });
});

app.put('/contacts/:id', (req, res) => {
  const contacts = loadContacts();
  const idx = contacts.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  contacts[idx] = { ...contacts[idx], ...req.body, id: req.params.id };
  saveContacts(contacts);
  res.json(contacts[idx]);
});

app.delete('/contacts/:id', (req, res) => {
  let contacts = loadContacts();
  contacts = contacts.filter(c => c.id !== req.params.id);
  saveContacts(contacts);
  res.json({ success: true });
});

app.post('/send', async (req, res) => {
  if (!twilioClient) {
    return res.status(400).json({ error: 'Twilio not configured' });
  }

  const { contactId, to, body, channel = 'sms' } = req.body;
  if (!to || !body) return res.status(400).json({ error: 'to and body required' });

  const from = channel === 'whatsapp' 
    ? (TWILIO_FROM_NUMBER.startsWith('whatsapp:') ? TWILIO_FROM_NUMBER : `whatsapp:${TWILIO_FROM_NUMBER}`)
    : TWILIO_FROM_NUMBER.replace(/^whatsapp:/, '');

  const toNumber = channel === 'whatsapp' && !to.startsWith('whatsapp:') ? `whatsapp:${to}` : to;

  try {
    const message = await twilioClient.messages.create({
      from,
      to: toNumber,
      body
    });

    const contacts = loadContacts();
    const contact = contacts.find(c => c.id === contactId) || findContactByPhone(to);
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
      saveContacts(contacts);
    }

    res.json({ success: true, sid: message.sid, status: message.status });
  } catch (err) {
    console.error('Twilio send error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/webhook/twilio', (req, res) => {
  const from = req.body.From || '';
  const body = req.body.Body || '';
  const channel = from.startsWith('whatsapp:') ? 'whatsapp' : 'sms';
  const cleanFrom = from.replace(/^whatsapp:/, '');

  console.log('Inbound message from', from, ':', body);

  const contacts = loadContacts();
  let contact = findContactByPhone(cleanFrom);

  if (!contact) {
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
    contacts.push(contact);
  }

  if (!contact.messages) contact.messages = [];
  contact.messages.push({
    direction: 'inbound',
    channel,
    body,
    date: new Date().toISOString(),
    from
  });

  saveContacts(contacts);

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

          const contacts = loadContacts();
          const exists = contacts.find(c => c.id === leadgenId);
          if (!exists) {
            contacts.push(leadData);
            saveContacts(contacts);
            console.log('Saved new Meta lead:', leadData.firstName, leadData.email || leadData.phone);
          }
        }
      }
    }
  } catch (err) {
    console.error('Webhook error:', err);
  }
});

app.get('/', (req, res) => {
  res.json({
    status: 'Body & Soul CRM Backend running',
    contacts: loadContacts().length,
    twilio: !!twilioClient,
    webhook: '/webhook/meta',
    twilioWebhook: '/webhook/twilio'
  });
});

app.listen(PORT, () => {
  console.log(`CRM Backend listening on port ${PORT}`);
  console.log(`Meta verify token: ${VERIFY_TOKEN}`);
  console.log(`Page Access Token set: ${!!PAGE_ACCESS_TOKEN}`);
  console.log(`Twilio configured: ${!!twilioClient}`);
});
