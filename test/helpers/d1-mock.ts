export class D1Mock {
  entries: any[] = [];

  prepare(sql: string) {
    const s = sql.replace(/\s+/g, " ").trim();
    const db = this;

    const makeStmt = (args: any[]) => ({
      async run() {
        if (s.startsWith("INSERT INTO entries")) {
          const [id, content, tags, source, created_at, vector_ids] = args;
          db.entries.push({ id, content, tags, source, created_at, vector_ids, recall_count: 0, importance_score: 0 });
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("UPDATE entries SET content = ?, vector_ids")) {
          const [content, vector_ids, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) { row.content = content; row.vector_ids = vector_ids; }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET vector_ids")) {
          const [vector_ids, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) row.vector_ids = vector_ids;
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET content = ?, tags")) {
          const [content, tags, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) { row.content = content; row.tags = tags; }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET content")) {
          const [content, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) row.content = content;
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET recall_count")) {
          const [id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) row.recall_count = (row.recall_count ?? 0) + 1;
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET importance_score")) {
          const [score, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) row.importance_score = score;
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("DELETE FROM entries WHERE id")) {
          const [id] = args;
          const before = db.entries.length;
          db.entries = db.entries.filter((e: any) => e.id !== id);
          return { meta: { changes: before - db.entries.length } };
        }
        return { meta: {} };
      },
      async first() {
        if (s.includes("SELECT vector_ids FROM entries WHERE id")) {
          const row = db.entries.find((e: any) => e.id === args[0]);
          return row ? { vector_ids: row.vector_ids } : null;
        }
        if (s.includes("COUNT(*) as count") && s.includes("AVG(importance_score)")) {
          const count = db.entries.length;
          const scored = db.entries.filter((e: any) => typeof e.importance_score === "number");
          const avg_importance = scored.length > 0
            ? scored.reduce((sum: number, e: any) => sum + e.importance_score, 0) / scored.length
            : null;
          return { count, avg_importance };
        }
        if (s.includes("COUNT(*) as count")) {
          return { count: db.entries.length };
        }
        if (s.includes("WHERE id") && !s.includes("json_each")) {
          return db.entries.find((e: any) => e.id === args[0]) ?? null;
        }
        return null;
      },
      async all() {
        if (s.includes("recall_count FROM entries")) {
          const results = db.entries
            .filter((e: any) => args.includes(e.id))
            .map((e: any) => ({ id: e.id, recall_count: e.recall_count ?? 0 }));
          return { results };
        }
        if (s.includes("SELECT id, content FROM entries WHERE id IN")) {
          const results = db.entries
            .filter((e: any) => args.includes(e.id))
            .map((e: any) => ({ id: e.id, content: e.content }));
          return { results };
        }
        if (s.includes("json_each(entries.tags)") && s.includes("GROUP BY value")) {
          // Top tags by frequency — for /stats
          const freq = new Map<string, number>();
          db.entries.forEach((e: any) => {
            (JSON.parse(e.tags ?? "[]") as string[]).forEach(t => freq.set(t, (freq.get(t) ?? 0) + 1));
          });
          const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
          return { results: sorted.map(([value, n]) => ({ value, n })) };
        }
        if (s.includes("json_each(entries.tags)")) {
          // Distinct sorted tags — for /tags
          const tags = new Set<string>();
          db.entries.forEach((e: any) => {
            (JSON.parse(e.tags ?? "[]") as string[]).forEach(t => tags.add(t));
          });
          return { results: [...tags].sort().map(t => ({ value: t })) };
        }
        if (s.includes("ORDER BY created_at DESC LIMIT")) {
          const limit = Number(args[args.length - 1]);
          const rows = [...db.entries].sort((a: any, b: any) => b.created_at - a.created_at);
          return { results: rows.slice(0, limit) };
        }
        return { results: [] };
      },
    });

    return {
      bind(...args: any[]) { return makeStmt(args); },
      ...makeStmt([]),
    };
  }

  async exec(_sql: string) { }
  async batch(stmts: any[]) { return Promise.all(stmts.map((s: any) => s.run())); }
  reset() { this.entries = []; }
}
