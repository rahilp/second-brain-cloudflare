import type { Env } from "../env";
import { resolveConfig } from "../config";
import { initializeDatabase } from "../db/init";
import { COMPRESSION_MIN_AGE_MS, compressionEligibilitySql } from "./eligibility";
import { compressTag } from "./digest";

export async function runNightlyCompression(env: Env, ctx: ExecutionContext): Promise<void> {
  const cfg = await resolveConfig(env);
  await initializeDatabase(env);

  const { results } = await env.DB.prepare(`
    SELECT value as tag, COUNT(*) as count
    FROM entries, json_each(entries.tags)
    WHERE value NOT IN ('synthesized', 'auto-pattern', 'duplicate-candidate', 'contradiction-resolved', 'rolled-up')
      AND value NOT LIKE 'status:%'
      AND value NOT LIKE 'kind:%'
      AND entries.tags NOT LIKE '%"rolled-up"%'
      AND entries.tags NOT LIKE '%"synthesized"%'
      AND entries.tags NOT LIKE '%"auto-pattern"%'
      AND ${compressionEligibilitySql("entries.", cfg)}
    GROUP BY value
    HAVING count > 10
    ORDER BY count DESC
  `).bind(Date.now() - cfg.COMPRESSION_MIN_AGE_MS).all();

  for (const row of results) {
    const tag = row.tag as string;
    try {
      await compressTag(tag, env, ctx);
    } catch (e) {
      console.error(`Compression failed for tag "${tag}" (non-fatal):`, e);
    }
  }
}
