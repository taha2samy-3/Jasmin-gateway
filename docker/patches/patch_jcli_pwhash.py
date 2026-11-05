#!/usr/bin/env python3
"""
Replace Jasmin's MD5 check of the jCLI admin password with PBKDF2-SHA256 (see jcli_pwhash.py).

Usage: patch_jcli_pwhash.py <site-packages>/jasmin

Every replacement must match the installed source exactly once; otherwise the build fails, so an
upstream change can never leave a half-patched (or silently unpatched) image.
Already-patched trees are left untouched.
"""
import os
import shutil
import sys

PATCHES = {
    "protocols/cli/configs.py": [
        (
            "        self.admin_password = binascii.unhexlify(self._get('jcli', 'admin_password',\n"
            "                                                           '79e9b0aa3f3e7c53e916f7ac47439bcb'))\n",
            "        # Patched: kept as the stored string, verified by jasmin.protocols.cli.pwhash.\n"
            "        self.admin_password = self._get('jcli', 'admin_password',\n"
            "                                        '79e9b0aa3f3e7c53e916f7ac47439bcb')\n",
        ),
    ],
    "protocols/cli/jcli.py": [
        ("from hashlib import md5\n", "from jasmin.protocols.cli import pwhash\n"),
        (
            "md5(self.authentication['password']).digest() == self.factory.config.admin_password):",
            "pwhash.verify(self.authentication['password'], self.factory.config.admin_password)):",
        ),
    ],
    "protocols/cli/factory.py": [
        ("from hashlib import md5\n", "from jasmin.protocols.cli import pwhash\n"),
        (
            "                        md5(self.loadConfigProfileWithCreds['password'].encode(\n"
            "                            'ascii')).digest() != self.config.admin_password):\n",
            "                        not pwhash.verify(self.loadConfigProfileWithCreds['password'],\n"
            "                                          self.config.admin_password)):\n",
        ),
    ],
}
MARKER = "from jasmin.protocols.cli import pwhash"


def main(pkg):
    here = os.path.dirname(os.path.abspath(__file__))
    jcli_src = os.path.join(pkg, "protocols/cli/jcli.py")
    with open(jcli_src) as f:
        if MARKER in f.read():
            print("jCLI password hashing already patched")
            return 0

    # Validate everything before writing anything.
    patched = {}
    for rel, replacements in PATCHES.items():
        path = os.path.join(pkg, rel)
        with open(path) as f:
            text = f.read()
        for old, new in replacements:
            count = text.count(old)
            if count != 1:
                sys.exit(f"[patch_jcli_pwhash] expected 1 match in {rel}, found {count}: {old.strip()[:70]!r}")
            text = text.replace(old, new)
        if "md5(" in text and rel != "protocols/cli/configs.py":
            sys.exit(f"[patch_jcli_pwhash] {rel} still calls md5() after patching")
        patched[path] = text

    shutil.copyfile(os.path.join(here, "jcli_pwhash.py"), os.path.join(pkg, "protocols/cli/pwhash.py"))
    for path, text in patched.items():
        with open(path, "w") as f:
            f.write(text)
    print("Patched jCLI admin password verification: PBKDF2-SHA256 instead of MD5")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    sys.exit(main(sys.argv[1]))
