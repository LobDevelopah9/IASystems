# SAHP IA Portal: security checklist

Status of each item in the external vulnerability list, checked against this codebase. **Verified** means an automated test in `test/security.test.js` or `test/gates.test.js` proves it on every run (`npm test`). **N/A** means the portal has no such feature, so the attack has nothing to target.

The portal has **no passwords, no usernames, no password reset, and no user file uploads**. Sign-in is Discord OAuth only, and evidence files come only from the bot, from Discord's CDN.

## Authentication & authorization

| # | Item | Status |
|---|------|--------|
| 1 | User enumeration via timing | **N/A.** No username/password login exists. Discord authenticates the user. |
| 2 | No rate limiting | **Fixed, verified.** Sign-in: 20 per 10 min per IP. API: 300/min. Writes: 60/min. Limits count the real visitor IP passed on by the pass-through, not the proxy's IP. |
| 3 | No account lockout | **N/A** (no passwords). Lockout for bad passwords is Discord's job. Bursts of denied sign-ins trigger alerts (#53). |
| 4 | Missing CSRF tokens | **Verified.** Every write needs the portal's `X-IA-Request` header, which a cross-site form cannot set because CORS is never enabled. It must also come from the portal's own origin, and a browser-reported cross-site or same-site `Sec-Fetch-Site` is rejected. Blocked attempts are logged. |
| 5 | OAuth redirect URI misconfiguration | **Verified.** The redirect URI is fixed server-side from `PUBLIC_URL` and never taken from a request. Discord only accepts it if it exactly matches a registered URI. |
| 6 | OAuth state not validated | **Fixed, verified.** The state is random, single-use, expires after 10 min, is stored server-side, and must also match an HttpOnly cookie in the same browser. |
| 7 | "Owner recovery" backdoor | **None exists.** Owners (`IA_OWNER_DISCORD_IDS`) must still sign in through Discord, plus 2FA. The owner override only relaxes the conflict-of-interest rules, and every use is audited. The dev sign-in route is never registered when `NODE_ENV=production`. |
| 8 | No 2FA | **Fixed.** IA staff (investigator and above) are refused sign-in unless their Discord account has 2FA enabled (`IA_REQUIRE_DISCORD_MFA`). |
| 9 | Session fixation | **Fixed, verified.** Each sign-in issues a new 256-bit random token and revokes any session the browser presented. |
| 10 | No session timeout | **Fixed, verified.** 12 h absolute, and 120 min of inactivity. |

## Injection & code execution

| # | Item | Status |
|---|------|--------|
| 11 | Path traversal in static assets | **Verified.** Static files are served from `public/` only. Encoded `../` is rejected. Attachment paths must resolve strictly inside the attachments folder. |
| 12 | SVG XSS via uploads | **N/A for users; hardened, verified.** There are no uploads. Ticket attachments are kept only if their actual bytes are PNG/JPEG/GIF/WebP or common video/audio. SVG/HTML/XML are rejected whatever type they claim, re-checked when served, and served with a `sandbox` CSP. |
| 13–14 | XXE / billion laughs | **N/A.** No XML or SVG is ever parsed. |
| 15 | SSRF | **Fixed.** The bot only downloads from `cdn.discordapp.com` / `media.discordapp.net` over HTTPS with redirects refused. Evidence links are stored as text and never fetched. AI endpoints come only from server config. |
| 28 | Input validation / SQL injection | **Verified.** Every query is a prepared statement. Editable fields and sort/filter columns are allow-lists. Full-text search input is tokenised. |
| – | Stored XSS | **Verified.** The UI renders all content with `textContent` (never `innerHTML`), and a strict CSP allows no inline script. |

## Configuration & exposure

| # | Item | Status |
|---|------|--------|
| 16 | Directory listings | **Verified.** Disabled. |
| 17–19 | `.env`, backups, `.git` exposed | **Verified.** Only `public/` is served, dotfiles are ignored, and none of these exist there. |
| 20 | Error messages leak info | **Verified.** Generic messages only, with no stack traces, paths, or library names. |
| 21, 41 | Branding / favicon | **Accepted.** The page is only reachable at an unlisted path, carries `noindex`, and sits behind Discord sign-in. |
| 22 | Discord client ID visible | **Accepted.** OAuth client IDs are public by design. The secret never leaves the server. |
| 23 | Rate-limit headers | **Verified.** Standard `RateLimit` headers. |
| 45 | Railway default domain | **Fixed, verified.** Without the pass-through secret, every path returns the same plain 404, including on the Railway domain. |

## OAuth

| # | Item | Status |
|---|------|--------|
| 24 | No PKCE | **Verified.** S256 PKCE. |
| 25 | Consent prompt | **Fixed.** `prompt=none` removed. Discord shows its consent screen by default. |
| 26 | Over-permissioned scopes | **Verified.** Only `identify` and `guilds.members.read`. Discord access tokens are revoked right after sign-in and never stored. |
| 27 | Login CSRF | **Fixed, verified.** The state is bound to the browser (#6). |
| 29–30, 40, 56–57 | Password rules / reset | **N/A.** There are no passwords. |

## Headers & sessions

| # | Item | Status |
|---|------|--------|
| 31–33, 35 | nosniff, Referrer-Policy, Permissions-Policy, DNS prefetch | **Verified.** All present, plus HSTS, frame denial, and strict CSP. |
| 34 | Clear-Site-Data | **Fixed, verified.** Sent on logout. |
| 36 | Logout | **Verified.** Revokes the session server-side. Admins can "Sign out everywhere". |
| 37 | Concurrent sessions | **Fixed, verified.** Max 3 per user; older ones are revoked. |
| 38–39 | SameSite / Secure cookies | **Verified.** `HttpOnly; Secure; SameSite=Lax`, scoped to the portal path. Lax is required for the Discord redirect back. |
| 42 | Server fingerprinting | **Verified.** No `X-Powered-By`, no ETag fingerprints. |
| 43 | Specific login errors | **Accepted.** Messages only appear after Discord has verified the person ("not a member", "no role", "needs 2FA"). There are no usernames to enumerate. |

## Infrastructure & monitoring

| # | Item | Status |
|---|------|--------|
| 44 | security.txt | **Accepted.** The portal is intentionally unlisted. Security contact is the Head of IA. |
| 46 | IP allow-listing | **Not applied.** Staff sign in from anywhere. Discord 2FA, role gating, and alerts cover this. |
| 47 | WAF | **Fixed.** Traffic now enters through Cloudflare via `sandyshores.dev`. |
| 48 | Debug mode | **Verified.** Production mode, and the dev routes are absent. |
| 49 | Static versioning | **Fixed.** Assets are revalidated on every load, so deploys take effect immediately. |
| 50 | SRI | **Accepted.** Only Google Fonts stylesheets are external, with no scripts. SRI cannot apply to Google's dynamic font CSS. CSP limits styles/fonts to those two hosts. |
| 51 | Mixed content | **Verified.** HTTPS only, and CSP `upgrade-insecure-requests`. |
| 52 | Audit logs | **Verified.** Append-only, hash-chained log of sign-ins, denials, views, edits, signatures, exports, and settings. |
| 53–54 | Suspicious-activity / failed-login alerts | **Fixed, verified.** Bursts of denied sign-ins, permission denials, CSRF blocks, or rate-limit hits alert the IA log channel. Alerts are throttled. |
| 55 | Geolocation | **Fixed.** The Cloudflare country is recorded with each sign-in in the audit log. |
