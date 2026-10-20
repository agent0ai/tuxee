const downloads = new Map();
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('message', event => {
    if (event.data?.start) {
        if (downloads.size >= 32) {
            event.ports[0]?.postMessage({ error: 'Too many downloads' });
            return;
        }
        const id = event.data.start, abort = new AbortController(), client = event.source.id;
        const timer = setTimeout(() => { downloads.delete(id); event.source.postMessage({ id, error: 'Download did not start' }); }, 15000);
        downloads.set(id, { abort, client, timer });
        event.ports[0]?.postMessage({ ok: true });
    }
    const item = downloads.get(event.data?.cancel);
    if (item && item.client === event.source.id)
        item.abort.abort();
});
self.addEventListener('fetch', event => {
    const url = new URL(event.request.url), id = url.searchParams.get('transfer');
    if (url.origin !== self.location.origin || url.pathname !== '/api/download' || !id)
        return;
    event.respondWith((async () => {
        const item = downloads.get(id);
        if (!item)
            return fetch(event.request);
        clearTimeout(item.timer);
        const { abort, client } = item;
        const message = async (data) => (await self.clients.get(client))?.postMessage({ id, ...data });
        try {
            const response = await fetch(event.request, { signal: abort.signal });
            if (!response.ok) {
                downloads.delete(id);
                message({ error: 'Download failed' });
                return response;
            }
            const reader = response.body.getReader(), total = Number(response.headers.get('content-length'));
            let loaded = 0, last = 0;
            const body = new ReadableStream({
                async pull(controller) { try {
                    const { done, value } = await reader.read();
                    if (done) {
                        controller.close();
                        downloads.delete(id);
                        message({ loaded, total, done: true });
                        return;
                    }
                    loaded += value.byteLength;
                    controller.enqueue(value);
                    if (Date.now() - last > 100) {
                        last = Date.now();
                        message({ loaded, total });
                    }
                }
                catch (error) {
                    controller.error(error);
                    downloads.delete(id);
                    message({ error: abort.signal.aborted ? 'Cancelled' : 'Download interrupted' });
                } },
                cancel() { abort.abort(); reader.cancel(); downloads.delete(id); message({ error: 'Cancelled' }); }
            });
            return new Response(body, { status: response.status, headers: response.headers });
        }
        catch (error) {
            downloads.delete(id);
            message({ error: abort.signal.aborted ? 'Cancelled' : 'Download failed' });
            throw error;
        }
    })());
});
