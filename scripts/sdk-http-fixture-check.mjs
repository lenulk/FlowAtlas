import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { appSource } from './http-benchmark-fixture.mjs';
test('SDK count diagnostic mirrors production SDK options on the same fixture', () => {
  const production = readFileSync(new URL('../src/otel-preload.mjs', import.meta.url), 'utf8');
  const qa = readFileSync(new URL('./sdk-http-count-preload.mjs', import.meta.url), 'utf8');
  const options = source => {
    const start = source.indexOf('const sdk = new NodeSDK('), end = source.indexOf('sdk.start();', start);
    assert.ok(start >= 0 && end > start);
    return source.slice(start, end).replace(/\s/g, '');
  };
  assert.equal(options(qa), options(production), 'Keep sampler, propagation, processors, resource and instrumentation options identical');
  assert.match(readFileSync(new URL('./benchmark-http-trace.mjs', import.meta.url), 'utf8'), /import \{ appSource \} from '\.\/http-benchmark-fixture\.mjs'/);
  assert.match(readFileSync(new URL('./benchmark-sdk-http.mjs', import.meta.url), 'utf8'), /import \{ appSource \} from '\.\/http-benchmark-fixture\.mjs'/);
  console.log('Shared fixture SHA256: ' + createHash('sha256').update(appSource).digest('hex'));
});
