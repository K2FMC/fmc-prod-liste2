const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
const ExcelJS = require('exceljs');

function getImageDimensions(buffer, ext) {
  try {
    if (ext === 'png') {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    // JPEG — cherche le marqueur SOF0/SOF1/SOF2
    let i = 2;
    while (i < buffer.length - 9) {
      if (buffer[i] !== 0xFF) break;
      const marker = buffer[i + 1];
      if (marker === 0xC0 || marker === 0xC1 || marker === 0xC2) {
        return { width: buffer.readUInt16BE(i + 7), height: buffer.readUInt16BE(i + 5) };
      }
      i += 2 + buffer.readUInt16BE(i + 2);
    }
  } catch(_) {}
  return null;
}

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

// PATCH surplus qty
app.patch('/api/surplus/:id', async (req, res) => {
  const { delta } = req.body;
  try {
    const result = await pool.query(
      'UPDATE surplus SET qty = GREATEST(0, qty + $1) WHERE id = $2 RETURNING *',
      [delta, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Non trouvé' });
    res.json(result.rows[0]);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST surplus/commit — persiste les déductions définitivement
app.post('/api/surplus/commit', async (req, res) => {
  const { deductions } = req.body; // [{ id, used }]
  try {
    for (const { id, used } of deductions) {
      if (used > 0) {
        await pool.query(
          'UPDATE surplus SET qty = GREATEST(0, qty - $1) WHERE id = $2',
          [used, id]
        );
      }
    }
    res.json({ success: true });
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

// POST /api/export — génère un fichier .xlsx avec images intégrées
app.post('/api/export', async (req, res) => {
  const { items, date } = req.body;
  try {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Production');

    sheet.columns = [
      { key: 'name',    width: 36 },
      { key: 'variant', width: 16 },
      { key: 'size',    width: 10 },
      { key: 'qty',     width: 16 },
      { key: 'photo',   width: 14 },
    ];

    // Ligne titre
    sheet.mergeCells('A1:E1');
    const titleCell = sheet.getCell('A1');
    titleCell.value = `FMC BETTER — Liste de production Atelier Paris — ${date}`;
    titleCell.font = { bold: true, size: 13 };
    titleCell.alignment = { vertical: 'middle' };
    sheet.getRow(1).height = 28;

    // Ligne header
    const headerRow = sheet.addRow(['Produit', 'Couleur', 'Taille', 'Qté à imprimer', 'Photo']);
    headerRow.height = 24;
    headerRow.eachCell(cell => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A1915' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
    });

    // Lignes de données
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const rowNum = i + 3; // 1=titre, 2=header, 3+=données
      const row = sheet.getRow(rowNum);
      row.height = 80;

      row.getCell(1).value = item.name;
      row.getCell(2).value = item.variant || '';
      row.getCell(3).value = item.size;
      row.getCell(4).value = item.toPrint;

      for (let c = 1; c <= 4; c++) {
        row.getCell(c).alignment = { vertical: 'middle', wrapText: true };
        if (i % 2 === 1) {
          row.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF7F6F3' } };
        }
      }

      if (item.imageUrl) {
        try {
          const imgRes = await fetch(item.imageUrl);
          const buffer = await imgRes.buffer();
          const urlPath = item.imageUrl.split('?')[0].toLowerCase();
          const ext = urlPath.endsWith('.png') ? 'png' : 'jpeg';
          const imageId = workbook.addImage({ buffer, extension: ext });
          const MAX = 72;
          const dims = getImageDimensions(buffer, ext);
          let imgW = MAX, imgH = MAX;
          if (dims) {
            const ratio = Math.min(MAX / dims.width, MAX / dims.height);
            imgW = Math.round(dims.width * ratio);
            imgH = Math.round(dims.height * ratio);
          }
          sheet.addImage(imageId, {
            tl: { col: 4, row: rowNum - 1 },
            ext: { width: imgW, height: imgH },
          });
        } catch(_) {
          row.getCell(5).value = 'N/A';
        }
      }

      row.commit();
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="fmc-atelier-paris-${date}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => console.log(`FMC Prod Liste — port ${PORT}`));
}).catch(e => { console.error('Erreur init DB:', e.message); process.exit(1); });