// ROBLOX background check from public APIs: account age, ban status, past usernames, and group memberships.
// Everything here is public profile data; nothing is written back to ROBLOX.
const TIMEOUT = 8000;

async function get(url, options = {}) {
	const response = await fetch(url, { ...options, signal: AbortSignal.timeout(TIMEOUT), headers: { Accept: "application/json", ...(options.headers || {}) } });
	if (!response.ok) throw new Error(`ROBLOX API ${response.status}`);
	return response.json();
}

async function lookup(username) {
	const name = String(username || "").trim();
	if (!/^[A-Za-z0-9_]{3,20}$/.test(name)) return null;
	const found = await get("https://users.roblox.com/v1/usernames/users", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ usernames: [name], excludeBannedUsers: false })
	});
	const hit = found.data?.[0];
	if (!hit) return { username: name, found: false };
	const settled = await Promise.allSettled([
		get(`https://users.roblox.com/v1/users/${hit.id}`),
		get(`https://users.roblox.com/v1/users/${hit.id}/username-history?limit=50&sortOrder=Desc`),
		get(`https://groups.roblox.com/v2/users/${hit.id}/groups/roles`)
	]);
	const [profile, history, groups] = settled.map(r => (r.status === "fulfilled" ? r.value : null));
	return {
		found: true,
		id: hit.id,
		username: hit.name,
		displayName: hit.displayName,
		profileUrl: `https://www.roblox.com/users/${hit.id}/profile`,
		createdAt: profile?.created ? Date.parse(profile.created) : null,
		banned: Boolean(profile?.isBanned),
		previousNames: (history?.data || []).map(x => x.name).filter(n => n && n !== hit.name).slice(0, 25),
		groups: (groups?.data || []).map(g => ({ id: g.group?.id, name: g.group?.name, role: g.role?.name, rank: g.role?.rank })).filter(g => g.name).slice(0, 60),
		partial: settled.some(r => r.status === "rejected")
	};
}

module.exports = { lookup };
