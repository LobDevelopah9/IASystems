// Detects a file's real type from its first bytes. Only these raster images, videos, and audio are ever stored
// or served. SVG/XML/HTML are never accepted, so script-in-image, XXE, and entity-expansion attacks do not apply.
const SIGNATURES = [
	{ type: "image/png", test: b => b.length > 8 && b[0] === 0x89 && b.toString("ascii", 1, 4) === "PNG" },
	{ type: "image/jpeg", test: b => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
	{ type: "image/gif", test: b => b.length > 6 && /^GIF8[79]a$/.test(b.toString("ascii", 0, 6)) },
	{ type: "image/webp", test: b => b.length > 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP" },
	{ type: "audio/wav", test: b => b.length > 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WAVE" },
	{ type: "video/webm", test: b => b.length > 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 },
	{ type: "video/quicktime", test: b => b.length > 12 && b.toString("ascii", 4, 8) === "ftyp" && b.toString("ascii", 8, 10) === "qt" },
	{ type: "video/mp4", test: b => b.length > 12 && b.toString("ascii", 4, 8) === "ftyp" },
	{ type: "audio/ogg", test: b => b.length > 4 && b.toString("ascii", 0, 4) === "OggS" },
	{ type: "audio/mpeg", test: b => b.length > 3 && (b.toString("ascii", 0, 3) === "ID3" || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) }
];

function detectType(buffer) {
	const head = Buffer.isBuffer(buffer) ? buffer.subarray(0, 64) : Buffer.alloc(0);
	return SIGNATURES.find(s => s.test(head))?.type || null;
}

const ALLOWED = new Set(SIGNATURES.map(s => s.type));

module.exports = { detectType, ALLOWED };
