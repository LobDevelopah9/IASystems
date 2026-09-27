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

module.exports = { record, verifyChain };
