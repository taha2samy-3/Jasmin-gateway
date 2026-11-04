#!/bin/sh
set -e

CONFIG_PATH="${CONFIG_PATH:-/etc/jasmin}"

# Ensure JCLI_ADMIN_PASSWORD env var is converted to MD5 hex digest
# because Jasmin's ConfigFile automatically reads JCLI_ADMIN_PASSWORD from os.environ
# and JCliConfig runs binascii.unhexlify on it.
if [ -n "$JCLI_ADMIN_PASSWORD" ]; then
    if [ ${#JCLI_ADMIN_PASSWORD} -ne 32 ]; then
        export JCLI_ADMIN_RAW_PASSWORD="${JCLI_ADMIN_PASSWORD}"
        export JCLI_ADMIN_PASSWORD=$(python -c "import hashlib, os; print(hashlib.md5(os.environ['JCLI_ADMIN_PASSWORD'].encode()).hexdigest())")
    else
        export JCLI_ADMIN_RAW_PASSWORD="${JCLI_ADMIN_RAW_PASSWORD:-$JCLI_ADMIN_PASSWORD}"
    fi
fi

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
