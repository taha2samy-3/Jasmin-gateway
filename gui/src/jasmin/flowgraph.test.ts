import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
// The exact module the browser editor loads.
import { lintGraph, normalizeFlow, routeConnectors, routeFilters, validateConnection } from '../../public/js/flow-rules.js';

const n = (id: string, type: string, data: Record<string, unknown> = {}) => ({ id, type, x: 0, y: 0, data });

function sample() {
  return {
    nodes: [
      n('in', 'ingress', { protocol: 'http', port: 1401 }),
      n('u', 'user', { uid: 'acme', gid: 'retail', username: 'acme' }),
      n('f1', 'filter', { fid: 'eg', type: 'DestinationAddrFilter', value: '^20' }),
      n('f2', 'filter', { fid: 'all', type: 'TransparentFilter', value: '' }),
      n('r1', 'route', { type: 'FailoverMTRoute', order: 20, rate: 0 }),
      n('r0', 'route', { type: 'DefaultRoute', order: 0, rate: 0 }),
      n('c1', 'connector', { kind: 'smpp', cid: 'carrier_a' }),
      n('c2', 'connector', { kind: 'smpp', cid: 'carrier_b' }),
      n('h1', 'connector', { kind: 'http', cid: 'crm' })
    ],
    connections: [
      { from: 'in', to: 'u' },
      { from: 'f1', to: 'r1' },
      { from: 'r1', to: 'c2' },
      { from: 'r1', to: 'c1' },
      { from: 'r0', to: 'c1' }
    ]
  };
}

describe('validateConnection', () => {
  test('allows the pipeline direction', () => {
    const g = sample();
    assert.equal(validateConnection(g, 'u', 'f2').valid, true);
    assert.equal(validateConnection(g, 'f2', 'r1').valid, true);
  });
  test('refuses shortcuts, loops, duplicates and self wires', () => {
    const g = sample();
    assert.match(validateConnection(g, 'f1', 'c1').reason, /Filter can only feed/);
    assert.match(validateConnection(g, 'r1', 'f1').reason, /MT Route can only feed/);
    assert.match(validateConnection(g, 'f1', 'r1').reason, /already wired/);
    assert.match(validateConnection(g, 'r1', 'r1').reason, /itself/);
    assert.match(validateConnection(g, 'in', 'r1').reason, /Ingress can only feed/);
  });
  test('enforces Jasmin route rules', () => {
    const g = sample();
    assert.match(validateConnection(g, 'r0', 'c2').reason, /exactly one connector/);
    assert.match(validateConnection(g, 'f2', 'r0').reason, /cannot have filters/);
    assert.match(validateConnection(g, 'r1', 'h1').reason, /SMPP client connectors only/);
  });
});

describe('route helpers', () => {
  test('connector order follows wire order (failover priority)', () => {
    assert.deepEqual(routeConnectors(sample(), 'r1'), ['carrier_b', 'carrier_a']);
    assert.deepEqual(routeFilters(sample(), 'r1'), ['eg']);
  });
});

describe('lintGraph', () => {
  test('a valid graph only warns about unused filters', () => {
    const issues = lintGraph(sample());
    assert.deepEqual(issues.map((i: any) => i.level), ['warning']);
    assert.match(issues[0].message, /not used/);
  });
  test('reports Jasmin rule violations', () => {
    const g = sample();
    g.nodes.push(n('r2', 'route', { type: 'StaticMTRoute', order: 20, rate: -1 }), n('f3', 'filter', { fid: 'bad id!', type: 'DestinationAddrFilter', value: '([' }));
    g.connections.push({ from: 'r2', to: 'c1' });
    const msgs = lintGraph(g).map((i: any) => i.message).join('\n');
    assert.match(msgs, /Order 20 is used by another route/);
    assert.match(msgs, /Rate must be/);
    assert.match(msgs, /needs at least one filter/);
    assert.match(msgs, /Filter ID must be/);
    assert.match(msgs, /Invalid regex/);
  });
  test('order 0 is reserved for the default route', () => {
    const g = sample();
    g.nodes.find((x) => x.id === 'r1')!.data.order = 0;
    assert.match(lintGraph(g).map((i: any) => i.message).join('\n'), /Order 0 is reserved/);
  });
});

describe('normalizeFlow', () => {
  test('imports older exports (edges, pattern, pri/bak roles) and drops dangling or DLR wires', () => {
    const flow = normalizeFlow({
      nodes: [n('f', 'filter', { fid: 'x', type: 'DestinationAddrFilter', pattern: '^1' }), n('r', 'route', { type: 'FailoverMTRoute', order: 5 }), n('conn_http_crm', 'connector', { cid: 'crm' }), n('a', 'connector', { cid: 'a' }), n('b', 'connector', { cid: 'b' }), { id: 'z', type: 'bogus' }],
      edges: [
        { source: 'f', target: 'r' },
        { source: 'r', target: 'b', role: 'bak' },
        { source: 'r', target: 'a', role: 'pri' },
        { source: 'r', target: 'missing' },
        { source: 'a', target: 'f', isDlr: true }
      ]
    });
    assert.equal(flow.nodes.length, 5);
    assert.equal(flow.nodes[0].data.value, '^1');
    assert.equal(flow.nodes[2].data.kind, 'http');
    assert.equal(flow.connections.length, 3);
    assert.deepEqual(routeConnectors(flow, 'r'), ['a', 'b'], 'primary before backup');
  });
});
