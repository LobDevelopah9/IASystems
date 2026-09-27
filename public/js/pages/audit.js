import { h, clear, icon, api, fmtDate, debounce, toast } from "../lib.js";

export async function render({ page, isCurrent }) {
	page.setTitle("Audit Log", "Every sign-in, view, edit, signature and permission change. Append-only and hash-chained.");
	const action = h("select", { class: "input" }, [
		["", "All actions"], ["case.view", "Case views"], ["case.edit", "Case edits"], ["case.sign", "Signatures"], ["case.status", "Status changes"],
		["ticket.", "Ticket activity"], ["auth.", "Sign-ins"], ["user.", "User changes"], ["settings.", "Settings"], ["access.denied", "Denied access"]
	].map(([v, l]) => h("option", { value: v }, l)));
	const actor = h("input", { class: "input", placeholder: "Actor" });
	const target = h("input", { class: "input", placeholder: "Case / ticket / user" });
	const chain = h("span", { class: "muted small" });
	const tbody = h("tbody");
	const more = h("button", { class: "btn", onclick: () => load(true) }, "Load older");
	let last = null;

	page.setActions(h("button", { class: "btn", onclick: verify }, icon("shield"), "Verify integrity"));

	async function verify() {
		const res = await api("/audit?verify=1&before=1");
		chain.textContent = res.chain.ok ? `Chain intact · ${res.chain.checked} entries verified` : `CHAIN BROKEN at entry #${res.chain.brokenAt}`;
		chain.style.color = res.chain.ok ? "var(--green)" : "var(--red)";
		toast(res.chain.ok ? "Audit chain verified" : "Audit chain integrity failure", res.chain.ok ? "ok" : "error");
	}

	async function load(append = false) {
		const params = new URLSearchParams({ action: action.value, actor: actor.value, target: target.value });
		if (append && last) params.set("before", last);
		const data = await api(`/audit?${params}`);
		if (!isCurrent()) return;
		if (!append) tbody.replaceChildren();
		data.entries.forEach(e => tbody.append(h("tr", null,
			h("td", { class: "mono small muted" }, `#${e.id}`),
			h("td", { class: "small", style: { whiteSpace: "nowrap" } }, fmtDate(e.at)),
			h("td", null, h("b", null, e.actor_name || "System")),
			h("td", null, h("span", { class: `tag ${e.action.startsWith("access.denied") || e.action.includes("denied") ? "red" : e.action === "case.sign" ? "green" : ""}` }, e.action)),
			h("td", { class: "mono small" }, e.target_ref ? (e.target_type === "case" ? h("a", { href: `#/cases/${e.target_ref}` }, `#${e.target_ref}`) : `${e.target_type}:${e.target_ref}`) : "-"),
			h("td", { class: "small muted" }, detail(e.detail)),
			h("td", { class: "mono small muted" }, e.ip || ""))));
		last = data.entries.at(-1)?.id || last;
		more.disabled = data.entries.length < 100;
	}

	const reload = debounce(() => load(), 200);
	action.addEventListener("change", reload);
	actor.addEventListener("input", reload);
	target.addEventListener("input", reload);

	clear(page.content,
		h("div", { class: "filters" }, action, actor, target, h("span", { class: "spacer" }), chain),
		h("div", { class: "panel table-wrap" }, h("table", { class: "table" },
			h("thead", null, h("tr", null, ["#", "When", "Actor", "Action", "Target", "Detail", "IP"].map(x => h("th", null, x)))), tbody)),
		h("div", { style: { marginTop: "12px" } }, more));
	await load();
}

function detail(d) {
	if (!d || !Object.keys(d).length) return "";
	return Object.entries(d).filter(([, v]) => v != null && v !== "").map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`).join(" · ").slice(0, 220);
}
