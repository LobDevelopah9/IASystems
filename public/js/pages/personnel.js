import { h, clear, icon, api, attempt, toast, fmtDate, ago, avatar, modal, closeLayer, debounce, statusPill } from "../lib.js";
import { findingLabel } from "../state.js";
import { discordMessage } from "../discord.js";

const RUNNING = ["queued", "scanning", "analysing"];
const STAGE = {
	queued: "Queued. The bot will start pulling the file shortly.",
	scanning: "Reading discipline, promotion, commendation, and leave logs and the member's messages in the SAHP Discord…",
	analysing: "Records pulled. The AI is preparing the assessment…"
};
const READINESS = {
	ready: ["Ready", "green"],
	ready_with_reservations: ["Ready with reservations", "gold"],
	not_yet: ["Not yet", "red"],
	insufficient_information: ["Insufficient information", ""]
};
const TREND = { improving: ["Improving", "green"], stable: ["Stable", "blue"], declining: ["Declining", "red"], insufficient_information: ["Unclear", ""] };
const LEVEL = { high: "red", medium: "gold", low: "blue" };
const KIND_TAG = { ia: ["IA", "red"], discipline: ["Discipline", "red"], promotion: ["Promotion", "green"], commendation: ["Commendation", "gold"], leave: ["Leave", "blue"], note: ["File note", "violet"], service: ["Service", ""] };

export async function render({ params, page, go, isCurrent }) {
	if (params[0]) return renderFile(Number(params[0]), { page, go, isCurrent });
	return renderSearch({ page, go, isCurrent });
}

// --- Search ---------------------------------------------------------------------------------

async function renderSearch({ page, go, isCurrent }) {
	page.setTitle("Personnel Files", "Pull a member's file: IA history, discipline and promotion logs, commendations, background, and an AI assessment.");
	const input = h("input", { class: "input", type: "search", placeholder: "Search by name, callsign, ROBLOX or Discord username…", "aria-label": "Search personnel", autofocus: true });
	const results = h("div");

	async function load() {
		const { personnel } = await api(`/personnel?q=${encodeURIComponent(input.value.trim())}`);
		if (!isCurrent()) return;
		const rows = personnel.filter(p => !p.demo);
		clear(results, rows.length
			? h("div", { class: "panel table-wrap" }, h("table", { class: "table" },
				h("thead", null, h("tr", null, ["Member", "Rank", "Callsign", "ROBLOX", "IA cases", ""].map(x => h("th", null, x)))),
				h("tbody", null, rows.map(p => h("tr", { class: "clickable", onclick: () => go(`#/personnel/${p.id}`) },
					h("td", null, h("b", null, p.name), p.discordId ? null : h("span", { class: "tag", style: { marginLeft: "8px" }, title: "No Discord account linked; Discord logs are matched by name only" }, "Not linked")),
					h("td", null, p.rank || "-"),
					h("td", { class: "mono" }, p.callsign || "-"),
					h("td", { class: "mono small" }, p.robloxUsername || "-"),
					h("td", { class: "mono" }, p.caseCount),
					h("td", null, h("a", { class: "btn sm", href: `#/personnel/${p.id}`, onclick: e => e.stopPropagation() }, icon("file"), "Pull file")))))))
			: h("div", { class: "panel" }, h("div", { class: "empty" }, input.value ? "No personnel match that search." : "No personnel records yet. Members are added from Discord syncs, cases, and imports.")));
	}

	input.addEventListener("input", debounce(load, 200));
	clear(page.content, h("div", { class: "stack" },
		h("div", { class: "filters" }, h("div", { class: "search" }, icon("search"), input)),
		results));
	await load();
}

// --- File -----------------------------------------------------------------------------------

async function renderFile(id, { page, go, isCurrent }) {
	let timer = null;
	const stop = () => clearTimeout(timer);
	window.addEventListener("hashchange", stop, { once: true });

	async function pull() {
		await attempt(() => api(`/personnel/${id}/file/refresh`, { method: "POST", body: {} }), "Pulling file. This takes a minute or two.");
		draw();
	}

	async function poll() {
		if (!isCurrent()) return;
		const s = await api(`/personnel/${id}/file/status`).catch(() => null);
		if (!isCurrent()) return;
		if (s && RUNNING.includes(s.status)) {
			const line = document.getElementById("scan-stage");
			if (line) line.textContent = STAGE[s.status];
			timer = setTimeout(poll, 4000);
		} else {
			if (s?.status === "failed") toast(`File pull failed: ${s.error || "unknown error"}`, "error");
			draw();
		}
	}

	async function draw() {
		stop();
		const f = await api(`/personnel/${id}/file`);
		if (!isCurrent()) return;
		const p = f.person;
		page.setTitle(p.name, [p.rank, p.callsign, p.department].filter(Boolean).join(" · "));
		const running = RUNNING.includes(f.scan.status);
		page.setActions(
			h("button", { class: "btn ghost", onclick: () => go("#/personnel") }, "All files"),
			h("button", { class: "btn", onclick: () => addNote(id, f.noteKinds, draw) }, icon("pen"), "Add file note"),
			h("button", { class: "btn primary", disabled: running, onclick: pull }, icon("refresh"), f.scan.status === "never" ? "Pull file" : running ? "Pulling…" : "Refresh file"));

		clear(page.content, h("div", { class: "stack", dataset: { contained: "" } },
			scanBanner(f, pull),
			jacketHead(f),
			statTiles(f),
			h("div", { class: "case-layout" },
				h("div", { class: "stack" },
					assessmentPanel(f),
					indicatorPanel(f),
					complaintsPanel(f),
					logPanel("Discipline log", "flag", f.scan.discipline, "No discipline has been logged against this member.", f, "discipline"),
					logPanel("Promotion / demotion history", "shield", f.scan.promotions, "No promotions or demotions logged for this member.", f, "promotions"),
					logPanel("Commendations", "check", f.scan.commendations, "No commendations on record.", f, "commendations"),
					flaggedPanel(f),
					timelinePanel(f)),
				h("aside", { class: "side" },
					serviceRecord(f),
					robloxPanel(f),
					notesPanel(f, () => addNote(id, f.noteKinds, draw)),
					involvementPanel(f),
					logPanel("Leave of absence", "clock", f.scan.leave, "No leave notices on record.", f, "leave", true),
					accessPanel(f)))));
		if (running) timer = setTimeout(poll, 4000);
	}

	await draw();
}

// --- Sections -------------------------------------------------------------------------------

function panel(title, iconName, body, extra = null) {
	return h("section", { class: "panel" },
		h("div", { class: "panel-head" }, icon(iconName), h("h2", null, title), h("div", { class: "spacer" }), extra),
		h("div", { class: "panel-body" }, body));
}

function scanBanner(f, pull) {
	const s = f.scan;
	if (RUNNING.includes(s.status)) {
		return h("div", { class: "file-banner", role: "status" }, h("span", { class: "spinner", "aria-hidden": "true" }), h("span", { id: "scan-stage" }, STAGE[s.status]));
	}
	if (s.status === "never") {
		return h("div", { class: "file-banner" }, icon("file"),
			h("span", { class: "spacer" }, "Portal records are shown below. Pull the file to add Discord discipline, promotion, commendation and leave logs, a ROBLOX background check, and the AI assessment."),
			h("button", { class: "btn primary sm", onclick: pull }, "Pull file"));
	}
	if (s.status === "failed") {
		return h("div", { class: "file-banner bad" }, icon("alert"), h("span", { class: "spacer" }, `The last pull failed: ${s.error || "unknown error"}`), h("button", { class: "btn sm", onclick: pull }, "Try again"));
	}
	return h("div", { class: "file-banner quiet" }, icon("clock"), `Discord and ROBLOX records pulled ${ago(s.fetchedAt)}. Found ${(s.messages || []).length} of the member's messages: ${s.messagesScanned || 0} read across ${s.channelsScanned || 0} channels${s.cached ? `, plus ${s.cached} from the live message log` : ""}${s.partial ? " (time limit reached; older history not read)" : ""}.`);
}

function jacketHead(f) {
	const p = f.person;
	const high = f.indicators.filter(i => i.level === "high").length;
	return h("header", { class: "casefile jacket" },
		h("div", { class: "casefile-head" },
			h("div", { class: "strip" }, h("img", { src: "img/ia-seal.png", alt: "" }), "Office of Professional Standards · Personnel File · Confidential"),
			h("div", { class: "jacket-id" },
				avatar(p.name, p.avatar, "xl"),
				h("div", { class: "spacer" },
					h("h2", null, p.name),
					h("div", { class: "jacket-line mono" }, [p.rank, p.callsign, p.badge && `Badge ${p.badge}`, p.roblox && `ROBLOX ${p.roblox}`].filter(Boolean).join("  |  ") || "No service details on file"),
					h("div", { class: "row", style: { marginTop: "8px" } },
						p.discordId ? h("span", { class: "tag green" }, "Discord linked") : h("span", { class: "tag" }, "Discord not linked"),
						f.ia.stats.open ? h("span", { class: "tag red" }, `${f.ia.stats.open} open case${f.ia.stats.open > 1 ? "s" : ""}`) : null,
						high ? h("span", { class: "tag red" }, icon("alert"), `${high} high-priority indicator${high > 1 ? "s" : ""}`) : null,
						p.title ? h("span", { class: "tag gold" }, p.title) : null)),
				f.assessment ? readinessBadge(f.assessment.readiness.assessment) : null)),
		p.notes ? h("div", { class: "section" }, h("div", { class: "muted small" }, "Personnel record note"), h("div", { class: "prose" }, p.notes)) : null);
}

function readinessBadge(key) {
	const [label, tone] = READINESS[key] || READINESS.insufficient_information;
	return h("div", { class: `readiness ${tone}` }, h("span", null, "Promotion readiness"), h("b", null, label));
}

function statTiles(f) {
	const tile = (n, label, color) => h("div", { class: "stat static", style: { "--c": color } }, h("b", null, n), h("span", null, label));
	return h("div", { class: "stats" },
		tile(f.ia.stats.total, "IA complaints", "var(--text)"),
		tile(f.ia.stats.sustained, "Sustained", f.ia.stats.sustained ? "var(--red)" : "var(--text)"),
		tile(f.scan.discipline?.length ?? "-", "Discipline entries", "var(--amber)"),
		tile(f.scan.commendations?.length ?? "-", "Commendations", "var(--gold-2)"),
		tile(f.assessment ? f.assessment.flagged.length : "-", "Flagged messages", f.assessment?.flagged.length ? "var(--red)" : "var(--text)"));
}

function assessmentPanel(f) {
	const a = f.assessment;
	if (!a) {
		return panel("AI assessment", "bot", h("div", { class: "muted" }, f.scan.status === "never" ? "Pull the file to generate an assessment." : "No assessment yet."));
	}
	const [trend, trendTone] = TREND[a.trend] || TREND.insufficient_information;
	const list = (title, items, tone) => items.length ? h("div", null, h("div", { class: `list-title ${tone}` }, title), h("ul", { class: "clean-list" }, items.map(x => h("li", null, x)))) : null;
	return panel("AI assessment", "bot", h("div", { class: "stack" },
		h("div", { class: "advisory" }, icon("alert"), "Advisory only. Written by AI from the records below; a supervisor makes every decision. Verify before relying on it."),
		h("div", { class: "prose" }, a.summary),
		h("div", { class: "row" }, readinessBadge(a.readiness.assessment), h("span", { class: `tag ${trendTone}` }, `Conduct trend: ${trend}`), a.lastPromotion ? h("span", { class: "tag green" }, `Last promotion: ${a.lastPromotion}`) : null),
		a.readiness.rationale ? h("div", { class: "note" }, h("b", null, "Readiness rationale. "), a.readiness.rationale) : null,
		h("div", { class: "grid-2" }, list("Strengths", a.strengths, "green"), list("Concerns", a.concerns, "red")),
		a.disciplineSummary ? h("div", null, h("div", { class: "list-title" }, "Discipline summary"), h("div", { class: "prose" }, a.disciplineSummary)) : null,
		a.commendationsSummary ? h("div", null, h("div", { class: "list-title" }, "Commendations summary"), h("div", { class: "prose" }, a.commendationsSummary)) : null,
		list("Recommended follow-up", a.followUp, "gold"),
		h("div", { class: "muted small" }, `${a.model} · ${fmtDate(a.at)}`)));
}

function indicatorPanel(f) {
	return panel("Early-warning indicators", "alert", f.indicators.length
		? h("ul", { class: "clean-list indicators" }, f.indicators.map(i => h("li", null, h("span", { class: `tag ${LEVEL[i.level]}` }, i.level), i.text)))
		: h("div", { class: "muted" }, "No indicators triggered."),
	h("span", { class: "muted small" }, "Fixed thresholds, not AI"));
}

function complaintsPanel(f) {
	const d = f.ia.disposition;
	const breakdown = [["sustained", "red"], ["partially_sustained", "red"], ["not_sustained", ""], ["exonerated", "green"], ["unfounded", "green"], ["policy_failure", "blue"]]
		.filter(([k]) => d[k]).map(([k, tone]) => h("span", { class: `tag ${tone}` }, `${findingLabel(k)}: ${d[k]}`));
	if (d.pending) breakdown.push(h("span", { class: "tag gold" }, `Pending: ${d.pending}`));
	return panel("IA complaint history", "scale", h("div", { class: "stack" },
		breakdown.length ? h("div", { class: "row" }, breakdown) : null,
		f.ia.cases.length
			? h("div", { class: "table-wrap" }, h("table", { class: "table" },
				h("thead", null, h("tr", null, ["Case", "Date", "Basis", "Finding", "Outcome", "Status"].map(x => h("th", null, x)))),
				h("tbody", null, f.ia.cases.map(c => h("tr", null,
					h("td", { class: "mono" }, h("a", { href: `#/cases/${encodeURIComponent(c.ref)}` }, `#${c.ref}`)),
					h("td", { class: "small" }, c.dateText || fmtDate(c.date, false)),
					h("td", { class: "small" }, c.basis.join(", ") || c.title),
					h("td", null, c.finding ? findingLabel(c.finding) : h("span", { class: "muted" }, "Pending")),
					h("td", { class: "small" }, c.punishment || "-", c.appeal ? h("div", { class: "muted small" }, `Appeal ${c.appeal}`) : null),
					h("td", null, statusPill(c.status)))))))
			: h("div", { class: "muted" }, "No IA complaints on record."),
		f.ia.filed.length ? h("div", { class: "muted small" }, `Reports filed by this member: ${f.ia.filed.map(c => `#${c.ref}`).join(", ")}`) : null));
}

// Log posts render like Discord messages. Only posts where this member is the subject are listed; posts they
// issued or approved for someone else are counted but left out.
function logPanel(title, iconName, entries, emptyText, f, key, compact = false) {
	if (f.scan.status === "never" && !entries) return null;
	const list = entries || [];
	const skipped = f.scan.excluded?.[key] || 0;
	const note = skipped ? h("div", { class: "muted small" }, `${skipped} post${skipped > 1 ? "s" : ""} where this member issued, approved, or was only mentioned ${skipped > 1 ? "are" : "is"} not shown.`) : null;
	return panel(title, iconName, h("div", { class: "stack", style: { gap: "10px" } },
		list.length
			? h("div", { class: `dc-list${compact ? " compact" : ""}` }, list.slice(0, compact ? 10 : 50).map(e => discordMessage(e, {
				highlight: f.person.discordId,
				extra: e.why ? h("div", { class: "dc-why" }, `Matched: ${e.why}`) : null
			})))
			: h("div", { class: "muted" }, emptyText),
		note),
	list.length ? h("span", { class: "muted small" }, `${list.length}`) : null);
}

function flaggedPanel(f) {
	const items = f.assessment?.flagged || [];
	if (!f.assessment) return null;
	return panel("Flagged messages", "flag", items.length
		? h("div", { class: "stack" }, items.map(m => h("div", { class: `flag-item ${m.severity}` },
			h("div", { class: "row" }, h("span", { class: `tag ${m.severity === "high" ? "red" : m.severity === "medium" ? "gold" : "blue"}` }, m.severity),
				h("span", { class: "muted small mono" }, fmtDate(m.at)), h("span", { class: "muted small" }, `#${m.channel}`), h("div", { class: "spacer" }),
				h("a", { class: "btn sm ghost", href: m.url, target: "_blank", rel: "noopener noreferrer" }, icon("link"), "Jump to message")),
			h("blockquote", { class: "quote" }, m.quote),
			h("div", { class: "small" }, m.reason))))
		: h("div", { class: "muted" }, f.scan.messages?.length ? `The AI reviewed ${f.scan.messages.length} of this member's messages and flagged none.` : f.person.discordId ? "No messages from this member were found. Check that the bot can read the scan channels (Settings → Discord & roles → Personnel file sources)." : "This record is not linked to a Discord account, so messages could not be reviewed. It links automatically through Bloxlink or the member's server nickname."),
	h("span", { class: "muted small" }, "Quotes verified against the source message"));
}

function timelinePanel(f) {
	if (!f.timeline.length) return null;
	return panel("Chronology", "clock", h("ol", { class: "log-list" }, f.timeline.map(t => {
		const [label, tone] = KIND_TAG[t.kind] || ["", ""];
		return h("li", null,
			h("div", { class: "log-meta" }, h("span", { class: "mono" }, fmtDate(t.at, false)), h("span", { class: `tag ${tone}` }, label),
				t.ref ? h("a", { href: `#/cases/${encodeURIComponent(t.ref)}` }, "Open case") : t.url ? h("a", { href: t.url, target: "_blank", rel: "noopener noreferrer" }, "Open in Discord") : null),
			h("div", { class: "log-text" }, t.text));
	})));
}

function facts(rows) {
	return h("dl", { class: "facts-dl" }, rows.filter(([, v]) => v !== null && v !== undefined && v !== "").flatMap(([k, v]) => [h("dt", null, k), h("dd", null, v)]));
}

function duration(from) {
	if (!from) return null;
	const days = Math.floor((Date.now() - from) / 86400000);
	if (days < 60) return `${days} days`;
	const months = Math.floor(days / 30.44);
	return months < 24 ? `${months} months` : `${(days / 365.25).toFixed(1)} years`;
}

function serviceRecord(f) {
	const p = f.person;
	const s = f.service;
	return panel("Service record", "user", h("div", { class: "stack" },
		facts([
			["Rank", p.rank],
			["Callsign", p.callsign],
			["Badge", p.badge],
			["Department", p.department],
			["Discord", p.discordUsername ? `@${p.discordUsername}` : p.discordId ? "Linked" : "Not linked"],
			["ROBLOX", p.roblox ? `${p.roblox}${p.identitySource === "bloxlink" ? " (verified via Bloxlink)" : p.identitySource === "nickname" ? " (from server nickname)" : ""}` : null],
			["Linked records", p.linkedRecords?.length ? p.linkedRecords.map(r => r.name).join(", ") : null],
			["Server nickname", s.displayName],
			["Joined server", s.joinedAt ? `${fmtDate(s.joinedAt, false)} (${duration(s.joinedAt)})` : null],
			["Time in grade", s.lastPromotionAt ? `${duration(s.lastPromotionAt)} (since ${fmtDate(s.lastPromotionAt, false)})` : null],
			["Discord account age", s.discordCreatedAt ? duration(s.discordCreatedAt) : null],
			["Portal last seen", p.portalLastSeen ? ago(p.portalLastSeen) : null]
		]),
		s.roles.length ? h("div", null, h("div", { class: "list-title" }, "Discord roles"), h("div", { class: "row", style: { gap: "4px" } }, s.roles.map(r => h("span", { class: "tag" }, r)))) : null));
}

function robloxPanel(f) {
	const r = f.roblox;
	if (!r) return f.person.roblox && f.scan.status === "never" ? null : panel("ROBLOX background", "search", h("div", { class: "muted small" }, f.person.roblox ? "Pull the file to run the check." : "No ROBLOX username on the personnel record."));
	if (r.error) return panel("ROBLOX background", "search", h("div", { class: "muted small" }, `Lookup failed: ${r.error}`));
	if (!r.found) return panel("ROBLOX background", "search", h("div", { class: "small" }, `No ROBLOX account named "${r.username}" exists. The username on file may be outdated.`));
	return panel("ROBLOX background", "search", h("div", { class: "stack" },
		facts([
			["Account", h("a", { href: r.profileUrl, target: "_blank", rel: "noopener noreferrer" }, `${r.username} (${r.id})`)],
			["Display name", r.displayName],
			["Created", r.createdAt ? `${fmtDate(r.createdAt, false)} (${duration(r.createdAt)})` : null],
			["Status", r.banned ? h("span", { class: "tag red" }, "Banned") : h("span", { class: "tag green" }, "Active")]
		]),
		r.previousNames.length ? h("div", null, h("div", { class: "list-title" }, "Previous usernames"), h("div", { class: "mono small" }, r.previousNames.join(", "))) : null,
		r.groups.length ? h("details", null, h("summary", { class: "small" }, `Groups (${r.groups.length})`),
			h("ul", { class: "clean-list small" }, r.groups.map(g => h("li", null, h("b", null, g.name), h("span", { class: "muted" }, ` · ${g.role}`))))) : null,
		r.partial ? h("div", { class: "muted small" }, "Some ROBLOX lookups did not respond; details may be incomplete.") : null));
}

function notesPanel(f, add) {
	return panel("IA file notes", "pen", f.notes.length
		? h("div", { class: "stack" }, f.notes.map(n => h("div", { class: "note" },
			h("div", { class: "row small" }, h("span", { class: "tag violet" }, n.kindLabel), h("span", { class: "muted" }, `${n.author} · ${fmtDate(n.createdAt)}`)),
			h("div", { class: "prose small", style: { marginTop: "6px" } }, n.body))))
		: h("div", { class: "muted small" }, "No notes. Notes are permanent once added and are visible to IA supervisors only."),
	h("button", { class: "btn sm", onclick: add }, icon("plus"), "Add"));
}

function involvementPanel(f) {
	const inv = f.ia.involved;
	if (!inv.length) return null;
	return panel("Witness / involved party", "users", h("ul", { class: "clean-list small" }, inv.map(t => h("li", null,
		h("span", { class: "mono" }, t.ref), ` · ${t.type} · ${fmtDate(t.created_at, false)}`,
		t.case_ref ? [" · ", h("a", { href: `#/cases/${encodeURIComponent(t.case_ref)}` }, `#${t.case_ref}`)] : null))));
}

function accessPanel(f) {
	return panel("File access log", "eye", h("ul", { class: "clean-list small" }, f.accessLog.map(a => h("li", null,
		h("b", null, a.who || "System"), h("span", { class: "muted" }, ` ${a.action === "view" ? "viewed" : a.action === "refresh" ? "pulled" : "added a note"} · ${ago(a.at)}`)))));
}

function addNote(id, kinds, done) {
	const kind = h("select", { class: "input" }, Object.entries(kinds).map(([k, label]) => h("option", { value: k }, label)));
	const body = h("textarea", { class: "input", rows: 6, maxlength: 4000, placeholder: "What should the next supervisor who pulls this file know?" });
	modal({
		title: "Add a file note",
		body: h("div", { class: "stack" },
			h("p", { class: "muted small" }, "File notes are permanent and cannot be edited or deleted. They are included in future AI assessments."),
			h("label", { class: "field" }, h("span", null, "Type"), kind),
			h("label", { class: "field" }, h("span", null, "Note"), body)),
		actions: [
			h("button", { class: "btn ghost", onclick: closeLayer }, "Cancel"),
			h("button", { class: "btn primary", onclick: async () => {
				const res = await attempt(() => api(`/personnel/${id}/file/notes`, { method: "POST", body: { kind: kind.value, body: body.value } }), "Note added to file");
				if (res.ok !== false) {
					closeLayer();
					done();
				}
			} }, "Add to file")
		]
	});
}
