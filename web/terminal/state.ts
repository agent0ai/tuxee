// Shared state boundary for the pinned xterm 6.0 engine. Private engine fields
// are confined here; browser and headless continuation tests qualify this format.
// Snapshots transfer data and never replay historical VT commands.
// deno-lint-ignore-file no-explicit-any
import { Unicode11Addon } from '@xterm/addon-unicode11';

export function installTerminalUnicode(terminal: any): void {
  terminal.loadAddon(new Unicode11Addon());
  terminal.unicode.activeVersion = '11';
}

type Palette = { colors: number[]; defaults: number[] };
export const terminalTheme = Object.freeze({
  background: "#0d1117",
  foreground: "#e6edf3",
  cursor: "#58a6ff",
});
export const MAX_SNAPSHOT_BYTES = 64 << 20;
export const MAX_NORMAL_CELLS = 512_000;
export const MAX_STRING_UNITS = 12 << 20;
export function retainedScrollback(cols: number, rows: number): number {
  return Math.max(
    0,
    Math.min(5000, Math.floor(MAX_NORMAL_CELLS / cols) - rows),
  );
}
const headlessPalettes = new WeakMap<object, Palette>();

function rgba(r: number, g: number, b: number) {
  return ((r << 24) | (g << 16) | (b << 8) | 255) >>> 0;
}

// Headless xterm publishes color requests but has no browser theme service to
// answer them. The terminal owner must supply that state and answer while detached.
export function installHeadlessColors(terminal: any) {
  const colors = [
    "2e3436",
    "cc0000",
    "4e9a06",
    "c4a000",
    "3465a4",
    "75507b",
    "06989a",
    "d3d7cf",
    "555753",
    "ef2929",
    "8ae234",
    "fce94f",
    "729fcf",
    "ad7fa8",
    "34e2e2",
    "eeeeec",
  ].map((hex) => ((parseInt(hex, 16) << 8) | 255) >>> 0);
  const levels = [0, 95, 135, 175, 215, 255];
  for (const r of levels) {
    for (const g of levels) {
      for (const b of levels) colors.push(rgba(r, g, b));
    }
  }
  for (let i = 0; i < 24; i++) {
    colors.push(rgba(8 + i * 10, 8 + i * 10, 8 + i * 10));
  }
  colors.push(rgba(230, 237, 243), rgba(13, 17, 23), rgba(88, 166, 255));
  const palette = { colors, defaults: [...colors] };
  headlessPalettes.set(terminal, palette);
  terminal._core._inputHandler.onColor((requests: any[]) => {
    for (const request of requests) {
      const index = request.index;
      if (request.type === 0) {
        const color = palette.colors[index]!;
        const channels = [
          color >>> 24,
          (color >>> 16) & 255,
          (color >>> 8) & 255,
        ];
        const identifier = index < 256
          ? `4;${index}`
          : String(index - 256 + 10);
        terminal._core.coreService.triggerDataEvent(
          `\x1b]${identifier};rgb:${
            channels.map((x) => (x * 257).toString(16).padStart(4, "0")).join(
              "/",
            )
          }\x1b\\`,
        );
      } else if (request.type === 1) {
        palette.colors[index] = rgba(
          request.color[0],
          request.color[1],
          request.color[2],
        );
      } else if (request.type === 2) {
        if (index === undefined) {
          palette.colors.splice(0, 256, ...palette.defaults.slice(0, 256));
        } else palette.colors[index] = palette.defaults[index]!;
      }
    }
  });
}

function paletteOf(terminal: any): Palette | undefined {
  const palette = headlessPalettes.get(terminal);
  if (palette) {
    return { colors: [...palette.colors], defaults: [...palette.defaults] };
  }
  const theme = terminal._core._themeService;
  if (!theme) return undefined;
  const values = (
    x: any,
  ) => [
    ...x.ansi.map((color: any) => color.rgba),
    x.foreground.rgba,
    x.background.rgba,
    x.cursor.rgba,
  ];
  return {
    colors: values(theme.colors),
    defaults: values(theme._restoreColors),
  };
}

function restorePalette(terminal: any, saved: Palette | undefined) {
  if (!saved) return;
  const palette = headlessPalettes.get(terminal);
  if (palette) {
    palette.colors = [...saved.colors];
    palette.defaults = [...saved.defaults];
    return;
  }
  const theme = terminal._core._themeService;
  if (!theme) throw new Error("terminal palette owner is unavailable");
  const color = (rgba: number) => ({
    rgba,
    css: `#${(rgba >>> 8).toString(16).padStart(6, "0")}`,
  });
  const apply = (target: any, values: number[]) => {
    target.ansi = values.slice(0, 256).map(color);
    target.foreground = color(values[256]!);
    target.background = color(values[257]!);
    target.cursor = color(values[258]!);
  };
  apply(theme._restoreColors, saved.defaults);
  theme.modifyColors((target: any) => apply(target, saved.colors));
}

function attrs(value: any) {
  return {
    fg: value.fg,
    bg: value.bg,
    ext: value.extended._ext,
    url: value.extended._urlId,
  };
}

function restoreAttrs(value: any, saved: any) {
  value.fg = saved.fg;
  value.bg = saved.bg;
  value.extended._ext = saved.ext;
  value.extended._urlId = saved.url;
}

function params(value: any) {
  return {
    params: [...value.params],
    sub: [...value._subParams],
    indices: [...value._subParamsIdx],
    length: value.length,
    subLength: value._subParamsLength,
    rejectDigits: value._rejectDigits,
    rejectSubDigits: value._rejectSubDigits,
    digitIsSub: value._digitIsSub,
  };
}

function restoreParams(value: any, saved: any) {
  value.params.set(saved.params);
  value._subParams.set(saved.sub);
  value._subParamsIdx.set(saved.indices);
  value.length = saved.length;
  value._subParamsLength = saved.subLength;
  value._rejectDigits = saved.rejectDigits;
  value._rejectSubDigits = saved.rejectSubDigits;
  value._digitIsSub = saved.digitIsSub;
}

const geometryKeys = [
  "x",
  "y",
  "ybase",
  "ydisp",
  "scrollTop",
  "scrollBottom",
  "savedX",
  "savedY",
];

function buffer(value: any) {
  return {
    ...JSON.parse(JSON.stringify({
      geometry: Object.fromEntries(geometryKeys.map((key) => [key, value[key]])),
      tabs: value.tabs,
      savedAttrs: attrs(value.savedCurAttrData),
      savedCharset: value.savedCharset,
    })),
    lines: Array.from({ length: value.lines.length }, (_, index) => {
      const line = value.lines.get(index);
      return {
        wrapped: line.isWrapped,
        length: line.length,
        data: Array.prototype.slice.call(line._data, 0, line.length * 3),
        combined: { ...line._combined },
        extended: Object.fromEntries(
          Object.entries(line._extendedAttrs).map((
            [key, a]: [string, any],
          ) => [key, { ext: a._ext, url: a._urlId }]),
        ),
      };
    }),
  };
}

function restoreBuffer(value: any, saved: any, attrTemplate: any) {
  value.clearAllMarkers();
  value.lines.length = 0;
  Object.assign(value, saved.geometry);
  value.tabs = { ...saved.tabs };
  value.savedCharset = saved.savedCharset;
  restoreAttrs(value.savedCurAttrData, saved.savedAttrs);
  for (const line of saved.lines) {
    const restored = value.getBlankLine(attrTemplate, line.wrapped);
    restored.length = line.length;
    restored._data = new Uint32Array(line.data);
    restored._combined = { ...line.combined };
    restored._extendedAttrs = {};
    for (
      const [key, data] of Object.entries(line.extended) as [string, any][]
    ) {
      const extended = attrTemplate.extended.clone();
      extended._ext = data.ext;
      extended._urlId = data.url;
      restored._extendedAttrs[key] = extended;
    }
    value.lines.push(restored);
  }
}

function handlers(value: any[]) {
  return value.map((handler) => ({
    data: handler._data,
    hitLimit: handler._hitLimit,
    ...(handler._params ? { params: params(handler._params) } : {}),
  }));
}

function restoreHandlers(value: any[], saved: any[]) {
  if (value.length !== saved.length) {
    throw new Error("xterm parser handlers differ");
  }
  value.forEach((handler, index) => {
    handler._data = saved[index].data;
    handler._hitLimit = saved[index].hitLimit;
    if (saved[index].params) {
      handler._params = handler._params.clone();
      restoreParams(handler._params, saved[index].params);
    }
  });
}

export function captureTerminal(terminal: any) {
  const c = terminal._core;
  const b = c._bufferService.buffers;
  const h = c._inputHandler;
  const p = h._parser;
  if (
    p._oscParser._stack.paused || p._dcsParser._stack.paused ||
    h._parseStack.paused
  ) {
    throw new Error("flush xterm writes before capturing state");
  }
  const charset = c._charsetService;
  const snapshot = {
    version: "the8020.xterm-6.0.0.2",
    cols: terminal.cols,
    rows: terminal.rows,
    scrollback: terminal.options.scrollback,
    normal: buffer(b.normal),
    alternate: buffer(b.alt),
    active: b.active === b.alt ? "alternate" : "normal",
    modes: c.coreService.modes,
    decModes: c.coreService.decPrivateModes,
    hidden: c.coreService.isCursorHidden,
    initialized: c.coreService.isCursorInitialized,
    cursorStyle: terminal.options.cursorStyle,
    cursorBlink: terminal.options.cursorBlink,
    palette: paletteOf(terminal),
    charset: {
      glevel: charset.glevel,
      charset: charset.charset,
      charsets: charset._charsets,
    },
    mouse: {
      protocol: c.coreMouseService.activeProtocol,
      encoding: c.coreMouseService.activeEncoding,
    },
    attr: attrs(h._curAttrData),
    erase: attrs(h._eraseAttrDataInternal),
    title: h._windowTitle,
    icon: h._iconName,
    titles: h._windowTitleStack,
    icons: h._iconNameStack,
    stringInterim: h._stringDecoder._interim,
    utf8Interim: [...h._utf8Decoder.interim],
    parser: {
      state: p.currentState,
      initial: p.initialState,
      collect: p._collect,
      preceding: p.precedingJoinState,
      params: params(p._params),
      osc: {
        id: p._oscParser._id,
        state: p._oscParser._state,
        active: handlers(p._oscParser._active),
      },
      dcs: { id: p._dcsParser._ident, active: handlers(p._dcsParser._active) },
    },
    links: [...c._oscLinkService._dataByLinkId.values()].map((entry: any) => ({
      id: entry.id,
      key: entry.key,
      data: entry.data,
      lines: entry.lines.map((marker: any) => ({
        buffer: b.normal.markers.includes(marker) ? "normal" : "alternate",
        line: marker.line,
      })),
    })),
    nextLinkId: c._oscLinkService._nextId,
  };
  // Cell arrays are already detached; JSON-copy the remaining engine metadata.
  const { normal, alternate, ...metadata } = snapshot;
  const result = { ...JSON.parse(JSON.stringify(metadata)), normal, alternate };
  validateSnapshot(result);
  return result;
}

export function restoreTerminal(terminal: any, snapshot: any) {
  validateSnapshot(snapshot);
  if (snapshot.version !== "the8020.xterm-6.0.0.2") {
    throw new Error("unknown state version");
  }
  terminal.options.scrollback = snapshot.scrollback;
  terminal.resize(snapshot.cols, snapshot.rows);
  terminal.reset();
  const c = terminal._core;
  const b = c._bufferService.buffers;
  const h = c._inputHandler;
  restoreBuffer(b.normal, snapshot.normal, h._curAttrData);
  restoreBuffer(b.alt, snapshot.alternate, h._curAttrData);
  const before = b.active;
  b._activeBuffer = snapshot.active === "alternate" ? b.alt : b.normal;
  b._onBufferActivate.fire({ activeBuffer: b.active, inactiveBuffer: before });
  c.coreService.modes = { ...snapshot.modes };
  c.coreService.decPrivateModes = { ...snapshot.decModes };
  c.coreService.isCursorHidden = snapshot.hidden;
  c.coreService.isCursorInitialized = snapshot.initialized;
  terminal.options.cursorStyle = snapshot.cursorStyle;
  terminal.options.cursorBlink = snapshot.cursorBlink;
  restorePalette(terminal, snapshot.palette);
  c._charsetService.glevel = snapshot.charset.glevel;
  c._charsetService.charset = snapshot.charset.charset;
  c._charsetService._charsets = snapshot.charset.charsets;
  c.coreMouseService.activeProtocol = snapshot.mouse.protocol;
  c.coreMouseService.activeEncoding = snapshot.mouse.encoding;
  restoreAttrs(h._curAttrData, snapshot.attr);
  restoreAttrs(h._eraseAttrDataInternal, snapshot.erase);
  h._windowTitle = snapshot.title;
  h._iconName = snapshot.icon;
  h._windowTitleStack = [...snapshot.titles];
  h._iconNameStack = [...snapshot.icons];
  h._stringDecoder._interim = snapshot.stringInterim;
  h._utf8Decoder.interim.set(snapshot.utf8Interim);
  const p = h._parser;
  p.currentState = snapshot.parser.state;
  p.initialState = snapshot.parser.initial;
  p._collect = snapshot.parser.collect;
  p.precedingJoinState = snapshot.parser.preceding;
  restoreParams(p._params, snapshot.parser.params);
  const osc = snapshot.parser.osc;
  p._oscParser._id = osc.id;
  p._oscParser._state = osc.state;
  p._oscParser._active = osc.active.length
    ? p._oscParser._handlers[osc.id] ?? []
    : [];
  restoreHandlers(p._oscParser._active, osc.active);
  const dcs = snapshot.parser.dcs;
  p._dcsParser._ident = dcs.id;
  p._dcsParser._active = dcs.active.length
    ? p._dcsParser._handlers[dcs.id] ?? []
    : [];
  restoreHandlers(p._dcsParser._active, dcs.active);
  const links = c._oscLinkService;
  links._dataByLinkId.clear();
  links._entriesWithId.clear();
  links._nextId = snapshot.nextLinkId;
  for (const saved of snapshot.links) {
    const entry = {
      id: saved.id,
      key: saved.key,
      data: saved.data,
      lines: [] as any[],
    };
    links._dataByLinkId.set(entry.id, entry);
    if (entry.key !== undefined) links._entriesWithId.set(entry.key, entry);
    for (const line of saved.lines) {
      const owner = line.buffer === "normal" ? b.normal : b.alt;
      const marker = owner.addMarker(line.line);
      entry.lines.push(marker);
      marker.onDispose(() => links._removeMarkerFromLink(entry, marker));
    }
  }
  // Install the restored scroll range before input or rendering sees the view.
  c._viewport?._sync();
  terminal.refresh?.(0, terminal.rows - 1);
}

// This boundary accepts only bounded JSON data, never objects with behavior.
// Detailed engine access is intentionally confined to this versioned module.
export function validateSnapshot(snapshot: any): void {
  let nodes = 0;
  let strings = 0;
  const cellArrays = new Set<any[]>();
  const walk = (value: any, depth: number): void => {
    if (++nodes > 3_000_000 || depth > 32) {
      throw new Error("terminal state exceeds structural bounds");
    }
    if (typeof value === "string") {
      strings += value.length;
      if (strings > MAX_STRING_UNITS) {
        throw new Error("terminal state exceeds text bounds");
      }
    } else if (typeof value === "number") {
      if (!Number.isSafeInteger(value)) {
        throw new Error("invalid terminal state number");
      }
    } else if (value !== null && typeof value === "object") {
      if (Array.isArray(value)) {
        if (cellArrays.has(value)) {
          // Cells are already validated; retain their structural budget.
          nodes += value.length;
          if (nodes > 3_000_000 || (value.length && depth + 1 > 32)) {
            throw new Error("terminal state exceeds structural bounds");
          }
        } else for (const item of value) walk(item, depth + 1);
      } else {
        if (Object.getPrototypeOf(value) !== Object.prototype) {
          throw new Error("terminal state must be plain JSON");
        }
        for (const key of Object.keys(value)) {
          if (
            key === "__proto__" || key === "constructor" || key === "prototype"
          ) throw new Error("invalid terminal state key");
          walk(value[key], depth + 1);
        }
      }
    } else if (value !== null && typeof value !== "boolean") {
      throw new Error("terminal state must contain only JSON values");
    }
  };
  const integer = (n: any, min: number, max: number): boolean =>
    Number.isSafeInteger(n) && n >= min && n <= max;
  if (
    snapshot?.version !== "the8020.xterm-6.0.0.2" ||
    !integer(snapshot.cols, 2, 500) || !integer(snapshot.rows, 1, 200) ||
    !integer(
      snapshot.scrollback,
      0,
      retainedScrollback(snapshot.cols, snapshot.rows),
    ) ||
    !["normal", "alternate"].includes(snapshot.active)
  ) throw new Error("invalid terminal state geometry or version");
  for (
    const [name, value] of [["normal", snapshot.normal], [
      "alternate",
      snapshot.alternate,
    ]] as const
  ) {
    const lineLimit = snapshot.rows +
      (name === "normal" ? snapshot.scrollback : 0);
    if (
      !Array.isArray(value?.lines) || value.lines.length > lineLimit ||
      Object.keys(value.geometry).sort().join() !==
        [...geometryKeys].sort().join()
    ) throw new Error("invalid terminal buffer");
    for (const [key, n] of Object.entries(value.geometry)) {
      if (!integer(n, 0, key === "x" || key === "savedX" ? 500 : 5200)) {
        throw new Error("invalid terminal cursor or margins");
      }
    }
    for (const line of value.lines) {
      if (
        !integer(line.length, 0, 500) || !Array.isArray(line.data) ||
        line.data.length !== line.length * 3 ||
        typeof line.wrapped !== "boolean"
      ) throw new Error("invalid terminal line");
      const data = line.data;
      for (let index = 0; index < data.length; index++) {
        const n = data[index];
        // Exact uint32 values only; indexed reads also reject sparse entries.
        if ((n >>> 0) !== n) throw new Error("invalid terminal line");
      }
      cellArrays.add(data);
      for (const [key, text] of Object.entries(line.combined)) {
        if (
          !/^\d+$/.test(key) || !integer(Number(key), 0, 499) ||
          typeof text !== "string"
        ) throw new Error("invalid terminal combined text");
      }
      for (
        const [key, attr] of Object.entries(line.extended) as [string, any][]
      ) {
        if (
          !/^\d+$/.test(key) || !integer(Number(key), 0, 499) ||
          !integer(attr.ext, 0, 0xffff_ffff) ||
          !integer(attr.url, 0, Number.MAX_SAFE_INTEGER)
        ) throw new Error("invalid terminal attributes");
      }
    }
  }
  if (
    !Array.isArray(snapshot.links) || snapshot.links.length > 32_768 ||
    snapshot.utf8Interim?.length !== 3 ||
    snapshot.palette?.colors.length !== 259 ||
    snapshot.palette?.defaults.length !== 259
  ) throw new Error("invalid terminal parser or palette state");
  walk(snapshot, 0);
}

// Bound retained variable-width strings as well as cells. Called after bounded
// output batches, never by an idle timer or a browser's consumption rate.
export function checkEngineTextBounds(terminal: any): void {
  const c = terminal._core;
  if (c._oscLinkService._dataByLinkId.size > 32_768) {
    throw new Error("terminal hyperlink limit exceeded");
  }
  let units = 0;
  for (
    const b of [c._bufferService.buffers.normal, c._bufferService.buffers.alt]
  ) {
    for (let i = 0; i < b.lines.length; i++) {
      const combined = b.lines.get(i)._combined;
      for (const key in combined) units += combined[key].length;
    }
  }
  for (const entry of c._oscLinkService._dataByLinkId.values()) {
    units += (entry.data.uri?.length ?? 0) + (entry.data.id?.length ?? 0);
  }
  const h = c._inputHandler;
  units += h._windowTitle.length + h._iconName.length;
  for (const text of [...h._windowTitleStack, ...h._iconNameStack]) {
    units += text.length;
  }
  for (
    const handler of [
      ...h._parser._oscParser._active,
      ...h._parser._dcsParser._active,
    ]
  ) units += handler._data?.length ?? 0;
  if (units > MAX_STRING_UNITS) {
    throw new Error("terminal retained text limit exceeded");
  }
}

/** Keep the pinned DOM renderer's text and block geometry on the cell grid. */
export function installTerminalMetrics(terminal: any): void {
  const renderer = terminal._core._renderService._renderer.value;
  const cache = renderer._widthCache;
  cache._measure = (text: string, variant: number) => {
    const element = cache._measureElements[variant];
    element.textContent = text.repeat(32);
    // offsetWidth rounds the entire run; that error accumulates across a terminal row.
    return (parseFloat(element.ownerDocument.defaultView.getComputedStyle(element).width) || 0) / 32;
  };
  renderer.handleCharSizeChanged();
  const factory = renderer._rowFactory;
  const createRow = factory.createRow;
  factory.createRow = function (...args: any[]): HTMLSpanElement[] {
    const cellWidth = args[7];
    return createRow.apply(this, args).flatMap((span: HTMLSpanElement) => {
      const text = span.textContent || '';
      if (!/[\u2580-\u259f]/u.test(text)) return [span];
      return text.match(/([\u2580-\u259f])\1*|[^\u2580-\u259f]+/gu)!.map(part => {
        const node = span.cloneNode(false) as HTMLSpanElement;
        node.textContent = part;
        const code = part.charCodeAt(0);
        if (code >= 0x2580 && code <= 0x259f) {
          node.style.width = `${part.length * cellWidth}px`;
          node.style.letterSpacing = '0';
          // Keep selectable text and its foreground; draw geometry independently of font ink bounds.
          node.style.webkitTextFillColor = 'transparent';
          if (code === 0x2588) node.style.backgroundColor = 'currentColor';
          else node.style.backgroundImage = blockBackground(code);
          node.style.backgroundSize = code >= 0x2591 && code <= 0x2593 ? '2px 2px' : `${cellWidth}px 100%`;
          node.style.backgroundRepeat = 'repeat';
        }
        return node;
      });
    });
  };
}

function blockBackground(code: number): string {
  const band = (direction: string, percent: number) =>
    `linear-gradient(to ${direction}, currentColor ${percent}%, transparent ${percent}%)`;
  if (code === 0x2580) return band('bottom', 50);
  if (code <= 0x2588) return band('top', (code - 0x2580) * 12.5);
  if (code <= 0x258f) return band('right', (0x2590 - code) * 12.5);
  if (code === 0x2590) return band('left', 50);
  if (code <= 0x2593) return `conic-gradient(currentColor ${(code - 0x2590) * 25}%, transparent 0)`;
  if (code === 0x2594) return band('bottom', 12.5);
  if (code === 0x2595) return band('left', 12.5);
  const quadrants = [4, 8, 1, 13, 9, 7, 11, 2, 6, 14][code - 0x2596];
  return `conic-gradient(${[2, 8, 4, 1].map((bit, i) => `${quadrants & bit ? 'currentColor' : 'transparent'} ${i * 25}% ${(i + 1) * 25}%`).join(',')})`;
}

/** Use the full content box: xterm's scrollbar overlays the terminal grid. */
export function terminalDimensions(terminal: any): { cols: number; rows: number } | undefined {
  const element = terminal.element as HTMLElement | undefined;
  if (!element) return;
  const { width, height } = terminal._core._renderService.dimensions.css.cell;
  if (!width || !height) return;
  const style = element.ownerDocument.defaultView!.getComputedStyle(element);
  return {
    cols: Math.max(2, Math.floor((element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)) / width)),
    rows: Math.max(1, Math.floor((element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)) / height)),
  };
}

/** Match xterm's renderer timeout: subsequent writes no longer defer painting. */
export function endSynchronizedOutput(terminal: any): void {
  terminal._core.coreService.decPrivateModes.synchronizedOutput = false;
}

/** Observe the parsed frame end before later bytes mutate the completed display. */
export function onSynchronizedOutputEnd(
  terminal: any,
  callback: () => void,
): () => void {
  const input = terminal._core._inputHandler;
  const core = terminal._core.coreService;
  const reset = input.resetModePrivate;
  input.resetModePrivate = function (...args: any[]) {
    const result = reset.apply(this, args);
    // The renderer's timeout may have cleared the mode before the actual end arrives.
    if (args[0].params.subarray(0, args[0].length).includes(2026) && !core.decPrivateModes.synchronizedOutput) callback();
    return result;
  };
  return () => {
    input.resetModePrivate = reset;
  };
}

/** Keep the existing DOM and scrollbar stable while a resize redraw is parsed. */
export function installTerminalResize(terminal: any): { begin(): void; release(): void } {
  const core = terminal._core, render = core._renderService;
  const renderer = render._renderer.value, viewport = core._viewport;
  let held = false, synchronized = false;
  let expires = 0;
  let quiet: ReturnType<typeof setTimeout>, deadline: ReturnType<typeof setTimeout>;
  const originals = ["renderRows", "handleResize", "clear"].map(name => {
    const original = renderer[name];
    renderer[name] = (...args: any[]) => { if (!held) return original.apply(renderer, args); };
    return { name, original };
  });
  const sync = viewport._sync;
  viewport._sync = (...args: any[]) => { if (!held) return sync.apply(viewport, args); };
  const present = () => {
    if (!held) return;
    held = false;
    clearTimeout(quiet); clearTimeout(deadline);
    render.handleResize(terminal.cols, terminal.rows);
    viewport._latestYDisp = undefined;
    viewport._sync();
    terminal.refresh(0, terminal.rows - 1);
    if (!render._isPaused) {
      render._renderDebouncer.dispose();
      render._renderDebouncer._innerRefresh();
    }
  };
  const release = () => { expires = 0; present(); };
  // Scroll-on-input runs before onData; it must see the rebuilt scrollbar range.
  const scrolling = ["scrollLines", "scrollToLine"].map(name => {
    const original = viewport[name];
    viewport[name] = (...args: any[]) => { release(); return original.apply(viewport, args); };
    return { name, original };
  });
  const hold = () => {
    if (held || performance.now() >= expires) return;
    held = true;
    synchronized = terminal.modes.synchronizedOutputMode;
    deadline = setTimeout(release, expires - performance.now());
    if (!synchronized) quiet = setTimeout(present, 300);
  };
  core._register(terminal.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params: number[]) => {
    if (params.includes(2026)) {
      hold();
      if (held) { synchronized = true; clearTimeout(quiet); }
    }
    return false;
  }));
  core._register(terminal.parser.registerCsiHandler({ final: "J" }, (params: number[]) => {
    // Transcript formatting can finish after the initial silent-resize grace period.
    if (params[0] === 3) hold();
    return false;
  }));
  const stop = onSynchronizedOutputEnd(terminal, present);
  core._register(terminal.onWriteParsed(() => {
    if (held && !synchronized) {
      clearTimeout(quiet);
      quiet = setTimeout(present, 120);
    }
  }));
  core._register({ dispose() {
    clearTimeout(quiet); clearTimeout(deadline); stop();
    for (const { name, original } of originals) renderer[name] = original;
    for (const { name, original } of scrolling) viewport[name] = original;
    viewport._sync = sync;
  } });
  return {
    begin() {
      expires = performance.now() + 5000;
      hold();
    },
    release,
  };
}

// Query responses originate synchronously in xterm's parser. Suppress only that
// origin in a view: keyboard, paste, focus, and mouse events outside parsing keep
// their ordinary xterm encoding. The canonical headless owner answers queries.
export function installTerminalView(terminal: any): void {
  const theme = terminal._core._themeService;
  // Whole rows leave spare pixels; paint the entire surface with the active palette.
  const paintBackground = () => terminal.element.style.backgroundColor = theme.colors.background.css;
  paintBackground();
  terminal._core._register(theme.onChangeColors(paintBackground));
  onSynchronizedOutputEnd(terminal, () => {
    const render = terminal._core._renderService;
    if (!render || render._isPaused) return;
    // DEC 2026 reset already queued the completed rows. Flush that render now:
    // the next begin marker can otherwise suppress its animation frame forever.
    render._renderDebouncer.dispose();
    render._renderDebouncer._innerRefresh();
  });
  const handler = terminal._core._inputHandler;
  const core = terminal._core.coreService;
  const parse = handler.parse.bind(handler);
  const send = core.triggerDataEvent.bind(core);
  let parsing = false;
  handler.parse = (...args: any[]) => {
    parsing = true;
    try {
      return parse(...args);
    } finally {
      parsing = false;
    }
  };
  core.triggerDataEvent = (...args: any[]) => {
    if (!parsing) send(...args);
  };
}
