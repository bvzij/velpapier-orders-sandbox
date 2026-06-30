// ─────────────────────────────────────────────────────────────
// Apps Script handlers required by the dashboard.
//
// IMPORTANT: This file is NOT executed by the website. It lives in the
// Google Apps Script project bound to your Orders sheet. You must:
//   1. Open the Apps Script editor for that project.
//   2. Paste these two functions in (alongside create_order etc.).
//   3. Add the two dispatch lines below into your doPost's action switch.
//   4. Deploy > Manage deployments > Edit > New version (REDEPLOY).
// Until you redeploy, delete/edit will keep returning "unknown action".
// If the redeploy changes the Web App URL, send it over and update API
// in app.js.
// ─────────────────────────────────────────────────────────────

// Add these inside doPost, alongside the other action handlers:
//   if (action === 'update_order')  return updateOrder(body);
//   if (action === 'delete_order')  return deleteOrder(body);

// Updates arbitrary columns on an order. body.fields is keyed by the
// exact sheet column names, e.g.
//   { "Primary Username": "...", "Products": "...", "Price": 200,
//     "Status": "Pagado", "Notes": "..." }
function updateOrder(body) {
  const sheet = getOrdersSheet();
  const orders = sheetToObjects(sheet);
  const order = orders.find(o => o['Order ID'] === body.order_id);
  if (!order) return jsonResponse({ error: 'Order not found' });
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const fields = body.fields || {};
  Object.keys(fields).forEach(col => {
    const colIdx = headers.indexOf(col);
    if (colIdx >= 0) sheet.getRange(order._rowIndex, colIdx + 1).setValue(fields[col]);
  });
  return jsonResponse({ result: 'updated', order_id: body.order_id });
}

function deleteOrder(body) {
  const sheet = getOrdersSheet();
  const orders = sheetToObjects(sheet);
  const order = orders.find(o => o['Order ID'] === body.order_id);
  if (!order) return jsonResponse({ error: 'Order not found' });
  sheet.deleteRow(order._rowIndex);
  return jsonResponse({ result: 'deleted', order_id: body.order_id });
}
