import { h, clear, icon, api, toast, attempt, confirmDialog, ago, tabStrip } from "../lib.js";
import { loadMe, store } from "../state.js";

const ROLE_INFO = {
	director: ["Head of Internal Affairs", "Full control: users, settings, reopening closed cases, plus everything below."],
	supervisor: ["OPS Supervisor", "Signs and approves cases, closes and hears appeals, assigns agents, reads the audit log."],
	investigator: ["IA Investigator", "Works cases: board, tickets and transcripts (including anonymous reporters), editing reports, notes, New Case, AI redrafts. Cannot sign or approve."],
	trooper: ["Trooper", "Can sign in to see their own approved IA determinations and request appeals. Nothing else."]
};

export async function render({ page, params, isCurrent }) {
	page.setTitle("Settings", "Discord connection, role mapping, discipline policy, AI drafting, and system health.");
	let tab = params[0] || "system";
	let tabs = h("div", { class: "tabs" });
	const body = h("div");
	clear(page.content, tabs, body);

	const TABS = [["system", "System status"], ["discord", "Discord & roles"], ["policy", "Punishment policy"], ...(store.owner ? [["import", "Import records"]] : [])];
	async function show() {
		tabs.replaceWith(tabs = tabStrip(TABS, tab, key => { tab = key; history.replaceState(null, "", `#/settings/${key}`); show(); }, "Settings sections"));
		clear(body, h("div", { class: "skeleton", style: { height: "240px" } }));
		if (tab === "system") await system();
		if (tab === "discord") await discord();
		if (tab === "policy") await policy();
		if (tab === "import") importRecords();
	}

	async function system() {
		const s = await api("/system");
		if (!isCurrent()) return;
		const item = (state, title, text, extra) => h("li", null,
			h("span", { class: `state ${state}` }, icon(state === "ok" ? "check" : state === "warn" ? "alert" : "x")),
			h("div", { style: { flex: 1, minWidth: 0 } }, h("b", null, title), h("p", null, text), extra || null));
		const aiResult = h("div", { class: "small", style: { marginTop: "6px" } });
		clear(body, h("div", { class: "grid-2", style: { alignItems: "start" } },
			h("div", { class: "panel" }, h("div", { class: "panel-head" }, h("h3", null, "Setup checklist")), h("div", { class: "panel-body" }, h("ul", { class: "checklist" },
				item(s.oauth.configured ? "ok" : "bad", "Discord sign-in (OAuth2)", s.oauth.configured ? "Client ID and secret are set." : "Set DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET.",
					h("p", null, "Redirect URI to register in the Discord developer portal: ", h("span", { class: "copyable" }, s.redirectUri))),
				item(s.bot.online ? "ok" : s.bot.configured ? "bad" : "bad", "IA bot", s.bot.online ? `Online as ${s.bot.tag}. Last role sync ${ago(s.bot.lastSync)}.` : s.bot.error || "Offline.",
					s.bot.inviteUrl ? h("p", null, h("a", { href: s.bot.inviteUrl, target: "_blank", rel: "noopener" }, "Invite the bot to the SAHP server →")) : null),
				item(s.discord.guildId ? "ok" : "bad", "SAHP server", s.discord.guildId ? `Guild ${s.discord.guildId}` : "Set the server ID under Discord & roles."),
				item(s.discord.ticketCategoryId ? "ok" : "warn", "Ticket category", s.discord.ticketCategoryId ? "Tickets open under the configured category." : "Optional, but recommended: choose a private category for IA tickets."),
				s.identity ? item(s.identity.bloxlink ? "ok" : "warn", "ROBLOX linking (Bloxlink)", s.identity.bloxlink
					? `Linking automatically. ${s.identity.roblox || 0} of ${s.identity.total || 0} personnel have a ROBLOX account on file (${s.identity.bloxlink || 0} verified by Bloxlink).`
					: "Server nicknames (RANK | CALLSIGN | RobloxName) are used. For verified links, add a Bloxlink server API key as BLOXLINK_API_KEY in Railway.") : null,
				item(s.discord.logChannelId ? "ok" : "warn", "IA log channel", s.discord.logChannelId ? "Ticket events post links (never content) here." : "Optional: a private staff channel for ticket notifications."),
				item(s.roleMapComplete ? "ok" : "bad", "Role mapping", s.roleMapComplete ? "Director, supervisor, and investigator roles are mapped." : "Map Discord roles to portal roles under Discord & roles."),
				item(s.ai.configured ? "ok" : "bad", "AI drafting", s.ai.configured ? `Primary: ${s.ai.provider} · ${s.ai.model}` : "Set AI_PROVIDER, AI_API_KEY and optionally AI_MODEL.",
					h("div", null,
						h("p", null, s.ai.fallback ? `Fallback: ${s.ai.fallback.provider} · ${s.ai.fallback.model}. Used automatically when the primary is overloaded or failing.` : "No fallback. Set AI_FALLBACK_API_KEY (Groq) so drafts keep working when the primary is overloaded."),
						h("button", { class: "btn sm", style: { marginTop: "6px" }, onclick: async () => {
							aiResult.textContent = "Testing…";
							const r = await api("/system/ai-test", { method: "POST", body: {} });
							const line = (label, t) => !t ? null : `${label}: ${t.ok ? `connected · ${t.provider}/${t.model} · ${t.latencyMs} ms` : `failed · ${t.error}`}`;
							aiResult.textContent = [line("Primary", r.primary), line("Fallback", r.fallback)].filter(Boolean).join("  |  ");
							aiResult.style.color = r.primary?.ok && (!r.fallback || r.fallback.ok) ? "var(--green)" : r.ok ? "var(--amber)" : "var(--red)";
						} }, icon("bot"), "Test connection"), aiResult)),
				item(s.persistent ? "ok" : "warn", "Persistent storage", s.persistent ? `Data stored on the volume at ${s.dataDir}.` : `Data directory ${s.dataDir} is not a mounted volume. Data will be lost on redeploy.`),
				item(s.owners ? "ok" : "warn", "Break-glass owner", s.owners ? `${s.owners} owner account(s) set via IA_OWNER_DISCORD_IDS.` : "Set IA_OWNER_DISCORD_IDS so at least one Head of IA can always sign in.")))),
			h("div", { class: "stack" },
				h("div", { class: "panel" }, h("div", { class: "panel-head" }, h("h3", null, "AI drafting queue")), h("div", { class: "panel-body" },
					h("div", { class: "grid-2" }, ["queued", "running", "done", "failed"].map(k => h("div", { class: "stat" }, h("b", null, s.jobs[k] || 0), h("span", null, k)))))),
				h("div", { class: "panel" }, h("div", { class: "panel-head" }, h("h3", null, "Demo data")), h("div", { class: "panel-body stack" },
					h("p", { class: "muted", style: { margin: 0 } }, s.demo.cases || s.demo.tickets
						? `${s.demo.cases} demo cases and ${s.demo.tickets} demo tickets are loaded so the portal can be evaluated. Purge them before real cases go in.`
						: "No demo data is loaded."),
					s.demo.cases || s.demo.tickets ? h("div", null, h("button", { class: "btn danger", onclick: purge }, icon("x"), "Purge demo data")) : null)))));
	}

	// Owner-only import of past investigations. The file is prepared from the Trello board and its Google Doc reports.
	function importRecords() {
		let records = null;
		const file = h("input", { type: "file", accept: "application/json,.json", class: "input" });
		const info = h("div", { class: "muted small" }, "Choose sahp-ia-legacy-import.json.");
		const result = h("div", { class: "stack" });
		const preview = h("button", { class: "btn", disabled: true }, icon("search"), "Preview import");
		const run = h("button", { class: "btn primary", disabled: true }, icon("check"), "Import records");
		file.addEventListener("change", async () => {
			records = null;
			preview.disabled = run.disabled = true;
			clear(result);
			try {
				const data = JSON.parse(await file.files[0].text());
				records = Array.isArray(data) ? data : data.records;
				if (!Array.isArray(records) || !records.length) throw new Error("No records found in this file");
				info.textContent = `${records.length} records ready${data.source ? ` from ${data.source}` : ""}.`;
				preview.disabled = false;
			} catch (error) {
				info.textContent = `Could not read the file: ${error.message}`;
			}
		});
		const show = (res, dry) => clear(result, h("div", { class: "panel" }, h("div", { class: "panel-body stack" },
			h("b", null, dry ? "Preview (nothing saved yet)" : "Import complete"),
			h("div", null, `${res.created} new cases · ${res.updated} already imported and refreshed · ${res.withReport} with full report text · ${res.personnel} new personnel records`),
			res.conflicts.length ? h("div", { class: "stale-banner" }, icon("alert"), h("div", null,
				h("b", null, `${res.conflicts.length} case numbers were already taken `), "and will get a suffix: ",
				res.conflicts.slice(0, 20).map(c => `#${String(c.caseNumber).padStart(4, "0")} → #${c.ref}`).join(", "),
				". If a clash is with a test case, delete the test case and import again.")) : null)));
		preview.addEventListener("click", async () => {
			const res = await attempt(() => api("/import/legacy", { method: "POST", body: { records, dryRun: true } }));
			show(res, true);
			run.disabled = false;
		});
		run.addEventListener("click", async () => {
			run.disabled = true;
			const res = await attempt(() => api("/import/legacy", { method: "POST", body: { records } }));
			show(res, false);
			toast(`Imported ${res.created} cases (${res.updated} refreshed)`);
		});
		clear(body, h("div", { class: "stack", style: { maxWidth: "820px" } },
			h("section", { class: "editor-section" }, h("h3", null, "Import past investigations"),
				h("p", { class: "muted", style: { marginTop: 0 } }, "Adds concluded investigations from the IA Trello board as read-only case records, with their original case numbers, basis, punishments, labels, and the full report text where the Google Doc was readable. Running it again is safe: existing imports are refreshed, never duplicated, and report text an investigator has edited is kept."),
				h("div", { class: "stack" }, file, info, h("div", { class: "row" }, preview, run))),
			result));
	}

	async function purge() {
		const text = await confirmDialog({ title: "Purge all demo data?", message: "Removes every demo case, ticket, personnel record, and demo user. Real data is untouched. Audit entries are kept.", confirmLabel: "Purge", danger: true, input: { label: "Type PURGE DEMO DATA to confirm", required: true } });
		if (!text) return;
		const res = await attempt(() => api("/system/purge-demo", { method: "POST", body: { confirm: text } }));
		toast(`Removed ${res.cases} cases, ${res.tickets} tickets, ${res.users} demo users`);
		await loadMe();
		show();
	}

	async function discord() {
		const s = await api("/settings");
		if (!isCurrent()) return;
		const channels = s.guildChannels;
		const idField = (value, kind) => {
			const options = channels.filter(c => c.type === kind);
			if (!options.length) return h("input", { class: "input mono", value, placeholder: "Discord ID" });
			return h("select", { class: "input", value }, h("option", { value: "" }, "Not set"), options.map(c => h("option", { value: c.id }, kind === "category" ? c.name : `#${c.name}`)));
		};
		const guild = h("input", { class: "input mono", value: s.discord.guildId, placeholder: "Server ID" });
		const category = idField(s.discord.ticketCategoryId, "category");
		const log = idField(s.discord.logChannelId, "text");

		const selections = {};
		const roleEditors = Object.keys(ROLE_INFO).map(role => {
			selections[role] = new Set(s.roleMap[role] || []);
			const editor = s.guildRoles.length
				? h("div", { class: "role-list" }, s.guildRoles.map(r => {
					const cb = h("input", { type: "checkbox", checked: selections[role].has(r.id) });
					const chip = h("label", { class: `role-chip${cb.checked ? " on" : ""}` }, cb, h("i"), r.name);
					chip.querySelector("i").style.background = r.color === "#000000" ? "var(--muted)" : r.color;
					cb.addEventListener("change", () => { cb.checked ? selections[role].add(r.id) : selections[role].delete(r.id); chip.classList.toggle("on", cb.checked); });
					return chip;
				}))
				: (() => {
					const input = h("input", { class: "input mono", value: [...selections[role]].join(", "), placeholder: "Role IDs, comma separated" });
					input.addEventListener("input", () => { selections[role] = new Set(input.value.split(/[\s,]+/).filter(Boolean)); });
					return input;
				})();
			return h("div", { class: "field" }, h("span", null, ROLE_INFO[role][0]), h("small", null, ROLE_INFO[role][1]), editor);
		});

		clear(body, h("div", { class: "stack", style: { maxWidth: "900px" } },
			h("section", { class: "editor-section" }, h("h3", null, "Discord server"),
				h("div", { class: "grid-3" },
					h("label", { class: "field" }, h("span", null, "SAHP server ID"), guild),
					h("label", { class: "field" }, h("span", null, "Ticket category"), category),
					h("label", { class: "field" }, h("span", null, "IA log channel"), log)),
				!channels.length ? h("p", { class: "muted small" }, "Invite the bot and save the server ID to pick channels from a list.") : null,
				h("div", { style: { marginTop: "12px" } }, h("button", { class: "btn primary", onclick: async () => {
					await attempt(() => api("/settings/discord", { method: "PUT", body: { guildId: guild.value.trim(), ticketCategoryId: category.value.trim(), logChannelId: log.value.trim() } }), "Discord settings saved");
					show();
				} }, "Save server settings"))),
			panelSection(channels),
			fileSources(s, channels),
			h("section", { class: "editor-section" }, h("h3", null, "Role mapping"),
				h("p", { class: "muted small", style: { marginTop: 0 } }, "Portal access follows these Discord roles. A member gets the highest portal role any of their Discord roles maps to. Changes sync to every member immediately. Individual overrides live on the Users page."),
				h("div", { class: "stack" }, roleEditors),
				h("div", { style: { marginTop: "12px" } }, h("button", { class: "btn primary", onclick: async () => {
					const roleMap = Object.fromEntries(Object.entries(selections).map(([k, v]) => [k, [...v]]));
					const res = await attempt(() => api("/settings/roles", { method: "PUT", body: { roleMap } }));
					toast(res.sync?.ok ? `Role mapping saved · ${res.sync.members} members re-synced` : "Role mapping saved. Sync runs when the bot is online.");
				} }, "Save role mapping")))));
	}

	async function policy() {
		const s = await api("/settings");
		if (!isCurrent()) return;
		let list = s.punishments.map(p => ({ ...p }));
		const caseNo = h("input", { class: "input mono", type: "number", min: "1", max: "8999", value: String(s.nextCaseNumber) });
		caseNo.style.maxWidth = "140px";
		const rows = h("tbody");
		function draw() {
			clear(rows, list.map((p, i) => {
				const label = h("input", { class: "input", value: p.label });
				const sev = h("input", { class: "input mono", type: "number", min: "0", max: "10", value: String(p.severity) });
				const appeal = h("input", { type: "checkbox", checked: p.appealable });
				const desc = h("input", { class: "input", value: p.description });
				label.addEventListener("input", () => { p.label = label.value; });
				sev.addEventListener("input", () => { p.severity = Number(sev.value); });
				appeal.addEventListener("change", () => { p.appealable = appeal.checked; });
				desc.addEventListener("input", () => { p.description = desc.value; });
				sev.style.width = "70px";
				return h("tr", null, h("td", null, label), h("td", null, sev), h("td", null, h("label", { class: "check" }, appeal, "Appealable")), h("td", null, desc),
					h("td", null, h("button", { class: "btn ghost sm", "aria-label": "Remove", onclick: () => { list.splice(i, 1); draw(); } }, icon("x"))));
			}));
		}
		draw();
		clear(body, h("div", { class: "stack" },
			h("section", { class: "editor-section" }, h("h3", null, "Case numbering"),
				h("div", { class: "row" }, caseNo, h("button", { class: "btn", onclick: async () => {
					const res = await attempt(() => api("/settings/case-number", { method: "PUT", body: { next: Number(caseNo.value) } }));
					toast(`The next case will be #${String(res.next).padStart(4, "0")}`);
				} }, "Save")),
				h("small", { class: "muted" }, "Cases continue the Office of Professional Standards series. The next new case gets this number.")),
			h("p", { class: "muted", style: { margin: 0 } }, "Several categories can be issued together (e.g. Black Mark + FTO). These categories drive the AI's recommendations and the supervisor signing form. Default appealability pre-fills the form; supervisors can override it per case. Existing cases keep the category they were signed with."),
			h("div", { class: "panel table-wrap" }, h("table", { class: "table" },
				h("thead", null, h("tr", null, ["Category", "Severity", "Default", "Description (given to the AI)", ""].map(x => h("th", null, x)))), rows)),
			h("div", { class: "row" },
				h("button", { class: "btn", onclick: () => { list.push({ key: "", label: "New category", severity: 1, appealable: true, description: "" }); draw(); } }, icon("plus"), "Add category"),
				h("span", { class: "spacer" }),
				h("button", { class: "btn primary", onclick: async () => {
					const res = await attempt(() => api("/settings/punishments", { method: "PUT", body: { punishments: list } }), "Punishment policy saved");
					list = res.punishments.map(p => ({ ...p }));
					await loadMe();
					draw();
				} }, "Save policy"))));
	}

	await show();

// Channels the bot reads when an IA supervisor pulls a personnel file.
const FILE_SOURCES = [
	["disciplineChannelIds", "Discipline log", "Posts that name or mention the member become their discipline history."],
	["promotionChannelIds", "Promotion log", "Used for promotion history, time in grade, and the last promotion date."],
	["commendationChannelIds", "Commendations", "Awards, shout-outs, and recognition posts."],
	["leaveChannelIds", "Leave of absence", "LOA and inactivity notices."],
	["scanChannelIds", "Message scan", "Channels searched for the member's own messages. Leave empty to scan every channel the bot can read (up to 40)."]
];

function fileSources(s, channels) {
	const text = channels.filter(c => c.type === "text");
	const picked = Object.fromEntries(FILE_SOURCES.map(([key]) => [key, new Set(s.discord[key] || [])]));
	const editor = key => text.length
		? h("div", { class: "role-list" }, text.map(c => {
			const cb = h("input", { type: "checkbox", checked: picked[key].has(c.id) });
			const chip = h("label", { class: `role-chip${cb.checked ? " on" : ""}` }, cb, h("i"), `#${c.name}`);
			cb.addEventListener("change", () => { cb.checked ? picked[key].add(c.id) : picked[key].delete(c.id); chip.classList.toggle("on", cb.checked); });
			return chip;
		}))
		: (() => {
			const input = h("input", { class: "input mono", value: [...picked[key]].join(", "), placeholder: "Channel IDs, comma separated" });
			input.addEventListener("input", () => { picked[key] = new Set(input.value.split(/[\s,]+/).filter(Boolean)); });
			return input;
		})();
	return h("section", { class: "editor-section" }, h("h3", null, "Personnel file sources"),
		h("p", { class: "muted small", style: { marginTop: 0 } }, "When a supervisor pulls a personnel file, the bot reads these channels. The bot needs View Channel and Read Message History on each one."),
		h("div", { class: "stack" }, FILE_SOURCES.map(([key, label, help]) => h("div", { class: "field" }, h("span", null, label), h("small", null, help), editor(key)))),
		h("div", { style: { marginTop: "12px" } }, h("button", { class: "btn primary", onclick: async () => {
			await attempt(() => api("/settings/discord", { method: "PUT", body: { ...s.discord, ...Object.fromEntries(Object.entries(picked).map(([k, v]) => [k, [...v]])) } }), "Personnel file sources saved");
		} }, "Save file sources")));
}

}

// Intake panels: where the report buttons are posted. The bot keeps each one up to date and reposts it if deleted.
function panelSection(channels) {
	const text = channels.filter(c => c.type === "text");
	const name = id => (text.find(c => c.id === id) ? `#${text.find(c => c.id === id).name}` : `Channel ${id}`);
	const body = h("div", { class: "stack" }, h("div", { class: "skeleton", style: { height: "60px" } }));

	const channelPicker = (value, exclude = []) => text.length
		? h("select", { class: "input", value: value || "" }, h("option", { value: "" }, "Choose a channel…"),
			text.filter(c => c.id === value || !exclude.includes(c.id)).map(c => h("option", { value: c.id }, `#${c.name}`)))
		: h("input", { class: "input mono", value: value || "", placeholder: "Channel ID" });

	const buttonPicker = (labels, selected) => {
		const chosen = new Set(selected);
		const el = h("div", { class: "role-list", style: { maxHeight: "none" } }, Object.entries(labels).map(([key, label]) => {
			const cb = h("input", { type: "checkbox", checked: chosen.has(key) });
			const chip = h("label", { class: `role-chip${cb.checked ? " on" : ""}` }, cb, h("i"), label);
			cb.addEventListener("change", () => { cb.checked ? chosen.add(key) : chosen.delete(key); chip.classList.toggle("on", cb.checked); });
			return chip;
		}));
		return { el, value: () => [...chosen] };
	};

	async function call(path, method, payload, success) {
		const data = await attempt(() => api(path, { method, body: payload }), success);
		draw(data);
	}

	function draw({ panels, buttons }) {
		const used = panels.map(p => p.channelId);
		const rows = panels.map(p => {
			const move = channelPicker(p.channelId, used);
			const picks = buttonPicker(buttons, p.buttons);
			return h("div", { class: "note stack", style: { gap: "10px" } },
				h("div", { class: "row" },
					h("b", null, name(p.channelId)),
					p.error ? h("span", { class: "tag red", title: p.error }, icon("alert"), p.error) : h("span", { class: "tag green" }, "Live"),
					h("span", { class: "muted small" }, p.postedAt ? `updated ${ago(p.postedAt)}` : ""),
					h("div", { class: "spacer" }),
					h("button", { class: "btn sm danger", onclick: async () => {
						const ok = await confirmDialog({ title: "Remove this panel?", message: `The panel message in ${name(p.channelId)} will be deleted. Open tickets are not affected.`, confirmLabel: "Remove panel", danger: true });
						if (ok) call(`/settings/panels/${p.channelId}`, "DELETE", undefined, "Panel removed");
					} }, icon("x"), "Remove")),
				h("div", { class: "grid-2" },
					h("label", { class: "field" }, h("span", null, "Channel"), move),
					h("div", { class: "field" }, h("span", null, "Buttons"), picks.el)),
				h("div", null, h("button", { class: "btn sm", onclick: () => {
					const target = move.value.trim();
					call(`/settings/panels/${p.channelId}`, "PATCH", { channelId: target || p.channelId, buttons: picks.value() }, target && target !== p.channelId ? `Panel moved to ${name(target)}` : "Panel updated");
				} }, icon("refresh"), "Save changes")));
		});

		const where = channelPicker("", used);
		const picks = buttonPicker(buttons, Object.keys(buttons));
		clear(body,
			rows.length ? rows : h("div", { class: "muted small" }, "No panels yet. Post one below, or run /ia-panel in a channel."),
			h("div", { class: "editor-subsection stack", style: { gap: "10px", paddingTop: "6px", borderTop: "1px dashed var(--line-2)" } },
				h("b", { class: "small" }, "Post a new panel"),
				h("div", { class: "grid-2" },
					h("label", { class: "field" }, h("span", null, "Channel"), where),
					h("div", { class: "field" }, h("span", null, "Buttons"), picks.el)),
				h("div", { class: "row" },
					h("button", { class: "btn primary", onclick: () => {
						if (!where.value.trim()) return toast("Choose a channel first", "error");
						call("/settings/panels", "POST", { channelId: where.value.trim(), buttons: picks.value() }, `Panel posted in ${name(where.value.trim())}`);
					} }, icon("plus"), "Post panel"),
					panels.length ? h("button", { class: "btn ghost", title: "Update every panel to the current design and repost any that were deleted", onclick: () => call("/settings/panels/sync", "POST", {}, "Panels checked") }, icon("refresh"), "Check all panels") : null)));
	}

	api("/settings/panels").then(draw).catch(error => clear(body, h("div", { class: "muted small" }, error.message)));
	return h("section", { class: "editor-section" }, h("h3", null, "Ticket panels"),
		h("p", { class: "muted small", style: { marginTop: 0 } }, "Choose where the report buttons appear. You can have a panel in several channels, choose which buttons each one shows, and move them at any time. The bot keeps every panel up to date and reposts it if the message is deleted."),
		body);
}
