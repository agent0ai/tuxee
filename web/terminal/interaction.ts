import type { Terminal } from '@xterm/xterm';

export function installTerminalTouch(terminal: Terminal, signal: AbortSignal) {
    const screen = terminal.element!.querySelector<HTMLElement>('.xterm-screen')!;
    let previous: Touch | undefined, dragging = false, remainder = 0;
    screen.addEventListener('touchstart', event => {
        previous = event.touches.length === 1 ? event.touches[0] : undefined;
        dragging = false;
        remainder = 0;
    }, { passive: true, signal });
    screen.addEventListener('touchmove', event => {
        if (event.touches.length !== 1) { previous = undefined; return; }
        if (!previous) return;
        const touch = event.touches[0], deltaY = previous.clientY - touch.clientY;
        if (!dragging && Math.abs(deltaY) < 8) return;
        dragging = true;
        event.preventDefault();
        // shortcut: xterm 6 lacks touch scrolling; retire this bridge with its upstream fix.
        const mouse = terminal.modes.mouseTrackingMode;
        if (terminal.buffer.active.type === 'normal' && (mouse === 'none' || mouse === 'x10')) {
            const lineHeight = screen.getBoundingClientRect().height / terminal.rows;
            remainder += deltaY;
            const lines = Math.trunc(remainder / lineHeight);
            terminal.scrollLines(lines);
            remainder -= lines * lineHeight;
        } else {
            // Keep xterm's application mouse encoding and alternate-screen cursor-key behavior.
            screen.dispatchEvent(new WheelEvent('wheel', {
                bubbles: true, cancelable: true, deltaY, clientX: touch.clientX, clientY: touch.clientY,
            }));
        }
        previous = touch;
    }, { passive: false, signal });
    for (const type of ['touchend', 'touchcancel']) {
        screen.addEventListener(type, () => { previous = undefined; }, { signal });
    }
}
