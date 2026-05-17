const { computeDeductions, computePerOrderAllocations } = require('../../lib/surplusCalc');

// --- Helpers ---
const item = (name, variant, size, qty, orders = {}) => ({ name, variant, size, qty, orders });
const stock = (id, sku, color, size, qty) => ({ id, sku, color, size, qty });

describe('computeDeductions', () => {
  it('déduit la quantité disponible quand le surplus couvre la commande', () => {
    const items = [item('Money Chasers', 'Blanc', 'M', 2)];
    const surplus = [stock(1, 'Money Chasers', '', 'M', 5)];
    const [result] = computeDeductions(items, surplus);
    expect(result.deducted).toBe(2);
    expect(result.toPrint).toBe(0);
    expect(result.surplusId).toBe(1);
  });

  it('déduit partiellement si le surplus est insuffisant', () => {
    const items = [item('Money Chasers', '', 'L', 5)];
    const surplus = [stock(1, 'Money Chasers', '', 'L', 3)];
    const [result] = computeDeductions(items, surplus);
    expect(result.deducted).toBe(3);
    expect(result.toPrint).toBe(2);
  });

  it('ne déduit rien si aucun surplus ne correspond', () => {
    const items = [item('Autre Produit', '', 'S', 4)];
    const surplus = [stock(1, 'Money Chasers', '', 'S', 10)];
    const [result] = computeDeductions(items, surplus);
    expect(result.deducted).toBe(0);
    expect(result.toPrint).toBe(4);
    expect(result.surplusId).toBeNull();
  });

  it('la correspondance SKU est insensible à la casse', () => {
    const items = [item('MONEY CHASERS', '', 'M', 1)];
    const surplus = [stock(1, 'money chasers', '', 'M', 5)];
    const [result] = computeDeductions(items, surplus);
    expect(result.deducted).toBe(1);
  });

  it('ne correspond pas si la taille diffère', () => {
    const items = [item('Money Chasers', '', 'XL', 2)];
    const surplus = [stock(1, 'Money Chasers', '', 'M', 10)];
    const [result] = computeDeductions(items, surplus);
    expect(result.deducted).toBe(0);
  });

  it('la couleur vide dans le surplus correspond à toutes les couleurs', () => {
    const items = [item('Produit', 'Rouge', 'M', 2)];
    const surplus = [stock(1, 'Produit', '', 'M', 5)];
    const [result] = computeDeductions(items, surplus);
    expect(result.deducted).toBe(2);
  });

  it('la couleur définie dans le surplus ne correspond pas à une autre couleur', () => {
    const items = [item('Produit', 'Bleu', 'M', 2)];
    const surplus = [stock(1, 'Produit', 'Rouge', 'M', 5)];
    const [result] = computeDeductions(items, surplus);
    expect(result.deducted).toBe(0);
  });

  it('répartit le surplus entre plusieurs articles dans l\'ordre', () => {
    const items = [
      item('Produit', '', 'M', 3),
      item('Produit', '', 'M', 4),
    ];
    const surplus = [stock(1, 'Produit', '', 'M', 5)];
    const [first, second] = computeDeductions(items, surplus);
    expect(first.deducted).toBe(3);   // 3 sur 5 disponibles
    expect(second.deducted).toBe(2);  // les 2 restants
    expect(second.toPrint).toBe(2);
  });

  it('le stock disponible ne peut pas être négatif', () => {
    const items = [item('Produit', '', 'S', 10)];
    const surplus = [stock(1, 'Produit', '', 'S', 0)];
    const [result] = computeDeductions(items, surplus);
    expect(result.deducted).toBe(0);
    expect(result.toPrint).toBe(10);
  });
});

describe('computePerOrderAllocations', () => {
  it('alloue la déduction à la première commande (FIFO)', () => {
    const prodList = [{
      name: 'Produit', variant: '', size: 'M',
      deducted: 2, surplusId: 1,
      orders: { '#1001': 3, '#1002': 2 },
    }];
    const allocs = computePerOrderAllocations(prodList);
    expect(allocs['#1001']).toHaveLength(1);
    expect(allocs['#1001'][0].allocated).toBe(2); // 2 pris sur les 3 de #1001
    expect(allocs['#1002']).toBeUndefined();       // #1002 non touché
  });

  it('répartit la déduction sur plusieurs commandes si nécessaire', () => {
    const prodList = [{
      name: 'Produit', variant: '', size: 'M',
      deducted: 5, surplusId: 1,
      orders: { '#1001': 3, '#1002': 4 },
    }];
    const allocs = computePerOrderAllocations(prodList);
    expect(allocs['#1001'][0].allocated).toBe(3); // commande entièrement couverte
    expect(allocs['#1002'][0].allocated).toBe(2); // reste du surplus
  });

  it('ne génère aucune allocation si deducted = 0', () => {
    const prodList = [{
      name: 'Produit', variant: '', size: 'M',
      deducted: 0, surplusId: null,
      orders: { '#1001': 2 },
    }];
    const allocs = computePerOrderAllocations(prodList);
    expect(Object.keys(allocs)).toHaveLength(0);
  });

  it('gère plusieurs produits avec des commandes communes', () => {
    const prodList = [
      { name: 'Produit A', variant: '', size: 'M', deducted: 1, surplusId: 1, orders: { '#1001': 2 } },
      { name: 'Produit B', variant: '', size: 'L', deducted: 3, surplusId: 2, orders: { '#1001': 1, '#1002': 3 } },
    ];
    const allocs = computePerOrderAllocations(prodList);
    expect(allocs['#1001']).toHaveLength(2); // Produit A + Produit B
    expect(allocs['#1002']).toHaveLength(1); // Produit B seulement
  });
});
