#!/usr/bin/env python3
"""
Dynamic configuration updater for Jasmin SMS Gateway.
Safely updates INI configuration files from environment variables.
"""
import os
import sys
import configparser

# jcli_pwhash.py lives next to this script in the image and in docker/patches/ in the repo.
_HERE = os.path.dirname(os.path.abspath(__file__))
for _p in (_HERE, os.path.join(_HERE, "patches")):
    if _p not in sys.path:
        sys.path.insert(0, _p)
from jcli_pwhash import make as _hash_jcli_password  # noqa: E402


def jcli_plain_password():
    """The jCLI admin password as plain text.

    JCLI_ADMIN_PASSWORD is always plain text: it is never inspected to guess whether it is
    already a digest. The entrypoint moves the plain value to JCLI_ADMIN_RAW_PASSWORD before it
    replaces JCLI_ADMIN_PASSWORD with the digest Jasmin expects, so that one is read first.
    """
    return os.getenv("JCLI_ADMIN_RAW_PASSWORD") or os.getenv("JCLI_ADMIN_PASSWORD") or ""


def jcli_password_digest(plain):
    """Salted PBKDF2-SHA256 hash of the jCLI admin password (no MD5).

    Upstream Jasmin compares an unsalted MD5; the image patches jCLI to verify this format
    instead (patches/patch_jcli_pwhash.py). The rules below mirror what jasmind does with the
    password, so a value that could never log in is rejected at start-up with a clear message:
      - jasmind -p encodes it as ASCII (protocols/cli/factory.py): non-ASCII crashes start-up;
      - the jCLI login strips the typed password: surrounding whitespace can never match.
    """
    if not plain:
        raise ValueError("the jCLI admin password is empty")
    try:
        raw = plain.encode("ascii")
    except UnicodeEncodeError:
        raise ValueError("the jCLI admin password must contain ASCII characters only (Jasmin limitation)")
    if plain != plain.strip():
        raise ValueError("the jCLI admin password must not start or end with whitespace (jCLI strips it)")
    if any(ord(c) < 32 or ord(c) == 127 for c in plain):
        raise ValueError("the jCLI admin password must not contain control characters")
    return _hash_jcli_password(raw)


def update_jasmin_config(config_file):
    if not os.path.isfile(config_file):
        print(f"Config file {config_file} not found, skipping dynamic update.")
        return

    parser = configparser.ConfigParser(interpolation=None)
    parser.read(config_file)

    def set_val(section, option, *env_vars):
        for env_var in env_vars:
            val = os.getenv(env_var)
            # Kubernetes injects <SERVICE>_PORT=tcp://10.0.0.1:6379 for every Service in the
            # namespace (a Service named "redis" gives REDIS_PORT): never take that as a port.
            if option == "port" and val and not val.isdigit():
                print(f"[WARN] Ignoring {env_var}={val!r} for [{section}] port: not a port number")
                continue
            if val is not None and val != "":
                if not parser.has_section(section):
                    parser.add_section(section)
                parser.set(section, option, str(val))
                break

    # [redis-client]
    set_val("redis-client", "host", "REDIS_CLIENT_HOST", "REDIS_HOST")
    set_val("redis-client", "port", "REDIS_CLIENT_PORT", "REDIS_PORT")
    set_val("redis-client", "password", "REDIS_CLIENT_PASSWORD", "REDIS_PASSWORD")
    set_val("redis-client", "dbid", "REDIS_CLIENT_DBID", "REDIS_DBID")
    set_val("redis-client", "poolsize", "REDIS_CLIENT_POOLSIZE", "REDIS_POOLSIZE")

    # [amqp-broker]
    set_val("amqp-broker", "host", "AMQP_BROKER_HOST", "AMQP_HOST")
    set_val("amqp-broker", "port", "AMQP_BROKER_PORT", "AMQP_PORT")
    set_val("amqp-broker", "username", "AMQP_BROKER_USER", "AMQP_USER")
    set_val("amqp-broker", "password", "AMQP_BROKER_PASSWORD", "AMQP_PASSWORD")
    set_val("amqp-broker", "vhost", "AMQP_BROKER_VHOST", "AMQP_VHOST")

    # [jcli]
    if not parser.has_section("jcli"):
        parser.add_section("jcli")
    parser.set("jcli", "bind", os.getenv("JCLI_BIND", "0.0.0.0"))
    set_val("jcli", "port", "JCLI_PORT")
    set_val("jcli", "admin_username", "JCLI_ADMIN_USERNAME")
    jcli_plain = jcli_plain_password()
    if jcli_plain:
        parser.set("jcli", "admin_password", jcli_password_digest(jcli_plain))

    # [smpp-server]
    if not parser.has_section("smpp-server"):
        parser.add_section("smpp-server")
    parser.set("smpp-server", "bind", os.getenv("SMPP_SERVER_BIND", "0.0.0.0"))
    set_val("smpp-server", "port", "SMPP_SERVER_PORT")

    # [http-api]
    if not parser.has_section("http-api"):
        parser.add_section("http-api")
    parser.set("http-api", "bind", os.getenv("HTTP_API_BIND", "0.0.0.0"))
    set_val("http-api", "port", "HTTP_API_PORT")

    # [sm-listener]
    # publish_submit_sm_resp publishes carrier responses on submit.sm.resp.<cid>; the console's
    # live traffic view needs it to show acceptance and latency.
    set_val("sm-listener", "publish_submit_sm_resp", "SM_LISTENER_PUBLISH_SUBMIT_SM_RESP", "PUBLISH_SUBMIT_SM_RESP")

    # [interceptor-client]
    set_val("interceptor-client", "host", "INTERCEPTOR_HOST")
    set_val("interceptor-client", "port", "INTERCEPTOR_PORT")

    with open(config_file, "w") as fp:
        parser.write(fp)
    print(f"Updated configuration written to {config_file}")

if __name__ == "__main__":
    if sys.argv[1:] == ["--jcli-digest"]:
        # Used by docker-entrypoint.sh: print the hash of the plain password, or fail clearly.
        try:
            print(jcli_password_digest(jcli_plain_password()))
        except ValueError as err:
            print(f"[ERROR] {err}", file=sys.stderr)
            sys.exit(2)
        sys.exit(0)
    cfg_path = sys.argv[1] if len(sys.argv) > 1 else "/etc/jasmin/jasmin.cfg"
    update_jasmin_config(cfg_path)

