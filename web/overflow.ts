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


export function overflowTabs(host: HTMLElement, items: HTMLElement[], label: string) {
    const visible = el('div', 'visible-tabs'), menu = el('div', 'overflow-tabs');
    let close = () => {}, frame = 0;
    const more = button(label, 'Ellipsis', () => { ({ close } = popover(more, menu)); });
    more.className = 'overflow-toggle'; more.setAttribute('aria-haspopup', 'menu');
    host.append(visible, more);
    function fit() {
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
    observer.observe(host); fit();
    return () => { observer.disconnect(); window.removeEventListener('tuxee-tabs-changed', schedule); cancelAnimationFrame(frame); close(); };
}
