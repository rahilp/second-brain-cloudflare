import type { Env } from "../env";

export const VECTORIZE_INDEX_NAME = "second-brain-vectors";

export interface VectorizeHealth {
  ok: boolean;
  indexName: string;
  dimensions?: number;
  error?: string;
}

export async function checkVectorizeHealth(env: Env): Promise<VectorizeHealth> {
  try {
    const info = (await env.VECTORIZE.describe()) as any;
    return {
      ok: true,
      indexName: VECTORIZE_INDEX_NAME,
      dimensions: info?.dimensions ?? info?.config?.dimensions,
    };
  } catch (e) {
    return {
      ok: false,
      indexName: VECTORIZE_INDEX_NAME,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
