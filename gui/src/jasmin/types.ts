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
  connectedAt: string;
  boundAt: string;
  disconnectedAt: string;
  submits: number;
  delivers: number;
  qosErrors: number;
  otherErrors: number;
}

export interface JasminMoRoute {
  order: number;
  type: string;
  connector: string;
  filters: string[];
}

export interface JasminMtRoute {
  order: number;
  type: string;
  rate: number;
  connector: string;
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
