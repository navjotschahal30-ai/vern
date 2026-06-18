// Strips anything outside printable ASCII (0x20-0x7E) before building the
// auth header. Copy-pasting an API key out of a rich-text source (Google
// Docs, Slack, some browser address bars) can silently substitute a
// Unicode line/paragraph separator (U+2028/U+2029) for a real line break —
// invisible in a text field, but Node's fetch rejects it outright since
// HTTP header values must be plain Latin-1 bytes. A real Lofty key is JWT-
// shaped (base64url + dots), entirely within this range, so sanitizing is
// safe and makes the app resilient to how the credential got into the
// environment rather than depending on a perfect paste every time.
function sanitizeApiKey(rawKey: string | undefined): string {
  return (rawKey ?? '').replace(/[^\x20-\x7E]/g, '').trim();
}

export function getLoftyHeaders(): Record<string, string> {
  return {
    Authorization: `token ${sanitizeApiKey(process.env.LOFTY_API_KEY)}`,
    'Content-Type': 'application/json',
  };
}
