import { h, clear, icon, api, toast, attempt, ago, drawer, redacted, debounce } from "../lib.js";
import { store, can } from "../state.js";
import { renderTranscript } from "./case.js";

export async function render({ page, go, isCurrent }) {
	page.setTitle("Ticket Inbox", "Discord tickets captured by the IA bot. Closed tickets not yet in a case wait here.");
	let state = "unattached";
	const selected = new Set();
	const search = h("input", { class: "input", type: "search", placeholder: "Search tickets…" });
	const tabs = h("div", { class: "tabs" });
	const box = h("div", { class: "panel table-wrap" });
	const bulk = h("div", { class: "row" });
	let rows = [];

	const TABS = [["unattached", "Awaiting a case"], ["open", "Open in Discord"], ["all", "All tickets"]];
	function drawTabs() {
		clear(tabs, TABS.map(([key, label]) => h("button", { class: state === key ? "on" : "", onclick: () => { state = key; selected.clear(); drawTabs(); load(); } }, label)));
	}

	async function load() {
		const data = await api(`/tickets?state=${state}&q=${encodeURIComponent(search.value)}`);
		if (!isCurrent()) return;
		rows = data.tickets;
		draw();
	}

	function draw() {
		clear(bulk,
			h("span", { class: "muted small" }, selected.size ? `${selected.size} selected` : "Select tickets to open a case or link them"),
			h("span", { class: "spacer" }),
			can("case.create") ? h("button", { class: "btn sm", disabled: selected.size < 2, onclick: link }, icon("link"), "Link (draft one case when all close)") : null,
			can("case.create") ? h("button", { class: "btn primary sm", disabled: !selected.size, onclick: () => go(`#/new?tickets=${[...selected].join(",")}`) }, icon("plus"), "Open case from selection") : null);
		clear(box, rows.length ? h("table", { class: "table" },
			h("thead", null, h("tr", null, ["", "Ticket", "Type", "Subject", "Reporter", "Allegation", "Messages", "Status", ""].map(x => h("th", null, x)))),
			h("tbody", null, rows.map(t => {
				const cb = h("input", { type: "checkbox", checked: selected.has(t.ref), disabled: Boolean(t.caseRef), "aria-label": `Select ${t.ref}` });
				cb.addEventListener("click", e => e.stopPropagation());
				cb.addEventListener("change", () => { cb.checked ? selected.add(t.ref) : selected.delete(t.ref); draw(); });
				return h("tr", { class: "clickable", onclick: () => openTicket(t) },
					h("td", null, cb),
					h("td", { class: "mono", style: { color: "var(--gold)" } }, t.ref, t.demo ? h("div", { class: "muted small" }, "demo") : null),
					h("td", null, t.typeLabel),
					h("td", null, t.subject || h("span", { class: "muted" }, "-")),
					h("td", null, t.anonymous ? (t.opener ? h("span", null, t.opener, " ", h("span", { class: "tag red" }, "Anon")) : redacted("Anonymous")) : t.opener || "-"),
					h("td", { class: "small" }, t.allegation || h("span", { class: "muted" }, "-")),
					h("td", { class: "mono small" }, t.messageCount),
					h("td", { class: "small" }, t.status === "open" ? h("span", { class: "tag blue" }, "Open") : `Closed ${ago(t.closedAt)}`, t.linkGroup && !t.caseRef ? h("div", null, h("span", { class: "tag violet" }, icon("link"), `Linked group ${t.linkGroup}`)) : null),
					h("td", null, t.caseRef ? h("a", { class: "tag gold", href: `#/cases/${t.caseRef}`, onclick: e => e.stopPropagation() }, `#${t.caseRef}`) : null));
			}))) : h("div", { class: "empty" }, icon("inbox"), h("div", null, state === "unattached" ? "Inbox zero. Every closed ticket belongs to a case." : "No tickets.")));
	}

	async function link() {
		const res = await attempt(() => api("/tickets/link", { method: "POST", body: { tickets: [...selected] } }));
		toast(res.caseRef ? `All linked tickets were closed, so case #${res.caseRef} was drafted` : `Linked ${res.tickets.join(", ")}. One case will be drafted when they all close.`);
		selected.clear();
		load();
	}

	async function openTicket(t) {
		const body = drawer({ title: `${t.ref} · ${t.typeLabel}`, subtitle: "Read-only transcript · access logged", body: h("div", { class: "skeleton", style: { height: "200px" } }) });
		try {
			const data = await api(`/tickets/${encodeURIComponent(t.ref)}`);
			renderTranscript(body, data, null);
		} catch (error) {
			clear(body, h("div", { class: "empty" }, error.message));
		}
	}

	search.addEventListener("input", debounce(load, 150));
	drawTabs();
	clear(page.content, tabs, h("div", { class: "filters" }, h("div", { class: "search" }, icon("search"), search), bulk), box);
	await load();
}
