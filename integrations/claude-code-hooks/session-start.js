#!/usr/bin/env node
'use strict';

async function main() {
  const baseUrl = process.env.SECOND_BRAIN_URL;
  const token = process.env.SECOND_BRAIN_TOKEN;
  if (!baseUrl || !token) return;

  const cwd = process.cwd();
  const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean);
  const projectName = parts[parts.length - 1] ?? 'project';
  const query = `${projectName} recent context decisions and facts`;

  let data;
  try {
    const url = new URL('/recall', baseUrl);
    url.searchParams.set('q', query);
    url.searchParams.set('topK', '5');
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return;
    data = await res.json();
  } catch {
    return;
  }

  const results = (data?.results ?? data?.data ?? []);
  if (!results.length) return;

  const formatted = results
    .slice(0, 5)
    .map((r, i) => `${i + 1}. ${String(r.content ?? '').trim()}`)
    .filter(line => line.length > 3)
    .join('\n');

  if (formatted) {
    process.stdout.write(`[Second Brain] Context recalled:\n${formatted}\n`);
  }
}

main().catch(() => {});
