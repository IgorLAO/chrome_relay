import puppeteer, { type Browser } from 'puppeteer';

const CHROMIUM_PATH = process.env.CHROMIUM_PATH || '/usr/bin/chromium-browser';

export async function connectToBrowser(): Promise<Browser> {
    const browser = await puppeteer.launch({
        executablePath: CHROMIUM_PATH,
        headless: true,
        defaultViewport: null,
        args: [
            '--no-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
        ],
    });
    console.log('Chromium launched');
    return browser;
}
