import { useEffect, useRef } from 'react';
import { BUTTONS, getMods, getVirtualKeyCode } from '../utils';
import type { WsMessage } from '../types';

interface CanvasProps {
    canvasRef: React.RefObject<HTMLCanvasElement | null>;
    send: (data: WsMessage) => void;
}

function Canvas({ canvasRef, send }: CanvasProps) {
    const sendRef = useRef(send);
    useEffect(() => { sendRef.current = send; });

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        let lastMoveTime = 0;
        let lastClickTime = 0, lastClickX = 0, lastClickY = 0, clickCount = 0;

        const scaleCoords = (e: MouseEvent | WheelEvent) => {
            const rect = canvas.getBoundingClientRect();
            return {
                x: Math.round((e.clientX - rect.left) * (canvas.width / rect.width)),
                y: Math.round((e.clientY - rect.top)  * (canvas.height / rect.height)),
            };
        };

        const onMouseMove = (e: MouseEvent) => {
            const now = Date.now();
            if (now - lastMoveTime < 16) return;
            lastMoveTime = now;
            const { x, y } = scaleCoords(e);
            sendRef.current({ type: 'mouse', params: { type: 'mouseMoved', x, y, modifiers: getMods(e) } });
        };

        const onMouseDown = (e: MouseEvent) => {
            e.preventDefault();
            canvas.focus();
            const { x, y } = scaleCoords(e);
            const now = Date.now();
            const sameSpot = Math.abs(x - lastClickX) < 4 && Math.abs(y - lastClickY) < 4;
            clickCount = (now - lastClickTime < 500 && sameSpot) ? 2 : 1;
            lastClickTime = now; lastClickX = x; lastClickY = y;
            sendRef.current({ type: 'mouse', params: {
                type: 'mousePressed', x, y,
                button: BUTTONS[e.button] || 'none', clickCount, modifiers: getMods(e),
            }});
        };

        const onMouseUp = (e: MouseEvent) => {
            const { x, y } = scaleCoords(e);
            sendRef.current({ type: 'mouse', params: {
                type: 'mouseReleased', x, y,
                button: BUTTONS[e.button] || 'none', clickCount, modifiers: getMods(e),
            }});
        };

        const onContextMenu = (e: MouseEvent) => e.preventDefault();

        const onWheel = (e: WheelEvent) => {
            e.preventDefault();
            const { x, y } = scaleCoords(e);
            sendRef.current({ type: 'wheel', x, y, deltaX: e.deltaX, deltaY: e.deltaY, modifiers: getMods(e) });
        };

        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'F12' || (e.ctrlKey && e.shiftKey && e.key === 'I')) return;
            e.preventDefault();
            const vk = getVirtualKeyCode(e);
            sendRef.current({ type: 'keydown', params: {
                key: e.key, code: e.code, modifiers: getMods(e),
                windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
            }});
        };

        const onKeyUp = (e: KeyboardEvent) => {
            if (e.key === 'F12' || (e.ctrlKey && e.shiftKey && e.key === 'I')) return;
            e.preventDefault();
            const vk = getVirtualKeyCode(e);
            sendRef.current({ type: 'keyup', params: {
                key: e.key, code: e.code, modifiers: getMods(e),
                windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
            }});
        };

        canvas.tabIndex = 0;
        canvas.addEventListener('mousemove', onMouseMove);
        canvas.addEventListener('mousedown', onMouseDown);
        canvas.addEventListener('mouseup', onMouseUp);
        canvas.addEventListener('contextmenu', onContextMenu);
        canvas.addEventListener('wheel', onWheel, { passive: false });
        canvas.addEventListener('keydown', onKeyDown);
        canvas.addEventListener('keyup', onKeyUp);

        return () => {
            canvas.removeEventListener('mousemove', onMouseMove);
            canvas.removeEventListener('mousedown', onMouseDown);
            canvas.removeEventListener('mouseup', onMouseUp);
            canvas.removeEventListener('contextmenu', onContextMenu);
            canvas.removeEventListener('wheel', onWheel);
            canvas.removeEventListener('keydown', onKeyDown);
            canvas.removeEventListener('keyup', onKeyUp);
        };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    return <canvas ref={canvasRef} id="screen" />;
}

export default Canvas;
