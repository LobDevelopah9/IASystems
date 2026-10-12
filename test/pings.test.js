process.env.IA_DB_FILE = ":memory:";
process.env.NODE_ENV = "test";
process.env.AI_PROVIDER = "none";

const test = require("node:test");
const assert = require("node:assert");
const policy = require("../lib/policy");

const ROLE = "333333333333333333";

test("new-ticket pings default to all IA staff, can be set, cleared, and survive other saves", () => {
	assert.equal(policy.discordSettings().ticketPingRoleIds, null, "unset means every IA staff role");

	policy.saveDiscordSettings({ guildId: "", ticketPingRoleIds: [ROLE, "not-an-id"] }, "x");
	assert.deepEqual(policy.discordSettings().ticketPingRoleIds, [ROLE]);

	// Saving the server fields alone keeps the ping roles.
	policy.saveDiscordSettings({ guildId: "", ticketCategoryId: "", logChannelId: "" }, "x");
	assert.deepEqual(policy.discordSettings().ticketPingRoleIds, [ROLE]);

	policy.saveDiscordSettings({ ticketPingRoleIds: [] }, "x");
	assert.deepEqual(policy.discordSettings().ticketPingRoleIds, [], "an empty list turns pings off");
});
