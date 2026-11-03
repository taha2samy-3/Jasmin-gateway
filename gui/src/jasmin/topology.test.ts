import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';

describe('Telecom Topology DAG & Validation Unit Tests', () => {
  // Architectural validation engine
  function validateEdge(sourceStage: number, targetStage: number, sourceType: string, targetType: string): { valid: boolean; reason?: string } {
    if (sourceStage === targetStage) {
      return { valid: false, reason: 'Self-stage loops forbidden' };
    }
    if (targetStage < sourceStage) {
      return { valid: false, reason: 'Cycles and backward traffic prohibited in DAG' };
    }
    if (sourceType === 'ingress' && targetType !== 'user') {
      return { valid: false, reason: 'Ingress must connect to User' };
    }
    if (sourceType === 'filter' && targetType !== 'route') {
      return { valid: false, reason: 'Filter must connect to Route' };
    }
    if (sourceType === 'route' && targetType !== 'connector') {
      return { valid: false, reason: 'Route must terminate at Connector' };
    }
    return { valid: true };
  }

  test('permits valid linear carrier pipeline progression', () => {
    // Stage 1 (Ingress) -> Stage 2 (User)
    assert.equal(validateEdge(1, 2, 'ingress', 'user').valid, true);
    // Stage 2 (User) -> Stage 3 (Interceptor)
    assert.equal(validateEdge(2, 3, 'user', 'interceptor').valid, true);
    // Stage 3 (Interceptor) -> Stage 4 (Filter)
    assert.equal(validateEdge(3, 4, 'interceptor', 'filter').valid, true);
    // Stage 4 (Filter) -> Stage 5 (Route)
    assert.equal(validateEdge(4, 5, 'filter', 'route').valid, true);
    // Stage 5 (Route) -> Stage 6 (Connector)
    assert.equal(validateEdge(5, 6, 'route', 'connector').valid, true);
  });

  test('strictly prevents illegal bypasses (e.g. Filter directly to Connector)', () => {
    const res = validateEdge(4, 6, 'filter', 'connector');
    assert.equal(res.valid, false);
    assert.match(res.reason!, /Filter must connect to Route/);
  });

  test('strictly prevents Ingress bypassing User account authentication', () => {
    const res = validateEdge(1, 5, 'ingress', 'route');
    assert.equal(res.valid, false);
    assert.match(res.reason!, /Ingress must connect to User/);
  });

  test('strictly prevents backward cycles and loops', () => {
    const res = validateEdge(5, 4, 'route', 'filter');
    assert.equal(res.valid, false);
    assert.match(res.reason!, /Cycles and backward traffic prohibited/);
  });

  test('synthesizes multi-connector syntax for Failover and Roundrobin routes', () => {
    const connectors = ['smsc_vodafone', 'smsc_orange'];
    const formatConn = (c: string) => (c.startsWith('smppc(') ? c : `smppc(${c})`);
    const formatted = connectors.map(formatConn).join(';');
    assert.equal(formatted, 'smppc(smsc_vodafone);smppc(smsc_orange)');
  });
});
