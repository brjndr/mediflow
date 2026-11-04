/**
 * Limits the reports answered on the spot, so one hospital cannot fill the replica's connections
 * with them: each hospital runs at most `perTenant` at a time, the instance at most `overall`.
 * In-process, so per API instance (like the rate limits); stored reports have the database quota.
 */
export class ReportGate {
  private readonly byTenant = new Map<string, number>();
  private total = 0;

  constructor(
    private readonly perTenant = 1,
    private readonly overall = 4,
  ) {}

  /** A release function, or null when the hospital or the instance is at its limit. */
  enter(tenantId: string): (() => void) | null {
    const held = this.byTenant.get(tenantId) ?? 0;
    if (held >= this.perTenant || this.total >= this.overall) return null;
    this.byTenant.set(tenantId, held + 1);
    this.total += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.total -= 1;
      const left = (this.byTenant.get(tenantId) ?? 1) - 1;
      if (left <= 0) this.byTenant.delete(tenantId);
      else this.byTenant.set(tenantId, left);
    };
  }
}
