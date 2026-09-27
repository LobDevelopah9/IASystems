const crypto = require("crypto");
const config = require("./config");
const { db, now } = require("./db");
const { roleFromDiscord, effectiveRole, can, capabilityList, ROLE_LABELS } = require("./permissions");
const { discordSettings } = require("./policy");
const audit = require("./audit");

const COOKIE = config.IS_PROD ? "__Host-ia_session" : "ia_session";
const API = "https://discord.com/api/v10";

const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const b64url = buffer => buffer.toString("base64url");

function parseCookies(header) {
	const out = {};
	for (const part of String(header || "").split(";")) {
		const index = part.indexOf("=");
		if (index > 0) out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
	}
	return out;
}

function cookieHeader(value, maxAgeSeconds) {
	return [
		`${COOKIE}=${value}`,
		"Path=/",
		"HttpOnly",
		"SameSite=Lax",
		config.IS_PROD ? "Secure" : null,
		`Max-Age=${maxAgeSeconds}`
	].filter(Boolean).join("; ");
}

function createSession(res, discordId, req) {
	const token = b64url(crypto.randomBytes(32));
	const ttl = config.SESSION_HOURS * 3600 * 1000;
	db.prepare("INSERT INTO sessions (id_hash, discord_id, created_at, expires_at, last_seen_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)")
		.run(sha(token), discordId, now(), now() + ttl, now(), req.ip, String(req.get("user-agent") || "").slice(0, 200));
	res.setHeader("Set-Cookie", cookieHeader(token, Math.floor(ttl / 1000)));
}

function destroySession(req, res) {
	const token = parseCookies(req.headers.cookie)[COOKIE];
	if (token) db.prepare("UPDATE sessions SET revoked = 1 WHERE id_hash = ?").run(sha(token));
	res.setHeader("Set-Cookie", cookieHeader("", 0));
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

// Loads the session on every request. Suspension or removal takes effect immediately.
function sessionMiddleware(req, res, next) {
	const token = parseCookies(req.headers.cookie)[COOKIE];
	if (token) {
		const session = db.prepare("SELECT * FROM sessions WHERE id_hash = ? AND revoked = 0 AND expires_at > ?").get(sha(token), now());
		if (session) {
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
			audit.record(req.user, "access.denied", { type: "route", ref: req.originalUrl.split("?")[0] }, { capability }, req.ip);
			return res.status(403).json({ error: "You do not have permission to do that" });
		}
		next();
	};
}

// Mutations must come from the portal itself: same origin plus a custom header a cross-site form cannot set.
function csrfGuard(req, res, next) {
	if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
	const origin = req.get("origin");
	const expected = new URL(config.PUBLIC_URL).origin;
	const host = `${req.protocol}://${req.get("host")}`;
	if (req.get("x-ia-request") !== "1" || (origin && origin !== expected && origin !== host)) {
		return res.status(403).json({ error: "Request blocked" });
	}
	next();
}

// --- Discord OAuth2 (PKCE) ------------------------------------------------------

function redirectUri() {
	return `${config.PUBLIC_URL}/auth/callback`;
}

function beginLogin(req, res) {
	if (!config.DISCORD_CLIENT_ID || !config.DISCORD_CLIENT_SECRET) {
		return res.redirect("/?error=oauth_not_configured");
	}
	const state = b64url(crypto.randomBytes(24));
	const verifier = b64url(crypto.randomBytes(48));
	const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
	db.prepare("DELETE FROM oauth_states WHERE created_at < ?").run(now() - 10 * 60000);
	db.prepare("INSERT INTO oauth_states (state, verifier, created_at) VALUES (?, ?, ?)").run(state, verifier, now());
	const params = new URLSearchParams({
		client_id: config.DISCORD_CLIENT_ID,
		response_type: "code",
		redirect_uri: redirectUri(),
		scope: "identify guilds.members.read",
		state,
		code_challenge: challenge,
		code_challenge_method: "S256",
		prompt: "none"
	});
	res.redirect(`https://discord.com/oauth2/authorize?${params}`);
}

async function discordGet(path, token) {
	const response = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) });
	return { status: response.status, data: await response.json().catch(() => ({})) };
}

function upsertUser(profile, member) {
	const existing = db.prepare("SELECT * FROM users WHERE discord_id = ?").get(profile.id);
	const roles = member?.roles || [];
	const displayName = member?.nick || profile.global_name || profile.username;
	const avatar = profile.avatar ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png?size=128` : null;
	const mapped = member ? roleFromDiscord(roles) : "none";
	if (existing) {
		db.prepare(`UPDATE users SET username = ?, display_name = ?, avatar = ?, discord_roles = ?, mapped_role = ?, in_guild = ?,
			updated_at = ?, last_login_at = ?, last_seen_at = ? WHERE discord_id = ?`)
			.run(profile.username, displayName, avatar, JSON.stringify(roles), mapped, member ? 1 : 0, now(), now(), now(), profile.id);
	} else {
		db.prepare(`INSERT INTO users (discord_id, username, display_name, avatar, discord_roles, mapped_role, in_guild, created_at, updated_at, last_login_at, last_seen_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
			.run(profile.id, profile.username, displayName, avatar, JSON.stringify(roles), mapped, member ? 1 : 0, now(), now(), now(), now());
	}
	return db.prepare("SELECT * FROM users WHERE discord_id = ?").get(profile.id);
}

async function finishLogin(req, res) {
	const { code, state, error } = req.query;
	if (error) return res.redirect("/?error=discord_denied");
	const saved = state ? db.prepare("SELECT * FROM oauth_states WHERE state = ?").get(String(state)) : null;
	if (!saved || now() - saved.created_at > 10 * 60000) return res.redirect("/?error=state");
	db.prepare("DELETE FROM oauth_states WHERE state = ?").run(saved.state);

	try {
		const tokenResponse = await fetch(`${API}/oauth2/token`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				client_id: config.DISCORD_CLIENT_ID,
				client_secret: config.DISCORD_CLIENT_SECRET,
				grant_type: "authorization_code",
				code: String(code || ""),
				redirect_uri: redirectUri(),
				code_verifier: saved.verifier
			}),
			signal: AbortSignal.timeout(8000)
		});
		const token = await tokenResponse.json().catch(() => ({}));
		if (!token.access_token) return res.redirect("/?error=token");

		const profile = await discordGet("/users/@me", token.access_token);
		if (profile.status !== 200 || !profile.data.id) return res.redirect("/?error=profile");
		const { guildId } = discordSettings();
		const member = guildId ? await discordGet(`/users/@me/guilds/${guildId}/member`, token.access_token) : { status: 404 };
		// We do not keep Discord access tokens: role sync afterwards comes from the bot.
		fetch(`${API}/oauth2/token/revoke`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ token: token.access_token, client_id: config.DISCORD_CLIENT_ID, client_secret: config.DISCORD_CLIENT_SECRET })
		}).catch(() => {});

		const user = upsertUser(profile.data, member.status === 200 ? member.data : null);
		const decorated = decorate(user);
		if (decorated.role === "none") {
			audit.record(decorated, "auth.login_denied", { type: "user", ref: user.discord_id }, { inGuild: Boolean(user.in_guild), suspended: Boolean(user.suspended) }, req.ip);
			return res.redirect(`/?error=${user.suspended ? "suspended" : user.in_guild ? "no_role" : "not_member"}`);
		}
		createSession(res, user.discord_id, req);
		audit.record(decorated, "auth.login", { type: "user", ref: user.discord_id }, { role: decorated.role }, req.ip);
		res.redirect(decorated.role === "trooper" ? "/app#/my" : "/app#/board");
	} catch (err) {
		console.error("[auth] login failed", err);
		res.redirect("/?error=login_failed");
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
	decorate
};
