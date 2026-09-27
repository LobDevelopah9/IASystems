const { OWNER_DISCORD_IDS } = require("./config");
const { roleMap } = require("./policy");

const RANK = { none: 0, trooper: 1, investigator: 2, supervisor: 3, director: 4 };

const ROLE_LABELS = {
	director: "Head of Internal Affairs",
	supervisor: "OPS Supervisor",
	investigator: "IA Investigator",
	trooper: "Trooper",
	none: "No access"
};

// Every capability is checked server-side. The UI only mirrors these.
const CAPABILITIES = {
	"self.cases": "trooper",
	"ia.access": "investigator",
	"case.view": "investigator",
	"case.create": "investigator",
	"case.edit": "investigator",
	"case.note": "investigator",
	"case.redraft": "investigator",
	"ticket.view": "investigator",
	"personnel.manage": "investigator",
	// Anonymous reports are anonymous to the accused only. Every IA agent sees the reporter.
	"case.view_identity": "investigator",
	"case.assign": "supervisor",
	"case.decide": "supervisor",
	"audit.view": "supervisor",
	"users.view": "supervisor",
	"users.manage": "director",
	"settings.manage": "director",
	"case.reopen_closed": "director"
};

function roleFromDiscord(discordRoleIds) {
	const map = roleMap();
	const held = new Set(discordRoleIds || []);
	for (const role of ["director", "supervisor", "investigator", "trooper"]) {
		if ((map[role] || []).some(id => held.has(id))) return role;
	}
	return "none";
}

function effectiveRole(user) {
	if (!user) return "none";
	if (OWNER_DISCORD_IDS.includes(user.discord_id)) return "director";
	if (user.suspended) return "none";
	if (!user.in_guild) return "none";
	if (user.role_override && RANK[user.role_override] !== undefined) return user.role_override;
	return RANK[user.mapped_role] !== undefined ? user.mapped_role : "none";
}

// Owners (IA_OWNER_DISCORD_IDS) bypass conflict-of-interest rules. Every bypass is flagged in the audit log.
function isOwner(user) {
	return Boolean(user?.discord_id && OWNER_DISCORD_IDS.includes(user.discord_id));
}

function can(user, capability) {
	const needed = CAPABILITIES[capability];
	if (!needed) throw new Error(`Unknown capability ${capability}`);
	return RANK[effectiveRole(user)] >= RANK[needed];
}

function capabilityList(user) {
	return Object.keys(CAPABILITIES).filter(cap => can(user, cap));
}

module.exports = { RANK, ROLE_LABELS, CAPABILITIES, roleFromDiscord, effectiveRole, can, capabilityList, isOwner };
