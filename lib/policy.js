const { getSetting, setSetting } = require("./db");
const config = require("./config");

// Findings follow standard internal-affairs dispositions.
// "supports" is how the Investigation Report answers "Does the evidence support the allegation(s)".
const FINDINGS = [
	{ key: "sustained", label: "Sustained", supports: "YES", help: "The evidence supports the allegation(s)." },
	{ key: "partially_sustained", label: "Partially Sustained", supports: "PARTIAL", help: "The evidence supports some of the allegations but not all." },
	{ key: "not_sustained", label: "Not Sustained", supports: "NO", help: "Insufficient evidence to prove or disprove the allegation(s)." },
	{ key: "exonerated", label: "Exonerated", supports: "NO", help: "The conduct occurred but was justified and within SOP." },
	{ key: "unfounded", label: "Unfounded", supports: "NO", help: "The alleged conduct did not occur." },
	{ key: "policy_failure", label: "Policy / System Failure", supports: "N/A", help: "The issue stems from policy, tooling, or a system error rather than a member." }
];

const CLASSIFICATIONS = ["Standard Trooper Report", "Anonymous Trooper Report", "Supervisor Report", "Internal Referral", "OPS / System Report"];

// Several punishments can be issued together, e.g. "X1 Black Mark + FTO".
const DEFAULT_PUNISHMENTS = [
	{ key: "no_action", label: "No Action", appealable: false, severity: 0, description: "No disciplinary action. Use when the evidence does not support the allegation." },
	{ key: "verbal_warning", label: "Verbal Warning", appealable: false, severity: 1, description: "Documented warning about expectations. For minor first-time issues." },
	{ key: "fto", label: "FTO", appealable: false, severity: 1, description: "Referral back to a Field Training Officer for remedial training. Often issued alongside a Black Mark for probationary troopers." },
	{ key: "black_mark", label: "Black Mark", appealable: true, severity: 3, description: "Formal Black Mark on the member's record. Detail states the count, e.g. X1. Standard punishment for unprofessionalism." },
	{ key: "suspension", label: "Suspension", appealable: true, severity: 4, description: "Temporary removal from duty. Detail must state the duration." },
	{ key: "demotion", label: "Demotion", appealable: true, severity: 5, description: "Reduction in rank. Detail must state the new rank." },
	{ key: "termination", label: "Termination", appealable: true, severity: 6, description: "Removal from the San Andreas Highway Patrol. Used for serious or repeated SOP violations, or refusing to cooperate with IA." },
	{ key: "blacklist", label: "Blacklist", appealable: false, severity: 7, description: "Bar on rejoining the department. Issued together with Termination for the most serious misconduct." }
];

const PORTAL_ROLES = ["director", "supervisor", "investigator", "trooper"];

function punishments() {
	const list = getSetting("punishments", null);
	return Array.isArray(list) && list.length ? list : DEFAULT_PUNISHMENTS;
}

function punishmentByKey(key) {
	return punishments().find(item => item.key === key) || null;
}

// Punishments are stored as comma-separated keys, e.g. "black_mark,fto".
function punishmentKeys(value) {
	return (Array.isArray(value) ? value : String(value || "").split(","))
		.map(k => String(k).trim()).filter(Boolean);
}

function punishmentLabel(value, detail) {
	const labels = punishmentKeys(value).map(k => punishmentByKey(k)?.label || k);
	if (!labels.length) return null;
	return `${labels.join(" + ")}${detail ? ` (${detail})` : ""}`;
}

function findingSupports(key) {
	return FINDINGS.find(f => f.key === key)?.supports || null;
}

// Case numbers continue the paper series (#0642, #0643, ...).
function nextCaseNumber() {
	const start = Number(process.env.CASE_NUMBER_START) || 644;
	const saved = Number(getSetting("next_case_number", 0)) || 0;
	const { db } = require("./db");
	const highest = db.prepare("SELECT MAX(case_number) AS n FROM cases WHERE demo = 0").get().n || 0;
	const next = Math.max(saved || start, highest + 1);
	setSetting("next_case_number", next + 1, null);
	return next;
}

function roleMap() {
	const saved = getSetting("role_map", null) || {};
	const map = {};
	for (const role of PORTAL_ROLES) {
		const fromEnv = String(process.env[`ROLE_${role.toUpperCase()}_IDS`] || "").split(/[\s,]+/).filter(Boolean);
		map[role] = Array.isArray(saved[role]) && saved[role].length ? saved[role] : fromEnv;
	}
	return map;
}

function discordSettings() {
	const saved = getSetting("discord", null) || {};
	return {
		guildId: saved.guildId || config.DISCORD_GUILD_ID || "",
		ticketCategoryId: saved.ticketCategoryId || process.env.DISCORD_TICKET_CATEGORY_ID || "",
		logChannelId: saved.logChannelId || process.env.DISCORD_LOG_CHANNEL_ID || ""
	};
}

function saveDiscordSettings(value, actorId) {
	const clean = {};
	for (const key of ["guildId", "ticketCategoryId", "logChannelId"]) {
		const text = String(value[key] || "").trim();
		if (text && !/^\d{15,22}$/.test(text)) throw Object.assign(new Error(`${key} must be a Discord ID`), { status: 400 });
		clean[key] = text;
	}
	setSetting("discord", clean, actorId);
}

function saveRoleMap(value, actorId) {
	const clean = {};
	for (const role of PORTAL_ROLES) {
		const ids = Array.isArray(value[role]) ? value[role] : [];
		clean[role] = [...new Set(ids.map(String).filter(id => /^\d{15,22}$/.test(id)))];
	}
	setSetting("role_map", clean, actorId);
}

function savePunishments(list, actorId) {
	if (!Array.isArray(list) || !list.length || list.length > 30) {
		throw Object.assign(new Error("Provide between 1 and 30 punishment categories"), { status: 400 });
	}
	const seen = new Set();
	const clean = list.map((item, index) => {
		const label = String(item.label || "").trim().slice(0, 60);
		let key = String(item.key || label).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);
		if (!label || !key) throw Object.assign(new Error("Every category needs a name"), { status: 400 });
		if (seen.has(key)) key = `${key}_${index}`;
		seen.add(key);
		return {
			key,
			label,
			appealable: Boolean(item.appealable),
			severity: Math.max(0, Math.min(10, Number(item.severity) || 0)),
			description: String(item.description || "").trim().slice(0, 300)
		};
	});
	setSetting("punishments", clean, actorId);
}

module.exports = {
	FINDINGS,
	CLASSIFICATIONS,
	DEFAULT_PUNISHMENTS,
	punishmentKeys,
	punishmentLabel,
	findingSupports,
	nextCaseNumber,
	PORTAL_ROLES,
	punishments,
	punishmentByKey,
	roleMap,
	saveRoleMap,
	discordSettings,
	saveDiscordSettings,
	savePunishments
};
