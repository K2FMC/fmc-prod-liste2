const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
const ExcelJS = require('exceljs');
const { initializeApp: initFirebaseApp, cert, getApps, getApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getImageDimensions } = require('./lib/imageUtils');

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

const PRINTTEX_CLIENT_NAME = process.env.PRINTTEX_CLIENT_NAME || 'FMC BETTER';
// Tailles reconnues par le formulaire de commande Printtex (index.html: TASK_SIZES)
const PRINTTEX_SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL'];
// Emplacements visuels attendus par item (index.html: SLOTS) — l'UI plante si absents
const PRINTTEX_EMPTY_SLOTS = { face: null, dos: null, mancheGauche: null, mancheDroite: null, etiquette: null, mockup1: null, mockup2: null };

let cachedToken = null;
let tokenExpiry = 0;

// Firestore du projet Printtex — accès admin (bypass des règles de sécurité client)
let printtexDb = null;
function getPrinttexDb() {
  if (printtexDb) return printtexDb;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON manquant');
  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw);
  } catch (_) {
    serviceAccount = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  }
  const app = getApps().length ? getApp() : initFirebaseApp({ credential: cert(serviceAccount) });
  printtexDb = getFirestore(app);
  return printtexDb;
}

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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS manual_items (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      variant TEXT DEFAULT '',
      size TEXT NOT NULL,
      qty INTEGER NOT NULL DEFAULT 1,
      image_url TEXT DEFAULT '',
      type_impression TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
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
    const row = result.rows[0];
    if (row.qty === 0) await pool.query('DELETE FROM surplus WHERE id = $1', [req.params.id]);
    res.json(row);
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
        const result = await pool.query(
          'UPDATE surplus SET qty = GREATEST(0, qty - $1) WHERE id = $2 RETURNING qty',
          [used, id]
        );
        if (result.rows.length && result.rows[0].qty === 0) {
          await pool.query('DELETE FROM surplus WHERE id = $1', [id]);
        }
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

// GET manual items
app.get('/api/manual', async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, variant, size, qty, image_url AS "imageUrl", type_impression AS "typeImpression" FROM manual_items ORDER BY created_at`
    );
    res.json(result.rows);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST manual item
app.post('/api/manual', async (req, res) => {
  const { name, variant = '', size, qty, imageUrl = '', typeImpression = '' } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO manual_items (name, variant, size, qty, image_url, type_impression) VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, variant, size, qty, image_url AS "imageUrl", type_impression AS "typeImpression"`,
      [name, variant, size, qty, imageUrl, typeImpression]
    );
    res.json(result.rows[0]);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE all manual items
app.delete('/api/manual', async (_req, res) => {
  try {
    await pool.query('DELETE FROM manual_items');
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE single manual item
app.delete('/api/manual/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM manual_items WHERE id = $1', [req.params.id]);
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
      { key: 'type',    width: 18 },
      { key: 'qty',     width: 16 },
      { key: 'photo',   width: 14 },
    ];

    // Ligne titre
    sheet.mergeCells('A1:F1');
    const titleCell = sheet.getCell('A1');
    titleCell.value = `FMC BETTER — Liste de production Atelier Paris — ${date}`;
    titleCell.font = { bold: true, size: 13 };
    titleCell.alignment = { vertical: 'middle' };
    sheet.getRow(1).height = 28;

    // Ligne header
    const headerRow = sheet.addRow(['Produit', 'Couleur', 'Taille', 'Type impression', 'Qté à imprimer', 'Photo']);
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
      row.getCell(4).value = item.typeImpression || '';
      row.getCell(5).value = item.toPrint;

      for (let c = 1; c <= 5; c++) {
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
          // col width 14 chars ≈ 98px, row height 80pt * (96/72) ≈ 107px — marge de 4px
          const CELL_W_PX = 94;
          const CELL_H_PX = 103;
          const dims = getImageDimensions(buffer, ext);
          let imgW = CELL_W_PX, imgH = CELL_H_PX;
          if (dims) {
            const ratio = Math.min(CELL_W_PX / dims.width, CELL_H_PX / dims.height);
            imgW = Math.round(dims.width * ratio);
            imgH = Math.round(dims.height * ratio);
          }
          sheet.addImage(imageId, {
            tl: { col: 5, row: rowNum - 1 },
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

// POST /api/push-to-printtex — crée une commande dans le Kanban "Commandes" de Printtex (Firestore)
app.post('/api/push-to-printtex', async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Aucun article à envoyer' });
  try {
    const db = getPrinttexDb();
    const ordersRef = db.collection('orders');

    // Regrouper par (nom, couleur) — un item de commande = un produit/couleur avec une répartition de tailles
    const groups = {};
    for (const it of items) {
      const key = it.name + '||' + (it.variant || '');
      if (!groups[key]) {
        groups[key] = {
          id: 'item_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
          product: 'Autre',
          productOther: it.name,
          blank: '',
          blankOther: '',
          sizes: Object.fromEntries(PRINTTEX_SIZES.map(s => [s, 0])),
          couleur: it.variant || '',
          impression: it.typeImpression || '',
          quantity: 0,
          slots: { ...PRINTTEX_EMPTY_SLOTS },
          imageUrl: it.imageUrl || '',
        };
      }
      const g = groups[key];
      const size = PRINTTEX_SIZES.includes(it.size) ? it.size : 'M';
      g.sizes[size] += it.toPrint;
      g.quantity += it.toPrint;
    }
    const orderItems = Object.values(groups).map(({ imageUrl, ...item }) => item);
    const totalQuantity = orderItems.reduce((sum, it) => sum + it.quantity, 0);
    const thumbnails = Object.values(groups).map(g => g.imageUrl).filter(Boolean).slice(0, 3);

    const snap = await ordersRef.get();
    const orderNumber = snap.docs.reduce((max, d) => Math.max(max, d.data().orderNumber || 0), 0) + 1;
    const id = 'ord_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);

    const order = {
      id, orderNumber,
      clientName: PRINTTEX_CLIENT_NAME,
      clientContact: '',
      items: orderItems,
      quantity: totalQuantity,
      product: orderItems.length === 1 ? orderItems[0].product : `${orderItems.length} produits`,
      productOther: orderItems.length === 1 ? orderItems[0].productOther : '',
      printMethod: orderItems.length === 1 ? orderItems[0].impression : 'Divers',
      deadline: '',
      prodTime: '',
      prodTimeUnit: 'jours',
      status: 'nouvelle',
      priority: 'normale',
      priceAmount: '',
      depositAmount: '',
      toCheckOnReceipt: false,
      notes: 'Envoyé automatiquement depuis fmc-prod-liste',
      thumbnails,
      imageCount: thumbnails.length,
      archived: false,
      createdAt: new Date().toISOString(),
    };

    await ordersRef.doc(id).set(order);
    res.json({ success: true, orderNumber, itemCount: orderItems.length, totalQuantity });
  } catch (e) {
    console.error('push-to-printtex error:', e);
    res.status(500).json({ error: e.message, stack: e.stack });
  }
});

const PORT = process.env.PORT || 3000;

if (require.main === module) {
  initDB().then(() => {
    app.listen(PORT, () => console.log(`FMC Prod Liste — port ${PORT}`));
  }).catch(e => { console.error('Erreur init DB:', e.message); process.exit(1); });
}

module.exports = { app };