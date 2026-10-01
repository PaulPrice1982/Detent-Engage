/** The embedding page supplies the browser's customer Origin. Only the owned
 * opaque frame can request the fixed widget routes, destination and key. Each
 * reply uses a MessagePort, never a wildcard message to a navigable window. */
export function bindPanelBridge(frame, options) {
    const listener = (event) => {
        if (!frame.isConnected || event.source !== frame.contentWindow || event.origin !== 'null')
            return;
        const data = event.data;
        if (data?.source !== 'detent-assistant')
            return;
        if (data.type === 'close') {
            options.close();
            return;
        }
        const port = event.ports[0];
        if (data.type !== 'request' || !port)
            return;
        const method = data.method;
        const path = data.path;
        const allowed = typeof path === 'string' && ((method === 'GET' && /^\/v1\/(locales\/[A-Za-z0-9-]+|sessions\/[A-Za-z0-9_-]+)$/.test(path))
            || (method === 'POST' && /^\/v1\/sessions(?:\/[A-Za-z0-9_-]+\/(?:messages|stream|consent|forget|modality))?$/.test(path)));
        const reply = (status, body, contentType = 'application/json') => {
            port.postMessage({ status, body, contentType });
            port.close();
        };
        if (!allowed || (data.body !== undefined && (typeof data.body !== 'string' || data.body.length > 64_000))) {
            reply(400, JSON.stringify({ message: 'Invalid panel request.' }));
            return;
        }
        void (async () => {
            try {
                const response = await fetch(`${options.api.replace(/\/$/, '')}${path}`, {
                    method, credentials: 'omit', redirect: 'error',
                    headers: { 'content-type': 'application/json', authorization: `Bearer ${options.key}` },
                    body: method === 'POST' ? data.body : undefined, signal: AbortSignal.timeout(60_000),
                });
                reply(response.status, await response.text(), response.headers.get('content-type') ?? 'application/json');
            }
            catch {
                reply(502, JSON.stringify({ message: 'The assistant is unavailable right now.' }));
            }
        })();
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
}
//# sourceMappingURL=panel-bridge.js.map