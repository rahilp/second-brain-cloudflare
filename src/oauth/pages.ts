const OAUTH_PAGE_STYLES = `
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #f4f1ea; --bg-card: #fcfbf7;
      --accent: #b26641; --accent-press: #9c522f; --accent-soft: rgba(178, 102, 65, 0.1); --on-accent: #fcfbf7;
      --text-primary: #26241f; --text-secondary: #6e6b62; --text-tertiary: #a8a498;
      --border-input: rgba(38, 36, 31, 0.11); --danger: #b3261e;
      --font-serif: Georgia, 'Times New Roman', serif; --font-sans: system-ui, -apple-system, 'Segoe UI', sans-serif;
      --ease: cubic-bezier(0.22, 1, 0.36, 1);
    }
    body { background: var(--bg); font-family: var(--font-sans); color: var(--text-primary); min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .auth-card { width: 100%; max-width: 400px; padding: 40px 32px; display: flex; flex-direction: column; align-items: center; animation: fade-in 0.5s var(--ease); }
    @keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
    .brain-logo { width: 70px; height: 70px; border-radius: 50%; background: var(--accent-soft); color: var(--accent); display: flex; align-items: center; justify-content: center; margin-bottom: 24px; position: relative; }
    .brain-logo svg { width: 33px; height: 33px; }
    .brain-logo::after { content: ''; position: absolute; inset: -7px; border-radius: 50%; border: 1px solid var(--accent-soft); }
    h1 { font-family: var(--font-serif); font-size: 29px; font-weight: 500; margin-bottom: 9px; letter-spacing: -0.015em; }
    p { font-size: 14px; color: var(--text-secondary); margin-bottom: 34px; text-align: center; line-height: 1.6; max-width: 300px; }
    form { width: 100%; display: flex; flex-direction: column; gap: 11px; margin-bottom: 14px; }
    input { width: 100%; padding: 14px 16px; background: var(--bg-card); border: 0.5px solid var(--border-input); border-radius: 13px; font-family: var(--font-sans); font-size: 15px; color: var(--text-primary); outline: none; transition: border-color 0.18s, box-shadow 0.18s; }
    input::placeholder { color: var(--text-tertiary); }
    input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
    button { width: 100%; padding: 15px; background: var(--accent); color: var(--on-accent); border: none; border-radius: 13px; font-family: var(--font-sans); font-size: 15px; font-weight: 600; cursor: pointer; transition: background 0.18s, transform 0.12s var(--ease); }
    button:hover { background: var(--accent-press); }
    button:active { transform: scale(0.985); }
    .auth-error { font-size: 13px; color: var(--danger); text-align: center; margin-top: 10px; min-height: 18px; }
    .auth-hint { font-size: 13px; color: var(--text-secondary); text-align: center; line-height: 1.55; max-width: 340px; }
    .auth-detail { font-size: 12px; color: var(--text-tertiary); text-align: center; margin-top: 14px; line-height: 1.45; max-width: 340px; }
`;

export const OAUTH_BRAIN_LOGO = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.5 4a2.5 2.5 0 0 0-2.45 2.96"/><path d="M14.5 4a2.5 2.5 0 0 1 2.45 2.96"/><path d="M4.5 11.5a7.5 7.5 0 0 1 15 0"/><path d="M6.5 11.5c0 2.2 1.2 4.1 3 5.2"/><path d="M17.5 11.5c0 2.2-1.2 4.1-3 5.2"/><path d="M9 16.5c.6 1.1 1.7 2 3 2s2.4-.9 3-2"/></svg>`;

export function oauthPageHtml(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <meta name="theme-color" content="#F4F1EA" />
  <title>${title}</title>
  <style>${OAUTH_PAGE_STYLES}</style>
</head>
<body>
  <div class="auth-card">
    <div class="brain-logo">${OAUTH_BRAIN_LOGO}</div>
    ${body}
  </div>
</body>
</html>`;
}

// Hosted OAuth login page. Self-contained (no CDN) so auth works in any browser session.
export function loginHtml(error?: string): string {
  return oauthPageHtml("Second Brain", `
    <h1>Second Brain</h1>
    <p>Enter your Bearer token to connect to your personal memory layer. This is the password you chose when you set up Second Brain.</p>
    <form method="POST">
      <input type="password" name="password" placeholder="Bearer token (your setup password)" autofocus autocomplete="current-password" />
      <button type="submit">Connect</button>
    </form>
    <div class="auth-error">${error ? error : ""}</div>
  `);
}

export function authorizeErrorHtml(hint: string, detail?: string): string {
  const detailBlock = detail
    ? `<p class="auth-detail">${detail}</p>`
    : "";
  return oauthPageHtml("Second Brain — sign-in error", `
    <h1>Could not start sign-in</h1>
    <p class="auth-hint">${hint}</p>
    ${detailBlock}
  `);
}

export function authorizeErrorHint(message: string): string {
  if (message.includes("Invalid client") || message.includes("clientId")) {
    return "Your MCP client has a stale OAuth registration. In Cursor: Settings → MCP → remove Second Brain, add it again, then click Connect.";
  }
  if (message.includes("redirect URI")) {
    return "The redirect URI from your MCP client does not match its registration. Remove and re-add the MCP server in Cursor, then authenticate again.";
  }
  return "Open this page from your MCP client (Cursor, Claude, ChatGPT), not by typing the URL manually.";
}
