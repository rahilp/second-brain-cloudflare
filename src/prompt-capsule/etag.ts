const encoder = new TextEncoder();

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function strongEtag(namespace: string, representation: string): Promise<string> {
  const hash = await sha256Hex(`${namespace}\0${representation}`);
  return `"${namespace}-${hash}"`;
}

function weakValue(value: string): string {
  return value.startsWith("W/") ? value.slice(2) : value;
}

/** RFC-style weak comparison is sufficient for conditional GET and HEAD. */
export function ifNoneMatchMatches(header: string | null, currentEtag: string): boolean {
  if (!header) return false;
  const current = weakValue(currentEtag);
  return header.split(",").some(value => {
    const candidate = value.trim();
    return candidate === "*" || weakValue(candidate) === current;
  });
}
