// ADE icon generator — dependency-free (built-in `node:zlib` only).
//
// Rasterizes the hand-authored ADE "P" logo (see apps/webui/public/favicon.svg)
// via signed-distance fields with 4x4 supersampling, and writes every raster the
// web UI + shippable executable need:
//   - apps/webui/public: favicon-32.png, apple-touch-icon.png, pwa-icon-{192,512}.png
//   - apps/desktop/src/resources/build/icons: icon.png (1024), icon.ico, icon.icns
//
// The geometry here mirrors favicon.svg exactly (512-unit space), so the SVG
// favicon and the PNG rasters render the same mark. Re-run after editing the logo:
//   node scripts/generate-icons.mjs
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

// ---------------------------------------------------------------- colors ----
const PARCHMENT_TOP = [0xee, 0xe3, 0xc6];
const PARCHMENT_BOT = [0xda, 0xc7, 0x92];
const INK_TOP = [0x4a, 0x3a, 0x24];
const INK_BOT = [0x2c, 0x21, 0x14];

const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c0, c1, t) => [
	lerp(c0[0], c1[0], t),
	lerp(c0[1], c1[1], t),
	lerp(c0[2], c1[2], t),
];

// ------------------------------------------------------------------ sdf -----
// All coordinates are in the 512x512 logo space.
function sdSegment(px, py, ax, ay, bx, by) {
	const pax = px - ax;
	const pay = py - ay;
	const bax = bx - ax;
	const bay = by - ay;
	const h = Math.max(0, Math.min(1, (pax * bax + pay * bay) / (bax * bax + bay * bay)));
	return Math.hypot(pax - bax * h, pay - bay * h);
}

// ADE "P": bold stem capsule + right-half bowl ring. Returns signed distance
// (<0 inside the ink). Matches favicon.svg's path exactly.
function inkSdf(px, py) {
	const stem = sdSegment(px, py, 204, 411, 204, 101) - 27; // capsule, half-width 27
	const ring = Math.abs(Math.hypot(px - 204, py - 205) - 104) - 27; // annulus, half-stroke 27
	const bowl = Math.max(ring, 204 - px); // keep only the right half (x >= 204)
	return Math.min(stem, bowl);
}

// Renders the logo at `size` px. Returns an RGBA Uint8Array (opaque, full-bleed).
function renderRGBA(size) {
	const SS = 4; // 4x4 supersampling
	const scale = 512 / size; // logo-space units per output pixel
	const out = new Uint8Array(size * size * 4);
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			let r = 0;
			let g = 0;
			let b = 0;
			for (let sy = 0; sy < SS; sy++) {
				for (let sx = 0; sx < SS; sx++) {
					const lx = (x + (sx + 0.5) / SS) * scale;
					const ly = (y + (sy + 0.5) / SS) * scale;
					const t = Math.max(0, Math.min(1, ly / 512));
					const parchment = mix(PARCHMENT_TOP, PARCHMENT_BOT, t);
					let c = parchment;
					if (inkSdf(lx, ly) < 0) c = mix(INK_TOP, INK_BOT, t);
					r += c[0];
					g += c[1];
					b += c[2];
				}
			}
			const n = SS * SS;
			const i = (y * size + x) * 4;
			out[i] = Math.round(r / n);
			out[i + 1] = Math.round(g / n);
			out[i + 2] = Math.round(b / n);
			out[i + 3] = 255;
		}
	}
	return out;
}

// ------------------------------------------------------------ png encode ----
const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();

function crc32(buf) {
	let c = 0xffffffff;
	for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length, 0);
	const typeBuf = Buffer.from(type, "ascii");
	const body = Buffer.concat([typeBuf, data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body), 0);
	return Buffer.concat([len, body, crc]);
}

function encodePNG(size, rgba) {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(size, 0);
	ihdr.writeUInt32BE(size, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // color type RGBA
	// 10,11,12 = compression/filter/interlace = 0
	// Raw scanlines, each prefixed with filter byte 0.
	const stride = size * 4;
	const raw = Buffer.alloc((stride + 1) * size);
	for (let y = 0; y < size; y++) {
		raw[y * (stride + 1)] = 0;
		Buffer.from(rgba.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
	}
	const idat = deflateSync(raw, { level: 9 });
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk("IHDR", ihdr),
		pngChunk("IDAT", idat),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
}

// Cache one PNG per size (several formats reuse the same rasters).
const pngCache = new Map();
function pngFor(size) {
	if (!pngCache.has(size)) pngCache.set(size, encodePNG(size, renderRGBA(size)));
	return pngCache.get(size);
}

// ------------------------------------------------------------ ico encode ----
// Windows .ico with PNG-compressed entries (Vista+). Sizes 256..16.
function encodeICO(sizes) {
	const pngs = sizes.map((s) => ({ size: s, data: pngFor(s) }));
	const header = Buffer.alloc(6);
	header.writeUInt16LE(0, 0); // reserved
	header.writeUInt16LE(1, 2); // type: icon
	header.writeUInt16LE(pngs.length, 4);
	const dir = Buffer.alloc(16 * pngs.length);
	let offset = 6 + dir.length;
	pngs.forEach((p, i) => {
		const o = i * 16;
		dir[o] = p.size >= 256 ? 0 : p.size; // width (0 => 256)
		dir[o + 1] = p.size >= 256 ? 0 : p.size; // height
		dir[o + 2] = 0; // palette
		dir[o + 3] = 0; // reserved
		dir.writeUInt16LE(1, o + 4); // color planes
		dir.writeUInt16LE(32, o + 6); // bits per pixel
		dir.writeUInt32LE(p.data.length, o + 8);
		dir.writeUInt32LE(offset, o + 12);
		offset += p.data.length;
	});
	return Buffer.concat([header, dir, ...pngs.map((p) => p.data)]);
}

// ----------------------------------------------------------- icns encode ----
// Apple .icns with PNG-encoded entries (OS X 10.7+). type => size.
function encodeICNS(entries) {
	const parts = [];
	for (const [type, size] of entries) {
		const png = pngFor(size);
		const head = Buffer.alloc(8);
		head.write(type, 0, "ascii");
		head.writeUInt32BE(png.length + 8, 4);
		parts.push(head, png);
	}
	const body = Buffer.concat(parts);
	const header = Buffer.alloc(8);
	header.write("icns", 0, "ascii");
	header.writeUInt32BE(body.length + 8, 4);
	return Buffer.concat([header, body]);
}

// ---------------------------------------------------------------- write -----
function write(relPath, buf) {
	const full = join(repoRoot, relPath);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, buf);
	console.log(`  wrote ${relPath} (${buf.length} bytes)`);
}

const webui = "apps/webui/public";
const desktopIcons = "apps/desktop/src/resources/build/icons";

console.log("Generating ADE icons...");
write(`${webui}/favicon-32.png`, pngFor(32));
write(`${webui}/apple-touch-icon.png`, pngFor(180));
write(`${webui}/pwa-icon-192.png`, pngFor(192));
write(`${webui}/pwa-icon-512.png`, pngFor(512));

write(`${desktopIcons}/icon.png`, pngFor(1024));
write(`${desktopIcons}/icon.ico`, encodeICO([256, 128, 64, 48, 32, 16]));
write(
	`${desktopIcons}/icon.icns`,
	encodeICNS([
		["ic10", 1024], // 512@2x
		["ic14", 512], // 256@2x
		["ic13", 256], // 128@2x
		["ic07", 128],
		["ic12", 64], // 32@2x
		["ic11", 32], // 16@2x
	]),
);
console.log("Done.");
