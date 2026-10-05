// Intake panels: the "Report a Trooper / Report Anonymously / OPS" button messages. Where they live is a saved
// setting, managed from Settings → Discord & roles or with /ia-panel. The bot keeps each panel in place: on startup
// and whenever settings change it updates the posted message to the current design, and reposts it if someone
// deleted it. Moving a panel removes the old message.
const { getSetting, setSetting, now } = require("./db");
const audit = require("./audit");

const BUTTONS = {
	report: "Report a Trooper",
	anon: "Report Anonymously",
	ops: "OPS / System Report"
};
const MAX_PANELS = 10;

const httpError = (status, message) => Object.assign(new Error(message), { status });

function list() {
	const saved = getSetting("intake_panels", []);
	return Array.isArray(saved) ? saved : [];
}

function save(panels, actorId) {
	setSetting("intake_panels", panels, actorId);
}

function cleanButtons(value) {
	const keys = (Array.isArray(value) ? value : Object.keys(BUTTONS)).filter(k => k in BUTTONS);
	if (!keys.length) throw httpError(400, "Choose at least one button");
	return Object.keys(BUTTONS).filter(k => keys.includes(k));
}

function checkChannelId(id) {
	if (!/^\d{15,22}$/.test(String(id || ""))) throw httpError(400, "Choose a channel");
	return String(id);
}

const bot = () => require("./bot");

// Posts a new panel in a channel (or updates the one already there).
async function add(channelId, buttons, actor, ip) {
	channelId = checkChannelId(channelId);
	buttons = cleanButtons(buttons);
	const panels = list();
	const existing = panels.find(p => p.channelId === channelId);
	if (!existing && panels.length >= MAX_PANELS) throw httpError(400, `At most ${MAX_PANELS} panels`);
	const messageId = await bot().placePanel(channelId, existing?.messageId, buttons);
	const panel = { channelId, messageId, buttons, postedAt: now(), postedBy: actor?.discord_id || null };
	save(existing ? panels.map(p => (p.channelId === channelId ? panel : p)) : [...panels, panel], actor?.discord_id);
	audit.record(actor, existing ? "bot.panel_updated" : "bot.panel_posted", { type: "channel", ref: channelId }, { buttons }, ip);
	return panel;
}

// Changes a panel's buttons and/or moves it to another channel.
async function update(channelId, { channelId: target, buttons }, actor, ip) {
	const panels = list();
	const panel = panels.find(p => p.channelId === String(channelId));
	if (!panel) throw httpError(404, "Panel not found");
	const next = { ...panel, buttons: buttons ? cleanButtons(buttons) : panel.buttons };
	const moving = target && String(target) !== panel.channelId;
	if (moving) {
		next.channelId = checkChannelId(target);
		if (panels.some(p => p.channelId === next.channelId)) throw httpError(409, "That channel already has a panel");
		next.messageId = await bot().placePanel(next.channelId, null, next.buttons);
		await bot().removePanel(panel.channelId, panel.messageId).catch(() => {});
	} else {
		next.messageId = await bot().placePanel(next.channelId, panel.messageId, next.buttons);
	}
	next.postedAt = now();
	save(panels.map(p => (p === panel ? next : p)), actor?.discord_id);
	audit.record(actor, moving ? "bot.panel_moved" : "bot.panel_updated", { type: "channel", ref: next.channelId }, { from: moving ? panel.channelId : undefined, buttons: next.buttons }, ip);
	return next;
}

async function remove(channelId, actor, ip) {
	const panels = list();
	const panel = panels.find(p => p.channelId === String(channelId));
	if (!panel) throw httpError(404, "Panel not found");
	await bot().removePanel(panel.channelId, panel.messageId).catch(() => {});
	save(panels.filter(p => p !== panel), actor?.discord_id);
	audit.record(actor, "bot.panel_removed", { type: "channel", ref: panel.channelId }, {}, ip);
}

// Brings every saved panel up to date; reposts any that were deleted. Runs when the bot comes online.
async function sync() {
	const panels = list();
	if (!panels.length) return { ok: 0, reposted: 0, failed: 0 };
	let ok = 0;
	let reposted = 0;
	let failed = 0;
	const next = [];
	for (const panel of panels) {
		try {
			const messageId = await bot().placePanel(panel.channelId, panel.messageId, panel.buttons);
			if (messageId !== panel.messageId) reposted++;
			else ok++;
			next.push({ ...panel, messageId, error: undefined });
		} catch (error) {
			failed++;
			next.push({ ...panel, error: error.message });
		}
	}
	save(next, null);
	if (reposted || failed) console.log(`[panels] ${ok} up to date, ${reposted} reposted, ${failed} failed`);
	return { ok, reposted, failed };
}

module.exports = { BUTTONS, list, add, update, remove, sync };
