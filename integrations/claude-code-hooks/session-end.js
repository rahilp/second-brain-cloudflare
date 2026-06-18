#!/usr/bin/env node
'use strict';

async function main() {
  const baseUrl = process.env.SECOND_BRAIN_URL;
  const token = process.env.SECOND_BRAIN_TOKEN;
  if (!baseUrl || !token) return;

  let raw = '';
  try {
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) {
      raw += chunk;
      if (raw.length > 200_000) break;
    }
  } catch {
    return;
  }

  if (!raw.trim()) return;

  let transcript;
  try {
    transcript = JSON.parse(raw);
  } catch {
    return;
  }

  const messages = transcript?.messages ?? transcript?.conversation ?? [];
  if (!Array.isArray(messages) || messages.length === 0) return;

  const meaningful = messages
    .filter(m => (m?.role === 'user' || m?.role === 'assistant') && typeof m?.content === 'string' && m.content.trim().length > 0)
    .slice(-10);

  if (meaningful.length === 0) return;

  const content = meaningful
    .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.trim()}`)
    .join('\n\n');

  if (content.length < 50) return;

  const body = content.length > 2000 ? content.slice(0, 2000) + '...' : content;

  try {
    await fetch(`${baseUrl}/capture`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: body, source: 'claude-code', tags: ['session'] }),
    });
  } catch {
    // silent — hooks must not disrupt session close
  }
}

main().catch(() => {});
