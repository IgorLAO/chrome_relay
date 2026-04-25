import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';
import type { Browser, Frame } from 'puppeteer';
import { setupDownloadHandler } from './download.ts';

const FRAME_W       = parseInt(process.env.FRAME_W       || '1280');
const FRAME_H       = parseInt(process.env.FRAME_H       || '720');
const FRAME_QUALITY = parseInt(process.env.FRAME_QUALITY || '70');
const DEFAULT_URL   = process.env.DEFAULT_URL || 'https://info.cern.ch/';

export async function createSession(browser: Browser, ws: any) {
    const page = await browser.newPage();
    await page.bringToFront(); // makes the tab active so input events register on first click
    await page.setViewport({ width: FRAME_W, height: FRAME_H });
    const cdp = await page.createCDPSession();

    const sessionId = crypto.randomUUID();
    const sessionDir = path.join('/tmp', 'chrome_relay_downloads', sessionId);
    await fs.mkdir(sessionDir, { recursive: true });
    const cleanupDownloads = setupDownloadHandler(page, cdp, ws, sessionDir);

    await cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: FRAME_QUALITY,
        everyNthFrame: 1,
    });

    cdp.on('Page.screencastFrame', (frame: any) => {
        cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
        if (ws.readyState === ws.OPEN)
            ws.send(Buffer.from(frame.data, 'base64'), { binary: true });
    });

    page.on('framenavigated', (frame: Frame) => {
        if (frame !== page.mainFrame()) return;
        if (ws.readyState === ws.OPEN)
            ws.send(JSON.stringify({ t: 'url', url: frame.url() }));
    });

    page.on('domcontentloaded', async () => {
        const title = await page.title().catch(() => '');
        if (ws.readyState === ws.OPEN)
            ws.send(JSON.stringify({ t: 'title', title }));
    });

    page.goto(DEFAULT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});

    return {
        page,
        cdp,
        stop: () => {
            cdp.send('Page.stopScreencast').catch(() => {});
            cleanupDownloads().catch(() => {});
        },
    };
}
