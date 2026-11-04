export interface JasminUser {
  uid: string;
  gid: string;
  username: string;
  balance: number | string;
  mtSmsQuota: string;
  throughput: string;
}

export interface JasminGroup {
  gid: string;
}

export interface JasminHttpConnector {
  cid: string;
  type: string;
  method: string;
  url: string;
}

export interface JasminSmppConnector {
  cid: string;
  /** Service state from `smppccm -l`: "started" | "stopped". */
  service: string;
  /** SMPP session state, e.g. "BOUND_TRX", "NONE". */
  session: string;
  starts: number;
  stops: number;
  connectedAt: string;
  boundAt: string;
  disconnectedAt: string;
  /** Counters from `stats --smppcs` (raw jCLI text, e.g. "12/12"). */
  submits: string;
  delivers: string;
  qosErrors: number;
  otherErrors: number;
}

export interface JasminMoRoute {
  order: number;
  type: string;
  /** Typed connectors joined with ';' e.g. "http(crm)" */
  connector: string;
  connectors: string[];
  filters: string[];
}

export interface JasminMtRoute {
  order: number;
  type: string;
  rate: number;
  /** Typed connectors joined with ';' e.g. "smppc(a);smppc(b)" */
  connector: string;
  connectors: string[];
  filters: string[];
}

export interface JasminHttpApiStats {
  createdAt: string;
  requestCount: number;
  lastRequestAt: string;
  authErrorCount: number;
  routeErrorCount: number;
  interceptorErrorCount: number;
  throughputErrorCount: number;
  chargingErrorCount: number;
  serverErrorCount: number;
  successCount: number;
  lastSuccessAt: string;
}

export interface JasminSmppsApiStats {
  createdAt: string;
  connectedCount: number;
  boundTrxCount: number;
  boundRxCount: number;
  boundTxCount: number;
  submitSmCount: number;
  deliverSmCount: number;
  throttlingErrorCount: number;
  otherSubmitErrorCount: number;
}

export interface JasminFilter {
  fid: string;
  type: string;
  routes: string;
  description: string;
  /** Parameter key and value extracted from the description, e.g. dst_addr / ^2010 */
  paramKey: string;
  value: string;
}

export interface JasminInterceptor {
  order: number;
  type: string;
  script: string;
  filters: string[];
}
