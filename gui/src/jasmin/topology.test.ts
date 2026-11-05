import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildTopology, filterDescription, planDeploy, planFingerprint, simulateMtRouting, FlowGraph } from './topology.js';
import type { GatewaySnapshot } from './gateway.js';

const filter = (fid: string, type: string, value: string) => {
  const description = filterDescription(type, value);
  return { fid, type, routes: type === 'UserFilter' ? 'MT' : 'MO MT', description, paramKey: '', value };
};
const conn = (cid: string, service = 'started', session = 'BOUND_TRX') => ({
  cid, service, session, starts: 1, stops: 0, connectedAt: '', boundAt: '', disconnectedAt: '', submits: '0/0', delivers: '0/0', qosErrors: 0, otherErrors: 0
});
const route = (order: number, type: string, rate: number, cids: string[], filters: string[]) => ({
  order, type, rate, connectors: cids.map((c) => `smppc(${c})`), connector: cids.map((c) => `smppc(${c})`).join(';'), filters
});

/** A gateway state shaped exactly like the one parsed from Jasmin 0.11.1. */
function snapshot(): GatewaySnapshot {
  const filters = [filter('eg_vodafone', 'DestinationAddrFilter', '^2010'), filter('bank_sender', 'SourceAddrFilter', '^BANK'), filter('vip', 'UserFilter', 'acme_otp'), filter('all', 'TransparentFilter', '')];
  return {
    fetchedAt: '',
    users: [{ uid: 'acme_otp', gid: 'retail', username: 'acme', balance: 10, mtSmsQuota: 'ND', throughput: 'ND/ND' }],
    groups: [{ gid: 'retail' }],
    smppConnectors: [conn('carrier_a'), conn('carrier_b')],
    httpConnectors: [],
    filters,
    mtRoutes: [
      route(30, 'StaticMTRoute', 0.02, ['carrier_a'], ['<DA (dst_addr=^2010)>']),
      route(20, 'FailoverMTRoute', 0.025, ['carrier_b', 'carrier_a'], ['<SA (src_addr=^BANK)>', '<U (uid=acme_otp)>']),
      route(0, 'DefaultRoute', 0.03, ['carrier_a'], [])
    ],
    moRoutes: [],
    mtInterceptors: [],
    moInterceptors: [],
    stats: {} as any
  };
}
const graphOf = (s: GatewaySnapshot): FlowGraph => {
  const t = buildTopology(s);
  return { nodes: t.nodes, connections: t.connections };
};

describe('buildTopology', () => {
  test('maps route filter descriptions back to filter IDs and keeps failover order', () => {
    const g = graphOf(snapshot());
    const into = (id: string) => g.connections.filter((c) => c.to === id).map((c) => c.from);
    const outOf = (id: string) => g.connections.filter((c) => c.from === id).map((c) => c.to);
    assert.deepEqual(into('route_20').sort(), ['filter_bank_sender', 'filter_vip']);
    assert.deepEqual(outOf('route_20'), ['smppc_carrier_b', 'smppc_carrier_a']);
    assert.deepEqual(into('route_0'), []);
    assert.ok(g.connections.some((c) => c.from === 'user_acme_otp' && c.to === 'filter_vip'), 'UserFilter wired from its user');
  });

  test('flags routes that point at deleted connectors or filters', () => {
    const s = snapshot();
    s.smppConnectors = [conn('carrier_a')];
    s.filters = s.filters.filter((f) => f.fid !== 'bank_sender');
    const t = buildTopology(s);
    assert.ok(t.nodes.find((n) => n.id === 'smppc_carrier_b')?.data.missing);
    assert.ok(t.nodes.some((n) => n.data.inline && n.data.description === '<SA (src_addr=^BANK)>'));
    assert.equal(t.warnings.length, 2);
  });
});

describe('planDeploy', () => {
  test('an unchanged flow produces no changes (exact round trip)', () => {
    const s = snapshot();
    const plan = planDeploy(graphOf(s), s, { prune: true });
    assert.deepEqual(plan.steps, []);
    assert.deepEqual(plan.errors, []);
  });

  test('editing a filter replaces it and every route that holds a copy of it', () => {
    const s = snapshot();
    const g = graphOf(s);
    g.nodes.find((n) => n.id === 'filter_bank_sender')!.data.value = '^BANK[A-Z]+';
    const plan = planDeploy(g, s);
    assert.deepEqual(plan.steps.map((x) => `${x.action} ${x.kind} ${x.id}`), ['replace filter bank_sender', 'replace route 20']);
  });

  test('reordering failover connectors replaces the route', () => {
    const s = snapshot();
    const g = graphOf(s);
    const wires = g.connections.filter((c) => c.from === 'route_20');
    g.connections = [...g.connections.filter((c) => c.from !== 'route_20'), wires[1], wires[0]];
    assert.deepEqual(planDeploy(g, s).steps.map((x) => x.summary), ['#20 FailoverMTRoute rate=0.025 → carrier_a, carrier_b [bank_sender, vip]']);
  });

  test('removing a route node removes the route only when pruning', () => {
    const s = snapshot();
    const g = graphOf(s);
    g.nodes = g.nodes.filter((n) => n.id !== 'route_30');
    g.connections = g.connections.filter((c) => c.from !== 'route_30' && c.to !== 'route_30');
    assert.deepEqual(planDeploy(g, s, { prune: false }).steps, []);
    assert.deepEqual(planDeploy(g, s, { prune: true }).steps.map((x) => `${x.action} ${x.kind} ${x.id}`), ['remove route 30']);
  });

  test('new connectors, users and groups are created before the routes that use them', () => {
    const s = snapshot();
    const g = graphOf(s);
    g.nodes.push(
      { id: 'c_new', type: 'connector', x: 0, y: 0, data: { kind: 'smpp', cid: 'carrier_x', host: '10.0.0.5', port: 2775, username: 'u', password: 'p' } },
      { id: 'f_new', type: 'filter', x: 0, y: 0, data: { fid: 'ksa', type: 'DestinationAddrFilter', value: '^966' } },
      { id: 'r_new', type: 'route', x: 0, y: 0, data: { type: 'StaticMTRoute', order: 40, rate: 0 } },
      { id: 'u_new', type: 'user', x: 0, y: 0, data: { uid: 'newbie', gid: 'wholesale', username: 'newbie', password: 'secret' } }
    );
    g.connections.push({ from: 'f_new', to: 'r_new' }, { from: 'r_new', to: 'c_new' });
    const order = planDeploy(g, s).steps.map((x) => `${x.action} ${x.kind} ${x.id}`);
    assert.deepEqual(order, ['add group wholesale', 'add user newbie', 'add connector carrier_x', 'add filter ksa', 'add route 40']);
  });

  test('reports incomplete new entities instead of half-deploying', () => {
    const s = snapshot();
    const g = graphOf(s);
    g.nodes.push({ id: 'c_new', type: 'connector', x: 0, y: 0, data: { kind: 'smpp', cid: 'carrier_x' } });
    g.nodes.push({ id: 'u_new', type: 'user', x: 0, y: 0, data: { uid: 'x', gid: 'retail', username: 'x' } });
    const plan = planDeploy(g, s);
    assert.equal(plan.errors.length, 2);
  });
});

describe('simulateMtRouting (Jasmin semantics)', () => {
  test('highest order first, all filters must match, default catches the rest', () => {
    const s = snapshot();
    assert.equal(simulateMtRouting(s, { destination_addr: '201012345678' }).route?.order, 30);
    assert.equal(simulateMtRouting(s, { destination_addr: '966500000000', source_addr: 'BANKEG', uid: 'acme_otp' }).route?.order, 20);
    // UserFilter fails for another user: falls through to the default route.
    assert.equal(simulateMtRouting(s, { destination_addr: '966500000000', source_addr: 'BANKEG', uid: 'someone' }).route?.order, 0);
  });

  test('regex filters are anchored at the start like Python re.match', () => {
    const s = snapshot();
    const r = simulateMtRouting(s, { destination_addr: '00201012345678' });
    assert.equal(r.route?.order, 0, '^2010 must not match in the middle of the number');
  });

  test('no route at all when there is no default route', () => {
    const s = snapshot();
    s.mtRoutes = s.mtRoutes.filter((r) => r.order !== 0);
    assert.equal(simulateMtRouting(s, { destination_addr: '44700000000' }).matched, false);
  });
});

describe('planDeploy validation and safety (Jasmin 0.11.1 rules)', () => {
  const routeNode = (g: FlowGraph, order: number) => g.nodes.find((n) => n.type === 'route' && n.data.order === order)!;

  test('rejects what jCLI would reject, before anything runs', () => {
    const s = snapshot();
    const g = graphOf(s);
    g.nodes.push({ id: 'filter_new', type: 'filter', x: 0, y: 0, data: { fid: 'a_very_long_filter_id', type: 'DestinationAddrFilter', value: '^1' } });
    g.nodes.push({ id: 'route_new', type: 'route', x: 0, y: 0, data: { order: 40, type: 'StaticMTRoute', rate: -1 } });
    g.connections.push({ from: 'filter_new', to: 'route_new' }, { from: 'route_new', to: 'smppc_carrier_a' });
    g.nodes.push({ id: 'route_rr', type: 'route', x: 0, y: 0, data: { order: 50, type: 'RandomRoundrobinMTRoute', rate: 0 } });
    g.connections.push({ from: 'filter_all', to: 'route_rr' }, { from: 'route_rr', to: 'smppc_carrier_a' });
    g.nodes.push({ id: 'route_blank', type: 'route', x: 0, y: 0, data: { order: '', type: 'StaticMTRoute', rate: 0 } });
    g.connections.push({ from: 'filter_all', to: 'route_blank' }, { from: 'route_blank', to: 'smppc_carrier_a' });
    const plan = planDeploy(g, s, { prune: false });
    const text = plan.errors.join('\n');
    assert.match(text, /a_very_long_filter_id.*1-16/);
    assert.match(text, /#40: rate must be a number ≥ 0/);
    assert.match(text, /#50: a RandomRoundrobinMTRoute needs at least two connectors/);
    assert.match(text, /"route_blank": order must be an integer ≥ 1/);
  });

  test('ConnectorFilter cannot be used on an MT route; bad interval borders are caught', () => {
    const s = snapshot();
    const g = graphOf(s);
    g.nodes.push({ id: 'filter_c', type: 'filter', x: 0, y: 0, data: { fid: 'from_smpp', type: 'ConnectorFilter', value: 'carrier_a' } });
    g.nodes.push({ id: 'filter_ti', type: 'filter', x: 0, y: 0, data: { fid: 'office', type: 'TimeIntervalFilter', value: '18:00:00;08:00:00' } });
    g.connections.push({ from: 'filter_c', to: routeNode(g, 30).id }, { from: 'filter_ti', to: routeNode(g, 30).id });
    const text = planDeploy(g, s).errors.join('\n');
    assert.match(text, /ConnectorFilter only works on MO routes/);
    assert.match(text, /right border must be after the left border/);
  });

  test('a broken live route that is not touched does not block other deploys', () => {
    const s = snapshot();
    // Route #25 still holds a copy of a deleted filter and points at a deleted connector.
    s.mtRoutes.unshift(route(25, 'StaticMTRoute', 0, ['gone_carrier'], ['<DA (dst_addr=^999)>']));
    const g = graphOf(s);
    routeNode(g, 30).data.rate = 0.05;
    const plan = planDeploy(g, s);
    assert.deepEqual(plan.errors, []);
    assert.deepEqual(plan.steps.map((st) => `${st.action} ${st.kind} ${st.id}`), ['replace route 30']);
    // Changing the broken route itself is refused with the reason.
    routeNode(g, 25).data.rate = 1;
    assert.match(planDeploy(g, s).errors.join('\n'), /#25: unnamed filter <DA \(dst_addr=\^999\)>.*smppc\(gone_carrier\) no longer exists/);
  });

  test('unchanged graph is idempotent even with rates beyond 5 decimals in the editor', () => {
    const s = snapshot();
    const g = graphOf(s);
    routeNode(g, 30).data.rate = 0.0200000001;
    const plan = planDeploy(g, s);
    assert.equal(plan.steps.length, 0);
  });

  test('pruning the DefaultRoute is called out; fingerprint changes when the gateway changes', () => {
    const s = snapshot();
    const g = graphOf(s);
    g.nodes = g.nodes.filter((n) => !(n.type === 'route' && n.data.type === 'DefaultRoute'));
    const plan = planDeploy(g, s, { prune: true });
    assert.ok(plan.warnings.some((w) => /DefaultRoute \(#0\) will be removed/.test(w)));
    const reviewed = planFingerprint(plan);
    assert.equal(planFingerprint(planDeploy(g, s, { prune: true })), reviewed);
    // Someone adds route #50 after the review: the recomputed plan now also removes it.
    s.mtRoutes.unshift(route(50, 'StaticMTRoute', 0, ['carrier_b'], ['<T>']));
    assert.notEqual(planFingerprint(planDeploy(g, s, { prune: true })), reviewed);
  });
});

describe('simulateMtRouting matches Jasmin semantics', () => {
  test('tags compare as strings; regex commas are preserved for unnamed filters', () => {
    const s = snapshot();
    s.filters.push(filter('tag5', 'TagFilter', '5'));
    s.mtRoutes.unshift(route(60, 'StaticMTRoute', 0, ['carrier_b'], ['<TG (tag=5)>']));
    s.mtRoutes.unshift(route(70, 'StaticMTRoute', 0, ['carrier_b'], ['<DA (dst_addr=^1{2,3}5)>']));
    assert.equal(simulateMtRouting(s, { destination_addr: '1115' }).route?.order, 70);
    assert.equal(simulateMtRouting(s, { destination_addr: '999', tags: ['05'] }).route?.order, 0);
    assert.equal(simulateMtRouting(s, { destination_addr: '999', tags: ['5'] }).route?.order, 60);
  });

  test('date interval uses the local date like the time interval', () => {
    const s = snapshot();
    s.filters.push(filter('nov5', 'DateIntervalFilter', '2026-11-05;2026-11-06'));
    s.mtRoutes.unshift(route(80, 'StaticMTRoute', 0, ['carrier_b'], [filterDescription('DateIntervalFilter', '2026-11-05;2026-11-06')]));
    const localEarly = new Date(2026, 10, 5, 1, 30, 0); // 01:30 local on Nov 5
    assert.equal(simulateMtRouting(s, { destination_addr: '999', at: localEarly }).route?.order, 80);
  });
});
