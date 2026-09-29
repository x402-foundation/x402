/**
 * HTTP-specific Bazaar Discovery Extension types and builders
 */

export type {
  QueryDiscoveryInfo,
  BodyDiscoveryInfo,
  QueryDiscoveryExtension,
  BodyDiscoveryExtension,
  DeclareQueryDiscoveryExtensionConfig,
  DeclareBodyDiscoveryExtensionConfig,
  DiscoveredHTTPResource,
} from "./types";

export { isQueryExtensionConfig, isBodyExtensionConfig } from "./types";

export { createQueryDiscoveryExtension, createBodyDiscoveryExtension } from "./resourceService";
