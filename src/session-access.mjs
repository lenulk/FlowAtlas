import { randomBytes, timingSafeEqual } from 'node:crypto';

export function sessionToken(value = randomBytes(32).toString('base64url')) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new Error('Invalid FlowAtlas session credential');
  }
  return value;
}

// No cookies or URL credentials: loopback cookies are shared across ports.
export function sessionAccess(request, token, port, publicPath = false) {
  const host = request.headers.host;
  if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(host)) {
    return { status: 421, error: 'Invalid local host' };
  }
  if ((request.headers.origin !== undefined && request.headers.origin !== `http://${host}`)
    || request.headers['sec-fetch-site'] === 'cross-site') {
    return { status: 403, error: 'Request origin is not allowed' };
  }
  if (token === null || publicPath) return null;
  const supplied = request.headers.authorization;
  const expected = `Bearer ${token}`;
  if (typeof supplied !== 'string' || Buffer.byteLength(supplied) !== Buffer.byteLength(expected)
    || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
    return { status: 401, error: 'Session authorization required' };
  }
  return null;
}

export function showPairing(token) {
  // QA and redirected output must never persist a live session credential.
  if (process.stderr.isTTY) console.error(`FlowAtlas pairing code: ${token}`);
  else console.log('FlowAtlas session protected. Pair in the viewer using FLOWATLAS_SESSION_TOKEN; credentials are hidden in redirected output.');
}
