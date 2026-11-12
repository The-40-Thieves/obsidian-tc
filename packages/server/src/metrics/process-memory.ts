// GH #1433: process-wide memory, read from process.memoryUsage() at scrape time. The process is one
// thing, so there is no vault label; `kind` is a fixed four-value set, never request-derived.
import { Gauge, type Registry } from "@prometheus-io/client";

export function registerProcessMemoryGauge(registers: Registry[]): void {
  new Gauge({
    name: "reliquary_tc_process_memory_bytes",
    help: "Process memory in bytes, by kind: rss (resident set), heap_used (JS heap in use), external (memory bound to JS objects but allocated natively), array_buffers (ArrayBuffer and SharedArrayBuffer backing stores). A sustained rss above the host's budget is the signal, not one sample.",
    labelNames: ["kind"],
    registers,
    collect() {
      this.reset();
      const m = process.memoryUsage();
      this.set({ kind: "rss" }, m.rss);
      this.set({ kind: "heap_used" }, m.heapUsed);
      this.set({ kind: "external" }, m.external);
      this.set({ kind: "array_buffers" }, m.arrayBuffers);
    },
  });
}
