import { useEffect, useRef, useState, useCallback } from 'react';
import './App.css';
import Canvas from './components/canvas';
import {
    drawJpegFrame,
    normalizeUrl,
    textToKeydownMessages,
    triggerBase64Download,
} from './utils';

function App() {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const viewportRef = useRef<HTMLDivElement>(null);
    const wsRef = useRef<WebSocket | null>(null);

    const [connected, setConnected] = useState(false);
    const [overlayMsg, setOverlayMsg] = useState('Connecting…');
    const [urlValue, setUrlValue] = useState('');
    const [pingText, setPingText] = useState('–');
    const [dlBanner, setDlBanner] = useState({ text: '', visible: false });

    const vpW = useRef(0);
    const vpH = useRef(0);
    const pingTime = useRef(0);
    const dlTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const send = useCallback((obj: unknown) => {
        const ws = wsRef.current;
        if (ws?.readyState === WebSocket.OPEN)
            ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
    }, []);

    function onDownloadStart(filename: string) {
        if (dlTimer.current) clearTimeout(dlTimer.current);
        setDlBanner({ text: 'Downloading: ' + filename + '…', visible: true });
    }

    function onDownloadReady(filename: string, base64data: string) {
        triggerBase64Download(filename, base64data);
        setDlBanner({ text: 'Downloaded: ' + filename, visible: true });
        if (dlTimer.current) clearTimeout(dlTimer.current);
        dlTimer.current = setTimeout(() => setDlBanner(b => ({ ...b, visible: false })), 3000);
    }

    // WebSocket lifecycle
    useEffect(() => {
        let destroyed = false;

        function connect() {
            if (destroyed) return;
            const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
            const ws = new WebSocket(`${proto}//${location.host}/ws`);
            ws.binaryType = 'arraybuffer';
            wsRef.current = ws;

            ws.onopen = () => {
                const canvas = canvasRef.current;
                const viewport = viewportRef.current;
                if (viewport && canvas) {
                    const w = viewport.clientWidth;
                    const h = viewport.clientHeight;
                    vpW.current = w; vpH.current = h;
                    canvas.width = w; canvas.height = h;
                    send({ t: 'resize', w, h });
                }
                canvas?.focus();
                setConnected(true);
            };

            ws.onmessage = async (ev) => {
                if (typeof ev.data !== 'string') {
                    const canvas = canvasRef.current;
                    if (canvas) await drawJpegFrame(canvas, ev.data, vpW.current, vpH.current);
                    return;
                }
                const msg = JSON.parse(ev.data);
                if      (msg.t === 'url')             setUrlValue(msg.url);
                else if (msg.t === 'title')            { if (msg.title) document.title = msg.title + ' – Chrome'; }
                else if (msg.t === 'pong')             setPingText((Date.now() - pingTime.current) + ' ms');
                else if (msg.t === 'download_start')   onDownloadStart(msg.filename);
                else if (msg.t === 'download_ready')   onDownloadReady(msg.filename, msg.data);
            };

            ws.onclose = () => {
                setConnected(false);
                setOverlayMsg('Disconnected. Reconnecting…');
                if (!destroyed) setTimeout(connect, 2000);
            };

            ws.onerror = () => ws.close();
        }

        connect();
        return () => { destroyed = true; wsRef.current?.close(); };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // Ping interval
    useEffect(() => {
        const id = setInterval(() => {
            if (wsRef.current?.readyState === WebSocket.OPEN) {
                pingTime.current = Date.now();
                send({ t: 'ping' });
            }
        }, 5000);
        return () => clearInterval(id);
    }, [send]);

    // Resize observer
    useEffect(() => {
        const viewport = viewportRef.current;
        if (!viewport) return;

        const observer = new ResizeObserver(() => {
            if (wsRef.current?.readyState !== WebSocket.OPEN) return;
            const w = viewport.clientWidth;
            const h = viewport.clientHeight;
            if (w === vpW.current && h === vpH.current) return;
            vpW.current = w; vpH.current = h;
            const canvas = canvasRef.current;
            if (canvas) { canvas.width = w; canvas.height = h; }
            send({ t: 'resize', w, h });
        });
        observer.observe(viewport);
        return () => observer.disconnect();
    }, [send]);

    // Paste fallback (when URL bar or other input is focused, not the canvas)
    useEffect(() => {
        const onPaste = (e: ClipboardEvent) => {
            if (document.activeElement === canvasRef.current) return;
            const text = e.clipboardData?.getData('text/plain');
            if (!text) return;
            for (const msg of textToKeydownMessages(text)) send(msg);
        };
        document.addEventListener('paste', onPaste);
        return () => document.removeEventListener('paste', onPaste);
    }, [send]);

    function navigate() {
        const url = normalizeUrl(urlValue);
        if (!url) return;
        send({ t: 'nav', url });
        canvasRef.current?.focus();
    }

    return (
        <>
            <div id="bar">
                <button id="btn-back" title="Back"
                    onClick={() => { send({ t: 'back' }); canvasRef.current?.focus(); }}>&#8592;</button>
                <button id="btn-fwd" title="Forward"
                    onClick={() => { send({ t: 'fwd' }); canvasRef.current?.focus(); }}>&#8594;</button>
                <button id="btn-reload" title="Reload"
                    onClick={() => { send({ t: 'reload' }); canvasRef.current?.focus(); }}>&#8635;</button>
                <div id="url-wrap">
                    <input
                        id="url-input"
                        type="text"
                        placeholder="Enter URL or search…"
                        spellCheck={false}
                        autoComplete="off"
                        value={urlValue}
                        onChange={e => setUrlValue(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') navigate(); e.stopPropagation(); }}
                        onFocus={e => e.target.select()}
                    />
                </div>
                <span id="ping">{pingText}</span>
            </div>

            <div id="viewport" ref={viewportRef}>
                <Canvas canvasRef={canvasRef} send={send} />
                {!connected && (
                    <div id="overlay">
                        <div className="spinner" />
                        <span id="overlay-msg">{overlayMsg}</span>
                    </div>
                )}
            </div>

            {dlBanner.visible && <div id="dl-banner">{dlBanner.text}</div>}
        </>
    );
}

export default App;
