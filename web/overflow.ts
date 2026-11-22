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
    availableWidth - overflowToggleWidth - (overflowToggleWidth ? gap : 0),
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


const strips = new WeakMap<HTMLElement, { visible: HTMLElement; menu: HTMLElement; more: HTMLElement; items: HTMLElement[]; fit: (allocated?: boolean) => void }>();

export function overflowTabs(host: HTMLElement, items: HTMLElement[], label: string, reorder?: (items: HTMLElement[]) => void, trailing?: HTMLElement) {
    const visible = el('div', 'visible-tabs'), menu = el('div', 'overflow-tabs');
    const vertical = host.classList.contains('vertical-tabs');
    let close = () => {}, frame = 0;
    const more = button(label, 'Ellipsis', () => { ({ close } = popover(more, menu)); });
    more.className = 'overflow-toggle'; more.setAttribute('aria-haspopup', 'menu');
    const actions = trailing && el('div', 'workspace-tab-actions');
    if (actions) { actions.append(more, trailing!); host.append(visible, actions); }
    else host.append(visible, more);
    strips.set(host, { visible, menu, more, items, fit });
    let dragging: ReturnType<typeof reorderTabs> | undefined;
    let bound: HTMLElement[] = [];
    function fit(allocated = false) {
        const parent = vertical && host.parentElement?.closest<HTMLElement>('.vertical-tabs');
        if (parent && !allocated) {
            const strip = strips.get(parent);
            if (!strip?.menu.matches(':popover-open')) strip?.fit();
            return;
        }
        if ((host.classList.contains('tab-drag-host') || host.querySelector('.tab-drag-host')) && bound.length === items.length && items.every(item => bound.includes(item))) return;
        const nested = host.querySelector<HTMLElement>('.vertical-tabs');
        const child = nested && strips.get(nested);
        const active = items.find(item => item.classList.contains('active'));
        let candidates = items;
        const focused = host.contains(document.activeElement) ? document.activeElement as HTMLElement : undefined;
        dragging?.cancel();
        if (reorder && (bound.length !== items.length || items.some(item => !bound.includes(item)))) {
            dragging?.dispose();
            bound = [...items];
            dragging = reorderTabs(items, more, visible, menu, () => { fit(); reorder(items); });
        }
        close();
        // A speculative ellipsis would shrink the nested list before measuring its space.
        visible.replaceChildren(...candidates); more.hidden = vertical;
        // Let CSS size both lists from their rows; fixed requested heights leave gaps and round down at browser zoom.
        if (vertical && child) {
            child.visible.replaceChildren(...child.items); child.more.hidden = true;
        }
        const layoutTop = (item: HTMLElement) => {
            const transform = getComputedStyle(item).transform;
            return item.getBoundingClientRect().top - (transform === 'none' ? 0 : new DOMMatrix(transform).m42);
        };
        const gap = parseFloat(getComputedStyle(visible)[vertical ? 'rowGap' : 'columnGap']) || 0;
        const style = getComputedStyle(host), toggleGap = parseFloat(style[vertical ? 'rowGap' : 'columnGap']) || 0;
        let widths = candidates.map(item => item.getBoundingClientRect()[vertical ? 'height' : 'width']);
        // The outer strip can grow into its parent's free space; its content-sized height is only the current result.
        let height = host.getBoundingClientRect().height;
        if (vertical && !allocated) {
            const container = host.parentElement!, containerStyle = getComputedStyle(container);
            height = container.getBoundingClientRect().bottom - host.getBoundingClientRect().top - parseFloat(containerStyle.paddingBottom);
            for (let sibling = host.nextElementSibling; sibling; sibling = sibling.nextElementSibling) {
                if (!sibling.getClientRects().length) continue;
                const peerStyle = getComputedStyle(sibling);
                height -= sibling.getBoundingClientRect().height + parseFloat(peerStyle.marginTop) + parseFloat(peerStyle.marginBottom) + (parseFloat(containerStyle.rowGap) || 0);
            }
        }
        const available = vertical ? height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom) - (actions ? actions.getBoundingClientRect().height + toggleGap : 0) + .001
            : host.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        if (vertical && child?.items.length && active) {
            const last = child.items.at(-1)!;
            let needed = widths.reduce((sum, size) => sum + size, 0) + gap * (items.length - 1)
                + Math.max(0, layoutTop(last) + last.getBoundingClientRect().height - child.visible.getBoundingClientRect().bottom);
            let end = items.length;
            // Only overflow later desktops when they would take space needed by the windows.
            while (end > items.indexOf(active) + 2 && needed > available) needed -= widths[--end] + gap;
            candidates = items.slice(0, end);
            visible.replaceChildren(...candidates);
            widths = candidates.map(item => item.getBoundingClientRect().height);
        }
        if (vertical && widths.reduce((sum, size) => sum + size, 0) + gap * Math.max(0, candidates.length - 1) > available) {
            more.hidden = false;
            widths = candidates.map(item => item.getBoundingClientRect().height);
        }
        const toggleSize = actions ? 0 : vertical ? more.getBoundingClientRect().height : more.offsetWidth;
        const count = fittingHeaderItemCount(widths, available, toggleSize, gap);
        const kept = new Set(candidates.slice(0, count));
        const priority = active ? [active] : [];
        const following = active && vertical && host.classList.contains('workspace-tabs') ? items[items.indexOf(active) + 1] : undefined;
        if (following) priority.push(following);
        for (const item of priority) if (!kept.has(item)) {
            let used = [...kept].reduce((sum, item) => sum + widths[items.indexOf(item)] + gap, 0);
            const reserve = actions ? 0 : toggleSize + toggleGap;
            while (kept.size && used + widths[items.indexOf(item)] + reserve > available) {
                const last = [...kept].reverse().find(item => !priority.includes(item));
                if (!last) break;
                kept.delete(last); used -= widths[items.indexOf(last)] + gap;
            }
            if (used + widths[items.indexOf(item)] + reserve <= available) kept.add(item);
        }
        visible.replaceChildren(...items.filter(item => kept.has(item)));
        menu.replaceChildren(...items.filter(item => !kept.has(item)));
        more.hidden = kept.size === items.length;
        if (vertical) child?.fit(true);
        bound = [...items];
        if (focused && document.activeElement !== focused) (focused.checkVisibility() ? focused : child?.items.some(item => item.contains(focused)) ? child.more : more).focus({ preventScroll: true });
    }
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => {
        const nested = host.querySelector<HTMLElement>('.vertical-tabs');
        if ((!menu.matches(':popover-open') && !(nested && strips.get(nested)?.menu.matches(':popover-open'))) || bound.length !== items.length || items.some(item => !bound.includes(item))) fit();
    }); };
    const observer = new ResizeObserver(schedule);
    menu.addEventListener('toggle', schedule);
    window.addEventListener('tuxee-tabs-changed', schedule);
    observer.observe(host); observer.observe(host.parentElement!);
    if (vertical) for (let sibling = host.nextElementSibling; sibling; sibling = sibling.nextElementSibling) observer.observe(sibling);
    fit();
    return () => { dragging?.dispose(); strips.delete(host); observer.disconnect(); menu.removeEventListener('toggle', schedule); window.removeEventListener('tuxee-tabs-changed', schedule); cancelAnimationFrame(frame); close(); };
}

function reorderTabs(items: HTMLElement[], more: HTMLElement, visible: HTMLElement, menu: HTMLElement, changed: () => void) {
    const events = new AbortController(), signal = events.signal;
    let cancel = () => {}, suppressClick = false;
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
        const verticalBar = visible.parentElement!.classList.contains('vertical-tabs');
        handle.setAttribute('aria-keyshortcuts', verticalBar ? 'Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight' : 'Alt+ArrowLeft Alt+ArrowRight');
        handle.setAttribute('aria-description', t("overflow.dragToReorderOrPressAltLeftOrAltRight"));
        handle.addEventListener('dragstart', event => event.preventDefault(), { signal });
        handle.addEventListener('keydown', event => {
            if (!event.altKey || !(verticalBar ? ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'] : ['ArrowLeft', 'ArrowRight']).includes(event.key)) return;
            event.preventDefault(); cancel();
            const rtl = !verticalBar && !!item.closest('.visible-tabs') && getComputedStyle(item).direction === 'rtl';
            const index = items.indexOf(item) + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1) * (rtl ? -1 : 1);
            if (index < 0 || index >= items.length) return;
            move(item, index);
            (item.closest('.visible-tabs') ? handle : more).focus();
        }, { signal });
        handle.addEventListener('pointerdown', event => {
            if (!event.isPrimary || event.button !== 0) return;
            cancel();
            const parent = item.parentElement!, siblings = [...parent.children] as HTMLElement[];
            siblings.forEach(tab => tab.getAnimations().forEach(animation => animation.cancel()));
            const vertical = parent === menu || verticalBar, rtl = !vertical && getComputedStyle(parent).direction === 'rtl';
            if (rtl) siblings.reverse();
            const axis = vertical ? 'y' : 'x', size = vertical ? 'height' : 'width';
            const rects = new Map(siblings.map(tab => [tab, tab.getBoundingClientRect()]));
            let original = rects.get(item)!, first = rects.get(siblings[0])!, last = rects.get(siblings.at(-1)!)!;
            const gesture = new AbortController(), signal = gesture.signal, capture = visible.parentElement!;
            let preview: ReturnType<typeof tabDrag> | undefined, destination: number | undefined;
            const targets = new Map<HTMLElement, Map<HTMLElement, DOMRect>>();
            const bar = more.closest<HTMLElement>('.window-bar');
            function finish(commit = false) {
                gesture.abort(); cancel = () => {};
                if (capture.hasPointerCapture(event.pointerId)) capture.releasePointerCapture(event.pointerId);
                if (!preview) return;
                const released = preview.rect();
                preview.dispose();
                if (commit && destination !== undefined) move(item, destination);
                if (item.checkVisibility()) animateTab(item, released);
            }
            cancel = () => finish();
            window.addEventListener('pointermove', e => {
                if (e.pointerId !== event.pointerId) return;
                const inside = (node: HTMLElement, margin = 0) => {
                    const r = node.getBoundingClientRect();
                    return node.checkVisibility() && e.clientX >= r.left - margin && e.clientX < r.right + margin && e.clientY >= r.top - margin && e.clientY < r.bottom + margin;
                };
                const bounds = bar?.getBoundingClientRect();
                // Keep diagonal paths from an overflow entry to the bar inside the reorder gesture.
                const progress = bounds && parent === menu ? (event.clientY - e.clientY) / (event.clientY - bounds.bottom) : -1;
                const towardBar = bounds && progress >= 0 && progress <= 1 &&
                    e.clientX >= event.clientX + (bounds.left - event.clientX) * progress - 4 &&
                    e.clientX <= event.clientX + (bounds.right - event.clientX) * progress + 4;
                if (bar && !inside(bar) && !inside(menu, 4) && !towardBar) { finish(); return; }
                if (!preview) {
                    if (Math.hypot(e.clientX - event.clientX, e.clientY - event.clientY) < 5) return;
                    suppressClick = true; capture.setPointerCapture(event.pointerId);
                    preview = tabDrag(item, visible, menu, event);
                    if (item.querySelector(':scope > .window-bar')) {
                        siblings.forEach(tab => rects.set(tab, tab.getBoundingClientRect()));
                        original = rects.get(item)!; first = rects.get(siblings[0])!; last = rects.get(siblings.at(-1)!)!;
                    }
                }
                e.preventDefault();
                if (inside(more) && !menu.matches(':popover-open')) { more.click(); preview.raise(); }
                const target = inside(menu, 4) ? menu : inside(bar || visible) ? visible : undefined;
                destination = undefined;
                if (target) {
                    let next: HTMLElement | undefined;
                    if (target === parent) {
                        const delta = vertical ? e.clientY - event.clientY : e.clientX - event.clientX;
                        const offset = Math.max(first[axis] - original[axis], Math.min(delta, last[axis] + last[size] - original[axis] - original[size]));
                        const start = original[axis] + offset, end = start + original[size];
                        const order = siblings.filter(tab => tab !== item);
                        // Fixed facing-edge thresholds keep unequal tabs from oscillating on reversal.
                        const index = order.filter(tab => {
                            const r = rects.get(tab)!, edge = r[axis] < original[axis] ? start : end;
                            return edge > r[axis] + r[size] / 2;
                        }).length;
                        order.splice(index, 0, item);
                        if (rtl) order.reverse();
                        next = order[order.indexOf(item) + 1];
                    } else {
                        if (!targets.has(target)) targets.set(target, new Map([...target.children]
                            .filter(tab => items.includes(tab as HTMLElement) && tab !== item)
                            .map(tab => [tab as HTMLElement, tab.getBoundingClientRect()])));
                        const reversed = target === visible && getComputedStyle(visible).direction === 'rtl';
                        next = [...targets.get(target)!].find(([, r]) => target === menu || verticalBar ? e.clientY < r.y + r.height / 2
                            : reversed ? e.clientX > r.x + r.width / 2 : e.clientX < r.x + r.width / 2)?.[0];
                    }
                    const remaining = items.filter(tab => tab !== item);
                    const previous = [...target.children].filter(tab => remaining.includes(tab as HTMLElement)).at(-1) as HTMLElement | undefined;
                    destination = next ? remaining.indexOf(next) : previous ? remaining.indexOf(previous) + 1 : 0;
                    preview.place(target, next, e);
                } else preview.follow(e);
            }, { signal, passive: false, capture: true });
            window.addEventListener('pointerup', e => { if (e.pointerId === event.pointerId) finish(true); }, { signal });
            window.addEventListener('pointercancel', cancel, { signal });
            capture.addEventListener('lostpointercapture', cancel, { signal });
            window.addEventListener('blur', cancel, { signal });
            window.addEventListener('resize', cancel, { signal });
            window.addEventListener('scroll', cancel, { signal, capture: true });
            document.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); cancel(); } }, { signal, capture: true });
        }, { signal });
    }
    return { cancel: () => cancel(), dispose: () => { cancel(); events.abort(); } };
}

const dragDuration = () => matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180;
function animateTab(tab: HTMLElement, from: DOMRect) {
    tab.getAnimations().forEach(animation => animation.cancel());
    const to = tab.getBoundingClientRect();
    if (!from.width || !to.width || (from.x === to.x && from.y === to.y)) return;
    tab.animate([{ transform: `translate(${from.x - to.x}px, ${from.y - to.y}px)` }, { transform: 'none' }],
        { duration: dragDuration(), easing: 'cubic-bezier(.2,.7,.2,1)' });
}

// The real tab reserves its destination space; only its inert chrome is copied into the top layer.
function tabDrag(item: HTMLElement, visible: HTMLElement, menu: HTMLElement, point: { clientX: number; clientY: number }, from?: DOMRect) {
    const parent = item.parentElement, next = item.nextSibling, hidden = item.hidden, host = visible.parentElement!;
    const originals = new Set([...visible.children, ...menu.children] as HTMLElement[]);
    const properties: [HTMLElement, string][] = [[host, 'flex'], [visible, 'flex'], [menu, 'width'], [menu, 'min-height']];
    const styles = properties.map(([node, property]) => ({ node, property, value: node.style.getPropertyValue(property) }));
    const dimension = host.classList.contains('vertical-tabs') ? 'height' : 'width';
    // Only incoming rows grow vertical lists; existing tabs keep stable bounds through handoff and reentry.
    if (dimension === 'width' || originals.has(item)) {
        host.style.flex = `0 0 ${host.getBoundingClientRect()[dimension]}px`;
        visible.style.flex = `0 0 ${visible.getBoundingClientRect()[dimension] || (dimension === 'width' ? host.clientWidth : host.clientHeight)}px`;
    }
    const windows = item.querySelector<HTMLElement>(':scope > .window-bar'), windowsHidden = windows?.hidden;
    if (windows) windows.hidden = true;
    from ||= item.getBoundingClientRect();
    const preview = el('div', 'tab-drag-preview'), copy = item.cloneNode(true) as HTMLElement;
    copy.querySelector(':scope > .window-bar')?.remove();
    for (const node of [copy, ...copy.querySelectorAll('*')]) for (const attr of [...node.attributes]) {
        if (attr.name === 'id' || attr.name.startsWith('data-') || ['aria-controls', 'aria-labelledby', 'aria-describedby'].includes(attr.name)) node.removeAttribute(attr.name);
    }
    copy.classList.add('tab-dragging'); preview.append(copy);
    preview.inert = true; preview.setAttribute('aria-hidden', 'true'); preview.popover = 'manual';
    const gripX = from.width ? Math.max(0, Math.min(1, (point.clientX - from.x) / from.width)) : .5;
    const gripY = from.height ? Math.max(0, Math.min(1, (point.clientY - from.y) / from.height)) : .5;
    preview.style.transform = `translate(${-gripX * 100}%, ${-gripY * 100}%)`;
    host.classList.add('tab-drag-host');
    originals.forEach(tab => tab.classList.add('tab-shifting'));
    item.classList.add('tab-placeholder', 'tab-dragging');
    let zone: HTMLElement | undefined, morph: Animation | undefined;
    const positions = () => new Map([...originals].filter(tab => tab !== item && tab.checkVisibility()).map(tab => [tab, tab.getBoundingClientRect()]));
    const slide = (before: Map<HTMLElement, DOMRect>) => before.forEach((rect, tab) => { if (tab.checkVisibility()) animateTab(tab, rect); });
    const follow = (p: { clientX: number; clientY: number }) => {
        preview.style.left = `${p.clientX}px`; preview.style.top = `${p.clientY}px`;
    };
    function place(target: HTMLElement, before: HTMLElement | undefined, p: { clientX: number; clientY: number }, floating = false) {
        const previous = zone ? preview.getBoundingClientRect() : from;
        if (target === menu && !menu.style.width) {
            const bounds = menu.getBoundingClientRect();
            menu.style.width = `${bounds.width}px`; menu.style.minHeight = `${bounds.height}px`;
        }
        const anchor = before || (preview.parentElement === target ? preview : null);
        const moved = item.parentElement !== target || item.nextElementSibling !== anchor || item.hidden !== floating;
        const rects = moved ? positions() : new Map<HTMLElement, DOMRect>();
        item.hidden = false;
        if (moved) target.insertBefore(item, anchor);
        const rect = item.getBoundingClientRect();
        item.hidden = floating;
        if (zone !== target) {
            morph?.cancel();
            preview.remove(); target.append(preview); preview.showPopover();
            Object.assign(preview.style, { width: `${rect.width}px`, height: `${rect.height}px` });
            morph = preview.animate([{ width: `${previous.width}px`, height: `${previous.height}px` }, { width: `${rect.width}px`, height: `${rect.height}px` }],
                { duration: dragDuration(), easing: 'cubic-bezier(.2,.7,.2,1)' });
            zone = target;
        }
        follow(p); slide(rects);
    }
    if ((parent === visible || parent === menu) && parent.checkVisibility()) place(parent, next instanceof HTMLElement ? next : undefined, point);
    return { place, follow, float(p: { clientX: number; clientY: number }) { place(visible, undefined, p, true); }, raise() { if (preview.isConnected) { preview.hidePopover(); preview.showPopover(); } }, rect: () => preview.getBoundingClientRect(), dispose() {
        const before = positions();
        morph?.cancel(); preview.remove();
        if (parent) parent.insertBefore(item, next?.parentNode === parent ? next : null); else item.remove();
        item.hidden = hidden;
        if (windows) windows.hidden = windowsHidden!;
        item.classList.remove('tab-placeholder', 'tab-dragging');
        originals.forEach(tab => tab.classList.remove('tab-shifting'));
        styles.forEach(({ node, property, value }) => value ? node.style.setProperty(property, value) : node.style.removeProperty(property));
        host.classList.remove('tab-drag-host'); slide(before);
    } };
}

export function overflowTabDrop(host: HTMLElement, item: HTMLElement, point: PointerEvent, from: DOMRect) {
    const { visible, menu, more } = strips.get(host)!;
    const preview = tabDrag(item, visible, menu, point, from);
    const rects = new Map<HTMLElement, Map<HTMLElement, DOMRect>>();
    return { ...preview, move(p: PointerEvent): HTMLElement | null | undefined {
        const inside = (node: HTMLElement) => {
            const r = node.getBoundingClientRect();
            return node.checkVisibility() && p.clientX >= r.left && p.clientX < r.right && p.clientY >= r.top && p.clientY < r.bottom;
        };
        if (inside(more) && !menu.matches(':popover-open')) { more.click(); preview.raise(); }
        const target = inside(menu) ? menu : inside(host.parentElement!) ? visible : undefined;
        if (!target) return undefined;
        if (!rects.has(target)) rects.set(target, new Map([...target.children]
            .filter(tab => tab !== item && !tab.classList.contains('tab-drag-preview'))
            .map(tab => [tab as HTMLElement, tab.getBoundingClientRect()])));
        const rtl = target === visible && getComputedStyle(visible).direction === 'rtl';
        const before = [...rects.get(target)!].find(([, r]) => target === menu || host.classList.contains('vertical-tabs') ? p.clientY < r.y + r.height / 2
            : rtl ? p.clientX > r.x + r.width / 2 : p.clientX < r.x + r.width / 2)?.[0];
        preview.place(target, before, p);
        return before || null;
    } };
}
