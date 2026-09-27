const config = require("./lib/config");
const { createApp } = require("./lib/server");
const seed = require("./lib/seed");
const pipeline = require("./lib/pipeline");
const bot = require("./lib/bot");

if (config.SEED_DEMO || config.DEV_LOGIN) seed.seedDemo();

const app = createApp();
const server = app.listen(config.PORT, () => {
	console.log(`[web] SAHP IA portal listening on ${config.PORT} (${config.PUBLIC_URL})`);
});

pipeline.start();
bot.start();

function shutdown(signal) {
	console.log(`[main] ${signal} received, shutting down`);
	pipeline.stop();
	server.close(() => process.exit(0));
	setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", error => console.error("[main] unhandled rejection", error));
