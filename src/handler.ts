const CTRL = 2, META = 4;

export function makeMessageHandler(page: any, cdp: any, ws: any) {
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    let firstResize = true;

    return (raw: any) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        switch (msg.type) {
            case 'nav': {
                let url = (msg.url as string).trim();
                if (!url.match(/^https?:\/\//)) url = 'https://' + url;
                page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
                return;
            }
            case 'back':   page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {}); return;
            case 'fwd':    page.goForward({ waitUntil: 'domcontentloaded' }).catch(() => {}); return;
            case 'reload': page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {}); return;

            case 'ping':
                ws.send('{"type":"pong"}');
                return;

            case 'resize': {
                const w = Math.min(Math.max(1, Math.round(msg.width ?? 0)), 3840);
                const h = Math.min(Math.max(1, Math.round(msg.height ?? 0)), 2160);
                if (resizeTimer) clearTimeout(resizeTimer);
                const delay = firstResize ? 0 : 150;
                firstResize = false;
                resizeTimer = setTimeout(() => {
                    page.setViewport({ width: w, height: h }).catch(() => {});
                    resizeTimer = null;
                }, delay);
                return;
            }

            case 'mouse':
                cdp.send('Input.dispatchMouseEvent', msg.params).catch(() => {});
                return;

            case 'wheel':
                cdp.send('Input.dispatchMouseEvent', {
                    type: 'mouseWheel',
                    x: msg.x, y: msg.y,
                    deltaX: msg.deltaX, deltaY: msg.deltaY,
                    modifiers: msg.modifiers || 0,
                }).catch(() => {});
                return;

            case 'keydown':
                cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...msg.params }).catch(() => {});
                // Skip char event for Ctrl/Meta shortcuts — sending it would type the character
                // instead of triggering the shortcut (e.g. Ctrl+C would insert 'c' not copy)
                if (msg.params.key && msg.params.key.length === 1 && !(msg.params.modifiers & (CTRL | META)))
                    cdp.send('Input.dispatchKeyEvent', { type: 'char', text: msg.params.key }).catch(() => {});
                return;

            case 'keyup':
                cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...msg.params }).catch(() => {});
                return;
        }
    };
}
