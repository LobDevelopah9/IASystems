const path = require("path");
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const config = require("./config");
const { db } = require("./db");
const auth = require("./auth");
const audit = require("./audit");
const { effectiveRole } = require("./permissions");

function createApp() {
	const app = express();
	app.disable("x-powered-by");
	app.set("trust proxy", 1);

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
				"object-src": ["'none'"]
			}
		},
		crossOriginEmbedderPolicy: false,
		referrerPolicy: { policy: "no-referrer" }
	}));
	app.use((req, res, next) => {
		res.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), display-capture=(), clipboard-write=()");
		next();
	});

	app.get("/healthz", (req, res) => res.json({ ok: true }));

	app.use(express.json({ limit: "256kb" }));
	app.use(auth.sessionMiddleware);

	const loginLimiter = rateLimit({ windowMs: 10 * 60000, limit: 30, standardHeaders: true, legacyHeaders: false });
	const apiLimiter = rateLimit({ windowMs: 60000, limit: 600, standardHeaders: true, legacyHeaders: false });

	app.get("/auth/login", loginLimiter, auth.beginLogin);
	app.get("/auth/callback", loginLimiter, auth.finishLogin);
	app.post("/auth/logout", auth.csrfGuard, (req, res) => {
		if (req.user) audit.record(req.user, "auth.logout", { type: "user", ref: req.user.discord_id }, {}, req.ip);
		auth.destroySession(req, res);
		res.json({ ok: true });
	});

	// Local-only role switcher so the portal can be exercised without Discord. Never available in production.
	if (config.DEV_LOGIN) {
		app.get("/auth/dev", (req, res) => {
			const id = String(req.query.as || "");
			const user = db.prepare("SELECT * FROM users WHERE discord_id = ? AND demo = 1").get(id);
			if (!user) return res.status(404).send("Unknown demo user");
			auth.createSession(res, user.discord_id, req);
			res.redirect(effectiveRole(user) === "trooper" ? "/app#/my" : "/app#/board");
		});
		app.get("/auth/dev-users", (req, res) => {
			res.json(db.prepare("SELECT * FROM users WHERE demo = 1").all()
				.map(u => ({ id: u.discord_id, name: u.display_name, role: effectiveRole(u) })));
		});
	}

	app.use("/api", apiLimiter, auth.csrfGuard, require("../routes/api"));

	const pub = path.join(__dirname, "..", "public");
	app.get("/app", (req, res) => {
		if (!req.user || req.user.role === "none") return res.redirect("/");
		res.set("Cache-Control", "no-store");
		res.sendFile(path.join(pub, "app.html"));
	});
	app.get("/", (req, res) => {
		if (req.user && req.user.role !== "none") return res.redirect(req.user.role === "trooper" ? "/app#/my" : "/app#/board");
		res.sendFile(path.join(pub, "index.html"));
	});
	app.get("/config.js", (req, res) => {
		res.type("application/javascript").set("Cache-Control", "no-store")
			.send(`window.IA_CONFIG=${JSON.stringify({ devLogin: config.DEV_LOGIN })};`);
	});
	app.use(express.static(pub, { index: false, maxAge: config.IS_PROD ? "1h" : 0 }));
	app.use((req, res) => res.status(404).sendFile(path.join(pub, "index.html")));
	return app;
}

module.exports = { createApp };
