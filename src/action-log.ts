export type ActionEntry = { time: string; verb: string } & Record<string, unknown>

const capacity = 500

export class ActionLog {
  private entries: ActionEntry[] = []

  add(verb: string, details: Record<string, unknown> = {}): void {
    this.entries.push({ time: new Date().toISOString(), verb, ...details })
    if (this.entries.length > capacity) this.entries.splice(0, this.entries.length - capacity)
  }

  list(): ActionEntry[] {
    return [...this.entries]
  }
}
