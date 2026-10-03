import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "scan_summary.py"


def run(kind, content, title="Mẫu"):
    d = tempfile.mkdtemp()
    f = Path(d) / "x.json"
    if content is not None:
        f.write_text(content)
    return subprocess.run(
        [sys.executable, str(SCRIPT), "--kind", kind, "--title", title, str(f)], capture_output=True, text=True
    )


class ScanSummary(unittest.TestCase):
    def test_pip_vuln(self):
        data = {"dependencies": [{"name": "foo", "version": "1.0", "vulns": [
            {"id": "PYSEC-1", "fix_versions": ["1.1"], "aliases": []}]}, {"name": "ok", "version": "2", "vulns": []}]}
        r = run("pip-audit", json.dumps(data))
        self.assertEqual(r.returncode, 0)
        self.assertIn("PYSEC-1", r.stdout)
        self.assertIn("1.1", r.stdout)
        self.assertIn("::warning::", r.stderr)

    def test_pip_clean(self):
        r = run("pip-audit", json.dumps({"dependencies": [{"name": "a", "version": "1", "vulns": []}]}))
        self.assertEqual(r.returncode, 0)
        self.assertIn("✅", r.stdout)
        self.assertNotIn("::warning::", r.stderr)

    def test_npm(self):
        data = {"metadata": {"vulnerabilities": {"critical": 0, "high": 1, "moderate": 2, "low": 0, "info": 0}},
                "vulnerabilities": {
                    "lodash": {"severity": "high", "fixAvailable": True, "via": []},
                    "a": {"severity": "moderate", "fixAvailable": False, "via": []},
                    "b": {"severity": "moderate", "fixAvailable": False, "via": []}}}
        r = run("npm-audit", json.dumps(data))
        self.assertEqual(r.returncode, 0)
        self.assertIn("high 1", r.stdout)
        self.assertIn("moderate 2", r.stdout)
        self.assertIn("lodash", r.stdout)
        self.assertNotIn("| a |", r.stdout)
        self.assertEqual(r.stderr.count("::warning::"), 1)

    def test_govulncheck_stream(self):
        objs = [
            {"config": {"scanner_name": "govulncheck"}},
            {"finding": {"osv": "GO-2024-0001", "fixed_version": "v1.2.3",
                         "trace": [{"module": "m/x", "version": "v1.0.0", "package": "m/x", "function": "Do"}]}},
            {"finding": {"osv": "GO-2024-0002", "trace": [{"module": "m/y", "version": "v1.0.0"}]}},
        ]
        r = run("govulncheck", "\n".join(json.dumps(o, indent=1) for o in objs))
        self.assertEqual(r.returncode, 0)
        self.assertIn("cao (mã thật sự gọi tới)", r.stdout)
        self.assertIn("thấp", r.stdout)
        self.assertEqual(r.stderr.count("::warning::"), 1)

    def test_missing_and_broken(self):
        for content in (None, "", "{hỏng"):
            r = run("pip-audit", content)
            self.assertEqual(r.returncode, 0)
            self.assertIn("Không chạy được quét", r.stdout)

    def test_bad_kind(self):
        self.assertEqual(run("khac", "{}").returncode, 2)


if __name__ == "__main__":
    unittest.main()
