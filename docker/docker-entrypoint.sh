#!/bin/sh
set -e

CONFIG_PATH="${CONFIG_PATH:-/etc/jasmin}"

# --- Environment files (e.g. rendered by the Vault Agent Injector) ------------------------------
# JASMIN_ENV_FILES: colon-separated list of shell files with `export KEY='value'` lines. They are
# sourced (executed) by this shell, so only point it at files you control. A listed file that is
# missing stops the container: starting with fallback credentials would be worse than not starting.
# Values from these files win over the container env, and the common service names below are
# mapped onto Jasmin's own variables. Only names actually set by the files are mapped, so the
# REDIS_PORT=tcp://... style variables Kubernetes injects for Services are never picked up.
ALIASES="REDIS_HOST:REDIS_CLIENT_HOST REDIS_PORT:REDIS_CLIENT_PORT REDIS_PASSWORD:REDIS_CLIENT_PASSWORD
RABBITMQ_HOST:AMQP_BROKER_HOST RABBITMQ_PORT:AMQP_BROKER_PORT RABBITMQ_USER:AMQP_BROKER_USER
RABBITMQ_PASSWORD:AMQP_BROKER_PASSWORD RABBITMQ_VHOST:AMQP_BROKER_VHOST"
if [ -n "${JASMIN_ENV_FILES:-}" ]; then
    for pair in $ALIASES; do
        src="${pair%%:*}"
        eval "__before_${src}=\${${src}-__unset__}"
    done
    old_ifs="$IFS"; IFS=':'
    for env_file in $JASMIN_ENV_FILES; do
        IFS="$old_ifs"
        [ -z "$env_file" ] && continue
        if [ ! -r "$env_file" ]; then
            echo "[ERROR] JASMIN_ENV_FILES lists ${env_file}, which does not exist or is not readable" >&2
            exit 1
        fi
        # shellcheck disable=SC1090
        . "$env_file"
        echo "[INFO] Loaded environment from ${env_file}"
    done
    IFS="$old_ifs"
    for pair in $ALIASES; do
        src="${pair%%:*}"; dst="${pair#*:}"
        eval "before=\${__before_${src}}; now=\${${src}-__unset__}"
        if [ "$now" != "__unset__" ] && [ "$now" != "$before" ]; then
            eval "export ${dst}=\"\$now\""
        fi
        unset "__before_${src}"
    done
    unset before now src dst pair env_file old_ifs
fi
unset ALIASES

# --- Log to stdout (JASMIN_LOG_TO_STDOUT=true) ------------------------------------------------------
# Every Jasmin component switches to a stream handler when its log_file contains "stdout", and
# reads <SECTION>_LOG_FILE from the environment, so no config rewrite is needed. Logs then go to
# the container log (kubectl logs, Fluent Bit, Promtail...) and no log volume has to be cleaned.
# Per-connector SMPP client logs are set per connector in jCLI (`logfile /dev/stdout`).
if [ "${JASMIN_LOG_TO_STDOUT:-false}" = "true" ]; then
    for section in SMPP_SERVER SMPP_SERVER_PB CLIENT_MANAGEMENT SERVICE_SMPPCLIENT SM_LISTENER DLR \
                   DLR_THROWER DELIVERSM_THROWER HTTP_API ROUTER JCLI REDIS_CLIENT AMQP_BROKER \
                   INTERCEPTOR REST_API; do
        eval "export ${section}_LOG_FILE=/dev/stdout"
    done
    unset section
    # The HTTP API access log stays a file: Twisted seeks in it, which fails on a pipe
    # ("Illegal seek" stops the HTTP API). It is small: one line per HTTP request.
    echo "[INFO] Jasmin logs go to stdout"
fi

# jCLI admin password. JCLI_ADMIN_PASSWORD is ALWAYS the plain-text password: it is never
# inspected to guess whether it is already a hash (a random 32-character hex password, e.g.
# `openssl rand -hex 16`, would otherwise be mistaken for one and login would fail).
# Jasmin reads JCLI_ADMIN_PASSWORD from the environment as the *stored* password, so the plain
# value moves to JCLI_ADMIN_RAW_PASSWORD (jasmind -p, bootstrap, console) and JCLI_ADMIN_PASSWORD
# becomes a salted PBKDF2-SHA256 hash (the image patches jCLI to verify it; no MD5).
# Unusable passwords (non-ASCII, surrounding spaces, control characters) stop the container here.
JCLI_PLAIN="${JCLI_ADMIN_PASSWORD:-${JCLI_ADMIN_RAW_PASSWORD:-}}"
if [ -n "$JCLI_PLAIN" ]; then
    export JCLI_ADMIN_RAW_PASSWORD="$JCLI_PLAIN"
    unset JCLI_ADMIN_PASSWORD
    JCLI_ADMIN_PASSWORD="$(python /usr/local/bin/configure.py --jcli-digest)" || exit 1
    export JCLI_ADMIN_PASSWORD
fi
unset JCLI_PLAIN

# Dynamically update configuration from environment variables if configure.py is present.
# In Kubernetes jasmin.cfg is usually a read-only ConfigMap mount: in that case the merged
# configuration is written to a writable runtime copy and jasmind is started with -c <copy>.
JASMIN_CFG="${CONFIG_PATH}/jasmin.cfg"
USE_RUNTIME_CFG=0
if [ -f "/usr/local/bin/configure.py" ] && [ -f "${JASMIN_CFG}" ]; then
    if [ -w "${JASMIN_CFG}" ]; then
        python /usr/local/bin/configure.py "${JASMIN_CFG}"
    else
        RUNTIME_DIR="${JASMIN_RUNTIME_DIR:-/tmp/jasmin-runtime}"
        mkdir -p "${RUNTIME_DIR}"
        cp "${JASMIN_CFG}" "${RUNTIME_DIR}/jasmin.cfg"
        chmod 600 "${RUNTIME_DIR}/jasmin.cfg"
        python /usr/local/bin/configure.py "${RUNTIME_DIR}/jasmin.cfg"
        JASMIN_CFG="${RUNTIME_DIR}/jasmin.cfg"
        USE_RUNTIME_CFG=1
        echo "[INFO] ${CONFIG_PATH}/jasmin.cfg is read-only; using ${JASMIN_CFG}"
    fi
fi

# Clean up lock files from previous unclean shutdowns
echo "[INFO] Cleaning up stale lock files..."
rm -f /tmp/*.lock

# Optionally start embedded interceptord daemon if requested
case " $* " in
    *" --enable-interceptor-client "*)
        if [ "${START_EMBEDDED_INTERCEPTOR:-true}" = "true" ]; then
            echo "[INFO] Starting embedded interceptord daemon in background..."
            interceptord.py &
        fi
        ;;
esac

# Run background bootstrap to restore persisted configuration and provision routes if configured
case " $* " in
    *"jasmind.py"*)
        if [ "${ENABLE_BOOTSTRAP:-true}" = "true" ] && [ -f "/usr/local/bin/bootstrap-routes.py" ]; then
            echo "[INFO] Starting background bootstrap route provisioner..."
            python /usr/local/bin/bootstrap-routes.py &
        fi
        ;;
esac

# jasmind loads the persisted configuration with -u/-p at start-up. The image CMD carries the
# default jCLI credentials: replace them with the configured ones so the load succeeds.
if [ "$(basename "$1")" = "jasmind.py" ] && [ -n "${JCLI_ADMIN_RAW_PASSWORD:-}" ]; then
    cmd="$1"; shift
    new_args=""
    skip=""
    for arg in "$@"; do
        if [ -n "$skip" ]; then skip=""; continue; fi
        case "$arg" in
            -u|--username|-p|--password) skip=1; continue ;;
            --username=*|--password=*) continue ;;
            --enable-interceptor-client)
                [ "${ENABLE_INTERCEPTOR_CLIENT:-true}" = "false" ] && continue ;;
        esac
        new_args="$new_args $(printf '%s' "$arg" | sed "s/'/'\\\\''/g; s/^/'/; s/\$/'/")"
    done
    eval "set -- \"\$cmd\" $new_args"
    set -- "$@" -u "${JCLI_ADMIN_USERNAME:-jcliadmin}" -p "${JCLI_ADMIN_RAW_PASSWORD}"
fi

# Point jasmind at the runtime copy unless the caller passed its own -c/--config.
if [ "${USE_RUNTIME_CFG}" = "1" ] && [ "$(basename "$1")" = "jasmind.py" ]; then
    case " $* " in
        *" -c "*|*" --config"*) ;;
        *) cmd="$1"; shift; set -- "$cmd" -c "${JASMIN_CFG}" "$@" ;;
    esac
fi

# Log the command without the jCLI password (masked per argument, so spaces cannot leak it).
shown=""
mask_next=""
for arg in "$@"; do
    if [ -n "$mask_next" ]; then shown="$shown ******"; mask_next=""; continue; fi
    case "$arg" in
        -p|--password) mask_next=1; shown="$shown $arg" ;;
        --password=*) shown="$shown --password=******" ;;
        *) shown="$shown $arg" ;;
    esac
done
echo "[INFO] Starting command:${shown}"
exec "$@"
