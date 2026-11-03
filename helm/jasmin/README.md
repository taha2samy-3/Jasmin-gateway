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

## 7. Production Telecom Resilience, Autoscaling & Kernel Tuning

High-throughput telecom workloads demand zero-downtime resilience for persistent, stateful SMPP client/server sessions. The Helm chart incorporates dedicated controls for kernel tuning, autoscaling, and zero-downtime rolling updates:

### A. Kernel Network Stack Tuning (`sysctls`)
Telecom SMS gateways handle bursts of thousands of concurrent TCP connections. Tuning the Linux kernel network stack buffers and socket queues prevents packet drops and connection throttling during peak loads:
```yaml
sysctls:
  enabled: true
  # Safe sysctls (namespaced, supported in Kubernetes 1.29+ / 1.32+ without kubelet flags)
  safe:
    enabled: true
    values:
      net.ipv4.tcp_syncookies: "1"               # Protect against SYN flood attacks
      net.ipv4.ip_local_port_range: "1024 65535" # Expand ephemeral port range for outbound binds
      net.ipv4.tcp_fin_timeout: "30"             # Accelerate cleanup of closed sockets
      net.ipv4.tcp_rmem: "4096 131072 6291456"   # TCP read buffers (min, default, max)
      net.ipv4.tcp_wmem: "4096 65536 6291456"    # TCP write buffers (min, default, max)
      net.ipv4.tcp_keepalive_time: "60"          # Send keepalive probe after 60s idle
      net.ipv4.tcp_keepalive_intvl: "10"         # Probe interval
      net.ipv4.tcp_keepalive_probes: "6"         # Drop stale dead connections after 6 probes
  # Unsafe sysctls (require --allowed-unsafe-sysctls on kubelet)
  unsafe:
    enabled: false
    values:
      net.core.somaxconn: "4096"                 # Expand listen socket backlog
      net.ipv4.tcp_max_syn_backlog: "4096"       # Expand SYN queue backlog
```

### B. StatefulSet Update Strategy (`updateStrategy`)
By default, Kubernetes `RollingUpdate` restarts pods immediately upon any template or configuration change. For stateful SMPP gateways, an unexpected pod restart severes all active upstream carrier binds and downstream customer sessions:
```yaml
updateStrategy:
  type: OnDelete # Only restarts pods when manually deleted, allowing maintenance during quiet hours
  # Or use partition:
  # type: RollingUpdate
  # rollingUpdate:
  #   partition: 1 # Prevents automatic pod restart on template change
```

### C. Kubernetes 1.33+ In-Place Pod Resource Resizing (`resizePolicy`)
Allows scaling CPU and Memory requests/limits dynamically on-the-fly without restarting the container:
```yaml
resizePolicy:
  - resourceName: cpu
    restartPolicy: NotRequired
  - resourceName: memory
    restartPolicy: NotRequired
```
With `restartPolicy: NotRequired`, expanding memory to handle sudden DLR spikes or traffic rushes will never trigger an `OOMKilled` restart or drop active SMPP sessions.

### D. Vertical Pod Autoscaler Integration (`autoscaling.vpa`)
Jasmin's Twisted event loop runs on a single thread bounded by Python's Global Interpreter Lock (GIL). Over-allocating CPU to a single process cannot exceed 1 core. The native VPA integration tracks actual resource consumption and provides advisory recommendations:
```yaml
autoscaling:
  vpa:
    enabled: true
    updateMode: "Off" # Recommendations-only mode (safest for SMPP production)
    controlledResources:
      - cpu
      - memory
    minAllowed:
      cpu: 250m
      memory: 512Mi
    maxAllowed:
      cpu: 2000m
      memory: 8Gi
```

### E. Telecom Alerting Pack (`monitoring.prometheusRule`)
Pre-packaged Prometheus Operator alerting rules monitoring Jasmin core telemetry:
```yaml
monitoring:
  serviceMonitor:
    enabled: true
    interval: 30s
    path: /metrics
  prometheusRule:
    enabled: true
    rules:
      smppConnectorDown:
        severity: critical
        for: 1m
      highSubmitErrorRate:
        severity: warning
        threshold: "0.05"
        for: 2m
      reactorHighCPU:
        severity: warning
        for: 5m
```
* **`JasminSMPPConnectorDown`**: Critical alert when upstream carrier SMPP session bound count reaches 0.
* **`JasminHighSubmitErrorRate`**: Warning when MT message submit error rate exceeds 5%.
* **`JasminReactorHighCPU`**: Warning when single-core CPU utilization exceeds 90% for >5m, signaling the need for horizontal pod scaling.

---

## 8. Verification Proof

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

## 9. Enterprise Web Management Dashboard (`gui/`)

A high-performance, zero-auth Node.js (TypeScript) Web Management Console connecting directly to Jasmin Gateway on `127.0.0.1:8990`, `127.0.0.1:1401`, and RabbitMQ on `5672`.

### Core Capabilities:
1. **Live AMQP Traffic & DLR Monitor:** Native AMQP 0-9-1 tap into exchange `messaging` (`submit.sm.*`, `submit.sm.resp.*`, `dlr_thrower.*`). Provides an in-memory ring buffer (up to 10,000 messages) with instant full-text search, status filtering (`SUBMITTED`, `ESME_ROK`, `DELIVRD`, `UNDELIV`), auto-scroll, and CSV export.
2. **Deep PDU Inspector:** One-click inspection of decoded SMPP PDU payloads (Source/Dest TON/NPI, Data Coding, Priority, Route CID, SMSC Delivery Receipt, and round-trip latency).
3. **Interactive jCLI Web Terminal (xterm.js):** Direct full-duplex interactive terminal in the browser connected via WebSocket to port `8990` with ANSI styling, autocomplete, and command history.
4. **Interactive Route Match Simulator:** Test any combination of User UID, Sender ID, Recipient Phone, and Message Content against active filters and MT routes to visualize exact routing resolution.
5. **Visual Filter Studio with Live Regex Testing:** Configure all 11 Jasmin filter types with an interactive real-time regex validator before saving.
6. **Gateway State Snapshot & Portability:** One-click JSON backup/export of all users, groups, connectors, filters, and routes, with instant restore.
7. **NOC Cockpit (Overview):** Live real-time throughput chart (TPS), system status badges, and Twisted core telemetry.
8. **User & Account Management:** Full CRUD for ESME clients, password generation, balance credits, and throughput limits.
9. **SMPP & HTTP Connectors:** Configure and monitor upstream carrier binds and HTTP webhooks.
10. **Persistence Safeguard:** One-click **Save Config** button triggering `persist` on Jasmin.

### Running the Dashboard:
```bash
cd gui
npm install
npm run build
npm start # Starts web server on http://localhost:3000
```

### Verified Screenshots:
Saved in [`gui/screenshots/`](file:///home/taha/Desktop/jasmain/gui/screenshots/):
- `01_noc_cockpit.png`: NOC Cockpit and live throughput chart.
- `02_users_accounts.png`: ESME user management table and balances.
- `03_connectors.png`: HTTP Webhook connectors.
- `04_routing_engine.png`: MO Routing Engine table.
- `05_sms_sandbox.png`: SMS Dispatch Sandbox console.
