#!/bin/sh
# Jasmin Console entrypoint: optional environment files, then the base image entrypoint.
set -e

# JASMIN_ENV_FILES: colon-separated list of shell files with `export KEY='value'` lines (e.g.
# rendered by the Vault Agent Injector). They are sourced (executed), so only point it at files
# you control. A listed file that is missing stops the container instead of starting the console
# with fallback credentials. Values from the files win over the container env; the names below
# are mapped onto the console's variables, but only when the files set them.
ALIASES="RABBITMQ_PASSWORD:RABBITMQ_PASS DASHBOARD_ADMIN_USERNAME:ADMIN_USERNAME DASHBOARD_ADMIN_PASSWORD:ADMIN_PASSWORD"
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
        echo "[console] Loaded environment from ${env_file}"
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

exec /usr/bin/docker-entrypoint.sh "$@"
