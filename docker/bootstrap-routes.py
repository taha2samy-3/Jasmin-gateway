#!/usr/bin/env python3
"""
Bootstrap script for Jasmin SMS Gateway.
1. Waits for jCLI to start listening.
2. Authenticates to jCLI console.
3. Automatically executes 'load' to restore persisted configurations from store.
4. If /etc/jasmin/routes.json is present, idempotently provisions:
   - HTTP Client Connectors (httpccm)
   - MO Routes (morouter)
   - MT Routes (mtrouter)
5. Executes 'persist' to ensure everything is saved to /etc/jasmin/store.
"""
import json
import logging
import os
import socket
import sys
import time

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] [bootstrap] %(message)s"
)
logger = logging.getLogger("jasmin-bootstrap")

def wait_for_jcli(host, port, max_attempts=45, delay=2):
    logger.info(f"Waiting for jCLI at {host}:{port}...")
    for attempt in range(1, max_attempts + 1):
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(2)
        try:
            s.connect((host, port))
            s.close()
            logger.info(f"jCLI is reachable at {host}:{port} on attempt {attempt}.")
            return True
        except (socket.error, socket.timeout):
            s.close()
            time.sleep(delay)
    logger.error(f"Timed out waiting for jCLI at {host}:{port} after {max_attempts * delay}s.")
    return False

def run_bootstrap():
    host = os.getenv("JCLI_HOST", "127.0.0.1")
    port = int(os.getenv("JCLI_PORT", "8990"))
    username = os.getenv("JCLI_ADMIN_USERNAME", "jcliadmin")
    password = os.getenv("JCLI_ADMIN_RAW_PASSWORD") or os.getenv("JCLI_ADMIN_PASSWORD", "secretpassword")
    routes_file = os.getenv("JASMIN_ROUTES_FILE", "/etc/jasmin/routes.json")

    if not wait_for_jcli(host, port):
        sys.exit(1)

    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(5)
    s.connect((host, port))

    # Read banner and authenticate
    time.sleep(0.5)
    s.recv(1024)
    s.sendall(username.encode() + b"\n")
    time.sleep(0.5)
    s.recv(1024)
    s.sendall(password.encode() + b"\n")
    time.sleep(0.5)
    welcome = s.recv(1024).decode(errors="ignore")

    if "Welcome to Jasmin" not in welcome and "jcli :" not in welcome:
        logger.error(f"jCLI authentication failed: {welcome.strip()}")
        s.close()
        sys.exit(1)

    logger.info("Successfully authenticated to jCLI.")

    def exec_cmd(cmd):
        s.sendall(cmd.encode() + b"\n")
        time.sleep(0.35)
        out = b""
        while True:
            try:
                part = s.recv(4096)
                out += part
                if len(part) < 4096:
                    break
            except socket.timeout:
                break
        return out.decode(errors="ignore")

    # Clear any leftover prompt state
    exec_cmd("ko")

    # 1. Always attempt 'load' to reload stored profiles
    load_res = exec_cmd("load")
    logger.info("Executed 'load' to restore persisted configuration.")

    # 2. Check if routes file is present
    if not os.path.isfile(routes_file):
        logger.info(f"No routes file found at {routes_file}. Bootstrap completed.")
        s.close()
        return

    try:
        with open(routes_file, "r") as fp:
            routes_data = json.load(fp)
    except Exception as e:
        logger.error(f"Failed to parse routes file {routes_file}: {e}")
        s.close()
        sys.exit(1)

    has_changes = False

    # Provision HTTP Connectors
    http_connectors = routes_data.get("httpConnectors", [])
    if http_connectors:
        existing_ccs = exec_cmd("httpccm -l")
        for cc in http_connectors:
            cid = cc.get("cid")
            url = cc.get("url")
            method = cc.get("method", "POST").upper()
            if not cid or not url:
                continue

            if f"#{cid}" in existing_ccs or f" {cid} " in existing_ccs:
                logger.info(f"HttpConnector '{cid}' already exists, skipping.")
                continue

            logger.info(f"Provisioning HttpConnector '{cid}' ({method} -> {url})...")
            exec_cmd("httpccm -a")
            exec_cmd(f"cid {cid}")
            exec_cmd(f"url {url}")
            exec_cmd(f"method {method}")
            res = exec_cmd("ok")
            if "Successfully added" in res:
                logger.info(f"HttpConnector '{cid}' created successfully.")
                has_changes = True
            else:
                logger.error(f"Failed to create HttpConnector '{cid}': {res.strip()}")
                exec_cmd("ko")

    # Provision MO Routes
    mo_routes = routes_data.get("moRoutes", [])
    if mo_routes:
        existing_mo = exec_cmd("morouter -l")
        for r in mo_routes:
            rtype = r.get("type", "DefaultRoute")
            connector = r.get("connector")
            order = r.get("order", 0)
            if not connector:
                continue

            if connector in existing_mo:
                logger.info(f"MO Route for '{connector}' already exists, skipping.")
                continue

            logger.info(f"Provisioning MO Route ({rtype} -> {connector})...")
            exec_cmd("morouter -a")
            exec_cmd(f"type {rtype}")
            if rtype != "DefaultRoute":
                exec_cmd(f"order {order}")
            exec_cmd(f"connector {connector}")
            res = exec_cmd("ok")
            if "Successfully added" in res:
                logger.info(f"MO Route ({rtype} -> {connector}) created successfully.")
                has_changes = True
            else:
                logger.error(f"Failed to create MO Route: {res.strip()}")
                exec_cmd("ko")

    # Provision MT Routes
    mt_routes = routes_data.get("mtRoutes", [])
    if mt_routes:
        existing_mt = exec_cmd("mtrouter -l")
        for r in mt_routes:
            rtype = r.get("type", "DefaultRoute")
            connector = r.get("connector")
            rate = r.get("rate", "0.0")
            order = r.get("order", 0)
            if not connector:
                continue

            if connector in existing_mt:
                logger.info(f"MT Route for '{connector}' already exists, skipping.")
                continue

            logger.info(f"Provisioning MT Route ({rtype} -> {connector})...")
            exec_cmd("mtrouter -a")
            exec_cmd(f"type {rtype}")
            if rtype != "DefaultRoute":
                exec_cmd(f"order {order}")
            exec_cmd(f"rate {rate}")
            exec_cmd(f"connector {connector}")
            res = exec_cmd("ok")
            if "Successfully added" in res:
                logger.info(f"MT Route ({rtype} -> {connector}) created successfully.")
                has_changes = True
            else:
                logger.error(f"Failed to create MT Route: {res.strip()}")
                exec_cmd("ko")

    if has_changes:
        exec_cmd("persist")
        logger.info("Persisted all new configurations to store.")

    s.close()
    logger.info("Bootstrap process completed successfully.")

if __name__ == "__main__":
    run_bootstrap()

