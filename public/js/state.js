import { api } from "./lib.js";

export const store = { me: null, policy: null, counts: {}, demo: false };

export async function loadMe() {
	const data = await api("/me");
	store.me = data.user;
	store.policy = data.policy;
	store.counts = data.counts;
	store.demo = data.demo;
	store.owner = Boolean(data.owner);
	return data;
}

export function can(capability) {
	return Boolean(store.me?.capabilities?.includes(capability));
}

export function findingLabel(key) {
	return store.policy?.findings.find(f => f.key === key)?.label || key || "-";
}

export function punishmentLabel(key) {
	return store.policy?.punishments.find(p => p.key === key)?.label || key || "-";
}
