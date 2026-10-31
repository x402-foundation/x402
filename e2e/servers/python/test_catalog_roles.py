"""The Python resource-server catalog exposes managed routes only in that role."""

import os
import unittest
from unittest.mock import patch

from catalog import catalog_routes


class CatalogRoleTests(unittest.TestCase):
    def setUp(self):
        filters = patch.dict(os.environ, {"E2E_EXCLUDE_SCHEMES": "", "E2E_EXCLUDE_NETWORKS": ""})
        filters.start()
        self.addCleanup(filters.stop)

    def test_standard_role_excludes_managed_routes(self):
        with patch.dict(os.environ, {"E2E_BATCH_SERVER_ROLE": "standard"}):
            self.assertFalse(any("batch-settlement-managed" in r.path for r in catalog_routes()))

    def test_managed_role_has_only_managed_routes(self):
        with patch.dict(os.environ, {"E2E_BATCH_SERVER_ROLE": "managed-batch"}):
            routes = catalog_routes()
        self.assertEqual(len(routes), 4)
        self.assertTrue(all("batch-settlement-managed" in r.path for r in routes))


if __name__ == "__main__":
    unittest.main()
