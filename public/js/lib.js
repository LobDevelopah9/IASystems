// Small DOM + API toolkit. All text goes through textContent, never innerHTML, so case content cannot inject markup.

export function h(tag, attrs, ...children) {
	const el = document.createElement(tag);
	let deferredValue;
	if (attrs) {
		for (const [key, value] of Object.entries(attrs)) {
			if (value == null || value === false) continue;
			if (key === "class") el.className = value;
			else if (key === "style" && typeof value === "object") Object.assign(el.style, value);
			else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2).toLowerCase(), value);
			else if (key === "dataset") Object.assign(el.dataset, value);
			else if (key === "value") deferredValue = value;
			else if (key in el && typeof value !== "string") el[key] = value;
			else el.setAttribute(key, value === true ? "" : value);
		}
	}
	append(el, children);
	if (deferredValue !== undefined) el.value = deferredValue;
	return el;
}

function append(el, children) {
	for (const child of children.flat(Infinity)) {
		if (child == null || child === false) continue;
		el.append(child instanceof Node ? child : document.createTextNode(String(child)));
	}
}

export function clear(el, ...children) {
	el.replaceChildren();
	append(el, children);
	return el;
}

const ICONS = {
	board: "M4 4h6v16H4zM14 4h6v10h-6z",
	inbox: "M4 13l2-8h12l2 8M4 13v6h16v-6M4 13h5l1 2h4l1-2h5",
	review: "M9 11l3 3 8-8M20 12v7a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h11",
	plus: "M12 5v14M5 12h14",
	users: "M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM22 19v-1a4 4 0 0 0-3-3.9M16 4.1a3 3 0 0 1 0 5.8",
	log: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
	gear: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
	shield: "M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z",
	file: "M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h8M8 17h5",
	search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3",
	lock: "M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4",
	eye: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
	edit: "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z",
	pen: "M3 21c3-1 5-3 7-6l7-7-4-4-7 7c-3 2-5 4-6 7zM14 5l5 5",
	move: "M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20",
	bot: "M12 8V4H8M4 12h16v8H4zM2 14v2M22 14v2M9 16h.01M15 16h.01",
	x: "M18 6L6 18M6 6l12 12",
	check: "M20 6L9 17l-5-5",
	alert: "M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
	clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2",
	link: "M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7",
	user: "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
	pin: "M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11zM12 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
	quote: "M7 7h4v4c0 3-2 5-4 6M15 7h4v4c0 3-2 5-4 6",
	chat: "M21 12a8 8 0 0 1-11.5 7.2L3 21l1.8-6.5A8 8 0 1 1 21 12z",
	scale: "M12 3v18M5 21h14M5 7h14M7 7l-3 7a3 3 0 0 0 6 0zM17 7l-3 7a3 3 0 0 0 6 0z",
	refresh: "M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6",
	menu: "M3 6h18M3 12h18M3 18h18",
	logout: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9",
	list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
	columns: "M3 4h5v16H3zM10 4h4v16h-4zM16 4h5v16h-5z",
	flag: "M4 22V4M4 4h13l-2 4 2 4H4"
};

export function icon(name, cls = "") {
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("class", `ic ${cls}`.trim());
	svg.setAttribute("aria-hidden", "true");
	const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
	path.setAttribute("d", ICONS[name] || ICONS.file);
	svg.append(path);
	return svg;
}

// --- API -----------------------------------------------------------------------------

export async function api(path, { method = "GET", body } = {}) {
	const response = await fetch(`/api${path}`, {
		method,
		credentials: "same-origin",
		headers: { "X-IA-Request": "1", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
		body: body !== undefined ? JSON.stringify(body) : undefined
	});
	if (response.status === 401) {
		location.href = "/";
		throw new Error("Signed out");
	}
	const data = await response.json().catch(() => ({}));
	if (!response.ok) {
		const error = new Error(data.error || `Request failed (${response.status})`);
		error.status = response.status;
		throw error;
	}
	return data;
}

// --- Feedback ----------------------------------------------------------------------------

export function toast(message, kind = "ok") {
	const el = h("div", { class: `toast ${kind}` }, icon(kind === "error" ? "alert" : "check"), h("div", null, message));
	document.getElementById("toasts").append(el);
	setTimeout(() => el.remove(), kind === "error" ? 6500 : 3500);
}

export async function attempt(fn, success) {
	try {
		const result = await fn();
		if (success) toast(success);
		return result;
	} catch (error) {
		toast(error.message, "error");
		throw error;
	}
}

let layer = null;

export function closeLayer() {
	if (layer) {
		layer.forEach(el => el.remove());
		layer = null;
		document.removeEventListener("keydown", escClose);
	}
}

function escClose(event) {
	if (event.key === "Escape") closeLayer();
}

function openLayer(panel) {
	closeLayer();
	const scrim = h("div", { class: "scrim", onclick: closeLayer });
	document.body.append(scrim, panel);
	layer = [scrim, panel];
	document.addEventListener("keydown", escClose);
	return panel;
}

export function modal({ title, body, actions = [], wide = false, contained = false }) {
	const foot = h("div", { class: "modal-foot" }, actions);
	const panel = h("div", { class: `modal${wide ? " wide" : ""}`, role: "dialog", "aria-modal": "true", dataset: contained ? { contained: "" } : {} },
		h("div", { class: "modal-head" }, h("h3", null, title), h("div", { class: "spacer" }),
			h("button", { class: "btn ghost sm", onclick: closeLayer, "aria-label": "Close" }, icon("x"))),
		h("div", { class: "modal-body" }, body),
		actions.length ? foot : null);
	openLayer(panel);
	const first = panel.querySelector("input, select, textarea");
	if (first) setTimeout(() => first.focus(), 30);
	return panel;
}

export function drawer({ title, subtitle, body, contained = true, watermarkFor }) {
	const bodyEl = h("div", { class: "drawer-body" }, body);
	if (watermarkFor) bodyEl.append(watermark(watermarkFor));
	const panel = h("aside", { class: "drawer", role: "dialog", "aria-modal": "true", dataset: contained ? { contained: "" } : {} },
		h("div", { class: "drawer-head" },
			h("div", null, h("h3", null, title), subtitle ? h("div", { class: "muted small" }, subtitle) : null),
			h("div", { class: "spacer" }),
			h("button", { class: "btn ghost sm", onclick: closeLayer, "aria-label": "Close" }, icon("x"))),
		bodyEl);
	openLayer(panel);
	return bodyEl;
}

export function confirmDialog({ title, message, confirmLabel = "Confirm", danger = false, input }) {
	return new Promise(resolve => {
		const field = input ? h(input.multiline ? "textarea" : "input", { class: "input", placeholder: input.placeholder || "", value: input.value || "" }) : null;
		const done = value => { closeLayer(); resolve(value); };
		modal({
			title,
			body: h("div", { class: "stack" }, h("p", { class: "muted" }, message),
				field ? h("label", { class: "field" }, h("span", null, input.label), field) : null),
			actions: [
				h("button", { class: "btn ghost", onclick: () => done(null) }, "Cancel"),
				h("button", { class: `btn ${danger ? "danger" : "primary"}`, onclick: () => {
					if (input?.required && !field.value.trim()) { field.focus(); return; }
					done(field ? field.value : true);
				} }, confirmLabel)
			]
		});
	});
}

// --- Formatting ------------------------------------------------------------------------------

export function fmtDate(ms, withTime = true) {
	if (!ms) return "-";
	const d = new Date(ms);
	return d.toLocaleString(undefined, withTime
		? { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }
		: { year: "numeric", month: "short", day: "numeric" });
}

export function ago(ms) {
	if (!ms) return "never";
	const s = Math.round((Date.now() - ms) / 1000);
	if (s < 60) return "just now";
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
	if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
	return fmtDate(ms, false);
}

export function initials(name) {
	return String(name || "?").replace(/^(tpr|sgt|lt|cpl|det|cmdr|capt|maj|col)\.?\s+/i, "").split(/\s+/).map(p => p[0]).slice(0, 2).join("").toUpperCase();
}

export function avatar(name, url, cls = "") {
	return h("span", { class: `avatar ${cls}` }, url ? h("img", { src: url, alt: "" }) : initials(name));
}

export const STATUS = {
	marked_for_review: { label: "Marked for Review", color: "var(--s-mfr)" },
	under_investigation: { label: "Under Investigation", color: "var(--s-ui)" },
	approved: { label: "Approved", color: "var(--s-approved)" },
	appealed: { label: "Appealed", color: "var(--s-appealed)" },
	closed: { label: "Closed", color: "var(--s-closed)" }
};

export function statusPill(status) {
	return h("span", { class: `pill status-${status}` }, STATUS[status]?.label || status);
}

export function redacted(text = "Redacted") {
	return h("span", { class: "redacted", title: "Identity withheld: anonymous report" }, icon("lock"), text);
}

// --- Containment ----------------------------------------------------------------------------

function inContained(node) {
	const el = node?.nodeType === 1 ? node : node?.parentElement;
	return Boolean(el?.closest?.("[data-contained]"));
}

export function installContainment() {
	const blockIfContained = event => {
		const sel = document.getSelection();
		if (inContained(event.target) || inContained(sel?.anchorNode) || inContained(document.activeElement)) {
			event.preventDefault();
			toast("Copying IA case material is disabled.", "error");
		}
	};
	document.addEventListener("copy", blockIfContained, true);
	document.addEventListener("cut", blockIfContained, true);
	document.addEventListener("contextmenu", event => {
		if (inContained(event.target)) event.preventDefault();
	}, true);
	document.addEventListener("dragstart", event => {
		if (inContained(event.target) && !event.target.closest?.("[draggable='true']")) event.preventDefault();
	}, true);
	document.addEventListener("keydown", event => {
		const key = event.key.toLowerCase();
		if ((event.ctrlKey || event.metaKey) && (key === "p" || key === "s")) {
			event.preventDefault();
			toast("Printing and saving are disabled in the IA portal.", "error");
		}
		if (key === "printscreen") shield(1500);
	}, true);
	document.addEventListener("keyup", event => {
		if (event.key.toLowerCase() === "printscreen") shield(1500);
	}, true);
	window.addEventListener("beforeprint", () => document.body.classList.add("shielded"));
	window.addEventListener("afterprint", () => document.body.classList.remove("shielded"));
	// Privacy shield: case material blurs whenever the portal loses focus (snipping tools, window switching).
	window.addEventListener("blur", () => document.body.classList.add("shielded"));
	window.addEventListener("focus", () => document.body.classList.remove("shielded"));
	document.addEventListener("visibilitychange", () => document.body.classList.toggle("shielded", document.hidden));
}

function shield(ms) {
	document.body.classList.add("shielded");
	setTimeout(() => { if (document.hasFocus()) document.body.classList.remove("shielded"); }, ms);
}

let viewerStamp = null;
export function setViewer(viewer) {
	viewerStamp = viewer;
}

// Tiled watermark naming the viewer, so any photo or screenshot identifies its source.
export function watermark(viewer = viewerStamp) {
	const text = `${viewer?.name || "IA"} · ${viewer?.id || ""} · ${new Date().toISOString().slice(0, 16).replace("T", " ")}Z · CONFIDENTIAL`;
	const canvas = document.createElement("canvas");
	canvas.width = 460;
	canvas.height = 200;
	const ctx = canvas.getContext("2d");
	ctx.translate(230, 100);
	ctx.rotate(-0.35);
	ctx.fillStyle = "#ffffff";
	ctx.font = "600 13px Inter, sans-serif";
	ctx.textAlign = "center";
	ctx.fillText(text, 0, 0);
	const el = h("div", { class: "watermark", "aria-hidden": "true" });
	el.style.backgroundImage = `url(${canvas.toDataURL()})`;
	return el;
}

export function debounce(fn, ms) {
	let t;
	return (...args) => {
		clearTimeout(t);
		t = setTimeout(() => fn(...args), ms);
	};
}

// Multi-select for punishments ("X1 Black Mark + FTO"). value() returns "key1,key2".
export function punishmentPicker(punishments, selected, onChange) {
	const chosen = new Set(String(selected || "").split(",").filter(Boolean));
	const el = h("div", { class: "role-list punishment-picker" }, punishments.map(p => {
		const cb = h("input", { type: "checkbox", checked: chosen.has(p.key) });
		const chip = h("label", { class: `role-chip${cb.checked ? " on" : ""}`, title: p.description }, cb, p.label);
		cb.addEventListener("change", () => {
			cb.checked ? chosen.add(p.key) : chosen.delete(p.key);
			chip.classList.toggle("on", cb.checked);
			onChange?.([...chosen]);
		});
		return chip;
	}));
	return { el, value: () => punishments.map(p => p.key).filter(k => chosen.has(k)).join(","), keys: () => [...chosen] };
}
