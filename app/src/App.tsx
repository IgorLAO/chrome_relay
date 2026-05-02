import { useEffect, useRef, useState, useCallback } from 'react';
import './App.css';
import Canvas from './components/canvas';
import {
    drawJpegFrame,
    triggerBase64Download,
} from './utils';
import Bar from './components/bar';
import type { WsMessage } from './types';


function App() {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const viewportRef = useRef<HTMLDivElement>(null);
    const wsRef = useRef<WebSocket | null>(null);

    const [connected, setConnected] = useState(false);
    const [overlayMsg, setOverlayMsg] = useState('Connecting…');
    const [pingText, setPingText] = useState('–');
    const [dlBanner, setDlBanner] = useState({ text: '', visible: false });

    const vpW = useRef(0);
    const vpH = useRef(0);
    const pingTime = useRef(0);
    const dlTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const send = useCallback((obj: WsMessage) => {
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
            if (destroyed) {
                return;
            }

            const ws = new WebSocket(`wss://${location.host}/ws`);
            ws.binaryType = 'arraybuffer';
            wsRef.current = ws;

            ws.onopen = () => {
                const canvas = canvasRef.current;
                const viewport = viewportRef.current;
                if (viewport && canvas) {
                    const w = viewport.clientWidth;
                    const h = viewport.clientHeight;
                    vpW.current = w; 
                    vpH.current = h;
                    canvas.width = w; canvas.height = h;
                    send({ type: 'resize', width: w, height: h });
                }
                canvas?.focus();
                setConnected(true);
            };

            ws.onmessage = async (ev) => {
                if (typeof ev.data !== 'string') {
                    const canvas = canvasRef.current;
                    if (canvas) {
                        await drawJpegFrame(canvas, ev.data, vpW.current, vpH.current);
                        return;
                    }
                }
                const msg = JSON.parse(ev.data);
                switch (msg.type) {
                    case 'pong':
                        setPingText((Date.now() - pingTime.current) + ' ms');
                        break
                    case 'download_start':
                        onDownloadStart(msg.filename)
                        break
                    case 'download_ready':
                        onDownloadReady(msg.filename, msg.data)
                        break
                }
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
                send({ type: 'ping' });
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
            send({ type: 'resize', width: w, height: h });
        });
        observer.observe(viewport);
        return () => observer.disconnect();
    }, [send]);

    return (
        <>

            <Bar pingValue={pingText} />
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
