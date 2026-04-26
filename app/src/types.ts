export interface WsMessage {
    type: string;
    x?: number;
    y?: number;
    params?: any;
    width?: number;
    height?: number;
    filename?: string;
    data?: string;
    deltaX?: number;
    deltaY?: number;
    modifiers?: number;
    url?: string;
}
