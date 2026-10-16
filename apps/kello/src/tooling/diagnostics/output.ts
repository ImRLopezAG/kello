import type { DiagnosticsOptions, DiagnosticsRecord } from "./types";
import type { Writable } from "node:stream";

type FileCloseResult = "closed" | "pending" | "failed";
type OutputWriter = NonNullable<DiagnosticsOptions["output"]>["write"];
// Internal ownership lookup keeps devCommand's public DiagnosticsOptions shape unchanged.
const fileClosers = new WeakMap<OutputWriter, (deadline?: number) => Promise<FileCloseResult>>();

export async function closeOwnedFile(write: OutputWriter | undefined, deadline: number): Promise<void> {
  if (!write) return;
  const close = fileClosers.get(write);
  fileClosers.delete(write);
  await close?.(deadline);
}

/** CLI-only owned file sink; not exported by kello/tooling. */
export function createFileOutput(file: {
  write(bytes: Uint8Array): Promise<{ bytesWritten: number }>;
  close(): Promise<void>;
}) {
  let pending: Promise<void> | undefined;
  let closing: Promise<FileCloseResult> | undefined;
  let cancelledAt: number | undefined;
  const output = {
    write(this: void, chunk: string, signal: AbortSignal): Promise<void> {
      const operation = (async () => {
        signal.throwIfAborted();
        if (closing) throw new Error("DIAGNOSTICS_OUTPUT_CLOSED");
        const bytes = new TextEncoder().encode(chunk);
        const cancel = () => {
          cancelledAt ??= performance.now();
        };
        signal.addEventListener("abort", cancel, { once: true });
        try {
          let offset = 0;
          while (offset < bytes.byteLength) {
            signal.throwIfAborted();
            const { bytesWritten } = await file.write(bytes.subarray(offset));
            signal.throwIfAborted();
            if (bytesWritten <= 0) throw new Error("DIAGNOSTICS_OUTPUT_WRITE_FAILED");
            offset += bytesWritten;
          }
        } finally {
          signal.removeEventListener("abort", cancel);
        }
      })();
      pending = operation;
      return operation;
    },
    close(this: void, deadline = (cancelledAt ?? performance.now()) + 2000): Promise<FileCloseResult> {
      if (closing) return closing;
      // Only the handle is retained by late settlement, never a session or its queues.
      const close = async (): Promise<"closed" | "failed"> => {
        try {
          await file.close();
          return "closed";
        } catch {
          return "failed";
        }
      };
      const settled = pending ? pending.then(close, close) : close();
      pending = undefined;
      const remaining = Math.max(0, deadline - performance.now());
      closing = new Promise((resolve) => {
        const timeout = setTimeout(() => resolve("pending"), remaining);
        void settled.then((result) => {
          clearTimeout(timeout);
          resolve(result);
        });
      });
      return closing;
    },
  };
  fileClosers.set(output.write, output.close);
  return output;
}

/** Shared stderr stays open. A false write result requires both callback and drain. */
export async function writeStderrOutput(stream: Writable, chunk: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let submitted = false;
    let callbackDone = false;
    let drained = false;
    let needsDrain = false;
    let callbackFailure: ReturnType<typeof setImmediate> | undefined;
    function finish(error?: Error, retainError = false) {
      if (settled) return;
      settled = true;
      stream.off("drain", onDrain);
      if (!retainError) stream.off("error", onError);
      signal.removeEventListener("abort", onAbort);
      if (!retainError && callbackFailure !== undefined) clearImmediate(callbackFailure);
      if (error) reject(error);
      else resolve();
    }
    function ready() {
      if (submitted && callbackDone && (!needsDrain || drained)) finish();
    }
    function onDrain() {
      drained = true;
      ready();
    }
    function onError(error: Error) {
      stream.off("error", onError);
      finish(error);
    }
    function onAbort() {
      // Submitted I/O cannot be revoked. Keep only its error observer until
      // the native callback settles, even though cancellation rejects now.
      finish(new Error("DIAGNOSTICS_OUTPUT_ABORTED"), !callbackDone || callbackFailure !== undefined);
    }
    stream.on("drain", onDrain);
    stream.on("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      signal.throwIfAborted();
      needsDrain = !stream.write(chunk, (error) => {
        callbackDone = true;
        if (settled) {
          if (error) setImmediate(() => stream.off("error", onError));
          else stream.off("error", onError);
          return;
        }
        if (error) {
          // Writable also emits error after its callback; retain containment for that turn.
          callbackFailure = setImmediate(() => {
            stream.off("error", onError);
            finish(error);
          });
        } else {
          ready();
        }
      });
      submitted = true;
      ready();
    } catch {
      finish(new Error("DIAGNOSTICS_OUTPUT_WRITE_FAILED"));
    }
  });
  signal.throwIfAborted();
}

/** Fixed storage shared by the ingress and output pumps; removed entries release references. */
export class Ring<Value> {
  private readonly values: (Value | undefined)[];
  private head = 0;
  private tail = 0;
  size = 0;
  constructor(private readonly capacity: number) {
    this.values = Array.from<Value | undefined>({ length: capacity });
  }
  push(value: Value): boolean {
    if (this.size === this.capacity) return false;
    this.values[this.tail] = value;
    this.tail = (this.tail + 1) % this.capacity;
    this.size++;
    return true;
  }
  pop(): Value | undefined {
    if (!this.size) return undefined;
    const value = this.values[this.head];
    this.values[this.head] = undefined;
    this.head = (this.head + 1) % this.capacity;
    this.size--;
    return value;
  }
  clear(): number {
    const count = this.size;
    while (this.size) this.pop();
    return count;
  }
}

function formatRecord(record: DiagnosticsRecord, format: "text" | "jsonl"): string {
  const json = JSON.stringify(record);
  const line = format === "jsonl" ? `${json}\n` : `${record.timestamp} ${record.source} ${json}\n`;
  if (new TextEncoder().encode(line).byteLength > 2048) throw new Error("DIAGNOSTICS_LINE_TOO_LARGE");
  return line;
}

interface Settlement {
  done: (() => void) | undefined;
  failed: (() => void) | undefined;
}

// This scope never captures queues, a session or its guard. Stop severs both callbacks.
function observeWrite(promise: Promise<void>, settlement: Settlement): void {
  void promise.then(
    () => settlement.done?.(),
    () => settlement.failed?.(),
  );
}

export function createOutput(
  output: NonNullable<DiagnosticsOptions["output"]>,
  dropped: (count: number) => void,
  failed: () => void,
) {
  const queue = new Ring<DiagnosticsRecord>(256);
  const controller = new AbortController();
  let enabled = true;
  let busy = false;
  let scheduled: ReturnType<typeof setTimeout> | undefined;
  let settlement: Settlement | undefined;
  function detach() {
    if (settlement) {
      settlement.done = undefined;
      settlement.failed = undefined;
      settlement = undefined;
    }
  }
  function disable() {
    enabled = false;
    detach();
    if (scheduled !== undefined) {
      clearTimeout(scheduled);
      scheduled = undefined;
    }
    dropped(queue.clear());
    controller.abort();
  }
  function failure() {
    failed();
    disable();
  }
  function schedule() {
    if (enabled && !busy && queue.size && scheduled === undefined) scheduled = setTimeout(pump, 0);
  }
  function pump() {
    scheduled = undefined;
    if (!enabled || busy) return;
    const record = queue.pop();
    if (!record) return;
    try {
      const line = formatRecord(record, output.format);
      busy = true;
      const result = output.write(line, controller.signal);
      // A writer may synchronously stop its own session.
      if (!enabled) {
        if (result) observeWrite(Promise.resolve(result), { done: undefined, failed: undefined });
        return;
      }
      if (result) {
        const current: Settlement = {
          done: () => {
            detach();
            busy = false;
            schedule();
          },
          failed: failure,
        };
        settlement = current;
        // Normalization can invoke a caller-controlled constructor getter and stop.
        // Keep the detached object stable even when stop clears the owner reference.
        observeWrite(Promise.resolve(result), current);
      } else {
        busy = false;
        schedule();
      }
    } catch {
      if (enabled) failure();
    }
  }
  return {
    enqueue(record: DiagnosticsRecord) {
      if (enabled) {
        if (!queue.push(record)) dropped(1);
        schedule();
      }
    },
    stop: disable,
  };
}
