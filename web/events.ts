// Low-volume session events. Each handler fetches its own authoritative state.
export function connectEvents(handlers: ReadonlyMap<string, () => void>) {
    let socket: WebSocket | undefined, retry: ReturnType<typeof setTimeout> | undefined;
    let delay = 1000, disposed = false;
    const url = new URL('api/events', location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    function reconnect() {
        if (disposed) return;
        retry = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 15000);
    }
    function connect() {
        try { socket = new WebSocket(url); } catch { reconnect(); return; }
        socket.onmessage = event => {
            if (disposed) return;
            let message;
            try { message = JSON.parse(event.data); } catch { return; }
            delay = 1000;
            handlers.get(message?.type)?.();
        };
        socket.onclose = reconnect;
    }
    connect();
    return () => { disposed = true; clearTimeout(retry); socket?.close(); };
}
