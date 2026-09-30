import { createServer } from 'node:http';

export function createInventoryService() {
  let stock = 2;
  let orderNumber = 0;
  return createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json; charset=utf-8');
    let url;
    try { url = new URL(request.url, 'http://localhost'); }
    catch {
      request.resume();
      response.statusCode = 400;
      response.end(JSON.stringify({ error: 'Invalid request URL' }));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/inventory/check') {
      response.end(JSON.stringify({ productId: 'atlas-notebook', stock }));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/inventory/reserve') {
      if (stock < 1) {
        response.statusCode = 409;
        response.end(JSON.stringify({ error: 'Out of stock' }));
        return;
      }
      stock -= 1;
      response.end(JSON.stringify({ orderId: `DEMO-${++orderNumber}`, remaining: stock }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'Not found' }));
  });
}
