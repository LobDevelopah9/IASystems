const crypto = require("crypto");
const { db, now } = require("./db");

const GENESIS = "0".repeat(64);

const insert = db.prepare(`
	INSERT INTO audit_log (at, actor_id, actor_name, action, target_type, target_ref, detail, ip, prev_hash, hash)
	VALUES (@at, @actor_id, @actor_name, @action, @target_type, @target_ref, @detail, @ip, @prev_hash, @hash)
`);
const lastHash = db.prepare("SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1");

function digest(row) {
	return crypto.createHash("sha256").update([
		row.prev_hash, row.at, row.actor_id || "", row.action, row.target_type || "", row.target_ref || "", row.detail
	].join("\u001f")).digest("hex");
}

// Append-only, hash-chained log. Tampering with any row breaks every later hash.
const record = db.transaction((actor, action, target = {}, detail = {}, ip = null) => {
	const row = {
		at: now(),
		actor_id: actor?.discord_id || actor?.id || null,
		actor_name: actor?.display_name || actor?.username || actor?.name || "System",
		action,
		target_type: target.type || null,
		target_ref: target.ref != null ? String(target.ref) : null,
		detail: JSON.stringify(detail || {}),
		ip,
		prev_hash: lastHash.get()?.hash || GENESIS
	};
	row.hash = digest(row);
	insert.run(row);
	return row;
});

function verifyChain() {
	let prev = GENESIS;
	let count = 0;
	for (const row of db.prepare("SELECT * FROM audit_log ORDER BY id").iterate()) {
		if (row.prev_hash !== prev || digest(row) !== row.hash) {
			return { ok: false, brokenAt: row.id, checked: count };
		}
		prev = row.hash;
		count++;
	}
	return { ok: true, checked: count };
}


// --- Suspicious-activity alerts -----------------------------------------------------
// Bursts of denied logins, blocked requests, CSRF rejections, or rate-limit hits are reported to the IA log
// channel (via the bot) and the server log. Alerts are throttled so a sustained attack cannot flood the channel.
const WATCHED = {
	"auth.login_denied": { threshold: 8, label: "failed or denied sign-ins" },
	"access.denied": { threshold: 15, label: "permission-denied requests" },
	"security.csrf_blocked": { threshold: 5, label: "blocked cross-site requests" },
	"security.rate_limited": { threshold: 5, label: "rate-limited requests" }
};
const WINDOW_MS = 10 * 60000;
const ALERT_COOLDOWN_MS = 30 * 60000;
const lastAlert = new Map();
let notifier = null;

function setAlertNotifier(fn) {
	notifier = fn;
}

function checkAlert(action) {
	const rule = WATCHED[action];
	if (!rule) return;
	const since = Date.now() - WINDOW_MS;
	const rows = db.prepare("SELECT ip, actor_name FROM audit_log WHERE action = ? AND at >= ?").all(action, since);
	if (rows.length < rule.threshold) return;
	if (Date.now() - (lastAlert.get(action) || 0) < ALERT_COOLDOWN_MS) return;
	lastAlert.set(action, Date.now());
	const ips = [...new Set(rows.map(r => r.ip).filter(Boolean))].slice(0, 5);
	const message = `Security alert: ${rows.length} ${rule.label} in the last 10 minutes${ips.length ? ` (sources: ${ips.join(", ")})` : ""}. Review the IA audit log.`;
	console.warn(`[security] ${message}`);
	record(null, "security.alert", { type: "system" }, { action, count: rows.length, ips });
	if (notifier) Promise.resolve(notifier(message)).catch(() => {});
}

const recordAndWatch = (actor, action, target, detail, ip) => {
	const row = record(actor, action, target, detail, ip);
	if (WATCHED[action]) checkAlert(action);
	return row;
};

module.exports = { record: recordAndWatch, verifyChain, setAlertNotifier };
