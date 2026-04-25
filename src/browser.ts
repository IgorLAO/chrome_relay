import puppeteer from 'puppeteer';

const CHROME_URL = process.env.CHROME_URL || 'http://127.0.0.1:9222';

export async function connectToBrowser(retries = 20): Promise<puppeteer.Browser> {
    for (let i = 0; i < retries; i++) {
        try {
            const res  = await fetch(`${CHROME_URL}/json/version`);
            const json = await res.json() as { webSocketDebuggerUrl: string };
            const browser = await puppeteer.connect({
                browserWSEndpoint: json.webSocketDebuggerUrl,
                defaultViewport: null,
            });
            console.log('Chrome connected');
            return browser;
        } catch {
            if (i < retries - 1) await new Promise(r => setTimeout(r, 1000));
        }
    }
    throw new Error('Could not connect to Chrome');
}
