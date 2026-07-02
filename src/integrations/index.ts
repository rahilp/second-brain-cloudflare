/**
 * Second Brain — integration registry.
 *
 * Adding a provider: create src/integrations/<provider>.ts exporting an
 * IntegrationProvider (see framework.ts for the contract), and register it
 * here. The Worker's routes (/integrations/:provider/…), the nightly cron, the
 * mirror edit guard, and the settings UI all iterate this registry — no other
 * code changes needed.
 */

import type { IntegrationProvider } from "./framework";
import { notionProvider } from "./notion";

export const INTEGRATION_PROVIDERS: Record<string, IntegrationProvider> = {
  [notionProvider.id]: notionProvider,
};

export function getProvider(id: string): IntegrationProvider | null {
  return Object.prototype.hasOwnProperty.call(INTEGRATION_PROVIDERS, id)
    ? INTEGRATION_PROVIDERS[id]
    : null;
}

export * from "./framework";
export {
  notionProvider,
  notionValidateToken,
  notionListPages,
  notionFetchPageText,
  extractPageTitle,
  flattenBlocks,
  buildPageContent,
  computeSyncPlan,
  SYNC_PAGE_BATCH,
} from "./notion";
export type { NotionPageMeta, SyncPlan } from "./notion";
