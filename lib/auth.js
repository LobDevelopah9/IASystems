const crypto = require("crypto");
const config = require("./config");
const { db, now } = require("./db");
const { roleFromDiscord, effectiveRole, can, capabilityList, RANK, ROLE_LABELS } = require("./permissions");
const { discordSettings } = require("./policy");
const audit = require("./audit");

const BASE = config.BASE_PATH;
const COOKIE_PATH = BASE || "/";
// __Host- requires Path=/, so under a base path the __Secure- prefix is used with a path-scoped cookie.
const COOKIE = config.IS_PROD ? (BASE ? "__Secure-ia_session" : "__Host-ia_session") : "ia_session";
const STATE_COOKIE = config.IS_PROD ? "__Secure-ia_oauth" : "ia_oauth";
const API = "https://discord.com/api/v10";

const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const b64url = buffer => buffer.toString("base64url");
const url = p => `${BASE}${p}`;

function safeEqual(a, b) {
	const x = Buffer.from(String(a || ""));
	const y = Buffer.from(String(b || ""));
	return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

function parseCookies(header) {
	const out = {};
	for (const part of String(header || "").split(";")) {
		const index = part.indexOf("=");
		if (index <= 0) continue;
		try {
			out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
		} catch {
			// Malformed cookie values are ignored rather than failing the request.
		}
	}
	return out;
}

function cookie(name, value, maxAgeSeconds, path = COOKIE_PATH) {
	return [
		`${name}=${value}`,
		`Path=${path}`,
		"HttpOnly",
		"SameSite=Lax",
		config.IS_PROD ? "Secure" : null,
		`Max-Age=${maxAgeSeconds}`
	].filter(Boolean).join("; ");
}

function createSession(res, discordId, req) {
	// Session fixation: whatever session the browser presented is revoked and a fresh random token issued.
	const previous = parseCookies(req.headers.cookie)[COOKIE];
	if (previous) db.prepare("UPDATE sessions SET revoked = 1 WHERE id_hash = ?").run(sha(previous));

	const token = b64url(crypto.randomBytes(32));
	const ttl = config.SESSION_HOURS * 3600 * 1000;
	db.prepare("INSERT INTO sessions (id_hash, discord_id, created_at, expires_at, last_seen_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)")
		.run(sha(token), discordId, now(), now() + ttl, now(), req.ip, String(req.get("user-agent") || "").slice(0, 200));

	// Concurrent sessions: keep only the newest few per user.
	const active = db.prepare("SELECT id_hash FROM sessions WHERE discord_id = ? AND revoked = 0 AND expires_at > ? ORDER BY created_at DESC").all(discordId, now());
	for (const s of active.slice(config.MAX_SESSIONS_PER_USER)) db.prepare("UPDATE sessions SET revoked = 1 WHERE id_hash = ?").run(s.id_hash);

	res.append("Set-Cookie", cookie(COOKIE, token, Math.floor(ttl / 1000)));
}

function destroySession(req, res) {
	const token = parseCookies(req.headers.cookie)[COOKIE];
	if (token) db.prepare("UPDATE sessions SET revoked = 1 WHERE id_hash = ?").run(sha(token));
	res.append("Set-Cookie", cookie(COOKIE, "", 0));
	res.set("Clear-Site-Data", "\"cache\", \"cookies\", \"storage\"");
}

function revokeAllSessions(discordId) {
	return db.prepare("UPDATE sessions SET revoked = 1 WHERE discord_id = ? AND revoked = 0").run(discordId).changes;
}

function decorate(user) {
	const role = effectiveRole(user);
	return {
		...user,
		role,
		roleLabel: ROLE_LABELS[role],
		capabilities: capabilityList(user)
	};
}

// Loads the session on every request. Suspension, removal, expiry, and inactivity take effect immediately.
function sessionMiddleware(req, res, next) {
	const token = parseCookies(req.headers.cookie)[COOKIE];
	if (token && token.length <= 128) {
		const session = db.prepare("SELECT * FROM sessions WHERE id_hash = ? AND revoked = 0 AND expires_at > ?").get(sha(token), now());
		if (session && now() - session.last_seen_at > config.SESSION_IDLE_MINUTES * 60000) {
			db.prepare("UPDATE sessions SET revoked = 1 WHERE id_hash = ?").run(session.id_hash);
		} else if (session) {
			const user = db.prepare("SELECT * FROM users WHERE discord_id = ?").get(session.discord_id);
			if (user) {
				req.user = decorate(user);
				req.sessionId = session.id_hash;
				if (now() - session.last_seen_at > 60000) {
					db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?").run(now(), session.id_hash);
					db.prepare("UPDATE users SET last_seen_at = ? WHERE discord_id = ?").run(now(), user.discord_id);
				}
			}
		}
	}
	next();
}

function requireAuth(req, res, next) {
	if (!req.user) return res.status(401).json({ error: "Sign in required" });
	if (req.user.role === "none") return res.status(403).json({ error: "Your account does not have portal access", code: "no_access" });
	next();
}

function requireCap(capability) {
	return (req, res, next) => {
		if (!req.user) return res.status(401).json({ error: "Sign in required" });
		if (!can(req.user, capability)) {
			audit.record(req.user, "access.denied", { type: "route", ref: req.originalUrl.split("?")[0].slice(0, 200) }, { capability }, req.ip);
			return res.status(403).json({ error: "You do not have permission to do that" });
		}
		next();
	};
}

// CSRF: every mutation must carry a custom header (a cross-site form or image cannot set one, and CORS is never
// enabled), must come from the portal's own origin, and must not be a cross-site fetch according to the browser.
function csrfGuard(req, res, next) {
	if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
	const origin = req.get("origin");
	const expected = new URL(config.PUBLIC_URL).origin;
	const fetchSite = req.get("sec-fetch-site");
	const blocked = req.get("x-ia-request") !== "1"
		|| (origin && origin !== expected)
		|| (fetchSite && !["same-origin", "none"].includes(fetchSite));
	if (blocked) {
		audit.record(req.user || null, "security.csrf_blocked", { type: "route", ref: req.originalUrl.split("?")[0].slice(0, 200) }, { origin: origin || null, fetchSite: fetchSite || null }, req.ip);
		return res.status(403).json({ error: "Request blocked" });
	}
	next();
}

// --- Discord OAuth2 (PKCE + state bound to the browser) ---------------------------

function redirectUri() {
	return `${config.PUBLIC_URL}/auth/callback`;
}

function beginLogin(req, res) {
	if (!config.DISCORD_CLIENT_ID || !config.DISCORD_CLIENT_SECRET) {
		return res.redirect(url("/?error=oauth_not_configured"));
	}
	const state = b64url(crypto.randomBytes(24));
	const verifier = b64url(crypto.randomBytes(48));
	const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
	db.prepare("DELETE FROM oauth_states WHERE created_at < ?").run(now() - 10 * 60000);
	db.prepare("INSERT INTO oauth_states (state, verifier, created_at) VALUES (?, ?, ?)").run(state, verifier, now());
	// The state is also set as a cookie; the callback only accepts a state that matches this browser's cookie.
	res.append("Set-Cookie", cookie(STATE_COOKIE, state, 600, url("/auth")));
	const params = new URLSearchParams({
		client_id: config.DISCORD_CLIENT_ID,
		response_type: "code",
		redirect_uri: redirectUri(),
		scope: "identify guilds.members.read",
		state,
		code_challenge: challenge,
		code_challenge_method: "S256"
	});
	res.redirect(`https://discord.com/oauth2/authorize?${params}`);
}

async function discordGet(path, token) {
	const response = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) });
	return { status: response.status, data: await response.json().catch(() => ({})) };
}

function upsertUser(profile, member) {
	const existing = db.prepare("SELECT * FROM users WHERE discord_id = ?").get(profile.id);
	const roles = Array.isArray(member?.roles) ? member.roles.filter(r => /^\d{15,22}$/.test(r)) : [];
	const displayName = String(member?.nick || profile.global_name || profile.username).slice(0, 80);
	const avatar = /^[a-z0-9_]+$/i.test(profile.avatar || "") ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png?size=128` : null;
	const mapped = member ? roleFromDiscord(roles) : "none";
	const username = String(profile.username || "").slice(0, 40);
	if (existing) {
		db.prepare(`UPDATE users SET username = ?, display_name = ?, avatar = ?, discord_roles = ?, mapped_role = ?, in_guild = ?,
			updated_at = ?, last_login_at = ?, last_seen_at = ? WHERE discord_id = ?`)
			.run(username, displayName, avatar, JSON.stringify(roles), mapped, member ? 1 : 0, now(), now(), now(), profile.id);
	} else {
		db.prepare(`INSERT INTO users (discord_id, username, display_name, avatar, discord_roles, mapped_role, in_guild, created_at, updated_at, last_login_at, last_seen_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
			.run(profile.id, username, displayName, avatar, JSON.stringify(roles), mapped, member ? 1 : 0, now(), now(), now(), now());
	}
	return db.prepare("SELECT * FROM users WHERE discord_id = ?").get(profile.id);
}

// Every failed sign-in goes to the same generic handler: same redirect shape, audited, and counted for alerts.
function denied(req, res, reason, actor = null, detail = {}) {
	audit.record(actor, "auth.login_denied", { type: "user", ref: actor?.discord_id || null }, { reason, country: req.clientCountry || null, ...detail }, req.ip);
	res.append("Set-Cookie", cookie(STATE_COOKIE, "", 0, url("/auth")));
	return res.redirect(url(`/?error=${reason}`));
}

async function finishLogin(req, res) {
	const { code, state, error } = req.query;
	if (error) return denied(req, res, "discord_denied");
	const browserState = parseCookies(req.headers.cookie)[STATE_COOKIE];
	if (typeof state !== "string" || !safeEqual(state, browserState)) return denied(req, res, "state");
	const saved = db.prepare("SELECT * FROM oauth_states WHERE state = ?").get(state);
	db.prepare("DELETE FROM oauth_states WHERE state = ?").run(state);
	if (!saved || now() - saved.created_at > 10 * 60000) return denied(req, res, "state");
	if (typeof code !== "string" || !/^[A-Za-z0-9_-]{10,128}$/.test(code)) return denied(req, res, "token");

	try {
		const tokenResponse = await fetch(`${API}/oauth2/token`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				client_id: config.DISCORD_CLIENT_ID,
				client_secret: config.DISCORD_CLIENT_SECRET,
				grant_type: "authorization_code",
				code,
				redirect_uri: redirectUri(),
				code_verifier: saved.verifier
			}),
			signal: AbortSignal.timeout(8000)
		});
		const token = await tokenResponse.json().catch(() => ({}));
		if (!token.access_token) return denied(req, res, "token");

		const profile = await discordGet("/users/@me", token.access_token);
		if (profile.status !== 200 || !/^\d{15,22}$/.test(String(profile.data.id || ""))) return denied(req, res, "profile");
		const { guildId } = discordSettings();
		const member = /^\d{15,22}$/.test(guildId) ? await discordGet(`/users/@me/guilds/${guildId}/member`, token.access_token) : { status: 404 };
		// Discord access tokens are never stored: role sync afterwards comes from the bot.
		fetch(`${API}/oauth2/token/revoke`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ token: token.access_token, client_id: config.DISCORD_CLIENT_ID, client_secret: config.DISCORD_CLIENT_SECRET })
		}).catch(() => {});

		const user = upsertUser(profile.data, member.status === 200 ? member.data : null);
		const decorated = decorate(user);
		if (decorated.role === "none") {
			return denied(req, res, user.suspended ? "suspended" : user.in_guild ? "no_role" : "not_member", decorated);
		}
		// Two-factor: IA staff (investigator and above) must have 2FA enabled on Discord.
		if (config.REQUIRE_DISCORD_MFA && RANK[decorated.role] >= RANK.investigator && profile.data.mfa_enabled !== true) {
			return denied(req, res, "mfa_required", decorated);
		}
		createSession(res, user.discord_id, req);
		res.append("Set-Cookie", cookie(STATE_COOKIE, "", 0, url("/auth")));
		audit.record(decorated, "auth.login", { type: "user", ref: user.discord_id }, { role: decorated.role, mfa: profile.data.mfa_enabled === true, country: req.clientCountry || null }, req.ip);
		res.redirect(url(decorated.role === "trooper" ? "/app#/my" : "/app#/board"));
	} catch (err) {
		console.error("[auth] login failed", err.message);
		return denied(req, res, "login_failed");
	}
}

module.exports = {
	COOKIE,
	sessionMiddleware,
	requireAuth,
	requireCap,
	csrfGuard,
	createSession,
	destroySession,
	revokeAllSessions,
	beginLogin,
	finishLogin,
	upsertUser,
	decorate,
	parseCookies,
	url
};
