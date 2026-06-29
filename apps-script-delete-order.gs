// Add this inside doPost's action dispatch, alongside the other actions:
//   if (action === 'delete_order') return deleteOrder(body);

function deleteOrder(body) {
  const sheet = getOrdersSheet();
  const orders = sheetToObjects(sheet);
  const order = orders.find(o => o['Order ID'] === body.order_id);
  if (!order) return jsonResponse({ error: 'Order not found' });
  sheet.deleteRow(order._rowIndex);
  return jsonResponse({ result: 'deleted', order_id: body.order_id });
}
