// ── Input mapping ────────────────────────────────────────────────────────────

import type { WsMessage } from "../types";

export const BUTTONS: Record<number, string> = {
    0: 'left', 1: 'middle', 2: 'right', 3: 'back', 4: 'forward',
};

const KEY_MAP: Record<string, number> = {
    Backspace: 8,
    Tab: 9,
    Enter: 13,
    Shift: 16,
    Control: 17,
    Alt: 18,
    Pause: 19,
    CapsLock: 20,
    Escape: 27,
    Space: 32,
    PageUp: 33,
    PageDown: 34,
    End: 35,
    Home: 36,
    ArrowLeft: 37,
    ArrowUp: 38,
    ArrowRight: 39,
    ArrowDown: 40,
    Insert: 45,
    Delete: 46,
};

export function getVirtualKeyCode(e: KeyboardEvent): number {
    switch (true) {
        case !!KEY_MAP[e.key]:
            return KEY_MAP[e.key];
        case e.key.length === 1:
            return e.key.toUpperCase().charCodeAt(0);
        case /^F\d+$/.test(e.key):
            return 111 + Number(e.key.slice(1));
        default:
            return 0;
    }
}

// CDP modifiers bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8
export function getMods(e: MouseEvent | WheelEvent | KeyboardEvent): number {
    return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

// ── URL ──────────────────────────────────────────────────────────────────────

export function normalizeUrl(input: string): string {
    const url = input.trim();
    if (!url) return '';
    if (!/^https?:\/\//.test(url)) return 'https://' + url;
    return url;
}

// ── Frame rendering ──────────────────────────────────────────────────────────

export async function drawJpegFrame(
    canvas: HTMLCanvasElement,
    data: ArrayBuffer,
    w: number,
    h: number,
): Promise<void> {
    try {
        const bitmap = await createImageBitmap(new Blob([data], { type: 'image/jpeg' }));
        canvas.getContext('2d')?.drawImage(bitmap, 0, 0, w, h);
        bitmap.close();
    } catch { }
}

// ── Downloads ────────────────────────────────────────────────────────────────

export function triggerBase64Download(filename: string, base64data: string): void {
    const bytes = Uint8Array.from(atob(base64data), c => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes]));
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// ── Paste → keydown messages ─────────────────────────────────────────────────

export interface KeyMsg {
    t: 'keydown';
    d: {
        key: string;
        code: string;
        modifiers: number;
        windowsVirtualKeyCode: number;
        nativeVirtualKeyCode: number;
    };
}

export function textToKeydownMessages(text: string): WsMessage[] {
    return [...text].map(ch => ({
        type: 'keydown',
        params: {
            key: ch, code: '', modifiers: 0,
            windowsVirtualKeyCode: ch.charCodeAt(0),
            nativeVirtualKeyCode: ch.charCodeAt(0),
        },
    }));
}
