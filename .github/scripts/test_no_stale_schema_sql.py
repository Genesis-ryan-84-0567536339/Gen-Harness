import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
NEEDLE = "docs/handoff/schema.sql"


class NoStaleSchemaSql(unittest.TestCase):
    def test_file_gone(self):
        self.assertFalse((REPO / NEEDLE).exists())

    def test_docs_do_not_point_to_it(self):
        bad = []
        for p in (REPO / "docs").rglob("*.md"):
            if p.relative_to(REPO / "docs").parts[0] in ("audit", "reports"):
                continue
            for n, line in enumerate(p.read_text(encoding="utf-8").splitlines(), 1):
                if NEEDLE in line and "đã bỏ" not in line:
                    bad.append(f"{p.relative_to(REPO)}:{n}")
        self.assertEqual(bad, [])


if __name__ == "__main__":
    unittest.main()
