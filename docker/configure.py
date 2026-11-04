#!/usr/bin/env python3
"""
Dynamic configuration updater for Jasmin SMS Gateway.
Safely updates INI configuration files from environment variables.
"""
import os
import sys
import configparser

def update_jasmin_config(config_file):
    if not os.path.isfile(config_file):
        print(f"Config file {config_file} not found, skipping dynamic update.")
        return

    parser = configparser.ConfigParser(interpolation=None)
    parser.read(config_file)

    def set_val(section, option, *env_vars):
        for env_var in env_vars:
            val = os.getenv(env_var)
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
    jcli_pwd = os.getenv("JCLI_ADMIN_PASSWORD")
    if jcli_pwd:
        # If not already a 32-char MD5 hex digest, compute MD5 digest so jCLI can authenticate properly
        if not (len(jcli_pwd) == 32 and all(c in "0123456789abcdefABCDEF" for c in jcli_pwd)):
            import hashlib
            jcli_pwd = hashlib.md5(jcli_pwd.encode("utf-8")).hexdigest()
        parser.set("jcli", "admin_password", jcli_pwd)

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
    cfg_path = sys.argv[1] if len(sys.argv) > 1 else "/etc/jasmin/jasmin.cfg"
    update_jasmin_config(cfg_path)

