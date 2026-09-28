const path = require("path");

const env = process.env;
const list = value => String(value || "").split(/[\s,]+/).filter(Boolean);

const NODE_ENV = env.NODE_ENV || "development";
const IS_PROD = NODE_ENV === "production";
const PORT = Number(env.PORT) || 3000;

const railwayUrl = env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : "";
const PUBLIC_URL = (env.PUBLIC_URL || railwayUrl || `http://localhost:${PORT}`).replace(/\/+$/, "");

const SESSION_SECRET = env.SESSION_SECRET || (IS_PROD ? "" : "local-development-secret-not-for-production-use");
if (IS_PROD && SESSION_SECRET.length < 32) {
	throw new Error("SESSION_SECRET must be set to at least 32 characters in production.");
}

module.exports = {
	NODE_ENV,
	IS_PROD,
	PORT,
	PUBLIC_URL,
	DATA_DIR: env.DATA_DIR || path.join(__dirname, "..", "data"),
	SESSION_SECRET,
	SESSION_HOURS: Number(env.SESSION_HOURS) || 12,
	// Sessions also end after this much inactivity.
	SESSION_IDLE_MINUTES: Number(env.SESSION_IDLE_MINUTES) || 120,
	// Oldest sessions beyond this count are signed out when a user signs in again.
	MAX_SESSIONS_PER_USER: Number(env.MAX_SESSIONS_PER_USER) || 3,
	// IA staff must have two-factor authentication enabled on their Discord account.
	REQUIRE_DISCORD_MFA: env.IA_REQUIRE_DISCORD_MFA !== "false",

	// Served under a path of the main site (e.g. /sahp/opr/ia) through the moderation panel's pass-through.
	BASE_PATH: String(env.BASE_PATH || "").replace(/\/+$/, "").replace(/^(?!\/)(.+)/, "/$1"),
	// Shared secret the pass-through adds to every request. When set, requests without it get a plain 404.
	PROXY_SECRET: env.IA_PROXY_SECRET || "",

	DISCORD_CLIENT_ID: env.DISCORD_CLIENT_ID || "",
	DISCORD_CLIENT_SECRET: env.DISCORD_CLIENT_SECRET || "",
	DISCORD_BOT_TOKEN: env.DISCORD_BOT_TOKEN || "",
	DISCORD_GUILD_ID: env.DISCORD_GUILD_ID || "",
	OWNER_DISCORD_IDS: list(env.IA_OWNER_DISCORD_IDS),
	// The only accounts allowed to export a case file as PDF.
	EXPORT_DISCORD_IDS: list(env.IA_EXPORT_DISCORD_IDS),

	AI_PROVIDER: (env.AI_PROVIDER || "none").toLowerCase(),
	AI_API_KEY: env.AI_API_KEY || "",
	AI_MODEL: env.AI_MODEL || "",
	AI_BASE_URL: env.AI_BASE_URL || "",
	// Backup provider used when the primary is overloaded, rate-limited, or failing.
	AI_FALLBACK_PROVIDER: (env.AI_FALLBACK_PROVIDER || (env.AI_FALLBACK_API_KEY ? "groq" : "none")).toLowerCase(),
	AI_FALLBACK_API_KEY: env.AI_FALLBACK_API_KEY || "",
	AI_FALLBACK_MODEL: env.AI_FALLBACK_MODEL || "",
	AI_FALLBACK_BASE_URL: env.AI_FALLBACK_BASE_URL || "",
	AI_MAX_INPUT_CHARS: Number(env.AI_MAX_INPUT_CHARS) || 60000,
	AI_TIMEOUT_MS: Number(env.AI_TIMEOUT_MS) || 120000,

	SEED_DEMO: env.SEED_DEMO === "true",
	DEV_LOGIN: !IS_PROD && env.DEV_LOGIN !== "false",
	ATTACHMENT_MAX_BYTES: Number(env.ATTACHMENT_MAX_BYTES) || 10 * 1024 * 1024
};
