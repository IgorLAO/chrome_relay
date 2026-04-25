import path from 'path';
import fs from 'fs/promises';

export function setupDownloadHandler(
    page: any,
    cdp: any,
    ws: any,
    sessionDir: string,
): () => Promise<void> {
    const pendingGuids = new Map<string, string>(); // guid → filename

    cdp.send('Page.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: sessionDir,
    }).catch(() => {});

    cdp.on('Page.downloadWillBegin', (evt: any) => {
        const { guid, suggestedFilename } = evt as { guid: string; suggestedFilename: string };
        pendingGuids.set(guid, suggestedFilename);
        if (ws.readyState === ws.OPEN)
            ws.send(JSON.stringify({ t: 'download_start', guid, filename: suggestedFilename }));
    });

    cdp.on('Page.downloadProgress', async (evt: any) => {
        const { guid, state } = evt as { guid: string; state: string; totalBytes: number; receivedBytes: number };
        if (state !== 'completed') return;

        const filename = pendingGuids.get(guid);
        pendingGuids.delete(guid);
        if (!filename) return;

        const filePath = path.join(sessionDir, filename);
        try {
            const data = await fs.readFile(filePath);
            const base64 = data.toString('base64');
            if (ws.readyState === ws.OPEN)
                ws.send(JSON.stringify({ t: 'download_ready', guid, filename, data: base64 }));
        } catch (err) {
            console.error('download read error:', err);
        } finally {
            fs.unlink(filePath).catch(() => {});
        }
    });

    return async () => {
        pendingGuids.clear();
        try {
            const entries = await fs.readdir(sessionDir);
            await Promise.all(entries.map(e => fs.unlink(path.join(sessionDir, e)).catch(() => {})));
            await fs.rmdir(sessionDir).catch(() => {});
        } catch {}
    };
}
