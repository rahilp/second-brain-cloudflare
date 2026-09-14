const OAUTH_PAGE_STYLES = `
    @font-face { font-family: 'Sora'; src: url(/fonts/sora.ttf) format('truetype'); font-weight: 100 800; font-display: swap; }
    @font-face { font-family: 'DM Sans'; src: url(/fonts/dm-sans-400.ttf) format('truetype'); font-weight: 400; font-display: swap; }
    @font-face { font-family: 'DM Sans'; src: url(/fonts/dm-sans-500.ttf) format('truetype'); font-weight: 500; font-display: swap; }
    @font-face { font-family: 'DM Sans'; src: url(/fonts/dm-sans-600.ttf) format('truetype'); font-weight: 600; font-display: swap; }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #ffffff; --card: #f3f4f6;
      --ink: #202124; --muted: #61646c; --line: #e2e4e8;
      --action: #cc4109; --action-hover: #a63508; --on-action: #ffffff;
      --focus: #bd410e; --danger: #b42318;
      --font-display: 'Sora', 'DM Sans', system-ui, sans-serif;
      --font-sans: 'DM Sans', system-ui, sans-serif;
      --ease: cubic-bezier(0.16, 1, 0.3, 1);
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #17181b; --card: #1e1f23;
        --ink: #f3f4f6; --muted: #c3c6cc; --line: #2f3237;
        --action: #ff9a61; --action-hover: #ffab6e; --on-action: #17181b;
        --focus: #ff9a61; --danger: #ff8a7a;
      }
    }
    body { background: var(--bg); font-family: var(--font-sans); color: var(--ink); min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .auth-card { width: 100%; max-width: 400px; padding: 40px 32px; background: var(--card); border-radius: 14px; display: flex; flex-direction: column; align-items: center; animation: fade-in 0.5s var(--ease); }
    @keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
    .brand-lockup { display: block; width: 174px; height: 25px; margin-bottom: 28px; }
    h1 { font-family: var(--font-display); font-size: 24px; font-weight: 500; letter-spacing: -0.02em; margin-bottom: 9px; text-align: center; }
    p { font-size: 14px; color: var(--muted); margin-bottom: 34px; text-align: center; line-height: 1.6; max-width: 300px; }
    form { width: 100%; display: flex; flex-direction: column; gap: 11px; margin-bottom: 14px; }
    input { width: 100%; padding: 14px 16px; background: var(--bg); border: 1px solid var(--line); border-radius: 6px; font-family: var(--font-sans); font-size: 15px; color: var(--ink); outline: none; transition: border-color 0.18s, box-shadow 0.18s; }
    input::placeholder { color: var(--muted); }
    button { width: 100%; height: 44px; display: flex; align-items: center; justify-content: center; background: var(--action); color: var(--on-action); border: none; border-radius: 7px; font-family: var(--font-sans); font-size: 15px; font-weight: 600; cursor: pointer; transition: background-color 0.15s var(--ease); }
    button:hover { background: var(--action-hover); }
    :is(input, button):focus-visible { outline: 3px solid var(--focus); outline-offset: 4px; }
    .auth-error { font-size: 13px; color: var(--danger); text-align: center; margin-top: 10px; min-height: 18px; }
    .auth-hint { font-size: 13px; color: var(--muted); text-align: center; line-height: 1.55; max-width: 340px; }
    .auth-detail { font-size: 12px; color: var(--muted); text-align: center; margin-top: 14px; line-height: 1.45; max-width: 340px; }
`;

export const OAUTH_BRAND_LOCKUP = `<picture>
      <source srcset="/brand-lockup-reverse.png" media="(prefers-color-scheme: dark)" />
      <img class="brand-lockup" src="/brand-lockup.png" alt="Second Brain" width="174" height="25" />
    </picture>`;

// Ampersand first so the entities introduced below survive later passes.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function oauthPageHtml(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <meta name="theme-color" content="#ffffff" />
  <meta name="theme-color" content="#17181b" media="(prefers-color-scheme: dark)" />
  <title>${escapeHtml(title)}</title>
  <style>${OAUTH_PAGE_STYLES}</style>
</head>
<body>
  <div class="auth-card">
    ${OAUTH_BRAND_LOCKUP}
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
    <div class="auth-error">${error ? escapeHtml(error) : ""}</div>
  `);
}

export function authorizeErrorHtml(hint: string, detail?: string): string {
  const detailBlock = detail
    ? `<p class="auth-detail">${escapeHtml(detail)}</p>`
    : "";
  return oauthPageHtml("Second Brain: sign-in error", `
    <h1>Could not start sign-in</h1>
    <p class="auth-hint">${escapeHtml(hint)}</p>
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
