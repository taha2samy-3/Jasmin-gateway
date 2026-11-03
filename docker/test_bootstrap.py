import json
import os
import socket
import tempfile
import threading
import unittest
import importlib.util

spec = importlib.util.spec_from_file_location(
    "bootstrap_routes",
    os.path.join(os.path.dirname(__file__), "bootstrap-routes.py")
)
bootstrap_routes = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap_routes)

class TestJasminBootstrap(unittest.TestCase):
    def setUp(self):
        self.tmp_dir = tempfile.mkdtemp()
        self.routes_file = os.path.join(self.tmp_dir, "routes.json")

    def tearDown(self):
        if os.path.exists(self.routes_file):
            os.remove(self.routes_file)
        if os.path.exists(self.tmp_dir):
            os.rmdir(self.tmp_dir)

    def test_bootstrap_with_mock_jcli(self):
        routes_data = {
            "httpConnectors": [
                {
                    "cid": "sms_webhook",
                    "url": "https://sms.example.com/mo",
                    "method": "POST"
                }
            ],
            "moRoutes": [
                {
                    "type": "DefaultRoute",
                    "connector": "http(sms_webhook)"
                }
            ]
        }
        with open(self.routes_file, "w") as f:
            json.dump(routes_data, f)

        # Start a local mock jCLI server on an ephemeral port
        server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        server.bind(("127.0.0.1", 0))
        server.listen(5)
        port = server.getsockname()[1]

        def handle_client():
            # First accept probe connection from wait_for_jcli()
            probe, _ = server.accept()
            probe.close()

            # Second accept main session connection
            conn, _ = server.accept()
            conn.sendall(b"Authentication required.\n")
            conn.recv(1024)
            conn.sendall(b"Password: ")
            conn.recv(1024)
            conn.sendall(b"Welcome to Jasmin 0.11.1 console\r\njcli : ")

            while True:
                try:
                    data = conn.recv(1024)
                    if not data:
                        break
                    cmd = data.decode(errors="ignore").strip()
                    if cmd == "ko":
                        conn.sendall(b"jcli : ")
                    elif cmd == "load":
                        conn.sendall(b"Configuration loaded.\r\njcli : ")
                    elif cmd == "httpccm -l":
                        conn.sendall(b"#Httpcc id   Type      Method  Url\r\njcli : ")
                    elif cmd == "httpccm -a":
                        conn.sendall(b"jcli (httpcc-add) : ")
                    elif cmd.startswith("cid ") or cmd.startswith("url ") or cmd.startswith("method "):
                        conn.sendall(b"jcli (httpcc-add) : ")
                    elif cmd == "ok":
                        conn.sendall(b"Successfully added HttpConnector\r\njcli : ")
                    elif cmd == "morouter -l":
                        conn.sendall(b"#Order Type   Connector\r\njcli : ")
                    elif cmd == "morouter -a":
                        conn.sendall(b"jcli (moroute-add) : ")
                    elif cmd.startswith("type ") or cmd.startswith("connector "):
                        conn.sendall(b"jcli (moroute-add) : ")
                    elif cmd == "persist":
                        conn.sendall(b"Configuration persisted.\r\njcli : ")
                    else:
                        conn.sendall(b"OK\r\njcli : ")
                except:
                    break
            conn.close()
            server.close()

        server_thread = threading.Thread(target=handle_client, daemon=True)
        server_thread.start()

        os.environ["JCLI_HOST"] = "127.0.0.1"
        os.environ["JCLI_PORT"] = str(port)
        os.environ["JCLI_ADMIN_USERNAME"] = "jcliadmin"
        os.environ["JCLI_ADMIN_PASSWORD"] = "jclipwd"
        os.environ["JASMIN_ROUTES_FILE"] = self.routes_file

        try:
            # Run bootstrap
            bootstrap_routes.run_bootstrap()
        finally:
            del os.environ["JCLI_HOST"]
            del os.environ["JCLI_PORT"]
            del os.environ["JCLI_ADMIN_USERNAME"]
            del os.environ["JCLI_ADMIN_PASSWORD"]
            del os.environ["JASMIN_ROUTES_FILE"]

if __name__ == "__main__":
    unittest.main()
