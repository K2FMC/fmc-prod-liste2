const request = require('supertest');

const mockQuery = jest.fn();
jest.mock('pg', () => ({
  Pool: jest.fn(() => ({ query: mockQuery })),
}));
jest.mock('node-fetch', () => jest.fn());

const { app } = require('../../server');

beforeEach(() => jest.clearAllMocks());

// ---------------------------------------------------------------------------
// GET /api/surplus
// ---------------------------------------------------------------------------
describe('GET /api/surplus', () => {
  it('retourne la liste des surplus', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 1, sku: 'Money Chasers', color: '', size: 'M', qty: 5 }],
    });
    const res = await request(app).get('/api/surplus');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].sku).toBe('Money Chasers');
  });

  it('retourne 500 si la base de données échoue', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB down'));
    const res = await request(app).get('/api/surplus');
    expect(res.status).toBe(500);
    expect(res.body.error).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// POST /api/surplus
// ---------------------------------------------------------------------------
describe('POST /api/surplus', () => {
  it('crée une nouvelle entrée si elle n\'existe pas', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // SELECT → rien
      .mockResolvedValueOnce({ rows: [{ id: 1, sku: 'Test', color: '', size: 'M', qty: 3 }] }); // INSERT
    const res = await request(app)
      .post('/api/surplus')
      .send({ sku: 'Test', size: 'M', qty: 3 });
    expect(res.status).toBe(200);
    expect(res.body.qty).toBe(3);
  });

  it('cumule la quantité si l\'entrée existe déjà', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 1, sku: 'Test', color: '', size: 'M', qty: 4 }] }) // SELECT → existant
      .mockResolvedValueOnce({ rows: [{ id: 1, sku: 'Test', color: '', size: 'M', qty: 6 }] }); // UPDATE
    const res = await request(app)
      .post('/api/surplus')
      .send({ sku: 'Test', size: 'M', qty: 2 });
    expect(res.status).toBe(200);
    expect(res.body.qty).toBe(6);
  });

  it('retourne 500 si la base de données échoue', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB down'));
    const res = await request(app)
      .post('/api/surplus')
      .send({ sku: 'Test', size: 'M', qty: 1 });
    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/surplus/:id
// ---------------------------------------------------------------------------
describe('PATCH /api/surplus/:id', () => {
  it('met à jour la quantité et retourne la ligne modifiée', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, qty: 6 }] });
    const res = await request(app)
      .patch('/api/surplus/1')
      .send({ delta: 1 });
    expect(res.status).toBe(200);
    expect(res.body.qty).toBe(6);
  });

  it('retourne 404 si l\'entrée n\'existe pas', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .patch('/api/surplus/99')
      .send({ delta: 1 });
    expect(res.status).toBe(404);
    expect(res.body.error).toBeDefined();
  });

  it('retourne 500 si la base de données échoue', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB down'));
    const res = await request(app)
      .patch('/api/surplus/1')
      .send({ delta: -1 });
    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/surplus/:id
// ---------------------------------------------------------------------------
describe('DELETE /api/surplus/:id', () => {
  it('supprime l\'entrée et retourne { success: true }', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).delete('/api/surplus/1');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('retourne 500 si la base de données échoue', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB down'));
    const res = await request(app).delete('/api/surplus/1');
    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// POST /api/surplus/commit
// ---------------------------------------------------------------------------
describe('POST /api/surplus/commit', () => {
  it('exécute une requête UPDATE par déduction avec used > 0', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const res = await request(app)
      .post('/api/surplus/commit')
      .send({ deductions: [{ id: 1, used: 3 }, { id: 2, used: 1 }] });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('ignore les déductions avec used = 0', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const res = await request(app)
      .post('/api/surplus/commit')
      .send({ deductions: [{ id: 1, used: 0 }, { id: 2, used: 2 }] });
    expect(res.status).toBe(200);
    expect(mockQuery).toHaveBeenCalledTimes(1); // seulement id=2
  });

  it('retourne { success: true } si la liste est vide', async () => {
    const res = await request(app)
      .post('/api/surplus/commit')
      .send({ deductions: [] });
    expect(res.status).toBe(200);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('retourne 500 si la base de données échoue', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB down'));
    const res = await request(app)
      .post('/api/surplus/commit')
      .send({ deductions: [{ id: 1, used: 1 }] });
    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// POST /api/export
// ---------------------------------------------------------------------------
describe('POST /api/export', () => {
  it('génère un fichier xlsx avec le bon content-type', async () => {
    const res = await request(app)
      .post('/api/export')
      .send({
        items: [{ name: 'Produit Test', variant: 'Blanc', size: 'M', toPrint: 2, typeImpression: 'Sérigraphie', imageUrl: null }],
        date: '14/05/2026',
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
  });

  it('génère un fichier xlsx valide même sans articles', async () => {
    const res = await request(app)
      .post('/api/export')
      .send({ items: [], date: '14/05/2026' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
  });

  it('inclut le type d\'impression dans le fichier', async () => {
    const res = await request(app)
      .post('/api/export')
      .send({
        items: [{ name: 'Broderie Classic', variant: '', size: 'L', toPrint: 1, typeImpression: 'Broderie', imageUrl: null }],
        date: '14/05/2026',
      });
    expect(res.status).toBe(200);
  });
});
