/** Single-use prewarms. Ambiguous dispatches are retired, never returned to admission. */
export class ProcessReadiness {
  private readonly ready = new Set<number>();
  private readonly consumed = new Set<number>();
  private readonly assignments = new Map<string, { pid: number; confirmed: boolean; timer: ReturnType<typeof setTimeout>; resolve: (entered: boolean) => void; entered: Promise<boolean> }>();
  constructor(private readonly alive: (pid: number) => boolean,
    private readonly retire: (pid: number) => void = () => {}) {}
  available() {
    for (const pid of this.ready) if (!this.alive(pid)) this.ready.delete(pid);
    for (const pid of this.consumed) if (!this.alive(pid)) this.consumed.delete(pid);
    return this.ready.size > 0;
  }
  register(pid: number) {
    this.available();
    if (!Number.isSafeInteger(pid) || pid <= 0 || this.ready.size >= 16 || this.consumed.has(pid) || !this.alive(pid)) return false;
    this.ready.add(pid); return true;
  }
  reserve(id?: string) {
    if (!this.available()) return false;
    if (id && this.assignments.has(id)) return false;
    const pid = this.ready.values().next().value!;
    this.ready.delete(pid); this.consumed.add(pid);
    if (id) {
      let resolve!: (entered: boolean) => void;
      const entered = new Promise<boolean>(r => { resolve = r; });
      // Existing SDK limits: assignment 7.5s, pool startup 60s, close 10s.
      // Retire only after the SDK's queue reader has expired, so it cannot steal a replacement.
      const timer = setTimeout(() => this.fail(id), 7500 + 60000 + 10000);
      this.assignments.set(id, { pid, confirmed: false, timer, resolve, entered });
    }
    return true;
  }
  waitForEntry(id: string) { return this.assignments.get(id)?.entered ?? Promise.resolve(false); }
  dispatched(id: string) {
    const assignment = this.assignments.get(id);
    if (!assignment || assignment.confirmed) return;
    clearTimeout(assignment.timer);
    assignment.timer = setTimeout(() => this.fail(id), 7500);
  }
  enter(id: string, pid: number) {
    const assignment = this.assignments.get(id);
    if (!assignment || assignment.confirmed || assignment.pid !== pid || !this.alive(pid)) return false;
    assignment.confirmed = true;
    clearTimeout(assignment.timer);
    assignment.resolve(true);
    // Keep the resolved receipt until the accepting callback observes it.
    return true;
  }
  complete(id: string) {
    const assignment = this.assignments.get(id);
    if (assignment) { clearTimeout(assignment.timer); this.assignments.delete(id); }
  }
  fail(id: string) {
    const assignment = this.assignments.get(id);
    if (!assignment) return;
    this.complete(id); assignment.resolve(false);
    // Killing a known, still-live single-use child reconciles even ambiguous assignment.
    // Its SDK watcher removes the queue entry and releases capacity exactly once.
    if (this.alive(assignment.pid)) this.retire(assignment.pid);
  }
  close() {
    for (const id of this.assignments.keys()) this.fail(id);
    this.ready.clear();
  }
}
