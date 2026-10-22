import { button, el, notify } from './ui';

export const isImage = (name: string) => /\.(png|jpe?g|gif|webp|avif|bmp|ico)$/i.test(name);

export class ImageViewer {
    readonly controls = el('div', 'image-controls');
    readonly copyButton = typeof navigator.clipboard?.write === 'function' && typeof ClipboardItem !== 'undefined' && (!ClipboardItem.supports || ClipboardItem.supports('image/png'))
        ? button('Copy image to clipboard', 'Copy', () => this.copy()) : undefined;
    private viewport = el('div', 'image-viewport');
    private stage = el('div', 'image-stage');
    private image = el('img', 'file-image');
    private out = button('Zoom out', 'ZoomOut', () => this.zoomTo(this.scale / 1.25));
    private actual = button('Actual size (100%)', undefined, () => this.zoomTo(1), 'image-scale');
    private into = button('Zoom in', 'ZoomIn', () => this.zoomTo(this.scale * 1.25));
    private fitButton = button('Fit image', 'Scan', () => this.fit());
    private events = new AbortController();
    private resize = new ResizeObserver(() => { if (this.fitted) this.fit(); else this.render(); });
    private scale = 1;
    private fitted = true;
    private ready = false;
    private gestureScale?: number;
    private drag?: { id: number; x: number; y: number; left: number; top: number };

    constructor(host: HTMLElement, url: string, name: string) {
        const signal = this.events.signal;
        this.controls.setAttribute('role', 'group'); this.controls.setAttribute('aria-label', 'Image zoom');
        this.controls.append(this.out, this.actual, this.into, this.fitButton);
        for (const control of [this.out, this.actual, this.into, this.fitButton]) control.disabled = true;
        if (this.copyButton) this.copyButton.disabled = true;
        this.actual.textContent = '—';
        this.viewport.tabIndex = 0;
        this.viewport.setAttribute('role', 'region'); this.viewport.setAttribute('aria-label', 'Image viewer');
        this.viewport.setAttribute('aria-keyshortcuts', '+ - 0 1');
        this.image.alt = name; this.image.draggable = false; this.image.decoding = 'async';
        this.stage.append(this.image); this.viewport.append(this.stage); host.append(this.viewport);
        this.image.addEventListener('load', () => {
            this.ready = true; this.viewport.dataset.ready = 'true';
            this.actual.disabled = this.fitButton.disabled = false; this.fit();
            if (this.copyButton) this.copyButton.disabled = false;
        }, { signal });
        this.image.addEventListener('error', () => {
            this.viewport.replaceChildren(el('div', 'empty', 'Cannot display image'));
        }, { signal });
        this.viewport.addEventListener('wheel', event => {
            // Ordinary scrolling stays native, including both axes and trackpad momentum.
            if (!event.ctrlKey) return;
            event.preventDefault();
            if (this.gestureScale !== undefined) return;
            const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.viewport.clientHeight : 1;
            this.zoomTo(this.scale * Math.exp(-event.deltaY * unit * 0.01), event.clientX, event.clientY);
        }, { signal, passive: false });
        this.viewport.addEventListener('gesturestart', event => {
            event.preventDefault(); this.gestureScale = this.scale;
        }, { signal, passive: false });
        this.viewport.addEventListener('gesturechange', event => {
            event.preventDefault();
            const gesture = event as Event & { scale: number; clientX?: number; clientY?: number };
            if (this.gestureScale !== undefined && Number.isFinite(gesture.scale) && gesture.scale > 0)
                this.zoomTo(this.gestureScale * gesture.scale, gesture.clientX, gesture.clientY);
        }, { signal, passive: false });
        this.viewport.addEventListener('gestureend', event => {
            event.preventDefault(); this.gestureScale = undefined;
        }, { signal, passive: false });
        this.viewport.addEventListener('pointerdown', event => {
            if (event.button !== 0 || event.pointerType === 'touch' || !this.ready || this.drag) return;
            const rect = this.viewport.getBoundingClientRect();
            if (event.clientX >= rect.left + this.viewport.clientWidth || event.clientY >= rect.top + this.viewport.clientHeight) return;
            event.preventDefault(); event.stopPropagation(); this.viewport.focus({ preventScroll: true });
            this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: this.viewport.scrollLeft, top: this.viewport.scrollTop };
            this.viewport.setPointerCapture(event.pointerId); this.viewport.classList.add('dragging');
        }, { signal });
        this.viewport.addEventListener('pointermove', event => {
            if (this.drag?.id !== event.pointerId) return;
            this.viewport.scrollLeft = this.drag.left + this.drag.x - event.clientX;
            this.viewport.scrollTop = this.drag.top + this.drag.y - event.clientY;
        }, { signal });
        for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'])
            this.viewport.addEventListener(type, event => { if ((event as PointerEvent).pointerId === this.drag?.id) this.endDrag(); }, { signal });
        window.addEventListener('blur', () => { this.endDrag(); this.gestureScale = undefined; }, { signal });
        this.viewport.addEventListener('dblclick', event => {
            event.preventDefault();
            if (this.fitted) this.zoomTo(Math.max(1, this.scale * 2), event.clientX, event.clientY);
            else this.fit();
        }, { signal });
        this.viewport.addEventListener('keydown', event => {
            if (event.ctrlKey || event.metaKey || event.altKey) return;
            if (!['+', '=', '-', '0', '1'].includes(event.key)) return;
            event.preventDefault(); event.stopPropagation();
            if (event.key === '0') this.fit();
            else this.zoomTo(event.key === '1' ? 1 : this.scale * (event.key === '-' ? 1 / 1.25 : 1.25));
        }, { signal });
        this.resize.observe(this.viewport);
        this.image.src = url;
    }
    private fitScale() {
        return Math.min(1, this.viewport.clientWidth / this.image.naturalWidth, this.viewport.clientHeight / this.image.naturalHeight);
    }
    private async copy() {
        if (!this.ready || !this.copyButton) return;
        this.copyButton.disabled = true;
        try {
            const canvas = el('canvas');
            canvas.width = this.image.naturalWidth; canvas.height = this.image.naturalHeight;
            const context = canvas.getContext('2d');
            if (!context) throw new Error('Cannot copy image');
            context.drawImage(this.image, 0, 0);
            const png = new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Cannot copy image')), 'image/png'));
            // Start the clipboard write during the click, before asynchronous PNG encoding loses user activation.
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
            if (!this.events.signal.aborted) notify('Image copied', this.viewport);
        } finally {
            if (!this.events.signal.aborted) this.copyButton.disabled = false;
        }
    }
    private fit() {
        if (!this.ready || !this.viewport.clientWidth || !this.viewport.clientHeight) return;
        this.fitted = true; this.scale = this.fitScale(); this.render();
        this.viewport.scrollLeft = this.viewport.scrollTop = 0;
    }
    private render() {
        if (!this.ready) return;
        this.stage.style.width = this.image.style.width = `${this.image.naturalWidth * this.scale}px`;
        this.stage.style.height = this.image.style.height = `${this.image.naturalHeight * this.scale}px`;
        const percent = this.scale * 100;
        this.actual.textContent = `${percent < 10 ? percent.toFixed(1) : Math.round(percent)}%`;
        this.out.disabled = this.scale <= Math.min(0.05, this.fitScale());
        this.into.disabled = this.scale >= 16;
        this.viewport.classList.toggle('can-pan', this.viewport.scrollWidth > this.viewport.clientWidth || this.viewport.scrollHeight > this.viewport.clientHeight);
    }
    private zoomTo(scale: number, clientX?: number, clientY?: number) {
        if (!this.ready || !this.viewport.clientWidth || !this.viewport.clientHeight) return;
        scale = Math.max(Math.min(0.05, this.fitScale()), Math.min(16, scale));
        const viewport = this.viewport.getBoundingClientRect(), image = this.image.getBoundingClientRect();
        const x = clientX === undefined ? this.viewport.clientWidth / 2 : clientX - viewport.left;
        const y = clientY === undefined ? this.viewport.clientHeight / 2 : clientY - viewport.top;
        const imageX = (viewport.left + x - image.left) / this.scale, imageY = (viewport.top + y - image.top) / this.scale;
        this.fitted = false; this.scale = scale; this.render();
        this.viewport.scrollLeft = imageX * scale + Math.max(0, (this.viewport.clientWidth - this.image.naturalWidth * scale) / 2) - x;
        this.viewport.scrollTop = imageY * scale + Math.max(0, (this.viewport.clientHeight - this.image.naturalHeight * scale) / 2) - y;
    }
    private endDrag() {
        const id = this.drag?.id; this.drag = undefined; this.viewport.classList.remove('dragging');
        if (id !== undefined && this.viewport.hasPointerCapture(id)) this.viewport.releasePointerCapture(id);
    }
    focus() { this.viewport.focus({ preventScroll: true }); }
    dispose() {
        this.events.abort(); this.resize.disconnect(); this.endDrag();
        this.image.removeAttribute('src'); this.viewport.remove(); this.controls.remove(); this.copyButton?.remove();
    }
}
