import { t } from './i18n';
import { button, el, popover } from './ui';
// Width fitting reused from the8020/uui responsive_header.ts.
export function fittingHeaderItemCount(
  itemWidths: readonly number[],
  availableWidth: number,
  overflowToggleWidth: number,
  gap: number,
): number {
  if (itemWidths.length === 0 || availableWidth <= 0) return 0;
  const allItemsWidth = itemWidths.reduce((total, width) => total + width, 0) +
    gap * Math.max(0, itemWidths.length - 1);
  if (allItemsWidth <= availableWidth) return itemWidths.length;
  const visibleWidth = Math.max(
    0,
    availableWidth - overflowToggleWidth - gap,
  );
  let used = 0;
  let visible = 0;
  for (const width of itemWidths) {
    const next = used + (visible === 0 ? 0 : gap) + width;
    if (next > visibleWidth) break;
    used = next;
    visible++;
  }
  return visible;
}


export function overflowTabs(host: HTMLElement, items: HTMLElement[], label: string, reorder?: (items: HTMLElement[]) => void) {
    const visible = el('div', 'visible-tabs'), menu = el('div', 'overflow-tabs');
    let close = () => {}, frame = 0;
    const more = button(label, 'Ellipsis', () => { ({ close } = popover(more, menu)); });
    more.className = 'overflow-toggle'; more.setAttribute('aria-haspopup', 'menu');
    host.append(visible, more);
    let dragging: ReturnType<typeof reorderTabs> | undefined;
    let bound: HTMLElement[] = [];
    function fit() {
        dragging?.cancel();
        if (reorder && (bound.length !== items.length || items.some(item => !bound.includes(item)))) {
            dragging?.dispose();
            bound = [...items];
            dragging = reorderTabs(items, more, visible, menu, () => { fit(); reorder(items); });
        }
        close();
        visible.replaceChildren(...items); more.hidden = false;
        const style = getComputedStyle(host), available = host.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        const widths = items.map(item => item.getBoundingClientRect().width);
        const count = fittingHeaderItemCount(widths, available, more.offsetWidth, 4);
        const kept = new Set(items.slice(0, count));
        const active = items.find(item => item.classList.contains('active'));
        if (count && active && !kept.has(active)) {
            // Keep the current tab visible, accounting for its own width.
            let used = [...kept].reduce((sum, item) => sum + widths[items.indexOf(item)] + 4, 0);
            while (kept.size && used + widths[items.indexOf(active)] + more.offsetWidth + 4 > available) {
                const last = [...kept].at(-1)!; kept.delete(last); used -= widths[items.indexOf(last)] + 4;
            }
            if (used + widths[items.indexOf(active)] + more.offsetWidth + 4 <= available) kept.add(active);
        }
        visible.replaceChildren(...items.filter(item => kept.has(item)));
        menu.replaceChildren(...items.filter(item => !kept.has(item)));
        more.hidden = kept.size === items.length;
    }
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(fit); };
    const observer = new ResizeObserver(schedule);
    window.addEventListener('tuxee-tabs-changed', schedule);
    observer.observe(host); observer.observe(host.parentElement!); fit();
    return () => { dragging?.dispose(); observer.disconnect(); window.removeEventListener('tuxee-tabs-changed', schedule); cancelAnimationFrame(frame); close(); };
}

function reorderTabs(items: HTMLElement[], more: HTMLElement, visible: HTMLElement, menu: HTMLElement, changed: () => void) {
    const events = new AbortController(), signal = events.signal;
    let cancel = () => {}, suppressClick = false;
    const duration = () => matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180;
    window.addEventListener('pointerdown', () => { suppressClick = false; }, { capture: true, signal });
    window.addEventListener('click', event => {
        if (suppressClick && event.detail) { event.preventDefault(); event.stopImmediatePropagation(); suppressClick = false; }
    }, { capture: true, signal });
    function move(item: HTMLElement, index: number) {
        items.splice(items.indexOf(item), 1); items.splice(index, 0, item); changed();
    }
    for (const item of items) {
        item.classList.add('reorderable-tab');
        const handle = item.firstElementChild as HTMLElement;
        handle.setAttribute('aria-keyshortcuts', 'Alt+ArrowLeft Alt+ArrowRight');
        handle.setAttribute('aria-description', t("overflow.dragToReorderOrPressAltLeftOrAltRight"));
        handle.addEventListener('dragstart', event => event.preventDefault(), { signal });
        handle.addEventListener('keydown', event => {
            if (!event.altKey || !["ArrowLeft", 'ArrowRight'].includes(event.key)) return;
            event.preventDefault(); cancel();
            const rtl = !!item.closest('.visible-tabs') && getComputedStyle(item).direction === 'rtl';
            const index = items.indexOf(item) + (event.key === 'ArrowLeft' ? -1 : 1) * (rtl ? -1 : 1);
            if (index < 0 || index >= items.length) return;
            move(item, index);
            (item.closest('.visible-tabs') ? handle : more).focus();
        }, { signal });
        handle.addEventListener('pointerdown', event => {
            if (!event.isPrimary || event.button !== 0) return;
            cancel();
            const parent = item.parentElement!, siblings = [...parent.children] as HTMLElement[];
            if (items.length < 2) return;
            siblings.forEach(tab => tab.getAnimations().forEach(animation => animation.cancel()));
            const vertical = parent.classList.contains('overflow-tabs');
            const rtl = !vertical && getComputedStyle(parent).direction === 'rtl';
            if (rtl) siblings.reverse(); // Pointer geometry is measured from the physical left edge.
            const axis = vertical ? 'y' : 'x', size = vertical ? 'height' : 'width';
            const rects = new Map(siblings.map(tab => [tab, tab.getBoundingClientRect()]));
            const original = rects.get(item)!, first = rects.get(siblings[0])!, last = rects.get(siblings.at(-1)!)!;
            const gap = parseFloat(getComputedStyle(parent).gap) || 0;
            const gesture = new AbortController(), signal = gesture.signal;
            let started = false, order = siblings;
            let destination: number | undefined, preview: HTMLElement | undefined;
            const bar = more.closest<HTMLElement>('.window-bar');
            const clearTarget = () => items.forEach(tab => tab.classList.remove('tab-drop-before', 'tab-drop-after'));
            function finish(commit = false) {
                gesture.abort(); cancel = () => {};
                if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
                preview?.remove(); clearTarget(); item.classList.remove('tab-drag-away');
                if (!started) return;
                const before = new Map(siblings.map(tab => [tab, tab.getBoundingClientRect()]));
                for (const tab of siblings) {
                    tab.classList.remove('tab-shifting', 'tab-dragging'); tab.style.removeProperty('transform');
                }
                if (commit && destination !== undefined) move(item, destination);
                else if (commit && order.indexOf(item) !== siblings.indexOf(item)) {
                    const logical = rtl ? [...order].reverse() : order;
                    const next = logical[logical.indexOf(item) + 1], previous = logical[logical.indexOf(item) - 1];
                    const remaining = items.filter(tab => tab !== item);
                    move(item, next ? remaining.indexOf(next) : remaining.indexOf(previous) + 1);
                }
                for (const tab of siblings) {
                    if (!tab.isConnected) continue;
                    const from = before.get(tab)!, to = tab.getBoundingClientRect();
                    tab.animate([{ transform: `translate(${from.x - to.x}px, ${from.y - to.y}px)` }, { transform: 'none' }],
                        { duration: duration(), easing: 'cubic-bezier(.2,.7,.2,1)' });
                }
            }
            cancel = () => finish();
            window.addEventListener('pointermove', e => {
                if (e.pointerId !== event.pointerId) return;
                const delta = vertical ? e.clientY - event.clientY : e.clientX - event.clientX;
                const inside = (node: HTMLElement, margin = 0) => {
                    const r = node.getBoundingClientRect();
                    return node.checkVisibility() && e.clientX >= r.left - margin && e.clientX < r.right + margin && e.clientY >= r.top - margin && e.clientY < r.bottom + margin;
                };
                const bounds = bar?.getBoundingClientRect();
                // Keep diagonal paths from an overflow entry to the bar inside the reorder gesture.
                const progress = bounds && vertical ? (event.clientY - e.clientY) / (event.clientY - bounds.bottom) : -1;
                const towardBar = bounds && progress >= 0 && progress <= 1 &&
                    e.clientX >= event.clientX + (bounds.left - event.clientX) * progress - 4 &&
                    e.clientX <= event.clientX + (bounds.right - event.clientX) * progress + 4;
                if (bar && !inside(bar) && !inside(menu, 4) && !towardBar) { finish(); return; }
                if (!started) {
                    if (Math.hypot(e.clientX - event.clientX, e.clientY - event.clientY) < 5) return;
                    started = true; suppressClick = true; handle.setPointerCapture(event.pointerId);
                    item.classList.add('tab-dragging');
                    siblings.filter(tab => tab !== item).forEach(tab => tab.classList.add('tab-shifting'));
                }
                e.preventDefault();
                if (inside(more) && !menu.matches(':popover-open')) more.click();
                const target = inside(menu, 4) ? menu : inside(bar || visible) ? visible : undefined;
                clearTarget(); destination = undefined;
                if (target !== parent) {
                    order = siblings;
                    siblings.forEach(tab => tab.style.removeProperty('transform'));
                    item.classList.add('tab-drag-away');
                    if (!preview) {
                        preview = el('div', 'tab-drag-preview', handle.textContent || handle.getAttribute('aria-label') || '');
                        preview.setAttribute('aria-hidden', 'true'); preview.popover = 'manual';
                        document.body.append(preview); preview.showPopover();
                    }
                    preview.style.left = `${e.clientX + 12}px`; preview.style.top = `${e.clientY + 12}px`;
                    if (target) {
                        const tabs = [...target.children] as HTMLElement[], remaining = items.filter(tab => tab !== item);
                        const reversed = target === visible && getComputedStyle(visible).direction === 'rtl';
                        const next = tabs.find(tab => {
                            const r = tab.getBoundingClientRect();
                            return target === menu ? e.clientY < r.y + r.height / 2 : reversed ? e.clientX > r.x + r.width / 2 : e.clientX < r.x + r.width / 2;
                        });
                        const previous = tabs.at(-1);
                        destination = next ? remaining.indexOf(next) : previous ? remaining.indexOf(previous) + 1 : 0;
                        (next || previous)?.classList.add(next ? 'tab-drop-before' : 'tab-drop-after');
                    }
                    return;
                }
                preview?.remove(); preview = undefined; item.classList.remove('tab-drag-away');
                const offset = Math.max(first[axis] - original[axis], Math.min(delta, last[axis] + last[size] - original[axis] - original[size]));
                const start = original[axis] + offset, end = start + original[size];
                order = siblings.filter(tab => tab !== item);
                // Compare the facing edge against fixed midpoints so unequal tabs swap early without oscillating.
                const index = order.filter(tab => {
                    const r = rects.get(tab)!, edge = r[axis] < original[axis] ? start : end;
                    return edge > r[axis] + r[size] / 2;
                }).length;
                order.splice(index, 0, item);
                let position = first[axis];
                for (const tab of order) {
                    const rect = rects.get(tab)!, shift = tab === item ? offset : position - rect[axis];
                    tab.style.transform = vertical ? `translateY(${shift}px)` : `translateX(${shift}px)`;
                    position += rect[size] + gap;
                }
            }, { signal, passive: false, capture: true });
            window.addEventListener('pointerup', e => { if (e.pointerId === event.pointerId) finish(true); }, { signal });
            window.addEventListener('pointercancel', cancel, { signal });
            handle.addEventListener('lostpointercapture', cancel, { signal });
            window.addEventListener('blur', cancel, { signal });
            window.addEventListener('resize', cancel, { signal });
            window.addEventListener('scroll', cancel, { signal, capture: true });
            document.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); cancel(); } }, { signal, capture: true });
        }, { signal });
    }
    return { cancel: () => cancel(), dispose: () => { cancel(); events.abort(); } };
}
