import puppeteer from 'puppeteer';

const CHROME_URL = process.env.CHROME_URL || 'http://127.0.0.1:9222';

export async function connectToBrowser(retries = 30): Promise<puppeteer.Browser> {
    let lastErr: unknown;
    for (let i = 0; i < retries; i++) {
        try {
            const browser = await puppeteer.connect({
                browserURL: CHROME_URL,
                defaultViewport: null,
            });
            console.log('Chrome connected');
            return browser;
        } catch (e) {
            lastErr = e;
            if (i < retries - 1) await new Promise(r => setTimeout(r, 1000));
        }
    }
    throw new Error(`Could not connect to Chrome at ${CHROME_URL}: ${lastErr}`);
}
