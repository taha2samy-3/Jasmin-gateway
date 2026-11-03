# Jasmin SMS Gateway - Docker & Production Helm Chart

Comprehensive production deployment package for **Jasmin SMS Gateway** on Kubernetes, including an optimized container image, live-tested jCLI authentication, and a fully tested Helm Chart with Gateway API `HTTPRoute` support.

> [!NOTE]
> **Disclaimer:**
> This repository provides an **unofficial**, hardened community distribution of Jasmin SMS Gateway, including custom Wolfi Linux container images, automated SLSA Level 3 attestations, and a Web Management Dashboard. This distribution is independently maintained and is not officially affiliated with, sponsored by, or endorsed by Jookies or the official Jasmin SMS Gateway project.
> * Official Jasmin SMS Gateway: [https://www.jasminsms.com](https://www.jasminsms.com) / [jookies/jasmin](https://github.com/jookies/jasmin).

---

## 1. Jasmin Architecture & Component Breakdown

Jasmin is an open-source, enterprise-grade SMS Gateway written in Python on top of the **Twisted** event-driven network engine.

### Core Daemons & Services:
* **`jasmind.py` (Core Gateway Daemon):**
  - **SMPP Server (Port 2775):** Listens for inbound SMPP client connections (ESME) for message submission (MT) and delivery (MO).
  - **HTTP API (Port 1401):** HTTP endpoint for sending SMS and querying Prometheus metrics (`/metrics`).
  - **jCLI Console (Port 8990):** Telnet-based interactive CLI for real-time management (users, groups, filters, connectors, routes) without restarting services.
  - **Perspective Broker (PB) Ports:** Internal RPC ports for connector management (`8989`), router (`8988`), and SMPP server (`14000`).
* **`interceptord.py` (Message Interceptor Daemon - Port 8987):**
  - Intercepts messages before the routing engine to apply custom Python logic (real-time billing, HLR lookups, PDU modification).
* **Delivery & Lookup Workers (Horizontally Scalable):**
  - `dlrd.py`: Dedicated daemon for dispatching Delivery Receipts (DLR) to clients.
  - `dlrlookupd.py`: Daemon for tracking DLR statuses via Redis.
  - `deliversmd.py`: Daemon for delivering incoming Mobile Originated (MO) messages.
* **Underlying Infrastructure Dependencies:**
  - **RabbitMQ (AMQP Broker - Port 5672):** High-reliability Store-and-Forward message queuing.
  - **Redis (Port 6379):** High-speed in-memory store for DLR mapping and user billing/credit quotas.

---

## 2. Dockerfile & Critical Bug Fixes

While an official Dockerfile exists in upstream `jookies/jasmin`, it crashes when deployed to modern environments. Our Dockerfile fixes three critical upstream bugs:

1. **Python 3.12 `pkg_resources` Removal:**
   - Jasmin imports `from pkg_resources import iter_entry_points`. In `setuptools>=82`, `pkg_resources` was removed. We pin `setuptools<82` to resolve this.
2. **Missing AMQP Specification XML Files:**
   - Jasmin's `txamqp` library expects specification files (`amqp0-9-1.xml` and `amqp0-8.stripped.rabbitmq.xml`) at `/etc/jasmin/resource/`. Without them, AMQP initialization crashes. These are now bundled in the image.
3. **jCLI Authentication & MD5 Password Encoding:**
   - Jasmin's `ConfigFile._get()` automatically reads `JCLI_ADMIN_PASSWORD` from `os.environ` and `JCliConfig` expects it to be an MD5 hex string. If passed as plaintext, `binascii.unhexlify()` throws `binascii.Error: Non-hexadecimal digit found`. Our `docker-entrypoint.sh` and `configure.py` automatically detect and convert plaintext passwords to MD5 hex on startup.
4. **Interface Binding:**
   - Automatically defaults `jcli`, `smpp-server`, and `http-api` to bind to `0.0.0.0` instead of `127.0.0.1` so that Kubernetes services can route traffic to them.
5. **Memory Optimization:**
   - Preloads `libjemalloc2` (`LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libjemalloc.so.2`) to prevent memory fragmentation under high load.

---

## 3. Helm Chart Structure & Features

```
helm/jasmin/
├── Chart.yaml
├── values.yaml
├── .helmignore
└── templates/
    ├── _helpers.tpl
    ├── statefulset.yaml      # StatefulSet with persistent storage for /etc/jasmin/store
    ├── service.yaml          # Exposes SMPP (2775), HTTP API (1401), jCLI (8990)
    ├── configmap.yaml        # Structured jasmin.cfg and interceptor.cfg templates
    ├── secret.yaml           # Passwords for jCLI, RabbitMQ, and Redis
    ├── ingress.yaml          # Standard Kubernetes Ingress
    ├── httproute.yaml        # Kubernetes Gateway API HTTPRoute (gateway.networking.k8s.io/v1)
    ├── servicemonitor.yaml   # Prometheus Operator ServiceMonitor
    └── NOTES.txt             # Post-install connection commands
```

### Full Configuration Control from `values.yaml`:
All sections of `jasmin.cfg` are now directly configurable via structured blocks in `values.yaml`:
* `config.smppServer.*` (bind, port, billingFeature, dlrExpiry, timers)
* `config.jcli.*` (bind, port, authentication, adminUsername, adminPassword)
* `config.httpApi.*` (bind, port, showJasminVersion)
* `config.redisClient.*` (poolsize, dbid)
* `config.amqpBroker.*` (vhost)
* `config.dlr.*` and `config.deliversmThrower.*`
* `config.extraConfig` (raw INI lines for any custom directives)
* `httpRoute` (Kubernetes Gateway API HTTPRoute support for exposing Jasmin HTTP API)
* `jasminRoutes` (Automated provisioning of HTTP Client Connectors and MO/MT routes)
* `hostNetwork` & `dnsPolicy` (ClusterFirstWithHostNet)
* `extraEnv`, `extraEnvFrom`, `extraVolumes`, `extraVolumeMounts`

---

## 4. Client Networking Architecture: Do you need `hostNetwork`?

**Short Answer:** **NO.** In 99% of production Kubernetes deployments, you do **NOT** need `hostNetwork: true`.

### How Clients Connect:
1. **SMPP Clients (ESME - Port 2775):**
   * SMPP is a persistent TCP connection.
   * **Recommended Approach:** Use Kubernetes `Service` with `type: LoadBalancer` (e.g. AWS NLB, GCP Network Load Balancer, MetalLB, Kube-VIP) and set `externalTrafficPolicy: Local`.
   * **Preserving Client Source IP:** Setting `externalTrafficPolicy: Local` prevents `kube-proxy` SNAT, ensuring Jasmin receives the original client IP (critical for Jasmin firewall and IP-based authentication).
   * **Alternative (NodePort):** Set `service.type: NodePort` and point clients or upstream firewalls to `<Node-IP>:<NodePort>`.
2. **HTTP Clients (Port 1401):**
   * Connect via Kubernetes Gateway API `HTTPRoute`, Standard Ingress, or the same `LoadBalancer` Service.
3. **Admin CLI (jCLI - Port 8990):**
   * Kept private inside the cluster. Accessible via `kubectl port-forward` or internal VPN.

### When to use `hostNetwork: true`?
* Only in bare-metal Kubernetes environments with **no LoadBalancer controller** (no MetalLB) where you want port 2775 bound directly to the host's physical network adapter.
* **Caveat:** `hostNetwork: true` binds host ports directly (meaning only 1 Jasmin instance per node) and bypasses CNI network policies. Our chart safely sets `dnsPolicy: ClusterFirstWithHostNet` when `hostNetwork: true` is enabled so internal CoreDNS resolution is never broken.

---

## 5. How to Pass & Patch Configurations via Helm

You can configure Jasmin through 5 distinct methods depending on your needs:

1. **Structured Values (`config.*` in `values.yaml`):**
   ```yaml
   config:
     smppServer:
       port: 2775
       dlrExpiry: 86400
     redisClient:
       poolsize: 50
   ```
2. **Raw INI Directives (`config.extraConfig`):**
   ```yaml
   config:
     extraConfig: |
       [my-custom-section]
       enable_custom_flag = True
   ```
3. **Full INI Override (`config.customJasminCfg` / `config.customInterceptorCfg`):**
   Directly injects the entire `jasmin.cfg` file content.
4. **Environment Variables (`extraEnv` / `extraEnvFrom`):**
   ```yaml
   extraEnv:
     - name: LOG_LEVEL
       value: "DEBUG"
   ```
5. **Custom Files & Scripts (`extraVolumes` / `extraVolumeMounts`):**
   Mount custom interceptor scripts or certificates directly into the pod.

---

## 6. HTTP Route Implementation: Two Dimensions

### A. Kubernetes Gateway API HTTPRoute (`gateway.networking.k8s.io/v1`)
Exposes Jasmin's HTTP API (port 1401) to external traffic with fine-grained endpoint control:
* **Predefined Endpoint Presets:**
  * `/send`: Submit SMS (GET / POST)
  * `/rate`: Calculate SMS billing rate (GET)
  * `/balance`: Query user balance (GET)
  * `/ping`: Health check (GET)
  * `/metrics`: Prometheus metrics (can be toggled or kept private)
* **Custom Rules:** Full support for custom headers, query params, path prefix / exact matches, timeouts, and filters.

Example `values.yaml` snippet:
```yaml
httpRoute:
  enabled: true
  parentRefs:
    - name: "my-gateway"
      namespace: "default"
      sectionName: "http"
  hostnames:
    - "sms.example.com"
  endpoints:
    send:
      enabled: true
      path: /send
      methods: [GET, POST]
    ping:
      enabled: true
      path: /ping
      methods: [GET]
```

### B. Jasmin SMS HTTP Routes & Connectors (`jasminRoutes`)
Enables Jasmin to route inbound SMS (MO) to external HTTP webhooks or APIs without manual Telnet commands:
* Automatically provisions `httpccm` (HTTP Client Connectors) and `morouter` (MO Routes) on container startup via `bootstrap-routes.py`.
* Persists routes directly into `/etc/jasmin/store` and reloads them on container restarts.

Example `values.yaml` snippet:
```yaml
jasminRoutes:
  enabled: true
  httpConnectors:
    - cid: "webhook_prod"
      url: "http://webhook-service.default.svc.cluster.local:8080/sms/incoming"
      method: "POST"
  moRoutes:
    - type: "DefaultRoute"
      connector: "http(webhook_prod)"
```

---

## 7. Verification Proof

- **Live jCLI Login & Route Provisioning Test:**
  Ran a live test stack with `redis`, `rabbitmq`, and `jasmin:local`. Verified automated bootstrap and Telnet console:
  ```
  [INFO] [bootstrap] Waiting for jCLI at 127.0.0.1:8990...
  [INFO] [bootstrap] jCLI is reachable at 127.0.0.1:8990 on attempt 7.
  [INFO] [bootstrap] Successfully authenticated to jCLI.
  [INFO] [bootstrap] Executed 'load' to restore persisted configuration.
  [INFO] [bootstrap] Provisioning HttpConnector 'auto_http_01' (POST -> http://sms-webhook.default.svc.cluster.local:8080/incoming-sms)...
  [INFO] [bootstrap] HttpConnector 'auto_http_01' created successfully.
  [INFO] [bootstrap] Provisioning MO Route (DefaultRoute -> http(auto_http_01))...
  [INFO] [bootstrap] MO Route (DefaultRoute -> http(auto_http_01)) created successfully.
  [INFO] [bootstrap] Persisted all new configurations to store.
  [INFO] [bootstrap] Bootstrap process completed successfully.
  ```
- **Live HTTP API Verification:**
  - `GET /` -> Status `200` (`0.11.1`)
  - `GET /ping` -> Status `200` (`Jasmin/PONG`)
- **Helm Lint:** Passed with 0 errors (`1 chart(s) linted, 0 chart(s) failed`).
- **Helm Template:** Verified rendering of both Kubernetes `HTTPRoute` (`gateway.networking.k8s.io/v1`) and ConfigMap `routes.json`.
- **Helm Template Rendering:** Tested with default values, `httpRoute.enabled=true`, `config.smppServer.dlrExpiry=99999`, and `config.redisClient.poolsize=50`.

---

## 8. Enterprise Web Management Dashboard (`gui/`)

A high-performance Node.js (TypeScript) Web Management Console connecting directly to Jasmin Gateway on `127.0.0.1:8990` and `127.0.0.1:1401`.

### Features:
1. **NOC Cockpit (Overview):** Live real-time throughput chart (TPS), system status badges, and Twisted core telemetry.
2. **User & Account Management:** Full CRUD for ESME clients, password generation, balance credits, and throughput limits.
3. **HTTP Webhooks & Connectors:** Register and test HTTP webhooks for MO inbound SMS routing.
4. **Routing Engine:** Manage MO and MT routing strategies (`DefaultRoute`, `StaticMORoute`).
5. **SMS Dispatch Sandbox:** Send single/bulk test SMS through Jasmin HTTP API (`/send`) and view raw transaction responses.
6. **Persistence Safeguard:** One-click **💾 Persist Config** button that triggers `persist` on Jasmin.

### Running the Dashboard:
```bash
cd gui
npm install
npm start # Starts web server on http://localhost:3000
```

### Verified Screenshots:
Saved in [`gui/screenshots/`](file:///home/taha/Desktop/jasmain/gui/screenshots/):
- `01_noc_cockpit.png`: NOC Cockpit and live throughput chart.
- `02_users_accounts.png`: ESME user management table and balances.
- `03_connectors.png`: HTTP Webhook connectors.
- `04_routing_engine.png`: MO Routing Engine table.
- `05_sms_sandbox.png`: SMS Dispatch Sandbox console.
