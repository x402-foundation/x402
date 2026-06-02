"""Bazaar catalog for storing discovered x402 resources.

This module provides a simple in-memory catalog for discovered resources during e2e testing
"""

from typing import Any

from x402.extensions.bazaar import DiscoveryResource


class BazaarCatalog:
    """Catalog for storing discovered x402 resources."""

    def __init__(self) -> None:
        self._resources: dict[str, DiscoveryResource] = {}

    def add(self, resource: DiscoveryResource) -> None:
        """Add a discovered resource to the catalog."""
        print(f"📝 Discovered resource: {resource.resource}")
        print(f"   x402 Version: {resource.x402_version}")
        if resource.service_name is not None:
            print(f"   Service: {resource.service_name}")
        if resource.tags is not None:
            print(f"   Tags: {', '.join(resource.tags)}")

        self._resources[resource.resource] = resource

    def get_resources(self, limit: int = 100, offset: int = 0) -> dict[str, Any]:
        """Get paginated list of discovered resources."""
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

    def search_resources(
        self,
        query: str,
        resource_type: str | None = None,
        limit: int | None = None,
    ) -> dict[str, Any]:
        """Search resources using case-insensitive keyword matching."""
        needle = query.lower()
        results = []
        for r in self._resources.values():
            haystack = " ".join(
                [
                    r.resource,
                    r.type,
                    r.description or "",
                    r.service_name or "",
                    *(r.tags or []),
                    *[str(v) for v in (r.extensions or {}).values()],
                ]
            ).lower()
            if needle in haystack:
                results.append(r)

        if resource_type:
            results = [r for r in results if r.type == resource_type]

        items = results[:limit] if limit is not None else results

        return {
            "x402Version": 2,
            "resources": [r.to_dict() for r in items],
            "partialResults": False,
            "pagination": None,
        }

    def get_count(self) -> int:
        """Get total count of discovered resources."""
        return len(self._resources)
