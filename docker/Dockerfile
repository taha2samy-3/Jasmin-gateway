FROM python:3.12-slim-bookworm

LABEL maintainer="Jasmin SMS Gateway"
LABEL description="Production-ready container image for Jasmin SMS Gateway"

# Install system runtime & build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    libffi-dev \
    libssl-dev \
    libjemalloc2 \
    procps \
    netcat-traditional \
    curl \
    ca-certificates \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Optimize memory allocation for Twisted Python process via jemalloc
ENV LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libjemalloc.so.2

# Define paths
ENV ROOT_PATH=/
ENV CONFIG_PATH=/etc/jasmin
ENV RESOURCE_PATH=/etc/jasmin/resource
ENV STORE_PATH=/etc/jasmin/store
ENV LOG_PATH=/var/log/jasmin
ENV UNICODEMAP_JP=unicode-ascii

# Create non-root system user and group
RUN groupadd -r -g 1000 jasmin && \
    useradd -r -u 1000 -g jasmin -d /etc/jasmin -s /bin/bash jasmin

# Create directories and assign ownership
RUN mkdir -p ${CONFIG_PATH} ${RESOURCE_PATH} ${STORE_PATH} ${LOG_PATH} && \
    chown -R jasmin:jasmin ${CONFIG_PATH} ${LOG_PATH}

# Install setuptools<82 (for pkg_resources compatibility in Jasmin), Jasmin, and Prometheus client
ARG JASMIN_VERSION=0.11.1
RUN pip install --no-cache-dir "setuptools<82" "jasmin==${JASMIN_VERSION}" prometheus-client

# Copy default configurations and resources
COPY config/jasmin.cfg ${CONFIG_PATH}/jasmin.cfg
COPY config/interceptor.cfg ${CONFIG_PATH}/interceptor.cfg
COPY config/resource/ ${RESOURCE_PATH}/

# Copy dynamic configuration helper, bootstrap provisioner, and entrypoint
COPY configure.py /usr/local/bin/configure.py
COPY bootstrap-routes.py /usr/local/bin/bootstrap-routes.py
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /usr/local/bin/configure.py /usr/local/bin/bootstrap-routes.py /docker-entrypoint.sh && \
    chown -R jasmin:jasmin ${CONFIG_PATH}

WORKDIR /etc/jasmin

# Expose ports:
# 2775: SMPP Server (MT/MO)
# 1401: HTTP API & Prometheus metrics (/metrics)
# 8990: jCli Telnet Management Console
# 8987: Interceptor PB
# 8989: SMPP Client Manager PB
# 8988: Router PB
EXPOSE 2775 1401 8990 8987

# Volumes for persistence
VOLUME ["/etc/jasmin/store", "/var/log/jasmin"]

USER jasmin

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["jasmind.py", "--enable-interceptor-client", "--enable-dlr-thrower", "--enable-dlr-lookup", "-u", "jcliadmin", "-p", "jclipwd"]
