export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

export function round6(n: number): number {
  return Math.round((n + Number.EPSILON) * 1e6) / 1e6
}

// Postgres numeric comes back as string; normalize once at the read boundary.
export function num(v: unknown): number {
  if (v === null || v === undefined) return 0
  return typeof v === 'number' ? v : Number(v)
}

export const fmtUSD = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
