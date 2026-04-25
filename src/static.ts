import type { IncomingMessage, ServerResponse } from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const staticDir  = path.join(__dirname, '..', 'public');

const MIME: Record<string, string> = {
    '.html': 'text/html',
    '.js':   'application/javascript',
    '.css':  'text/css',
};

export function serveStatic(req: IncomingMessage, res: ServerResponse) {
    const relPath  = req.url === '/' ? 'index.html' : (req.url?.replace(/^\//, '') ?? '');
    const filePath = path.resolve(staticDir, relPath);

    if (!filePath.startsWith(staticDir + path.sep)) {
        res.writeHead(403);
        return res.end();
    }

    fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); return res.end('Not found'); }
        const ct = MIME[path.extname(filePath)] ?? 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': ct });
        res.end(data);
    });
}
