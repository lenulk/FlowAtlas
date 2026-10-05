export const appSource = `import { createServer } from 'node:http';
import { cpuUsage, memoryUsage } from 'node:process';
const started = cpuUsage();
const seen = new Set();
let requests = 0;
let metricsRequests = 0;
let invalid = 0;
let maxRssBytes = memoryUsage().rss;
const server = createServer((req, res) => {
  maxRssBytes = Math.max(maxRssBytes, memoryUsage().rss);
  if (req.method === 'GET' && req.url === '/__flowatlas_benchmark_metrics') {
    metricsRequests++;
    const cpu = cpuUsage(started);
    const body = Buffer.from(JSON.stringify({ requests, uniqueRequests: seen.size, metricsRequests, invalid,
      cpuUserMicros: cpu.user, cpuSystemMicros: cpu.system, maxRssBytes: Math.max(maxRssBytes, memoryUsage().rss) }));
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': body.length });
    res.end(body);
    return;
  }
  requests++;
  const match = /^\\/bench\\/(warmup-\\d{4}|measured-\\d{4})$/.exec(req.url ?? '');
  if (req.method !== 'GET' || !match || seen.has(match[1])) {
    invalid++;
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('invalid');
  } else {
    seen.add(match[1]);
    const body = Buffer.from('flowatlas-benchmark:' + match[1] + ':ok');
    res.writeHead(200, { 'content-type': 'text/plain', 'content-length': body.length });
    res.end(body);
  }
});
server.listen(Number(process.env.PORT), '127.0.0.1', () =>
  console.log('Registered app: http://127.0.0.1:' + server.address().port));
`;
