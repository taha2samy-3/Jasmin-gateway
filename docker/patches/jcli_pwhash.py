"""
jCLI admin password hashing (installed as jasmin/protocols/cli/pwhash.py by patch_jcli_pwhash.py).

Upstream Jasmin 0.11.1 stores the jCLI admin password as an unsalted MD5 hex digest and compares
md5(password). This module replaces that with salted PBKDF2-HMAC-SHA256:

    pbkdf2_sha256$<iterations>$<salt b64>$<hash b64>

A stored value without that prefix is the upstream MD5 hex format. It is still accepted so an
image started without a password (default jcliadmin/jclipwd) keeps working; the entrypoint always
writes the PBKDF2 format when a password is configured.

Only the standard library is used (hashlib.pbkdf2_hmac, implemented in C).
"""
import base64
import binascii
import hashlib
import hmac
import os

PREFIX = "pbkdf2_sha256"
# jCLI logins run on Twisted's reactor thread, so verification time stalls SMPP/HTTP traffic for
# that long. 100k iterations is ~40-60 ms; the password is also expected to be long and random.
DEFAULT_ITERATIONS = 100_000
_MAX_ITERATIONS = 2_000_000


def _b64(data):
    return base64.b64encode(data).decode("ascii")


def make(plain, iterations=DEFAULT_ITERATIONS, salt=None):
    """Hash a plain-text password into the stored format."""
    if isinstance(plain, str):
        plain = plain.encode("utf-8")
    salt = salt if salt is not None else os.urandom(16)
    digest = hashlib.pbkdf2_hmac("sha256", plain, salt, iterations)
    return "%s$%d$%s$%s" % (PREFIX, iterations, _b64(salt), _b64(digest))


def verify(password, stored):
    """Constant-time check of a password (str or bytes) against a stored value."""
    if password is None or stored is None:
        return False
    if isinstance(password, str):
        password = password.encode("utf-8")
    if isinstance(stored, bytes):
        stored = stored.decode("ascii", "replace")
    stored = stored.strip()

    if stored.startswith(PREFIX + "$"):
        try:
            _, iterations, salt_b64, hash_b64 = stored.split("$")
            iterations = int(iterations)
            salt = base64.b64decode(salt_b64, validate=True)
            expected = base64.b64decode(hash_b64, validate=True)
        except (ValueError, binascii.Error):
            return False
        if not 1 <= iterations <= _MAX_ITERATIONS or not expected:
            return False
        actual = hashlib.pbkdf2_hmac("sha256", password, salt, iterations, dklen=len(expected))
        return hmac.compare_digest(actual, expected)

    # Upstream format: MD5 hex digest (kept only for the unconfigured default credentials).
    try:
        expected = binascii.unhexlify(stored)
    except (ValueError, binascii.Error):
        return False
    return hmac.compare_digest(hashlib.md5(password).digest(), expected)
