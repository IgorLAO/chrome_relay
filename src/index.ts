import http from 'http';
import https from 'https';
import fs from 'fs';
import { WebSocketServer } from 'ws';

import { serveStatic } from './static.ts';
import { createSession } from './session.ts';
import { makeMessageHandler } from './handler.ts';
import { connectToBrowser } from './browser.ts';

const HTTPS_PORT = parseInt(process.env.HTTPS_PORT || '3051');

async function main() {
    const browser = await connectToBrowser();

    const sslKey = process.env.SSL_KEY ?? 'key.pem';
    const sslCert = process.env.SSL_CERT ?? 'cert.pem';

    const httpsServer = https.createServer(
        {
            key: fs.readFileSync(sslKey),
            cert: fs.readFileSync(sslCert)
        },
        serveStatic
    );

    const wss = new WebSocketServer(
        {
            server: httpsServer,
            path: '/ws',
            perMessageDeflate: false
        }
    );

    wss.on('connection', async ws => {
        let session;
        try {
            session = await createSession(browser, ws);
        } catch (err) {
            console.error('Session create failed:', err);
            ws.close();
            return;
        }

        const { page, cdp, stop } = session;
        const onMessage = makeMessageHandler(page, cdp, ws);

        ws.on('message', onMessage);
        ws.on('close', async () => {
            stop();
            try { if (!page.isClosed()) await page.close(); } catch { }
        });
    });

    httpsServer.listen(
        HTTPS_PORT,
        () => console.log(`running on https://localhost:${HTTPS_PORT}`)
    );
}

main().catch(err => { console.error(err); process.exit(1); });
