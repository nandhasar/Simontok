import http from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { extname, join } from 'node:path';

const port = process.env.PORT || 3000;
const root = process.cwd();
const dbPath = join(root, 'data', 'db.json');

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

function ensureDb() {
  if (!existsSync(join(root, 'data'))) mkdirSync(join(root, 'data'), { recursive: true });
  if (!existsSync(dbPath)) writeFileSync(dbPath, JSON.stringify([], null, 2));
}

function readDb() {
  const raw = readFileSync(dbPath, 'utf8');
  const parsed = JSON.parse(raw || '[]');
  return Array.isArray(parsed) ? parsed : [];
}

function writeDb(rows) {
  writeFileSync(dbPath, JSON.stringify(rows, null, 2));
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => resolve(body));
  });
}

function json(res, obj, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function toDateInput(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value).slice(0, 10);
  const offset = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - offset).toISOString().slice(0, 10);
}

function normalizeTask(item) {
  return {
    id: String(item.id ?? ''),
    title: item.title || item.task || '',
    status: item.status || 'To Do',
    priority: item.priority || 'Medium',
    due_date: toDateInput(item.due_date || ''),
    note: item.note || '',
    updated_at: toDateInput(item.updated_at || ''),
    created_at: toDateInput(item.created_at || '')
  };
}

ensureDb();

const server = http.createServer(async (req, res) => {
  const urlPath = req.url.split('?')[0];

  if (urlPath === '/api/data' && req.method === 'GET') {
    try {
      json(res, { ok: true, data: readDb().map(normalizeTask) });
    } catch (err) {
      json(res, { ok: false, message: err.message }, 500);
    }
    return;
  }

  if (urlPath === '/api/data' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const data = JSON.parse(body || '{}');
      if (Array.isArray(data.tasks)) {
        const rows = data.tasks.map((row) => normalizeTask({
          ...row,
          id: row.id || String(Date.now()),
          updated_at: row.updated_at || new Date().toISOString().slice(0, 10),
          created_at: row.created_at || new Date().toISOString().slice(0, 10)
        }));
        writeDb(rows);
        json(res, { ok: true });
        return;
      }
      json(res, { ok: false, message: 'Invalid payload' }, 400);
    } catch (err) {
      json(res, { ok: false, message: err.message }, 500);
    }
    return;
  }

  const publicRoot = join(root, 'public');
  if (urlPath === '/') {
    const indexPath = join(publicRoot, 'index.html');
    if (existsSync(indexPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(readFileSync(indexPath));
      return;
    }
  }

  const safePath = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = join(publicRoot, safePath);
  if (existsSync(filePath)) {
    const ext = extname(filePath);
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    res.end(readFileSync(filePath));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${port}`);
});
