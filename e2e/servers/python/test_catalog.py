"""Catalog payment terms must reach Python middleware unchanged."""

import json
import unittest
from pathlib import Path

from catalog import resolve_routes


class SplitRouteTests(unittest.TestCase):
    def test_split_terms_are_preserved(self):
        definition = json.loads(
            (Path(__file__).parents[2] / "config/mechanisms_svm.json").read_text()
        )["routes"]["/exact/svm/splits"]
        routes = resolve_routes({"SERVER_SVM_ADDRESS": "merchant"}.get)
        route = next(route for route in routes if route.path == "/exact/svm/splits")
        self.assertEqual(route.extra, definition["requirementsExtra"])


if __name__ == "__main__":
    unittest.main()
