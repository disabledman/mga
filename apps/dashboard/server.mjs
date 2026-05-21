import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.MGA_DASHBOARD_PORT ?? 7808);
const QUERY_API = process.env.MGA_QUERY_URL ?? 'http://localhost:7100';

const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  if (url.pathname.startsWith('/api/')) {
    const target = QUERY_API + url.pathname.replace('/api', '/v1/reports') + url.search;
    try {
      const apiRes = await fetch(target, {
        headers: { 'x-tenant-id': 't_demo' },
      });
      const body = await apiRes.text();
      res.writeHead(apiRes.status, { 'Content-Type': 'application/json' });
      res.end(body);
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }

  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  const path = join(__dirname, 'public', file);
  try {
    const data = await readFile(path);
    const ext = file.slice(file.lastIndexOf('.'));
    res.writeHead(200, { 'Content-Type': mime[ext] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`Dashboard http://localhost:${PORT}`);
});
