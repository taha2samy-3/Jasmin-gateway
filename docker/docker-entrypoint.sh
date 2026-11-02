#!/usr/bin/env bash
set -e

CONFIG_PATH="${CONFIG_PATH:-/etc/jasmin}"

# Ensure JCLI_ADMIN_PASSWORD env var is converted to MD5 hex digest
# because Jasmin's ConfigFile automatically reads JCLI_ADMIN_PASSWORD from os.environ
# and JCliConfig runs binascii.unhexlify on it.
if [ -n "$JCLI_ADMIN_PASSWORD" ]; then
    if [ ${#JCLI_ADMIN_PASSWORD} -ne 32 ]; then
        export JCLI_ADMIN_RAW_PASSWORD="${JCLI_ADMIN_PASSWORD}"
        export JCLI_ADMIN_PASSWORD=$(python3 -c "import hashlib, os; print(hashlib.md5(os.environ['JCLI_ADMIN_PASSWORD'].encode()).hexdigest())")
    else
        export JCLI_ADMIN_RAW_PASSWORD="${JCLI_ADMIN_RAW_PASSWORD:-$JCLI_ADMIN_PASSWORD}"
    fi
fi

# Dynamically update configuration from environment variables if configure.py is present
if [ -f "/usr/local/bin/configure.py" ] && [ -f "${CONFIG_PATH}/jasmin.cfg" ]; then
    python3 /usr/local/bin/configure.py "${CONFIG_PATH}/jasmin.cfg"
fi

# Clean up lock files from previous unclean shutdowns
echo "[INFO] Cleaning up stale lock files..."
rm -f /tmp/*.lock

# Optionally start embedded interceptord if requested
if [[ " $* " == *" --enable-interceptor-client "* ]] && [ "${START_EMBEDDED_INTERCEPTOR:-true}" = "true" ]; then
    echo "[INFO] Starting embedded interceptord daemon in background..."
    interceptord.py &
fi

# Run background bootstrap to restore persisted configuration and provision routes if configured
if [[ " $* " == *"jasmind.py"* ]] && [ "${ENABLE_BOOTSTRAP:-true}" = "true" ] && [ -f "/usr/local/bin/bootstrap-routes.py" ]; then
    echo "[INFO] Starting background bootstrap route provisioner..."
    python3 /usr/local/bin/bootstrap-routes.py &
fi

echo "[INFO] Starting command: $@"
exec "$@"

