import { h, clear, icon, api, avatar, STATUS, statusPill, ago, debounce, toast, attempt, confirmDialog } from "../lib.js";
import { store, can, findingLabel } from "../state.js";
import { openSignModal } from "./case.js";
import { refreshCounts } from "../app.js";

const COLUMNS = ["marked_for_review", "under_investigation", "approved", "appealed", "closed"];
const PREFS_KEY = "ia.board.view";

function readPref() {
	try {
		return localStorage.getItem(PREFS_KEY) || "board";
	} catch {
		return "board";
	}
}

export async function render({ key, page, go, isCurrent }) {
	const review = key === "review";
	page.setTitle(review ? "Review Queue" : "Case Board", review
		? "AI-drafted and returned cases awaiting a supervisor decision"
		: "Every Internal Affairs case, from intake to close");
	if (can("case.create")) page.setActions(h("a", { class: "btn primary", href: "#/new" }, icon("plus"), "New Case"));

	const filters = { q: "", status: review ? ["marked_for_review"] : [], kind: "", agent: "", from: "", to: "", subject: "", reporter: "", anonymous: "", tag: "", source: "" };
	const tagSelect = h("select", { class: "input", "aria-label": "Label" }, h("option", { value: "" }, "All labels"), (store.policy.tags || []).map(t => h("option", { value: t.key }, t.label)));
	const sourceSelect = h("select", { class: "input", "aria-label": "Source" }, h("option", { value: "" }, "All records"), h("option", { value: "portal" }, "Portal cases"), h("option", { value: "legacy" }, "Imported (Trello)"), h("option", { value: "voided" }, "Voided"));
	let view = review ? "list" : readPref();
	let agents = [];
	let results = [];

	const statsEl = h("div", { class: "stats" });
	const resultLine = h("div", { class: "result-line" });
	const body = h("div");
	const searchInput = h("input", { class: "input", type: "search", placeholder: "Search cases, callsigns, usernames…", "aria-label": "Search case number, 2M callsign, ROBLOX or Discord username, basis, punishment, or report text" });
	const agentSelect = h("select", { class: "input", "aria-label": "Assigned agent" }, h("option", { value: "" }, "Any agent"), h("option", { value: "me" }, "Assigned to me"), h("option", { value: "unassigned" }, "Unassigned"));
	const kindSelect = h("select", { class: "input", "aria-label": "Case type" }, h("option", { value: "" }, "All types"), h("option", { value: "misconduct" }, "Misconduct"), h("option", { value: "ops" }, "OPS / system"));
	const from = h("input", { class: "input", type: "date", "aria-label": "Opened from" });
	const to = h("input", { class: "input", type: "date", "aria-label": "Opened to" });
	const subject = h("input", { class: "input", placeholder: "Trooper", "aria-label": "Trooper name" });
	const reporter = h("input", { class: "input", placeholder: "Reporting party", "aria-label": "Reporting party" });
	const anon = h("input", { type: "checkbox" });
	const viewToggle = h("div", { class: "segmented" },
		h("button", { type: "button", class: view === "board" ? "on" : "", "aria-pressed": String(view === "board"), "aria-label": "Board view", title: "Board view", onclick: () => setView("board") }, icon("columns")),
		h("button", { type: "button", class: view === "list" ? "on" : "", "aria-pressed": String(view === "list"), "aria-label": "List view", title: "List view", onclick: () => setView("list") }, icon("list")));

	// One line by default: search, a Filters button (with how many are on), and the view toggle.
	// Everything else lives in a panel that opens under the bar.
	const field = (label, control) => h("label", { class: "field" }, h("span", null, label), control);
	const clearAll = h("button", { type: "button", class: "btn ghost sm", onclick: () => {
		for (const el of [subject, reporter, from, to]) el.value = "";
		for (const el of [kindSelect, agentSelect, tagSelect, sourceSelect]) el.value = "";
		anon.checked = false;
		Object.assign(filters, { kind: "", agent: "", from: "", to: "", subject: "", reporter: "", anonymous: "", tag: "", source: "" });
		updateCount();
		reload();
	} }, "Clear filters");
	const morePanel = h("div", { class: "filter-panel", id: "board-filters", hidden: true },
		h("div", { class: "filter-grid" },
			field("Trooper", subject),
			field("Reporting party", reporter),
			field("Case type", kindSelect),
			field("Assigned agent", agentSelect),
			field("Label", tagSelect),
			field("Records", sourceSelect),
			field("Opened from", from),
			field("Opened to", to)),
		h("div", { class: "row" }, h("label", { class: "check" }, anon, "Anonymous reports only"), h("div", { class: "spacer" }), clearAll));
	const countBadge = h("span", { class: "count-badge", hidden: true });
	const moreButton = h("button", { type: "button", class: "btn", "aria-expanded": "false", "aria-controls": "board-filters", onclick: () => {
		const open = morePanel.hidden;
		morePanel.hidden = !open;
		moreButton.setAttribute("aria-expanded", String(open));
		moreButton.classList.toggle("on", open);
	} }, icon("list"), "Filters", countBadge);
	function updateCount() {
		const n = ["subject", "reporter", "kind", "agent", "from", "to", "anonymous", "tag", "source"].filter(k => filters[k]).length;
		countBadge.textContent = String(n);
		countBadge.hidden = !n;
		clearAll.disabled = !n;
	}
	updateCount();

	const filterBar = h("div", { class: "filters" },
		h("div", { class: "filter-row" },
			h("div", { class: "search" }, icon("search"), searchInput, h("kbd", null, "/")),
			moreButton,
			review ? null : viewToggle),
		morePanel);

	clear(page.content, review ? null : statsEl, filterBar, resultLine, body);

	function setView(next) {
		view = next;
		try { localStorage.setItem(PREFS_KEY, next); } catch { /* storage unavailable */ }
		[...viewToggle.children].forEach((b, i) => { const on = (i === 0) === (next === "board"); b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on)); });
		draw();
	}

	let lastQuery = null;
	const load = async (force = false) => {
		const params = new URLSearchParams();
		for (const [k, v] of Object.entries(filters)) {
			if (Array.isArray(v)) { if (v.length) params.set(k, v.join(",")); }
			else if (v) params.set(k, v);
		}
		// Typing that doesn't change the query (e.g. trailing spaces) doesn't refetch the board.
		if (!force && params.toString() === lastQuery) return;
		lastQuery = params.toString();
		const data = await api(`/cases?${params}`);
		if (!isCurrent()) return;
		results = data.cases;
		draw();
	};
	const reload = debounce(() => { updateCount(); load().catch(e => toast(e.message, "error")); }, 140);

	searchInput.addEventListener("input", () => { filters.q = searchInput.value; reload(); });
	subject.addEventListener("input", () => { filters.subject = subject.value; reload(); });
	reporter.addEventListener("input", () => { filters.reporter = reporter.value; reload(); });
	kindSelect.addEventListener("change", () => { filters.kind = kindSelect.value; reload(); });
	agentSelect.addEventListener("change", () => { filters.agent = agentSelect.value; reload(); });
	from.addEventListener("change", () => { filters.from = from.value; reload(); });
	to.addEventListener("change", () => { filters.to = to.value; reload(); });
	anon.addEventListener("change", () => { filters.anonymous = anon.checked ? "1" : ""; reload(); });
	tagSelect.addEventListener("change", () => { filters.tag = tagSelect.value; reload(); });
	sourceSelect.addEventListener("change", () => { filters.source = sourceSelect.value; reload(); });
	const slash = event => {
		if (!isCurrent()) return document.removeEventListener("keydown", slash);
		if (event.key === "/" && !/input|textarea|select/i.test(document.activeElement?.tagName)) {
			event.preventDefault();
			searchInput.focus();
		}
	};
	document.addEventListener("keydown", slash);

	api("/agents").then(data => {
		agents = data.agents;
		agentSelect.append(...agents.map(a => h("option", { value: a.id }, a.name)));
	}).catch(() => {});

	function drawStats() {
		const counts = Object.fromEntries(COLUMNS.map(s => [s, 0]));
		results.forEach(c => { counts[c.status]++; });
		clear(statsEl, COLUMNS.map(s => {
			const active = filters.status.length === 1 && filters.status[0] === s;
			const el = h("button", { type: "button", class: `stat${active ? " active" : ""}`, "aria-pressed": String(active), title: `Filter: ${STATUS[s].label}` },
				h("b", null, active || !filters.status.length ? counts[s] : "·"), h("span", null, STATUS[s].label));
			el.style.setProperty("--c", STATUS[s].color);
			const toggle = () => { filters.status = active ? [] : [s]; load(); };
			el.addEventListener("click", toggle);
			return el;
		}));
	}

	function draw() {
		if (!review) drawStats();
		const anyFilter = filters.q || filters.subject || filters.reporter || filters.kind || filters.agent || filters.from || filters.to || filters.anonymous || filters.tag || filters.source || (!review && filters.status.length);
		resultLine.textContent = `${results.length} case${results.length === 1 ? "" : "s"}${anyFilter ? " match your filters" : ""}`;
		if (!results.length) {
			clear(body, h("div", { class: "panel" }, h("div", { class: "empty" }, icon(review ? "review" : "search"),
				h("div", null, review ? "Nothing is waiting for review." : "No cases match."))));
			return;
		}
		clear(body, view === "board" && !review ? boardView() : listView());
	}

	function listView() {
		return h("div", { class: "panel table-wrap" }, h("table", { class: "table" },
			h("thead", null, h("tr", null, ["Case", "Subject", "Status", "AI recommendation", "Outcome", "Agent", "Updated"].map(t => h("th", null, t)))),
			h("tbody", null, results.map(c => h("tr", { class: "clickable", onclick: () => go(`#/cases/${c.ref}`) },
				h("td", null, h("div", { class: "mono small", style: { color: "var(--gold)" } }, `#${c.ref}`), h("div", null, h("b", null, c.title)),
					h("div", { class: "row", style: { gap: "5px", marginTop: "4px" } }, tags(c))),
				h("td", null, c.subject ? c.subject.name : h("span", { class: "muted" }, "-"), c.subject?.callsign ? h("div", { class: "muted small mono" }, c.subject.callsign) : null),
				h("td", null, statusPill(c.status)),
				h("td", null, c.aiPunishment ? h("div", null, c.aiPunishment.label, h("div", { class: "muted small" }, findingLabel(c.aiPunishment.finding))) : h("span", { class: "muted" }, "-")),
				h("td", null, c.punishment || h("span", { class: "muted" }, "Pending")),
				h("td", null, c.agent ? h("span", { class: "agent row", style: { gap: "8px", flexWrap: "nowrap" } }, avatar(c.agent, c.agentAvatar, "sm"), c.agent) : h("span", { class: "muted" }, "Unassigned")),
				h("td", { class: "muted small" }, ago(c.updatedAt)))))));
	}

	function boardView() {
		const board = h("div", { class: "board" });
		let dragging = null;
		for (const status of COLUMNS) {
			const items = results.filter(c => c.status === status);
			const colBody = h("div", { class: "column-body" }, items.map(c => cardEl(c)));
			const head = h("div", { class: "column-head" }, h("span", { class: "dot" }), h("b", null, STATUS[status].label), h("span", { class: "n" }, items.length));
			const col = h("section", { class: "column", "aria-label": STATUS[status].label, dataset: { status } }, head, colBody);
			col.style.setProperty("--c", STATUS[status].color);
			col.addEventListener("dragover", event => {
				if (dragging && dragging.transitions.includes(status)) {
					event.preventDefault();
					col.classList.add("drop-hover");
				}
			});
			col.addEventListener("dragleave", () => col.classList.remove("drop-hover"));
			col.addEventListener("drop", event => {
				event.preventDefault();
				col.classList.remove("drop-hover");
				if (dragging && dragging.transitions.includes(status)) moveCase(dragging, status);
			});
			board.append(col);
		}

		function cardEl(c) {
			const draggable = c.transitions.length > 0;
			const el = h("a", { class: "card", href: `#/cases/${c.ref}`, draggable: draggable ? "true" : "false" },
				c.demo ? h("span", { class: "demo-flag" }, "DEMO") : null,
				h("div", { class: "ref" }, `Case #${c.ref}`),
				h("div", { class: "title" }, c.subjectLine || c.title),
				c.violations?.length ? h("div", { class: "basis" }, h("b", null, "Basis: "), c.violations.join(", ")) : null,
				c.tags?.length ? h("div", { class: "labels" }, c.tags.map(t => h("span", { class: `label-chip ${t.color}` }, t.label))) : null,
				h("div", { class: "meta" }, tags(c)),
				h("div", { class: "foot" },
					c.agent ? h("span", { class: "agent" }, avatar(c.agent, c.agentAvatar, "sm"), c.agent) : h("span", null, "Unassigned"),
					h("span", { class: "spacer" }),
					h("span", { title: new Date(c.updatedAt).toLocaleString() }, ago(c.updatedAt))));
			el.addEventListener("dragstart", event => {
				dragging = c;
				el.classList.add("dragging");
				event.dataTransfer.effectAllowed = "move";
				event.dataTransfer.setData("text/plain", c.ref);
				board.querySelectorAll(".column").forEach(col => {
					const ok = c.transitions.includes(col.dataset.status);
					col.classList.toggle("drop-ok", ok);
					col.classList.toggle("drop-no", !ok && col.dataset.status !== c.status);
				});
			});
			el.addEventListener("dragend", () => {
				dragging = null;
				el.classList.remove("dragging");
				board.querySelectorAll(".column").forEach(col => col.classList.remove("drop-ok", "drop-no", "drop-hover"));
			});
			return el;
		}
		return board;
	}

	async function moveCase(c, status) {
		if (status === "approved") {
			const full = await api(`/cases/${encodeURIComponent(c.ref)}`);
			openSignModal(full.case, () => load());
			return;
		}
		const needsNote = ["under_investigation", "appealed"].includes(status);
		const note = await confirmDialog({
			title: `Move case #${c.ref} to ${STATUS[status].label}?`,
			message: status === "closed" ? "Closing locks the case file. Only the Head of IA can reopen it on appeal."
				: status === "under_investigation" ? "The case goes back to investigators. Say what needs to be done."
				: status === "appealed" ? "Record why the appeal is being heard." : "Add an optional note for the case file.",
			confirmLabel: "Move case",
			input: { label: needsNote ? "Note (required)" : "Note (optional)", multiline: true, required: needsNote }
		});
		if (note === null) return;
		await attempt(() => api(`/cases/${encodeURIComponent(c.ref)}/status`, { method: "POST", body: { to: status, note: note === true ? "" : note } }), `Case #${c.ref} moved to ${STATUS[status].label}`);
		refreshCounts();
		load(true);
	}

	await load(true);
}

export function tags(c) {
	return [
		c.kind === "ops" ? h("span", { class: "tag blue" }, "OPS") : null,
		c.legacy ? h("span", { class: "tag", title: "Imported from the Trello board" }, icon("file"), "Imported") : null,
		c.anonymous ? h("span", { class: "tag red", title: "Anonymous report: reporter hidden from the accused" }, icon("lock"), "Anon") : null,
		c.aiState === "queued" || c.aiState === "drafting" ? h("span", { class: "tag violet" }, icon("bot"), c.aiState === "queued" ? "AI queued" : "Drafting") : null,
		c.aiState === "failed" ? h("span", { class: "tag red" }, icon("bot"), "AI failed") : null,
		c.signatureState === "valid" ? h("span", { class: "tag green" }, icon("pen"), "Signed") : null,
		c.signatureState === "stale" ? h("span", { class: "tag red" }, icon("alert"), "Signature stale") : null,
		c.appealPending ? h("span", { class: "tag violet" }, icon("flag"), "Appeal requested") : null,
		c.ticketCount > 1 ? h("span", { class: "tag gold" }, icon("link"), `${c.ticketCount} tickets`) : null,
		c.punishmentText || c.punishment ? h("span", { class: "tag gold tag-clip", title: c.punishmentText || c.punishment }, icon("scale"), h("span", { class: "clip" }, c.punishmentText || c.punishment)) : null
	];
}
