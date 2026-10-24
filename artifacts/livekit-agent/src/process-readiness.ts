/** Single-use prewarmed processes. A reservation is consumed even if dispatch later fails. */
export class ProcessReadiness {
  private readonly ready = new Set<number>();
  constructor(private readonly alive: (pid: number) => boolean) {}
  available() {
    for (const pid of this.ready) if (!this.alive(pid)) this.ready.delete(pid);
    return this.ready.size > 0;
  }
  register(pid: number) {
    this.available();
    if (!Number.isSafeInteger(pid) || pid <= 0 || this.ready.size >= 16 || !this.alive(pid)) return false;
    this.ready.add(pid); return true;
  }
  reserve() {
    if (!this.available()) return false;
    this.ready.delete(this.ready.values().next().value!); return true;
  }
}
