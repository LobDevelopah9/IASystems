import { h, clear, icon, avatar, api, installContainment, setViewer, closeLayer, toast } from "./lib.js";
import { store, loadMe, can } from "./state.js";

const pages = {
	board: () => import("./pages/board.js"),
	review: () => import("./pages/board.js"),
	cases: () => import("./pages/case.js"),
	edit: () => import("./pages/editor.js"),
	new: () => import("./pages/newcase.js"),
	tickets: () => import("./pages/tickets.js"),
	users: () => import("./pages/users.js"),
	audit: () => import("./pages/audit.js"),
	settings: () => import("./pages/settings.js"),
	personnel: () => import("./pages/personnel.js"),
	my: () => import("./pages/my.js")
};

const NAV = [
	{ section: "Casework" },
	{ key: "board", label: "Case Board", icon: "board", cap: "case.view" },
	{ key: "review", label: "Review Queue", icon: "review", cap: "case.decide", count: () => store.counts.review },
	{ key: "tickets", label: "Ticket Inbox", icon: "inbox", cap: "ticket.view" },
	{ key: "new", label: "New Case", icon: "plus", cap: "case.create" },
	{ key: "personnel", label: "Personnel Files", icon: "file", cap: "personnel.dossier" },
	{ section: "Administration", cap: "users.view" },
	{ key: "users", label: "Users & Agents", icon: "users", cap: "users.view" },
	{ key: "audit", label: "Audit Log", icon: "log", cap: "audit.view" },
	{ key: "settings", label: "Settings", icon: "gear", cap: "settings.manage" },
	{ section: "Member" },
	{ key: "my", label: "My IA Record", icon: "user", cap: "self.cases" }
];

const SIDEBAR_KEY = "ia.sidebar";
let collapseButton;

function setCollapsed(collapsed) {
	document.body.classList.toggle("nav-collapsed", collapsed);
	try { localStorage.setItem(SIDEBAR_KEY, collapsed ? "collapsed" : "open"); } catch { /* storage unavailable */ }
	if (collapseButton) {
		collapseButton.replaceChildren(icon(collapsed ? "expand" : "collapse"));
		collapseButton.setAttribute("aria-label", collapsed ? "Expand sidebar" : "Collapse sidebar");
		collapseButton.setAttribute("aria-expanded", String(!collapsed));
		collapseButton.title = collapsed ? "Expand sidebar ( [ )" : "Collapse sidebar ( [ )";
	}
}

let root;
let content;
let titleEl;
let subEl;
let actionsEl;
let navEl;

export const page = {
	setTitle(title, sub = "") {
		titleEl.textContent = title;
		subEl.textContent = sub;
		document.title = `${title} · SAHP Internal Affairs`;
	},
	setActions(...nodes) {
		clear(actionsEl, nodes);
	},
	get content() {
		return content;
	}
};

export function go(hash) {
	location.hash = hash;
}

function renderShell() {
	const me = store.me;
	navEl = h("nav", { class: "nav" });
	titleEl = h("h1");
	subEl = h("div", { class: "sub" });
	actionsEl = h("div", { class: "row" });
	content = h("main", { class: "content", id: "content", tabindex: "-1" });
	collapseButton = h("button", { class: "btn ghost sm sidebar-toggle", type: "button", onclick: () => setCollapsed(!document.body.classList.contains("nav-collapsed")) });
	root = clear(document.getElementById("root"),
		h("div", { class: "shell" },
			h("aside", { class: "sidebar" },
				h("div", { class: "brand-row" },
					h("a", { class: "brand", href: "#/", title: "SAHP Internal Affairs" }, h("img", { src: "img/ia-seal.png", alt: "" }),
						h("div", { class: "brand-text" }, h("b", null, "SAHP · IA"), h("span", null, "Professional Standards"))),
					collapseButton),
				navEl,
				h("div", { class: "me" },
					avatar(me.displayName, me.avatar),
					h("div", { class: "who" }, h("b", null, me.displayName), h("span", null, me.roleLabel)),
					h("button", { class: "btn ghost sm", title: "Sign out", "aria-label": "Sign out", onclick: logout }, icon("logout")))),
			h("div", { class: "main" },
				h("div", { class: "classbar" }, "Confidential · Internal Affairs · Eyes Only"),
				h("header", { class: "topbar" },
					h("button", { class: "btn ghost sm menu-toggle", "aria-label": "Menu", onclick: () => document.body.classList.toggle("nav-open") }, icon("menu")),
					h("div", null, titleEl, subEl),
					h("div", { class: "spacer" }),
					actionsEl),
				content)));
}

function renderNav(active) {
	const items = [];
	let pendingSection = null;
	for (const item of NAV) {
		if (item.section) {
			pendingSection = item;
			continue;
		}
		if (!can(item.cap)) continue;
		if (pendingSection && (!pendingSection.cap || can(pendingSection.cap))) {
			items.push(h("div", { class: "nav-label" }, pendingSection.section));
			pendingSection = null;
		}
		const count = item.count?.();
		items.push(h("a", { href: `#/${item.key}`, class: active === item.key ? "active" : "", title: item.label, "aria-label": count ? `${item.label} (${count})` : item.label },
			icon(item.icon), h("span", { class: "nav-text" }, item.label), count ? h("span", { class: "count" }, count) : null));
	}
	clear(navEl, items);
}

async function logout() {
	await fetch("auth/logout", { method: "POST", headers: { "X-IA-Request": "1" } }).catch(() => {});
	location.href = "./";
}

let routeToken = 0;

async function route() {
	closeLayer();
	document.body.classList.remove("nav-open");
	const token = ++routeToken;
	const parts = location.hash.replace(/^#\/?/, "").split("?")[0].split("/").map(decodeURIComponent);
	let [key, ...rest] = parts;
	if (!key) key = can("case.view") ? "board" : "my";
	if (key === "cases" && rest[1] === "edit") key = "edit";
	const loader = pages[key];
	const navKey = key === "cases" || key === "edit" ? "board" : key;
	renderNav(navKey);
	page.setActions();
	clear(content, h("div", { class: "skeleton", style: { height: "320px" } }));
	if (!loader) {
		page.setTitle("Not found");
		clear(content, h("div", { class: "empty" }, "That page does not exist."));
		return;
	}
	try {
		const mod = await loader();
		if (token !== routeToken) return;
		await mod.render({ key, params: rest, page, go, isCurrent: () => token === routeToken });
	} catch (error) {
		if (token !== routeToken) return;
		page.setTitle(error.status === 403 ? "Access denied" : error.status === 404 ? "Not found" : "Something went wrong");
		clear(content, h("div", { class: "panel" }, h("div", { class: "empty" }, icon(error.status === 403 ? "lock" : "alert"), h("div", null, error.message))));
	}
}

export async function refreshCounts() {
	try {
		await loadMe();
		renderNav(location.hash.replace(/^#\/?/, "").split("/")[0] || "board");
	} catch {
		// ignore
	}
}

async function boot() {
	installContainment();
	try {
		await loadMe();
	} catch (error) {
		if (error.status === 403) location.href = "./?error=no_role";
		return;
	}
	setViewer({ name: store.me.displayName, id: store.me.id });
	renderShell();
	let saved = "open";
	try { saved = localStorage.getItem(SIDEBAR_KEY) || "open"; } catch { /* storage unavailable */ }
	setCollapsed(saved === "collapsed");
	document.addEventListener("keydown", event => {
		const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName) || event.target.isContentEditable;
		if (event.key === "[" && !typing && !event.ctrlKey && !event.metaKey && !event.altKey) setCollapsed(!document.body.classList.contains("nav-collapsed"));
	});
	window.addEventListener("hashchange", route);
	route();
	setInterval(refreshCounts, 60000);
	if (store.demo && can("settings.manage")) {
		setTimeout(() => toast("Demo case data is loaded. Purge it from Settings → System before real use."), 800);
	}
}

boot();
