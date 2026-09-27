import { h, clear, icon, api, toast, attempt, ago, avatar, modal, closeLayer, confirmDialog } from "../lib.js";
import { store, can } from "../state.js";

const ROLE_ORDER = { director: 0, supervisor: 1, investigator: 2, trooper: 3, none: 4 };
const ROLE_TAG = { director: "gold", supervisor: "green", investigator: "blue", trooper: "", none: "red" };

export async function render({ page, isCurrent }) {
	page.setTitle("Users & Agents", "Portal access is driven by Discord roles. Overrides, suspensions, and agent profiles are managed here.");
	const manage = can("users.manage");
	if (manage) page.setActions(h("button", { class: "btn", onclick: sync }, icon("refresh"), "Sync from Discord"));
	let tab = "agents";
	let data = { users: [], roles: [] };
	let personnel = [];
	const tabs = h("div", { class: "tabs" });
	const search = h("input", { class: "input", type: "search", placeholder: "Search by name, username, callsign…" });
	const body = h("div");

	async function load() {
		[data, { personnel }] = await Promise.all([api("/users"), api("/personnel")]);
		if (isCurrent()) draw();
	}

	async function sync() {
		const res = await attempt(() => api("/users/sync", { method: "POST", body: {} }));
		toast(res.ok ? `Synced ${res.members} Discord members` : `Sync failed: ${res.error}`, res.ok ? "ok" : "error");
		load();
	}

	function drawTabs() {
		const counts = {
			agents: data.users.filter(u => ["director", "supervisor", "investigator"].includes(u.role)).length,
			members: data.users.length,
			personnel: personnel.length
		};
		clear(tabs, [["agents", "IA Agents"], ["members", "All portal users"], ["personnel", "Personnel directory"]].map(([key, label]) =>
			h("button", { class: tab === key ? "on" : "", onclick: () => { tab = key; draw(); } }, `${label} (${counts[key]})`)));
	}

	function draw() {
		drawTabs();
		const needle = search.value.trim().toLowerCase();
		const match = (...values) => !needle || values.some(v => String(v || "").toLowerCase().includes(needle));
		if (tab === "personnel") {
			const rows = personnel.filter(p => match(p.name, p.callsign, p.robloxUsername, p.discordUsername, p.rank));
			clear(body, h("div", { class: "panel table-wrap" }, h("table", { class: "table" },
				h("thead", null, h("tr", null, ["Name", "ROBLOX", "Discord", "Rank", "Callsign", "Cases as accused", ""].map(x => h("th", null, x)))),
				h("tbody", null, rows.map(p => h("tr", null,
					h("td", null, h("b", null, p.name), p.demo ? h("span", { class: "muted small" }, "  demo") : null),
					h("td", { class: "mono small" }, p.robloxUsername || "-"),
					h("td", { class: "small" }, p.discordUsername || "-", p.discordId ? h("span", { class: "tag green", style: { marginLeft: "6px" } }, "Linked") : null),
					h("td", null, p.rank || "-"),
					h("td", { class: "mono" }, p.callsign || "-"),
					h("td", { class: "mono" }, p.caseCount),
					h("td", null, can("personnel.manage") ? h("button", { class: "btn sm", onclick: () => editPersonnel(p) }, icon("edit"), "Edit") : null)))))),
				can("personnel.manage") ? h("div", { style: { marginTop: "12px" } }, h("button", { class: "btn", onclick: () => editPersonnel(null) }, icon("plus"), "Add personnel record")) : null);
			return;
		}
		const list = data.users
			.filter(u => tab === "members" || ["director", "supervisor", "investigator"].includes(u.role))
			.filter(u => match(u.displayName, u.username, u.callsign, u.badgeNumber, u.title, u.robloxUsername))
			.sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.displayName.localeCompare(b.displayName));
		clear(body, list.length ? h("div", { class: "panel table-wrap" }, h("table", { class: "table" },
			h("thead", null, h("tr", null, ["Member", "Portal role", "Callsign / badge", "Active cases", "Last seen", "Status", ""].map(x => h("th", null, x)))),
			h("tbody", null, list.map(u => h("tr", null,
				h("td", null, h("div", { class: "row", style: { gap: "10px", flexWrap: "nowrap" } }, avatar(u.displayName, u.avatar),
					h("div", null, h("b", null, u.displayName), h("div", { class: "muted small" }, `@${u.username}${u.robloxUsername ? ` · ROBLOX ${u.robloxUsername}` : ""}${u.title ? ` · ${u.title}` : ""}`)))),
				h("td", null, h("span", { class: `tag ${ROLE_TAG[u.role]}` }, u.roleLabel),
					u.override ? h("div", { class: "muted small", style: { marginTop: "3px" } }, "Manual override") : u.owner ? h("div", { class: "muted small", style: { marginTop: "3px" } }, "Owner (env)") : h("div", { class: "muted small", style: { marginTop: "3px" } }, "From Discord roles")),
				h("td", { class: "mono small" }, [u.callsign, u.badgeNumber && `#${u.badgeNumber}`].filter(Boolean).join(" · ") || "-"),
				h("td", { class: "mono" }, u.activeCases),
				h("td", { class: "small muted" }, ago(u.lastSeenAt), u.sessions ? h("div", null, `${u.sessions} active session${u.sessions > 1 ? "s" : ""}`) : null),
				h("td", null, u.suspended ? h("span", { class: "tag red", title: u.suspendedReason || "" }, icon("lock"), "Suspended") : !u.inGuild ? h("span", { class: "tag red" }, "Left server") : h("span", { class: "tag green" }, "Active")),
				h("td", null, manage && u.id !== store.me.id ? h("button", { class: "btn sm", onclick: () => editUser(u) }, icon("edit"), "Manage") : null)))))) : h("div", { class: "panel" }, h("div", { class: "empty" }, "No users.")));
	}

	function editUser(u) {
		const override = h("select", { class: "input", value: u.override || "" },
			h("option", { value: "" }, `Use Discord roles (currently: ${labelFor(u.mappedRole)})`),
			["director", "supervisor", "investigator", "trooper", "none"].map(r => h("option", { value: r }, `Override: ${labelFor(r)}`)));
		const callsign = h("input", { class: "input", value: u.callsign || "", placeholder: "IA-11" });
		const badge = h("input", { class: "input", value: u.badgeNumber || "", placeholder: "2107" });
		const title = h("input", { class: "input", value: u.title || "", placeholder: "Assistant Commissioner" });
		const roblox = h("input", { class: "input", value: u.robloxUsername || "", placeholder: "BLUEFAMILY227" });
		modal({
			title: `Manage ${u.displayName}`,
			body: h("div", { class: "stack" },
				h("label", { class: "field" }, h("span", null, "Portal role"), override, h("small", null, "Overrides win over Discord roles. Lowering a role signs the user out everywhere.")),
				h("div", { class: "grid-3" }, h("label", { class: "field" }, h("span", null, "Callsign"), callsign), h("label", { class: "field" }, h("span", null, "Badge no."), badge), h("label", { class: "field" }, h("span", null, "Title"), title)),
				h("label", { class: "field" }, h("span", null, "ROBLOX username"), roblox, h("small", null, "Used as the investigator / approver name on Investigation Reports.")),
				h("div", { class: "row" },
					u.suspended
						? h("button", { class: "btn", onclick: () => setSuspended(u, false) }, icon("check"), "Reinstate access")
						: h("button", { class: "btn danger", disabled: u.owner, onclick: () => setSuspended(u, true) }, icon("lock"), "Suspend access"),
					h("button", { class: "btn", disabled: !u.sessions, onclick: async () => {
						await attempt(() => api(`/users/${u.id}/revoke-sessions`, { method: "POST", body: {} }), "Signed out everywhere");
						closeLayer();
						load();
					} }, icon("logout"), "Sign out everywhere"))),
			actions: [
				h("button", { class: "btn ghost", onclick: closeLayer }, "Cancel"),
				h("button", { class: "btn primary", onclick: async () => {
					await attempt(() => api(`/users/${u.id}`, { method: "PATCH", body: { override: override.value || null, callsign: callsign.value, badgeNumber: badge.value, title: title.value, robloxUsername: roblox.value } }), "User updated");
					closeLayer();
					load();
				} }, "Save")
			]
		});
	}

	async function setSuspended(u, suspended) {
		const reason = suspended ? await confirmDialog({ title: `Suspend ${u.displayName}?`, message: "They are signed out immediately and cannot sign in until reinstated.", confirmLabel: "Suspend", danger: true, input: { label: "Reason (recorded in the audit log)", required: true } }) : true;
		if (!reason) return;
		await attempt(() => api(`/users/${u.id}`, { method: "PATCH", body: { suspended, reason: suspended ? reason : undefined } }), suspended ? "Access suspended" : "Access reinstated");
		closeLayer();
		load();
	}

	function editPersonnel(p) {
		const name = h("input", { class: "input", value: p?.name || "", disabled: Boolean(p?.discordId) });
		const callsign = h("input", { class: "input", value: p?.callsign || "" });
		const rank = h("input", { class: "input", value: p?.rank || "" });
		const roblox = h("input", { class: "input", value: p?.robloxUsername || "" });
		const discordUser = h("input", { class: "input", value: p?.discordUsername || "" });
		modal({
			title: p ? `Edit ${p.name}` : "Add personnel record",
			body: h("div", { class: "stack" },
				h("label", { class: "field" }, h("span", null, "Name"), name, p?.discordId ? h("small", null, "Synced from Discord") : null),
				h("div", { class: "grid-3" }, h("label", { class: "field" }, h("span", null, "Callsign"), callsign), h("label", { class: "field" }, h("span", null, "Rank"), rank), h("label", { class: "field" }, h("span", null, "ROBLOX username"), roblox)),
				h("label", { class: "field" }, h("span", null, "Discord username"), discordUser)),
			actions: [
				h("button", { class: "btn ghost", onclick: closeLayer }, "Cancel"),
				h("button", { class: "btn primary", onclick: async () => {
					const body = { name: name.value, callsign: callsign.value, rank: rank.value, roblox_username: roblox.value, robloxUsername: roblox.value, discord_username: discordUser.value, discordUsername: discordUser.value };
					await attempt(() => p ? api(`/personnel/${p.id}`, { method: "PATCH", body }) : api("/personnel", { method: "POST", body }), "Saved");
					closeLayer();
					load();
				} }, "Save")
			]
		});
	}

	function labelFor(role) {
		return data.roles.find(r => r.key === role)?.label || role;
	}

	search.addEventListener("input", draw);
	clear(page.content, tabs, h("div", { class: "filters" }, h("div", { class: "search" }, icon("search"), search)), body);
	await load();
}
