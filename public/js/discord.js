// Renders a Discord message the way Discord shows it: author line, markdown, pings, role mentions, channels,
// timestamps, custom emoji, spoilers, and embeds. Built entirely with DOM nodes (no innerHTML), so message text
// can never inject markup.
import { h, avatar, fmtDate } from "./lib.js";

const INLINE = /(<@!?\d{15,22}>|<@&\d{15,22}>|<#\d{15,22}>|<t:-?\d{1,13}(?::[tTdDfFR])?>|<a?:\w{2,32}:\d{15,22}>|\*\*\*[^*]+?\*\*\*|\*\*[^*]+?\*\*|__[^_]+?__|~~[^~]+?~~|\|\|[^|]+?\|\||`[^`]+`|\*[^*\s][^*]*?\*|(?<![A-Za-z0-9])_[^_\s][^_]*?_(?![A-Za-z0-9])|\[[^\]]{1,200}\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s<>]+)/;

function timestamp(unix, style) {
	const d = new Date(Number(unix) * 1000);
	const text = style === "R" ? relative(d) : style === "t" || style === "T" ? d.toLocaleTimeString() : style === "d" || style === "D" ? d.toLocaleDateString(undefined, { dateStyle: style === "D" ? "long" : "short" }) : fmtDate(d.getTime());
	return h("span", { class: "dc-time", title: d.toLocaleString() }, text);
}

function relative(d) {
	const days = Math.round((d.getTime() - Date.now()) / 86400000);
	if (Math.abs(days) < 1) return "today";
	return days < 0 ? `${-days} day${days === -1 ? "" : "s"} ago` : `in ${days} day${days === 1 ? "" : "s"}`;
}

function inline(text, ctx) {
	const out = [];
	let rest = String(text || "");
	let guard = 0;
	while (rest && guard++ < 2000) {
		const m = rest.match(INLINE);
		if (!m) {
			out.push(rest);
			break;
		}
		if (m.index) out.push(rest.slice(0, m.index));
		out.push(token(m[0], ctx));
		rest = rest.slice(m.index + m[0].length);
	}
	return out;
}

function token(t, ctx) {
	const refs = ctx.refs || {};
	let m;
	if ((m = t.match(/^<@!?(\d+)>$/))) {
		const user = refs.users?.[m[1]];
		const self = ctx.highlight && m[1] === ctx.highlight;
		return h("span", { class: `dc-mention${self ? " self" : ""}`, title: m[1] }, `@${user?.name || "unknown-user"}`);
	}
	if ((m = t.match(/^<@&(\d+)>$/))) {
		const role = refs.roles?.[m[1]];
		const el = h("span", { class: "dc-mention role" }, `@${role?.name || "deleted-role"}`);
		if (role?.color) el.style.setProperty("--role", role.color);
		return el;
	}
	if ((m = t.match(/^<#(\d+)>$/))) return h("span", { class: "dc-mention" }, `#${refs.channels?.[m[1]]?.name || "unknown"}`);
	if ((m = t.match(/^<t:(-?\d+)(?::([tTdDfFR]))?>$/))) return timestamp(m[1], m[2]);
	if ((m = t.match(/^<(a?):(\w+):(\d+)>$/))) return h("img", { class: "dc-emoji", src: `https://cdn.discordapp.com/emojis/${m[3]}.${m[1] ? "gif" : "png"}?size=48`, alt: `:${m[2]}:`, title: `:${m[2]}:` });
	if (t.startsWith("***")) return h("strong", null, h("em", null, inline(t.slice(3, -3), ctx)));
	if (t.startsWith("**")) return h("strong", null, inline(t.slice(2, -2), ctx));
	if (t.startsWith("__")) return h("u", null, inline(t.slice(2, -2), ctx));
	if (t.startsWith("~~")) return h("s", null, inline(t.slice(2, -2), ctx));
	if (t.startsWith("||")) {
		const el = h("span", { class: "dc-spoiler", tabindex: "0", role: "button", "aria-label": "Reveal spoiler" }, inline(t.slice(2, -2), ctx));
		const reveal = () => el.classList.add("shown");
		el.addEventListener("click", reveal);
		el.addEventListener("keydown", e => (e.key === "Enter" || e.key === " ") && reveal());
		return el;
	}
	if (t.startsWith("`")) return h("code", { class: "dc-code" }, t.slice(1, -1));
	if (t.startsWith("*") || t.startsWith("_")) return h("em", null, inline(t.slice(1, -1), ctx));
	if ((m = t.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/))) return h("a", { href: m[2], target: "_blank", rel: "noopener noreferrer" }, inline(m[1], ctx));
	const url = t.replace(/[.,;:!?)]+$/, "");
	return [h("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, url), t.slice(url.length)];
}

// Block-level markdown: code blocks, quotes, headings, lists.
export function markdown(text, ctx = {}) {
	const out = [];
	const parts = String(text || "").split(/```(?:\w{1,15}\n)?([\s\S]*?)```/);
	parts.forEach((part, i) => {
		if (i % 2) {
			out.push(h("pre", { class: "dc-pre" }, part.replace(/\n$/, "")));
			return;
		}
		let quote = null;
		for (const line of part.split("\n")) {
			const q = line.match(/^>>?>? ?(.*)$/);
			const heading = line.match(/^(#{1,3}) (.+)$/);
			const item = line.match(/^\s*[-*] (.+)$/);
			const sub = line.match(/^-# (.+)$/);
			let el;
			if (sub) el = h("div", { class: "dc-sub" }, inline(sub[1], ctx));
			else if (heading) el = h("div", { class: `dc-h${heading[1].length}` }, inline(heading[2], ctx));
			else if (item) el = h("div", { class: "dc-li" }, inline(item[1], ctx));
			else el = h("div", { class: "dc-line" }, line ? inline(line, ctx) : " ");
			if (q && !heading) {
				if (!quote) out.push(quote = h("blockquote", { class: "dc-quote" }));
				quote.append(h("div", { class: "dc-line" }, inline(q[1], ctx)));
				continue;
			}
			quote = null;
			out.push(el);
		}
	});
	while (out.length && out[out.length - 1].textContent === " ") out.pop();
	return out;
}

function embed(e, ctx) {
	const el = h("div", { class: "dc-embed" },
		e.author ? h("div", { class: "dc-embed-author" }, e.author) : null,
		e.title ? h("div", { class: "dc-embed-title" }, e.url ? h("a", { href: e.url, target: "_blank", rel: "noopener noreferrer" }, inline(e.title, ctx)) : inline(e.title, ctx)) : null,
		e.description ? h("div", { class: "dc-embed-desc" }, markdown(e.description, ctx)) : null,
		e.fields?.length ? h("div", { class: "dc-fields" }, e.fields.map(f => h("div", { class: `dc-field${f.inline ? " inline" : ""}` },
			h("div", { class: "dc-field-name" }, inline(f.name, ctx)),
			h("div", { class: "dc-field-value" }, markdown(f.value, ctx))))) : null,
		e.footer ? h("div", { class: "dc-embed-footer" }, e.footer) : null);
	if (e.color) el.style.setProperty("--embed", e.color);
	return el;
}

// entry: { author, authorAvatar, authorBot, at, text, embeds, refs, url, channel }
export function discordMessage(entry, { highlight, extra } = {}) {
	const ctx = { refs: entry.refs || {}, highlight };
	const text = entry.text ?? (entry.embeds?.length ? "" : entry.content);
	return h("article", { class: "dc-msg" },
		avatar(entry.author, entry.authorAvatar, "sm dc-avatar"),
		h("div", { class: "dc-body" },
			h("div", { class: "dc-head" },
				h("b", null, entry.author || "Unknown"),
				entry.authorBot ? h("span", { class: "dc-bot" }, "APP") : null,
				h("span", { class: "dc-meta" }, `${fmtDate(entry.at)}${entry.channel ? ` · #${entry.channel}` : ""}`),
				entry.url ? h("a", { class: "dc-jump", href: entry.url, target: "_blank", rel: "noopener noreferrer" }, "Jump") : null),
			text ? h("div", { class: "dc-content" }, markdown(text, ctx)) : null,
			(entry.embeds || []).map(e => embed(e, ctx)),
			extra || null));
}
