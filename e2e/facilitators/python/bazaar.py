"""Bazaar catalog for storing discovered x402 resources.

This module provides a simple in-memory catalog for discovered resources during e2e testing
"""

from datetime import datetime
from typing import Any


class DiscoveredResource:
    """A discovered resource entry in the bazaar catalog."""

    def __init__(
        self,
        resource: str,
        resource_type: str,
        x402_version: int,
        accepts: list[dict[str, Any]],
        discovery_info: dict[str, Any] | None = None,
        route_template: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        self.resource = resource
        self.type = resource_type
        self.x402_version = x402_version
        self.accepts = accepts
        self.discovery_info = discovery_info
        self.route_template = route_template
        self.last_updated = datetime.now().isoformat()
        self.metadata = metadata or {}

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        result: dict[str, Any] = {
            "resource": self.resource,
            "type": self.type,
            "x402Version": self.x402_version,
            "accepts": self.accepts,
            "lastUpdated": self.last_updated,
            "metadata": self.metadata,
        }
        if self.discovery_info:
            result["discoveryInfo"] = self.discovery_info
        if self.route_template:
            result["routeTemplate"] = self.route_template
        return result


class BazaarCatalog:
    """Catalog for storing discovered x402 resources."""

    def __init__(self) -> None:
        self._resources: dict[str, DiscoveredResource] = {}

    def catalog_resource(
        self,
        resource_url: str,
        method: str,
        x402_version: int,
        discovery_info: dict[str, Any] | None,
        payment_requirements: dict[str, Any],
        route_template: str | None = None,
    ) -> None:
        """Add a discovered resource to the catalog.

        Args:
            resource_url: The URL of the discovered resource.
            method: The HTTP method (GET, POST, etc.).
            x402_version: The x402 protocol version.
            discovery_info: Optional discovery metadata.
            payment_requirements: The payment requirements for this resource.
            route_template: Optional route template for dynamic routes.
        """
        print(f"📝 Discovered resource: {resource_url}")
        print(f"   Method: {method}")
        print(f"   x402 Version: {x402_version}")
        if route_template:
            print(f"   Route template: {route_template}")

        self._resources[resource_url] = DiscoveredResource(
            resource=resource_url,
            resource_type="http",
            x402_version=x402_version,
            accepts=[payment_requirements],
            discovery_info=discovery_info,
            route_template=route_template,
            metadata={},
        )

    def get_resources(self, limit: int = 100, offset: int = 0) -> dict[str, Any]:
        """Get paginated list of discovered resources.

        Args:
            limit: Maximum number of resources to return.
            offset: Number of resources to skip.

        Returns:
            Dictionary with x402Version, items, and pagination info.
        """
        all_resources = list(self._resources.values())
        total = len(all_resources)
        items = all_resources[offset : offset + limit]

        return {
            "x402Version": 2,
            "items": [r.to_dict() for r in items],
            "pagination": {
                "limit": limit,
                "offset": offset,
                "total": total,
            },
        }

    def get_count(self) -> int:
        """Get total count of discovered resources."""
        return len(self._resources)
