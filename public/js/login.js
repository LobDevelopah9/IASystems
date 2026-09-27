(function () {
	const messages = {
		oauth_not_configured: "Discord sign-in has not been configured yet. An administrator needs to set the Discord client ID and secret.",
		discord_denied: "Discord sign-in was cancelled.",
		state: "Your sign-in link expired. Please try again.",
		token: "Discord did not accept the sign-in. Please try again.",
		profile: "Could not read your Discord profile. Please try again.",
		not_member: "You must be a member of the SAHP Discord server to use this system.",
		no_role: "Your Discord roles do not grant access to the Internal Affairs portal.",
		suspended: "Your portal access has been suspended. Contact the Head of Internal Affairs.",
		login_failed: "Sign-in failed. Please try again in a moment."
	};
	const code = new URLSearchParams(location.search).get("error");
	if (code) {
		const el = document.getElementById("error");
		el.textContent = messages[code] || "Sign-in failed.";
		el.classList.remove("hidden");
		history.replaceState(null, "", "/");
	}
	if (window.IA_CONFIG && window.IA_CONFIG.devLogin) {
		fetch("/auth/dev-users").then(r => r.json()).then(users => {
			const box = document.getElementById("dev-users");
			users.forEach(u => {
				const a = document.createElement("a");
				a.href = `/auth/dev?as=${encodeURIComponent(u.id)}`;
				const name = document.createElement("span");
				name.textContent = u.name;
				const role = document.createElement("span");
				role.className = "muted small";
				role.textContent = u.role;
				a.append(name, role);
				box.append(a);
			});
			if (users.length) document.getElementById("dev").classList.remove("hidden");
		}).catch(() => {});
	}
})();
