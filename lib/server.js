const path = require("path");
const crypto = require("crypto");
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const config = require("./config");
const { db } = require("./db");
const auth = require("./auth");
const audit = require("./audit");
const { effectiveRole } = require("./permissions");

const BASE = config.BASE_PATH;

function secretMatches(value) {
	const a = Buffer.from(String(value || ""));
	const b = Buffer.from(config.PROXY_SECRET);
	return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

const notFound = (req, res) => res.status(404).type("text/plain").set("Cache-Control", "no-store").send("Not found");

function createApp() {
	const app = express();
	app.disable("x-powered-by");
	app.disable("etag");
	app.set("trust proxy", 1);

	// Railway health check only. Reveals nothing about the application.
	app.get("/healthz", (req, res) => res.json({ ok: true }));

	// Origin lock: when a proxy secret is configured, only the sandyshores.dev pass-through can reach the portal.
	// Anything else (including the raw Railway domain) gets an indistinguishable 404.
	app.use((req, res, next) => {
		if (config.PROXY_SECRET) {
			if (!secretMatches(req.get("x-ia-proxy-secret"))) return notFound(req, res);
			const clientIp = String(req.get("x-ia-client-ip") || "").trim().slice(0, 64);
			if (clientIp) Object.defineProperty(req, "ip", { value: clientIp, configurable: true });
			req.clientCountry = String(req.get("x-ia-client-country") || "").trim().slice(0, 2).toUpperCase() || null;
		}
		next();
	});

	app.use(helmet({
		contentSecurityPolicy: {
			useDefaults: false,
			directives: {
				"default-src": ["'self'"],
				"script-src": ["'self'"],
				"style-src": ["'self'", "https://fonts.googleapis.com"],
				"font-src": ["'self'", "https://fonts.gstatic.com"],
				"img-src": ["'self'", "data:", "https://cdn.discordapp.com"],
				"media-src": ["'self'"],
				"connect-src": ["'self'"],
				"frame-ancestors": ["'none'"],
				"form-action": ["'self'", "https://discord.com"],
				"base-uri": ["'none'"],
				"object-src": ["'none'"],
				"upgrade-insecure-requests": []
			}
		},
		crossOriginEmbedderPolicy: false,
		strictTransportSecurity: { maxAge: 31536000, includeSubDomains: false },
		referrerPolicy: { policy: "no-referrer" }
	}));
	app.use((req, res, next) => {
		res.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), display-capture=(), clipboard-write=(), payment=(), usb=()");
		res.set("X-Robots-Tag", "noindex, nofollow, noarchive");
		next();
	});

	const router = express.Router({ strict: false });
	// Legacy imports can be several megabytes; everything else stays small.
	const smallJson = express.json({ limit: "256kb" });
	const importJson = express.json({ limit: "16mb" });
	router.use((req, res, next) => (req.path === "/api/import/legacy" ? importJson : smallJson)(req, res, next));
	router.use(auth.sessionMiddleware);

	// Rate limits are per client IP (the real visitor IP when served through the pass-through). Hits are audited
	// and feed the security alerts.
	const limited = (req, res, next, options) => {
		audit.record(req.user || null, "security.rate_limited", { type: "route", ref: req.originalUrl.split("?")[0].slice(0, 200) }, { limit: options.limit }, req.ip);
		res.status(429).json({ error: "Too many requests. Please slow down." });
	};
	const loginLimiter = rateLimit({ windowMs: 10 * 60000, limit: 20, standardHeaders: "draft-7", legacyHeaders: false, handler: limited });
	const apiLimiter = rateLimit({ windowMs: 60000, limit: 300, standardHeaders: "draft-7", legacyHeaders: false, handler: limited });
	const mutationLimiter = rateLimit({
		windowMs: 60000, limit: 60, standardHeaders: "draft-7", legacyHeaders: false, handler: limited,
		skip: req => ["GET", "HEAD", "OPTIONS"].includes(req.method)
	});

	router.get("/auth/login", loginLimiter, auth.beginLogin);
	router.get("/auth/callback", loginLimiter, auth.finishLogin);
	router.post("/auth/logout", loginLimiter, auth.csrfGuard, (req, res) => {
		if (req.user) audit.record(req.user, "auth.logout", { type: "user", ref: req.user.discord_id }, {}, req.ip);
		auth.destroySession(req, res);
		res.json({ ok: true });
	});

	// Local-only role switcher so the portal can be exercised without Discord. Never registered in production.
	if (config.DEV_LOGIN) {
		router.get("/auth/dev", (req, res) => {
			const id = String(req.query.as || "");
			const user = db.prepare("SELECT * FROM users WHERE discord_id = ? AND demo = 1").get(id);
			if (!user) return res.status(404).send("Unknown demo user");
			auth.createSession(res, user.discord_id, req);
			res.redirect(auth.url(effectiveRole(user) === "trooper" ? "/app#/my" : "/app#/board"));
		});
		router.get("/auth/dev-users", (req, res) => {
			res.json(db.prepare("SELECT * FROM users WHERE demo = 1").all()
				.map(u => ({ id: u.discord_id, name: u.display_name, role: effectiveRole(u) })));
		});
	}

	router.use("/api", apiLimiter, mutationLimiter, auth.csrfGuard, require("../routes/api"));

	const pub = path.join(__dirname, "..", "public");
	const html = file => (req, res) => {
		res.set("Cache-Control", "no-store");
		res.sendFile(path.join(pub, file));
	};
	router.get("/app", (req, res, next) => {
		if (!req.user || req.user.role === "none") return res.redirect(auth.url("/"));
		html("app.html")(req, res, next);
	});
	router.get("/", (req, res, next) => {
		// The page must end in "/" so its relative asset paths resolve under the base path.
		if (BASE && req.originalUrl.split("?")[0] === BASE) return res.redirect(301, `${BASE}/`);
		if (req.user && req.user.role !== "none") return res.redirect(auth.url(req.user.role === "trooper" ? "/app#/my" : "/app#/board"));
		html("index.html")(req, res, next);
	});
	router.get("/config.js", (req, res) => {
		res.type("application/javascript").set("Cache-Control", "no-store")
			.send(`window.IA_CONFIG=${JSON.stringify({ devLogin: config.DEV_LOGIN })};`);
	});
	// Static assets: no directory listings, dotfiles ignored, path traversal rejected by the static server,
	// revalidated on every load so a deploy is picked up immediately. "no-cache" (not max-age=0) because the edge
	// proxy in front of sandyshores.dev raises low max-age values to 4 hours, which left browsers running old
	// scripts against new styles after a deploy. Unchanged files still cost only a 304.
	router.use(express.static(pub, {
		index: false, redirect: false, dotfiles: "ignore", etag: true, lastModified: true, cacheControl: false,
		setHeaders: res => res.set("Cache-Control", "no-cache")
	}));
	router.use(notFound);

	app.use(BASE || "/", router);
	app.use(notFound);

	// Last-resort error handler: never leaks stack traces, paths, or library names.
	// eslint-disable-next-line no-unused-vars
	app.use((error, req, res, next) => {
		const status = error.status || error.statusCode || 500;
		if (status >= 500) console.error("[web]", error.message);
		if (res.headersSent) return res.end();
		const message = status === 400 ? "Bad request" : status === 413 ? "Request too large" : status >= 500 ? "Internal error" : "Request failed";
		if (req.originalUrl.startsWith(`${BASE}/api`)) return res.status(status).json({ error: message });
		res.status(status).type("text/plain").send(message);
	});
	return app;
}

module.exports = { createApp };
