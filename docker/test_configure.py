import os
import tempfile
import unittest
import re
import subprocess
import sys
from configure import update_jasmin_config, jcli_password_digest
from jcli_pwhash import verify

class TestJasminConfigure(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.NamedTemporaryFile(mode="w+", delete=False, suffix=".cfg")
        self.tmp.write("""[redis-client]
host = 127.0.0.1
port = 6379

[amqp-broker]
host = 127.0.0.1
port = 5672

[jcli]
bind = 0.0.0.0
port = 8990
""")
        self.tmp.close()

    def tearDown(self):
        if os.path.exists(self.tmp.name):
            os.remove(self.tmp.name)

    def test_update_config_from_env(self):
        os.environ["REDIS_HOST"] = "redis-cluster.internal"
        os.environ["REDIS_PORT"] = "6380"
        os.environ["AMQP_HOST"] = "rabbitmq.internal"
        os.environ["JCLI_ADMIN_PASSWORD"] = "myplainsecret"

        try:
            update_jasmin_config(self.tmp.name)
            with open(self.tmp.name, "r") as f:
                content = f.read()

            self.assertIn("host = redis-cluster.internal", content)
            self.assertIn("port = 6380", content)
            self.assertIn("host = rabbitmq.internal", content)

            stored = re.search(r"admin_password = (\S+)", content).group(1)
            self.assertTrue(stored.startswith("pbkdf2_sha256$"), stored)
            self.assertTrue(verify("myplainsecret", stored))
            self.assertFalse(verify("wrong", stored))
        finally:
            del os.environ["REDIS_HOST"]
            del os.environ["REDIS_PORT"]
            del os.environ["AMQP_HOST"]
            del os.environ["JCLI_ADMIN_PASSWORD"]

    def test_publish_submit_sm_resp_from_env(self):
        os.environ["SM_LISTENER_PUBLISH_SUBMIT_SM_RESP"] = "True"
        try:
            update_jasmin_config(self.tmp.name)
            with open(self.tmp.name, "r") as f:
                content = f.read()
            self.assertIn("[sm-listener]", content)
            self.assertIn("publish_submit_sm_resp = True", content)
        finally:
            del os.environ["SM_LISTENER_PUBLISH_SUBMIT_SM_RESP"]

    def test_publish_submit_sm_resp_untouched_without_env(self):
        update_jasmin_config(self.tmp.name)
        with open(self.tmp.name, "r") as f:
            self.assertNotIn("publish_submit_sm_resp", f.read())

class TestServiceLinkVariables(unittest.TestCase):
    def test_kubernetes_service_link_port_is_ignored(self):
        tmp = tempfile.NamedTemporaryFile(mode="w+", delete=False, suffix=".cfg")
        tmp.write("[redis-client]\nport = 6379\n")
        tmp.close()
        os.environ["REDIS_PORT"] = "tcp://10.0.0.5:6379"
        try:
            update_jasmin_config(tmp.name)
            with open(tmp.name) as f:
                self.assertIn("port = 6379", f.read())
        finally:
            del os.environ["REDIS_PORT"]
            os.remove(tmp.name)


class TestJcliPassword(unittest.TestCase):
    def test_hex_looking_password_is_plain_text(self):
        # `openssl rand -hex 16` output: must be hashed like any other password, never trusted as a hash.
        pw = "5f4dcc3b5aa765d61d8327deb882cf99"
        stored = jcli_password_digest(pw)
        self.assertTrue(stored.startswith("pbkdf2_sha256$"))
        self.assertTrue(verify(pw, stored))

    def test_salted(self):
        self.assertNotEqual(jcli_password_digest("same-password"), jcli_password_digest("same-password"))

    def test_rejects_unusable_passwords(self):
        for bad in ["", "kl\u00e9", " lead", "trail ", "tab\tinside", "new\nline"]:
            with self.assertRaises(ValueError, msg=repr(bad)):
                jcli_password_digest(bad)

    def test_inner_spaces_and_symbols_allowed(self):
        pw = "a b$c'd\"e`f!"
        self.assertTrue(verify(pw, jcli_password_digest(pw)))

    def _cli(self, **env):
        e = {k: v for k, v in os.environ.items() if not k.startswith("JCLI_ADMIN")}
        e.update(env)
        here = os.path.dirname(os.path.abspath(__file__))
        return subprocess.run([sys.executable, os.path.join(here, "configure.py"), "--jcli-digest"], env=e, capture_output=True, text=True)

    def test_cli_prefers_raw_password(self):
        r = self._cli(JCLI_ADMIN_RAW_PASSWORD="plain-one", JCLI_ADMIN_PASSWORD="ignored")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue(verify("plain-one", r.stdout.strip()))

    def test_cli_fails_clearly(self):
        r = self._cli(JCLI_ADMIN_PASSWORD="pässword")
        self.assertEqual(r.returncode, 2)
        self.assertIn("ASCII", r.stderr)

    def test_legacy_md5_still_verifies_default(self):
        self.assertTrue(verify(b"jclipwd", "79e9b0aa3f3e7c53e916f7ac47439bcb"))
        self.assertFalse(verify(b"other", "79e9b0aa3f3e7c53e916f7ac47439bcb"))
        self.assertFalse(verify(b"x", "pbkdf2_sha256$garbage"))


if __name__ == "__main__":
    unittest.main()

