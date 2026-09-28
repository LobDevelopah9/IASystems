// Runs the app the way production does: under a base path, reachable only through the pass-through secret.
process.env.IA_DB_FILE = ":memory:";
process.env.NODE_ENV = "test";
process.env.BASE_PATH = "/sahp/opr/ia";
process.env.IA_PROXY_SECRET = "test-proxy-secret-0123456789";
process.env.DISCORD_CLIENT_ID = "123456789012345678";
process.env.DISCORD_CLIENT_SECRET = "secret";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const request = require("supertest");
const { seedDemo } = require("../lib/seed");
const { createApp } = require("../lib/server");
const { db } = require("../lib/db");
const config = require("../lib/config");

seedDemo();
const app = createApp();
const B = "/sahp/opr/ia";
const SECRET = process.env.IA_PROXY_SECRET;
const DIRECTOR = "900000000000000001";

// Every request through the pass-through carries the secret and the real client IP.
const via = (req, ip = "203.0.113.10") => req.set("X-IA-Proxy-Secret", SECRET).set("X-IA-Client-IP", ip);

async function signedIn(id = DIRECTOR, ip) {
	const agent = request.agent(app);
	await via(agent.get(`${B}/auth/dev?as=${id}`), ip).expect(302);
	return agent;
}

test("origin lock: without the proxy secret everything is an indistinguishable 404 (except the health check)", async () => {
	for (const url of [`${B}/`, `${B}/api/me`, `${B}/auth/login`, "/", "/api/me", `${B}/css/ia.css`]) {
		const res = await request(app).get(url).expect(404);
		assert.strictEqual(res.text, "Not found");
	}
	await request(app).get(`${B}/`).set("X-IA-Proxy-Secret", "wrong").expect(404);
	await request(app).get("/healthz").expect(200);
});

test("base path: the portal only exists under /sahp/opr/ia and redirects to the trailing slash", async () => {
	await via(request(app).get("/")).expect(404);
	const bare = await via(request(app).get(B)).expect(301);
	assert.strictEqual(bare.headers.location, `${B}/`);
	await via(request(app).get(`${B}/`)).expect(200);
	await via(request(app).get(`${B}/css/ia.css`)).expect(200);
});

test("security headers are present and the server is not fingerprinted", async () => {
	const res = await via(request(app).get(`${B}/`)).expect(200);
	const h = res.headers;
	assert.strictEqual(h["x-content-type-options"], "nosniff");
	assert.strictEqual(h["referrer-policy"], "no-referrer");
	assert.strictEqual(h["x-dns-prefetch-control"], "off");
	assert.strictEqual(h["x-frame-options"], "SAMEORIGIN");
	assert.match(h["permissions-policy"], /camera=\(\)/);
	assert.match(h["content-security-policy"], /default-src 'self'/);
	assert.match(h["content-security-policy"], /frame-ancestors 'none'/);
	assert.match(h["content-security-policy"], /upgrade-insecure-requests/);
	assert.match(h["strict-transport-security"], /max-age=31536000/);
	assert.match(h["x-robots-tag"], /noindex/);
	assert.strictEqual(h["x-powered-by"], undefined);
});

test("no source, config, dotfiles, backups, or directory listings are served", async () => {
	for (const p of ["/.env", "/.git/config", "/.git/HEAD", "/package.json", "/index.js", "/lib/auth.js", "/data/ia.sqlite",
		"/js/", "/css/", "/img/", "/public/index.html", "/index.html.bak", "/js/app.js~", "/.env.example", "/railway.json"]) {
		const res = await via(request(app).get(`${B}${p}`));
		assert.strictEqual(res.status, 404, `${p} must not be served`);
	}
});

test("path traversal in static paths is rejected", async () => {
	for (const p of ["/../package.json", "/%2e%2e/package.json", "/css/..%2f..%2fpackage.json", "/..%5c..%5cpackage.json", "/css/%2e%2e%2f%2e%2e%2f.env"]) {
		const res = await via(request(app).get(`${B}${p}`));
		assert.notStrictEqual(res.status, 200, `${p} must not resolve`);
		assert.ok(!/sahp-internal-affairs|SESSION_SECRET/.test(res.text));
	}
});

test("error responses never leak stack traces or internals", async () => {
	const agent = await signedIn();
	const res = await via(agent.post(`${B}/api/cases`).set("X-IA-Request", "1").set("Content-Type", "application/json").send("{bad json"));
	assert.strictEqual(res.status, 400);
	assert.ok(!/at |node_modules|SyntaxError|\\.js:/.test(res.text), "no stack trace or library detail");
	const big = await via(agent.post(`${B}/api/cases`).set("X-IA-Request", "1").set("Content-Type", "application/json").send(JSON.stringify({ title: "x".repeat(300000) })));
	assert.strictEqual(big.status, 413);
});

test("CSRF: mutations need the portal header, the portal origin, and a same-origin fetch", async () => {
	const agent = await signedIn();
	await via(agent.post(`${B}/api/cases/9002/notes`).send({ body: "x" })).expect(403);
	await via(agent.post(`${B}/api/cases/9002/notes`).set("X-IA-Request", "1").set("Origin", "https://evil.example").send({ body: "x" })).expect(403);
	await via(agent.post(`${B}/api/cases/9002/notes`).set("X-IA-Request", "1").set("Sec-Fetch-Site", "cross-site").send({ body: "x" })).expect(403);
	await via(agent.post(`${B}/api/cases/9002/notes`).set("X-IA-Request", "1").set("Sec-Fetch-Site", "same-site").send({ body: "x" })).expect(403);
	await via(agent.post(`${B}/api/cases/9002/notes`).set("X-IA-Request", "1").set("Origin", new URL(config.PUBLIC_URL).origin).set("Sec-Fetch-Site", "same-origin").send({ body: "ok" })).expect(200);
	assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'security.csrf_blocked'").get());
});

test("OAuth: PKCE, fixed redirect URI, minimal scopes, and state bound to the browser", async () => {
	const res = await via(request(app).get(`${B}/auth/login`)).expect(302);
	const target = new URL(res.headers.location);
	assert.strictEqual(target.origin, "https://discord.com");
	assert.strictEqual(target.searchParams.get("code_challenge_method"), "S256");
	assert.ok(target.searchParams.get("code_challenge"));
	assert.strictEqual(target.searchParams.get("redirect_uri"), `${config.PUBLIC_URL}/auth/callback`);
	assert.strictEqual(target.searchParams.get("scope"), "identify guilds.members.read");
	assert.strictEqual(target.searchParams.get("prompt"), null);
	const state = target.searchParams.get("state");
	const stateCookie = res.headers["set-cookie"].find(c => c.includes("ia_oauth="));
	assert.ok(stateCookie && stateCookie.includes("HttpOnly") && stateCookie.includes("SameSite=Lax"));

	// A valid state replayed from a different browser (no matching cookie) is rejected: login CSRF is blocked.
	const hijack = await via(request(app).get(`${B}/auth/callback?code=abcdefghijklmnop&state=${state}`)).expect(302);
	assert.match(hijack.headers.location, /error=state/);
	// A forged state with a forged cookie is also rejected (it was never issued by the server).
	const forged = await via(request(app).get(`${B}/auth/callback?code=abcdefghijklmnop&state=forgedstate123`).set("Cookie", "ia_oauth=forgedstate123")).expect(302);
	assert.match(forged.headers.location, /error=state/);
	// A foreign browser cannot consume (burn) the legitimate user's state either.
	assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM oauth_states WHERE state = ?").get(state).n, 1);
	// With the matching cookie the state is consumed exactly once (single use), even though the code exchange then fails.
	await via(request(app).get(`${B}/auth/callback?code=abcdefghijklmnop&state=${state}`).set("Cookie", `ia_oauth=${state}`)).expect(302);
	assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM oauth_states WHERE state = ?").get(state).n, 0);
	assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'auth.login_denied'").get());
});

test("sessions: fixation-safe, HttpOnly/SameSite cookies scoped to the base path, logout clears site data", async () => {
	const agent = request.agent(app);
	const first = await via(agent.get(`${B}/auth/dev?as=${DIRECTOR}`)).expect(302);
	const cookie1 = first.headers["set-cookie"].find(c => c.startsWith("ia_session="));
	assert.ok(cookie1.includes("HttpOnly") && cookie1.includes("SameSite=Lax") && cookie1.includes(`Path=${B}`));
	const token1 = cookie1.split(";")[0].split("=")[1];
	// Signing in again issues a new token and revokes the old one.
	const second = await via(agent.get(`${B}/auth/dev?as=${DIRECTOR}`)).expect(302);
	const token2 = second.headers["set-cookie"].find(c => c.startsWith("ia_session=")).split(";")[0].split("=")[1];
	assert.notStrictEqual(token1, token2);
	await via(request(app).get(`${B}/api/me`).set("Cookie", `ia_session=${token1}`)).expect(401);
	const out = await via(agent.post(`${B}/auth/logout`).set("X-IA-Request", "1")).expect(200);
	assert.match(out.headers["clear-site-data"], /cookies/);
	await via(request(app).get(`${B}/api/me`).set("Cookie", `ia_session=${token2}`)).expect(401);
});

test("sessions: idle timeout and concurrent-session cap", async () => {
	const agent = await signedIn("900000000000000002");
	await via(agent.get(`${B}/api/me`)).expect(200);
	db.prepare("UPDATE sessions SET last_seen_at = ? WHERE discord_id = ? AND revoked = 0").run(Date.now() - (config.SESSION_IDLE_MINUTES + 1) * 60000, "900000000000000002");
	await via(agent.get(`${B}/api/me`)).expect(401);

	for (let i = 0; i < config.MAX_SESSIONS_PER_USER + 3; i++) await signedIn("900000000000000003");
	const active = db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE discord_id = ? AND revoked = 0").get("900000000000000003").n;
	assert.strictEqual(active, config.MAX_SESSIONS_PER_USER);
});

test("rate limiting is per real client IP, sends RateLimit headers, and is audited", async () => {
	let last;
	for (let i = 0; i < 22; i++) last = await via(request(app).get(`${B}/auth/login`), "198.51.100.77");
	assert.strictEqual(last.status, 429);
	assert.ok(last.headers["ratelimit"] || last.headers["ratelimit-policy"], "standard RateLimit headers present");
	// A different visitor is unaffected.
	await via(request(app).get(`${B}/auth/login`), "198.51.100.78").expect(302);
	assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'security.rate_limited' AND ip = '198.51.100.77'").get());
});

test("attachments: traversal and non-media files (SVG, HTML, text) are never served", async () => {
	const agent = await signedIn();
	const ticket = db.prepare("SELECT id FROM tickets WHERE ref = 'T-0001'").get();
	const dir = path.join(config.DATA_DIR, "attachments", "T-0001");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "evil.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
	fs.writeFileSync(path.join(dir, "ok.png"), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]));
	const add = (p, type) => db.prepare("INSERT INTO ticket_attachments (ticket_id, seq, filename, content_type, size, stored_path, created_at) VALUES (?, 1, 'f', ?, 10, ?, ?)").run(ticket.id, type, p, Date.now()).lastInsertRowid;
	const svg = add(path.join("attachments", "T-0001", "evil.svg"), "image/png");
	const traversal = add(path.join("..", "..", "package.json"), "image/png");
	const png = add(path.join("attachments", "T-0001", "ok.png"), "image/png");
	await via(agent.get(`${B}/api/attachments/${svg}`)).expect(415);
	await via(agent.get(`${B}/api/attachments/${traversal}`)).expect(404);
	const ok = await via(agent.get(`${B}/api/attachments/${png}`)).expect(200);
	assert.strictEqual(ok.headers["content-type"], "image/png");
	assert.match(ok.headers["content-security-policy"], /sandbox/);
	fs.rmSync(dir, { recursive: true, force: true });
});

test("file type detection rejects SVG, XML, HTML, and scripts regardless of claimed type", () => {
	const { detectType } = require("../lib/filetype");
	assert.strictEqual(detectType(Buffer.from('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "a">]><svg/>')), null);
	assert.strictEqual(detectType(Buffer.from("<svg onload=alert(1)>")), null);
	assert.strictEqual(detectType(Buffer.from("<html><script>")), null);
	assert.strictEqual(detectType(Buffer.from("#!/bin/sh")), null);
	assert.strictEqual(detectType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), "image/jpeg");
});

test("SQL injection strings are treated as plain data", async () => {
	const agent = await signedIn();
	for (const q of ["' OR 1=1 --", "\"; DROP TABLE cases; --", "9001' UNION SELECT * FROM users --", "*", "NEAR(", "\"unterminated"]) {
		const res = await via(agent.get(`${B}/api/cases?q=${encodeURIComponent(q)}&subject=${encodeURIComponent(q)}&reporter=${encodeURIComponent(q)}`));
		assert.strictEqual(res.status, 200, `search with ${q}`);
	}
	await via(agent.get(`${B}/api/cases/${encodeURIComponent("9001' OR '1'='1")}`)).expect(404);
	assert.ok(db.prepare("SELECT COUNT(*) AS n FROM cases").get().n > 0, "tables intact");
});

test("stored XSS: HTML in case content is returned as data, never rendered server-side", async () => {
	const agent = await signedIn();
	const payload = '<img src=x onerror=alert(1)><script>alert(2)</script>';
	await via(agent.post(`${B}/api/cases/9002/notes`).set("X-IA-Request", "1").send({ body: payload })).expect(200);
	const res = await via(agent.get(`${B}/api/cases/9002`)).expect(200);
	assert.strictEqual(res.headers["content-type"].split(";")[0], "application/json");
	assert.ok(res.body.case.notes.some(n => n.body === payload), "stored verbatim, escaped by the UI's text-only rendering");
});

test("security alerts fire on bursts of denied sign-ins", async () => {
	const alerts = [];
	require("../lib/audit").setAlertNotifier(m => alerts.push(m));
	for (let i = 0; i < 9; i++) await via(request(app).get(`${B}/auth/callback?error=access_denied`), `192.0.2.${i}`);
	assert.ok(alerts.some(m => /sign-ins/.test(m)), "an alert was raised");
	assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'security.alert'").get());
});
