/**
 * Calcule les déductions surplus pour une liste d'articles agrégés.
 * @param {Array} aggregatedItems - [{ name, variant, size, qty, orders: {ref: qty} }]
 * @param {Array} surplusStock    - [{ id, sku, color, size, qty }]
 * @returns {Array} items enrichis de { deducted, toPrint, surplusId }
 */
function computeDeductions(aggregatedItems, surplusStock) {
  const usedMap = {};

  return aggregatedItems.map(item => {
    const s = surplusStock.find(s =>
      item.name.toUpperCase().includes(s.sku.toUpperCase()) &&
      s.size === item.size &&
      (!s.color || s.color === '' || s.color.toUpperCase() === (item.variant || '').toUpperCase())
    );
    const used = usedMap[s?.id] || 0;
    const available = s ? Math.max(0, s.qty - used) : 0;
    const deducted = Math.min(available, item.qty);
    if (s && deducted > 0) usedMap[s.id] = used + deducted;
    return { ...item, deducted, toPrint: item.qty - deducted, surplusId: s ? s.id : null };
  });
}

/**
 * Distribue les déductions surplus par commande en FIFO.
 * @param {Array} prodList - sortie de computeDeductions (items avec .deducted et .orders)
 * @returns {Object} { orderRef: [{ surplusId, name, variant, size, allocated }] }
 */
function computePerOrderAllocations(prodList) {
  const allocations = {};

  prodList.forEach(item => {
    if (!item.deducted || item.deducted <= 0) return;
    let remaining = item.deducted;

    for (const [ref, qty] of Object.entries(item.orders || {})) {
      if (remaining <= 0) break;
      const allocated = Math.min(qty, remaining);
      if (!allocations[ref]) allocations[ref] = [];
      allocations[ref].push({
        surplusId: item.surplusId,
        name: item.name,
        variant: item.variant || '',
        size: item.size,
        allocated,
      });
      remaining -= allocated;
    }
  });

  return allocations;
}

module.exports = { computeDeductions, computePerOrderAllocations };
