import os
import tempfile
import unittest
import hashlib
from configure import update_jasmin_config

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

            expected_hash = hashlib.md5(b"myplainsecret").hexdigest()
            self.assertIn(f"admin_password = {expected_hash}", content)
        finally:
            del os.environ["REDIS_HOST"]
            del os.environ["REDIS_PORT"]
            del os.environ["AMQP_HOST"]
            del os.environ["JCLI_ADMIN_PASSWORD"]

if __name__ == "__main__":
    unittest.main()
