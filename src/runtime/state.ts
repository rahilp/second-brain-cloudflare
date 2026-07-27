import type { Env } from "../env";
import { initializeDatabase } from "../db/init";

let dbReady = false;

export function isDbReady(): boolean {
  return dbReady;
}

export function setDbReady(ready: boolean): void {
  dbReady = ready;
}

export function ensureDbReady(ctx: ExecutionContext, env: Env): void {
  if (!dbReady) {
    ctx.waitUntil(initializeDatabase(env).then(() => { dbReady = true; }));
  }
}
