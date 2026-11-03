# Build Stage: Wolfi Python development environment
FROM ghcr.io/taha2samy-3/python:3.12-dev AS builder

USER root
WORKDIR /build

ARG JASMIN_VERSION=0.11.1

# Create virtualenv and install build tools, setuptools<82 (for pkg_resources compatibility), Jasmin and prometheus-client
RUN python -m venv /opt/venv && \
    /opt/venv/bin/pip install --no-cache-dir --upgrade pip "setuptools<82" wheel && \
    /opt/venv/bin/pip install --no-cache-dir "jasmin==${JASMIN_VERSION}" prometheus-client

# Runtime Stage: Minimal hardened Wolfi Python image (No Alpine, stripped binaries)
FROM ghcr.io/taha2samy-3/python:3.12 AS runner

LABEL maintainer="taha2samy-3 (Unofficial Community Distribution)"
LABEL description="Unofficial production-ready container image for Jasmin SMS Gateway on hardened Wolfi Linux"

USER root

# Define environment variables and paths
ENV ROOT_PATH=/ \
    CONFIG_PATH=/etc/jasmin \
    RESOURCE_PATH=/etc/jasmin/resource \
    STORE_PATH=/etc/jasmin/store \
    LOG_PATH=/var/log/jasmin \
    UNICODEMAP_JP=unicode-ascii \
    PATH="/opt/venv/bin:$PATH"

# Create jasmin non-root system user and groups (UID 1000)
RUN (deluser python 2>/dev/null || true) && \
    adduser -D -u 1000 -h /etc/jasmin -s /bin/sh jasmin && \
    ln -sf /usr/bin/python /usr/bin/python3 && \
    mkdir -p ${CONFIG_PATH} ${RESOURCE_PATH} ${STORE_PATH} ${LOG_PATH} && \
    chown -R jasmin:jasmin ${CONFIG_PATH} ${RESOURCE_PATH} ${STORE_PATH} ${LOG_PATH}

# Copy pre-built virtual environment with all Python wheels from builder
COPY --from=builder --chown=jasmin:jasmin /opt/venv /opt/venv

# Copy default configurations and resources
COPY --chown=jasmin:jasmin config/jasmin.cfg ${CONFIG_PATH}/jasmin.cfg
COPY --chown=jasmin:jasmin config/interceptor.cfg ${CONFIG_PATH}/interceptor.cfg
COPY --chown=jasmin:jasmin config/resource/ ${RESOURCE_PATH}/

# Copy dynamic configuration helper, bootstrap provisioner, and entrypoint
COPY --chown=jasmin:jasmin configure.py /usr/local/bin/configure.py
COPY --chown=jasmin:jasmin bootstrap-routes.py /usr/local/bin/bootstrap-routes.py
COPY --chown=jasmin:jasmin docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /usr/local/bin/configure.py /usr/local/bin/bootstrap-routes.py /docker-entrypoint.sh

WORKDIR /etc/jasmin

# Expose ports:
# 2775: SMPP Server (MT/MO)
# 1401: HTTP API & Prometheus metrics (/metrics)
# 8990: jCli Telnet Management Console
# 8987: Interceptor PB
# 8989: SMPP Client Manager PB (smppccm management)
# 8988: Router PB
EXPOSE 2775 1401 8990 8987 8989 8988

# Volumes for persistence
VOLUME ["/etc/jasmin/store", "/var/log/jasmin"]

USER jasmin

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["jasmind.py", "--enable-interceptor-client", "--enable-dlr-thrower", "--enable-dlr-lookup", "-u", "jcliadmin", "-p", "jclipwd"]
