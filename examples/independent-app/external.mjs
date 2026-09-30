import { createServer } from 'node:http';

export function createMessageService() {
  let nextId = 1;
  return createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const received = request.headers.traceparent;
    if (typeof received === 'string') response.setHeader('x-received-traceparent', received);
    response.setHeader('content-type', 'application/json; charset=utf-8');
    if (request.method === 'GET' && url.pathname === '/external/message') {
      response.end(JSON.stringify({ message: 'Hello from the separate message service' }));
    } else if (request.method === 'POST' && url.pathname === '/external/send') {
      response.end(JSON.stringify({ messageId: `MSG-${nextId++}` }));
    } else if (request.method === 'POST' && url.pathname === '/external/fail') {
      response.statusCode = 503;
      response.end(JSON.stringify({ error: 'Message service is temporarily unavailable' }));
    } else {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: 'Not found' }));
    }
  });
}
