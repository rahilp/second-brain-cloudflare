import { vi } from "vitest";
import { D1Mock } from "./d1-mock";
import type { Env } from "../../src/index";

export function makeVectorizeMock(overrides: Partial<VectorizeIndex> = {}): VectorizeIndex {
  return {
    query: vi.fn().mockResolvedValue({ matches: [] }),
    insert: vi.fn().mockResolvedValue({ mutationId: "m" }),
    deleteByIds: vi.fn().mockResolvedValue({ mutationId: "m" }),
    upsert: vi.fn().mockResolvedValue({ mutationId: "m" }),
    getByIds: vi.fn().mockResolvedValue([]),
    describe: vi.fn().mockResolvedValue({}),
    ...overrides,
  } as unknown as VectorizeIndex;
}

export function makeAIMock(): Ai {
  return {
    run: vi.fn().mockImplementation(async (model: string) => {
      if (model === "@cf/baai/bge-small-en-v1.5")
        return { data: [new Array(384).fill(0.1)] };
      return new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {"response":"3"}\n\n'));
          c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          c.close();
        },
      });
    }),
  } as unknown as Ai;
}

export function makeTestDb() { return new D1Mock(); }

export function makeKVMock(): KVNamespace {
  return {
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue({ keys: [], list_complete: true, cacheStatus: null }),
  } as unknown as KVNamespace;
}

export function makeTestEnv(db?: D1Mock, overrides: Partial<Env> = {}): Env {
  return {
    DB: (db ?? new D1Mock()) as unknown as D1Database,
    VECTORIZE: makeVectorizeMock(),
    AI: makeAIMock(),
    AUTH_TOKEN: "test-token",
    OAUTH_KV: makeKVMock(),
    ...overrides,
  };
}
