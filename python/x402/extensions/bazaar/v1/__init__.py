"""V1 Bazaar Discovery Extension support.

In v1, discovery information is stored in the `output_schema` field
of PaymentRequirements, which has a different structure than v2.

This module transforms v1 data into v2 DiscoveryInfo format.
"""

from .facilitator import (
    build_bazaar_extension_from_discovery_info,
    build_v1_catalog_extensions,
    extract_discovery_info_v1,
    extract_resource_metadata_v1,
    is_discoverable_v1,
)

__all__ = [
    "build_bazaar_extension_from_discovery_info",
    "build_v1_catalog_extensions",
    "extract_discovery_info_v1",
    "is_discoverable_v1",
    "extract_resource_metadata_v1",
]
