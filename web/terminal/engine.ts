// Package runtime imports retain explicit versions under the generic import map.
// deno-lint-ignore no-import-prefix
import headless from "@xterm/headless";
type TerminalSize = { columns: number; rows: number };
type TerminalEvent = { data?: Uint8Array; size?: TerminalSize };
import {
  captureTerminal,
  checkEngineTextBounds,
  installHeadlessColors,
  installTerminalUnicode,
  retainedScrollback,
  terminalTheme,
} from "./state.ts";

const { Terminal } = headless;
const encoder = new TextEncoder();

/** One canonical interpreter; snapshots and application share this write queue. */
export class TerminalEngine {
  readonly terminal: InstanceType<typeof Terminal>;
  #pending: Promise<void> = Promise.resolve();
  #reply: string[] = [];
  #replyBytes = 0;
  #checkedBytes = 0;
  #closed = false;

  constructor(size: TerminalSize) {
    this.terminal = new Terminal({
      cols: size.columns,
      rows: size.rows,
      scrollback: retainedScrollback(size.columns, size.rows),
      allowProposedApi: true,
      theme: terminalTheme,
    });
    installTerminalUnicode(this.terminal);
    installHeadlessColors(this.terminal);
    this.terminal.onData((data) => {
      this.#replyBytes += data.length;
      if (this.#replyBytes <= 65_536) this.#reply.push(data);
    });
  }

  #ordered<T>(action: () => Promise<T> | T): Promise<T> {
    const result = this.#pending.then(() => {
      if (this.#closed) throw new Error("terminal display owner is closed");
      return action();
    });
    this.#pending = result.then(() => {}, () => {});
    return result;
  }

  async apply(event: TerminalEvent): Promise<Uint8Array | undefined> {
    return (await this.applyBatch([event]))[0];
  }

  /** Queue one bounded native read together; xterm owns its parser time slicing. */
  applyBatch(
    events: readonly TerminalEvent[],
  ): Promise<Array<Uint8Array | undefined>> {
    return this.#ordered(async () => {
      const replies = new Array<Uint8Array | undefined>(events.length).fill(
        undefined,
      );
      let pending: Promise<void>[] = [];
      let failure: unknown;
      const flush = async () => {
        await Promise.all(pending);
        pending = [];
        if (failure) throw failure;
      };
      for (let index = 0; index < events.length; index++) {
        const event = events[index]!;
        if (event.size) {
          // A resize must occur after earlier bytes and before later bytes.
          await flush();
          this.terminal.options.scrollback = retainedScrollback(
            event.size.columns,
            event.size.rows,
          );
          this.terminal.resize(event.size.columns, event.size.rows);
        }
        const data = event.data;
        if (data) {
          pending.push(
            new Promise<void>((resolve) => {
              this.terminal.write(data, () => {
                try {
                  this.#checkedBytes += data.length;
                  replies[index] = this.#takeReply();
                } catch (error) {
                  failure ??= error;
                } finally {
                  resolve();
                }
              });
            }),
          );
        }
      }
      await flush();
      return replies;
    });
  }

  #takeReply(): Uint8Array | undefined {
    if (this.#checkedBytes >= 65_536) {
      checkEngineTextBounds(this.terminal);
      this.#checkedBytes = 0;
    }
    if (this.#replyBytes > 65_536) {
      throw new Error("terminal query response limit exceeded");
    }
    const reply = this.#reply.length
      ? encoder.encode(this.#reply.join(""))
      : undefined;
    if (reply && reply.byteLength > 65_536) {
      throw new Error("terminal query response limit exceeded");
    }
    this.#reply = [];
    this.#replyBytes = 0;
    return reply;
  }

  capture(): Promise<ReturnType<typeof captureTerminal>> {
    return this.#ordered(() => captureTerminal(this.terminal));
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#pending;
    this.terminal.dispose();
  }
}
