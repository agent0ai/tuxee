import {TerminalEngine} from './engine';
import {endSynchronizedOutput, setTerminalBackground, terminalArchiveRecorder} from './state';
let engine: TerminalEngine;
let recorder: ReturnType<typeof terminalArchiveRecorder>;
export function init(cols: number, rows: number) {
  engine = new TerminalEngine({columns:cols, rows});
  recorder = terminalArchiveRecorder(engine.terminal, (globalThis as any).__archiveText);
}
function result(reply:number[] = []) {
  return JSON.stringify({reply,synchronized:engine.terminal.modes.synchronizedOutputMode});
}
export async function apply(bytes: number[], columns?:number, rows?:number) {
  const replies = await engine.applyBatch([{data:bytes.length ? new Uint8Array(bytes) : undefined, size:columns ? {columns,rows:rows!} : undefined}]);
  return result(Array.from(replies[0]??[]));
}
export async function capture() { return JSON.stringify(await engine.capture()); }
export function background(color: string, foreground: string) { setTerminalBackground(engine.terminal, color, foreground); }
export function flush() {endSynchronizedOutput(engine.terminal);return result();}
export function sampleArchive() { recorder.sample(); }
export function archive() { return JSON.stringify(recorder.capture()); }
export async function close() {recorder.dispose(); await engine.close();}
