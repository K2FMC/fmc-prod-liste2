const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const STORE = process.env.SHOPIFY_STORE;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;

let cachedToken = null;
let tokenExpiry = 0;

async function getShopifyToken() {
  if (cachedToken && Date.now() < tokenExpiry - 60000) return cachedToken;
  const res = await fetch(`https://${STORE}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: 'client_credentials' })
  });
  const data = await res.json();
  if (data.errors) throw new Error('Auth Shopify échouée');
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in || 86400) * 1000;
  return cachedToken;
}

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS surplus (
      id SERIAL PRIMARY KEY,
      sku TEXT NOT NULL,
      color TEXT DEFAULT '',
      size TEXT NOT NULL,
      qty INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE surplus ADD COLUMN IF NOT EXISTS color TEXT DEFAULT ''`);
  console.log('Base de données prête.');
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Shopify GraphQL — credentials côté serveur uniquement
app.post('/api/shopify', async (req, res) => {
  const { query } = req.body;
  try {
    const token = await getShopifyToken();
    const response = await fetch(`https://${STORE}/admin/api/2024-01/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({ query })
    });
    const data = await response.json();
    if (data.errors) return res.status(400).json({ error: data.errors[0].message });
    if (!data.data) return res.status(400).json({ error: 'Réponse Shopify vide — vérifie le token', raw: data });
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET surplus
app.get('/api/surplus', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM surplus ORDER BY sku, size');
    res.json(result.rows);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST surplus
app.post('/api/surplus', async (req, res) => {
  const { sku, color = '', size, qty } = req.body;
  try {
    const existing = await pool.query('SELECT * FROM surplus WHERE sku = $1 AND size = $2 AND color = $3', [sku, size, color]);
    if (existing.rows.length > 0) {
      const result = await pool.query('UPDATE surplus SET qty = qty + $1 WHERE sku = $2 AND size = $3 AND color = $4 RETURNING *', [qty, sku, size, color]);
      res.json(result.rows[0]);
    } else {
      const result = await pool.query('INSERT INTO surplus (sku, color, size, qty) VALUES ($1, $2, $3, $4) RETURNING *', [sku, color, size, qty]);
      res.json(result.rows[0]);
    }
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE surplus
app.delete('/api/surplus/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM surplus WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => console.log(`FMC Prod Liste — port ${PORT}`));
}).catch(e => { console.error('Erreur init DB:', e.message); process.exit(1); });