const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const DATA_FILE = path.join(__dirname, 'contacts.json');
const PORT = process.env.PORT || 3000;

// Verify token for Meta webhook (set this in Meta App settings)
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || 'bodyandsoul_crm_verify';

// Page Access Token for fetching lead details (required for real leads)
const PAGE_ACCESS_TOKEN = process.env.META_PAGE_ACCESS_TOKEN || '';

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

// GET /contacts — frontend pulls the latest list
app.get('/contacts', (req, res) => {
  res.json(loadContacts());
});

// POST /contacts — manual add or frontend sync
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

    const exists = contacts.find(x => 
      (c.email && x.email === c.email) || 
      (c.phone && x.phone === c.phone) ||
      x.id === c.id
    );
    if (!exists) {
      contacts.push(c);
      added++;
    }
  });

  saveContacts(contacts);
  res.json({ success: true, added, total: contacts.length });
});

// Meta Webhook verification (GET)
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

// Meta Webhook — new lead arrives (POST)
app.post('/webhook/meta', async (req, res) => {
  // Always respond quickly so Meta doesn't retry
  res.status(200).send('EVENT_RECEIVED');

  try {
    const body = req.body;
    if (body.object !== 'page') return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field === 'leadgen') {
          const leadgenId = change.value.leadgen_id;
          const pageId = change.value.page_id;
          const formId = change.value.form_id;
          const createdTime = change.value.created_time;

          console.log('New Meta lead:', leadgenId);

          let leadData = {
            id: leadgenId,
            source: 'Facebook / Meta',
            stage: 'New Lead',
            tags: ['ad-lead', 'meta'],
            notes: [{ date: new Date().toISOString(), text: `Lead from Meta form ${formId}` }],
            createdAt: new Date(createdTime * 1000).toISOString(),
            firstName: '',
            lastName: '',
            email: '',
            phone: '',
            condition: ''
          };

          // Fetch full lead details if we have a Page Access Token
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

          // Save it
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

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'Body & Soul CRM Backend running',
    contacts: loadContacts().length,
    webhook: '/webhook/meta'
  });
});

app.listen(PORT, () => {
  console.log(`CRM Backend listening on port ${PORT}`);
  console.log(`Meta verify token: ${VERIFY_TOKEN}`);
  console.log(`Page Access Token set: ${!!PAGE_ACCESS_TOKEN}`);
});
