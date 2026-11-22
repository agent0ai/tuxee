import { Marked } from 'marked';
import { locale, t } from './i18n';
import { api, button, el, icon, popover } from './ui';

const noticeIcons = { default: 'Bell', info: 'Info', success: 'CircleCheck', warning: 'TriangleAlert', error: 'CircleAlert' } as const;
type Notice = { id: string; type: keyof typeof noticeIcons; text?: string; release?: string; resolved?: boolean; created: string };
type Feed = { items: Notice[]; count: number };

const escaped = (text: string) => el('span', '', text).innerHTML;
const markdown = new Marked({ renderer: {
    html: ({ text }) => escaped(text),
    image: ({ text }) => escaped(text),
    link({ href, tokens }) {
        const label = this.parser.parseInline(tokens);
        let url: URL;
        try { url = new URL(href); } catch { return label; }
        if (!['https:', 'http:', 'mailto:'].includes(url.protocol)) return label;
        const link = el('a');
        link.href = url.href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.innerHTML = label;
        return link.outerHTML;
    },
} });

export class Inbox {
    private feed: Feed = { items: [], count: 0 };
    private timer?: ReturnType<typeof setTimeout>;
    private request?: AbortController;
    private events = new AbortController();
    private pending = false;
    private unavailable = false;
    private ready = false;
    private repaint = () => {};

    constructor(private about: () => void) {
        document.addEventListener('visibilitychange', () => void this.refresh(), { signal: this.events.signal });
        window.addEventListener('focus', () => void this.refresh(), { signal: this.events.signal });
        void this.refresh();
    }

    async refresh(fromEvent = false) {
        clearTimeout(this.timer);
        if ((!fromEvent && document.hidden) || this.events.signal.aborted) return;
        if (this.request) { this.pending = true; return; }
        const request = this.request = new AbortController();
        const previous = this.feed, failed = this.unavailable, ready = this.ready;
        try {
            const result = await api<Feed>('/notifications', 'GET', undefined, request.signal);
            if (request.signal.aborted) return;
            this.feed = result;
            this.unavailable = false;
        } catch {
            if (request.signal.aborted) return;
            this.unavailable = true;
        }
        this.request = undefined;
        this.ready = true;
        if (this.pending) {
            this.pending = false;
            void this.refresh(true);
        } else if (!document.hidden) this.timer = setTimeout(() => void this.refresh(), 15000);
        if (!ready || failed !== this.unavailable || JSON.stringify(previous) !== JSON.stringify(this.feed)) this.repaint();
    }

    control(compact: boolean) {
        let close = () => {}, reposition = () => {};
        let content: HTMLElement | undefined, rows: HTMLElement | undefined;
        const label = t('notifications.title');
        const opener = button(label, 'Bell', () => {
            content = el('div', 'inbox');
            content.dataset.edge = opener.closest<HTMLElement>('#app')?.dataset.panelPosition;
            content.setAttribute('role', 'dialog');
            content.setAttribute('aria-label', label);
            rows = el('div', 'inbox-rows');
            const heading = el('header', 'launcher-heading');
            const all = button(t('notifications.dismissAll'), 'X', async () => {
                all.disabled = true;
                try { await api('/notifications', 'DELETE', undefined, this.events.signal); }
                finally { all.disabled = false; void this.refresh(true); }
            }, 'inbox-dismiss-all');
            all.append(t('notifications.all'));
            heading.append(el('h2', '', label), all);
            content.append(heading, rows);
            paint(true);
            ({ close, reposition } = popover(opener, content, opener, { alignToPanel: true, fillWorkspace: compact }));
            void this.refresh();
        }, 'notifications-button');
        opener.setAttribute('aria-haspopup', 'dialog');
        const badge = el('span', 'inbox-badge');
        badge.setAttribute('aria-hidden', 'true');
        opener.append(badge);
        const paint = (opening = false) => {
            const { items, count } = this.feed;
            opener.hidden = count === 0 && !this.unavailable;
            if (opener.hidden) close();
            badge.hidden = count === 0;
            badge.textContent = count > 99 ? '99+' : new Intl.NumberFormat(locale()).format(count);
            if (count) opener.setAttribute('aria-description', t('notifications.count', { count }));
            else opener.removeAttribute('aria-description');
            if (!rows || (!opening && !content?.isConnected)) return;
            const active = document.activeElement as HTMLElement | null;
            const focusedNotice = active?.closest<HTMLElement>('.inbox-card')?.dataset.notice;
            const focusedAction = active?.className;
            const scroll = rows.scrollTop;
            rows.replaceChildren();
            if (this.unavailable) rows.append(el('p', 'inbox-status', t('notifications.unavailable')));
            else if (!items.length) rows.append(el('p', 'inbox-status muted', t(this.ready ? 'notifications.empty' : 'common.loading')));
            for (const item of items) {
                const card = el('article', 'inbox-card');
                card.dataset.notice = item.id;
                card.dataset.type = item.type;
                const severity = el('span', 'inbox-type');
                severity.append(icon(noticeIcons[item.type]));
                severity.setAttribute('role', 'img');
                severity.setAttribute('aria-label', t(`notifications.type.${item.type}`));
                const time = el('time', 'muted');
                time.dateTime = item.created;
                time.textContent = new Date(item.created).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' });
                const dismiss = button(t('display.clipboard.dismiss'), 'X', async () => {
                    dismiss.disabled = true;
                    try {
                        await api('/notifications/' + item.id, 'DELETE', undefined, this.events.signal);
                        if (this.events.signal.aborted) return;
                        const remaining = this.feed.items.filter(other => other.id !== item.id);
                        this.feed = { items: remaining, count: Math.max(remaining.length, this.feed.count - Number(remaining.length !== this.feed.items.length)) };
                        this.repaint();
                        void this.refresh();
                    } finally { dismiss.disabled = false; }
                }, 'inbox-dismiss');
                const header = el('header', 'inbox-card-header');
                header.append(severity, time, dismiss);
                const message = el('div', 'inbox-message');
                message.dir = 'auto';
                if (item.release) {
                    const about = button(t('app.aboutTuxee'), undefined, () => { close(); this.about(); }, 'inbox-about');
                    const status = item.resolved ? t('updates.upToDate') : t('updates.available', { version: item.release });
                    message.append(el('p', '', status), about);
                } else {
                    try { message.innerHTML = markdown.parse(item.text || '', { async: false }); }
                    catch { message.textContent = item.text || ''; }
                    message.addEventListener('click', event => {
                        if ((event.target as Element).closest('a')) close();
                    });
                }
                card.append(header, message);
                rows.append(card);
            }
            if (!opening) reposition();
            rows.scrollTop = scroll;
            if (focusedNotice) {
                const card = [...rows.querySelectorAll<HTMLElement>('.inbox-card')].find(node => node.dataset.notice === focusedNotice);
                const target = [...(card?.querySelectorAll<HTMLElement>('button, a') || [])].find(node => node.className === focusedAction);
                (target || rows.querySelector('button') || opener).focus({ preventScroll: true });
            }
        };
        this.repaint = paint;
        paint();
        return { button: opener, dispose: () => { close(); if (this.repaint === paint) this.repaint = () => {}; } };
    }

    dispose() {
        this.events.abort();
        this.request?.abort();
        clearTimeout(this.timer);
    }
}
