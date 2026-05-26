"""Tests to verify that all __all__ exports from x402.extensions are importable.

This test ensures that the public API contract is maintained - everything
listed in __all__ must be importable from the top-level x402.extensions module.
"""

import pytest

# Import the module to get access to __all__
from x402 import extensions


class TestExtensionExports:
    """Test that all __all__ exports are importable."""

    def test_all_exports_are_importable(self) -> None:
        """Test that every item in __all__ can be imported from x402.extensions."""
        # Get the list of exported names
        exported_names = extensions.__all__

        # Try to import each exported name
        missing_exports = []
        for name in exported_names:
            try:
                # Try to get the attribute from the module
                attr = getattr(extensions, name)
                if attr is None:
                    missing_exports.append(f"{name} (is None)")
            except AttributeError as e:
                missing_exports.append(f"{name} ({e})")

        if missing_exports:
            pytest.fail(
                "The following exports from __all__ are not importable:\n"
                + "\n".join(f"  - {name}" for name in missing_exports)
            )

    def test_validation_result_imports(self) -> None:
        """Test that ValidationResult and its aliases work correctly."""
        from x402.extensions import (
            BazaarValidationResult,
            PaymentIdentifierValidationResult,
            ValidationResult,
        )

        # ValidationResult should be an alias for BazaarValidationResult
        assert ValidationResult is BazaarValidationResult

        # All three should be different classes
        assert ValidationResult is not PaymentIdentifierValidationResult
        assert BazaarValidationResult is not PaymentIdentifierValidationResult

    def test_import_all_star(self) -> None:
        """Test that 'from x402.extensions import *' works correctly."""
        # Create a new namespace
        namespace = {}
        # Execute import * in that namespace
        exec("from x402.extensions import *", namespace)

        # Verify all __all__ items are in the namespace
        exported_names = extensions.__all__
        missing = [name for name in exported_names if name not in namespace]
        if missing:
            pytest.fail(
                "The following exports are missing from 'import *':\n"
                + "\n".join(f"  - {name}" for name in missing)
            )
