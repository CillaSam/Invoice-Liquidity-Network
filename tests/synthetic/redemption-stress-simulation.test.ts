/**
 * tests/synthetic/redemption-stress-simulation.test.ts
 *
 * Regression check for the redemption simulation (#1313). The simulation
 * reproduces docs/trust-liquidity-model.md §6.2 and extends it with a
 * FCFS vs. pro-rata branch. The tests below exercise:
 *
 *   - success: published row matches the computed row for every severity
 *     shown in §6.2;
 *   - failure: a shifted idle-cash pool makes the fulfilment ratio diverge
 *     and the diff is caught;
 *   - replay / restart: the pure functions are deterministic — the same
 *     inputs always produce the same outputs across repeated calls;
 *   - boundary: 0%, 100%, and above-total-capital severities; allocation
 *     invariants (sum(paid) ≤ idleCash) hold.
 *
 * The simulation module is a plain ES module; tests import the exported
 * functions directly so no child-process orchestration is needed.
 */

import { describe, expect, it } from 'vitest';

import {
  BASELINE_POOL,
  PUBLISHED_SCENARIOS,
  computeStressRow,
  diffRow,
  fcfsAllocation,
  proRataAllocation,
  runStressSweep,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore — .mjs module resolved by Vitest without .d.ts
} from '../../scripts/redemption-stress-simulation.mjs';

describe('redemption stress — published table reconciliation (§6.2)', () => {
  it.each(PUBLISHED_SCENARIOS)(
    'severity %p matches the published row within floating-point tolerance',
    (scenario) => {
      const computed = computeStressRow(scenario.severity);
      expect(diffRow(scenario, computed)).toBeNull();
    },
  );

  it('full sweep reports MATCH for every row the docs publish', () => {
    const { reconciliation } = runStressSweep();
    for (const row of reconciliation) {
      expect(row.diff).toBeNull();
    }
  });
});

describe('redemption stress — failure detection', () => {
  it('detects drift when the pool changes (idle cash drops, published numbers no longer hold)', () => {
    // Shrink idle cash; the 50% severity row must drift because
    // immediatelyPayable can no longer reach 40.
    const shrunkPool = { ...BASELINE_POOL, idleCash: 20 };
    const computed = computeStressRow(0.5, shrunkPool);
    const diff = diffRow(
      PUBLISHED_SCENARIOS.find((s) => s.severity === 0.5)!,
      computed,
    );
    expect(diff).not.toBeNull();
    expect(diff).toHaveProperty('immediatelyPayable');
    expect(diff!.immediatelyPayable).toEqual({ published: 40, computed: 20 });
  });
});

describe('redemption stress — determinism / replay', () => {
  it('computeStressRow is pure and repeatable', () => {
    const a = computeStressRow(0.5);
    const b = computeStressRow(0.5);
    expect(a).toEqual(b);
  });

  it('runStressSweep produces identical output on back-to-back invocations', () => {
    const a = runStressSweep();
    const b = runStressSweep();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('redemption stress — boundary conditions', () => {
  it('0% severity: no one is withdrawing, nothing is payable, nothing is queued', () => {
    const row = computeStressRow(0);
    expect(row.requestSize).toBe(0);
    expect(row.immediatelyPayable).toBe(0);
    expect(row.remaining).toBe(0);
    // Fulfilment is defined as 1.0 for a no-op request so downstream
    // alerting doesn't flag "0% fill" when there is nothing to fill.
    expect(row.immediateFulfilment).toBe(1);
  });

  it('100% severity exposes the liquidity cliff: 40% paid, 60% queued', () => {
    const row = computeStressRow(1);
    expect(row.requestSize).toBe(100);
    expect(row.immediatelyPayable).toBe(40);
    expect(row.remaining).toBe(60);
    expect(row.immediateFulfilment).toBeCloseTo(0.4, 10);
  });

  it('above-pool severity caps payout at idle cash (never over-commits)', () => {
    // §6.2 never claims pool liabilities can exceed total capital; this
    // guards against a bug where the simulation would hand out more than
    // the pool holds.
    const row = computeStressRow(1.25);
    expect(row.immediatelyPayable).toBeLessThanOrEqual(BASELINE_POOL.idleCash);
    expect(row.immediatelyPayable + row.remaining).toBe(row.requestSize);
  });
});

describe('redemption stress — allocation strategies', () => {
  const requests = [
    { id: 'lp-1', amount: 20 },
    { id: 'lp-2', amount: 20 },
    { id: 'lp-3', amount: 20 },
    { id: 'lp-4', amount: 20 },
  ];

  it('pro-rata gives every caller the same fill ratio (§7.1.2 fairness invariant)', () => {
    const result = proRataAllocation(40, requests);
    expect(result.fillRatio).toBeCloseTo(0.5, 10);
    for (const paid of Object.values(result.paid)) {
      expect(paid).toBeCloseTo(10, 10);
    }
    // sum(paid) must not exceed idle cash — core protocol invariant.
    const total = Object.values(result.paid).reduce<number>((acc, v) => acc + (v as number), 0);
    expect(total).toBeLessThanOrEqual(40 + 1e-9);
  });

  it('FCFS satisfies early callers in full and starves late ones', () => {
    const result = fcfsAllocation(40, requests);
    expect(result.paid['lp-1']).toBe(20);
    expect(result.paid['lp-2']).toBe(20);
    expect(result.paid['lp-3']).toBe(0);
    expect(result.paid['lp-4']).toBe(0);
    expect(result.totalPaid).toBe(40);
  });

  it('FCFS and pro-rata disagree on per-LP outcomes but agree on total paid', () => {
    const pro = proRataAllocation(40, requests);
    const fcfs = fcfsAllocation(40, requests);
    expect(pro.totalPaid).toBe(fcfs.totalPaid);
    // Max per-LP delta between strategies should be the full starvation
    // gap for a late caller (20 - 10 = 10).
    const deltas = requests.map((r) => Math.abs(pro.paid[r.id] - fcfs.paid[r.id]));
    expect(Math.max(...deltas)).toBeCloseTo(10, 10);
  });

  it('empty request set is a no-op (no divide-by-zero on fillRatio)', () => {
    const pro = proRataAllocation(40, []);
    expect(pro.totalPaid).toBe(0);
    expect(pro.fillRatio).toBe(1);
  });
});
