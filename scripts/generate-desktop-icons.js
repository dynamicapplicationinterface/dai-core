import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const iconsDir = resolve(__dirname, "../apps/desktop/src-tauri/icons");
mkdirSync(iconsDir, { recursive: true });

/**
 * Creates a valid Windows 3.00 format ICO binary buffer with multiple image sizes.
 * Windows Resource Compiler (rc.exe) error RC2175 is thrown if the file lacks
 * a valid ICONDIR header, 40-byte BITMAPINFOHEADER, or matching byte offsets.
 */
function createWindowsIco(sizes) {
  const numImages = sizes.length;
  const headerSize = 6;
  const entrySize = 16;
  const dirSize = headerSize + numImages * entrySize;

  // Build payloads for each size
  const payloads = sizes.map(({ width, height }) => {
    const bmiHeaderSize = 40;
    const pixelBytesCount = width * height * 4;
    const andRowBytes = Math.ceil(width / 32) * 4;
    const andMaskBytesCount = andRowBytes * height;
    const totalPayloadSize = bmiHeaderSize + pixelBytesCount + andMaskBytesCount;

    const payload = Buffer.alloc(totalPayloadSize);

    // BITMAPINFOHEADER (40 bytes)
    payload.writeUInt32LE(40, 0);                 // biSize
    payload.writeInt32LE(width, 4);               // biWidth
    payload.writeInt32LE(height * 2, 8);          // biHeight (XOR + AND mask height)
    payload.writeUInt16LE(1, 12);                 // biPlanes
    payload.writeUInt16LE(32, 14);                // biBitCount (32-bit ARGB)
    payload.writeUInt32LE(0, 16);                 // biCompression (BI_RGB)
    payload.writeUInt32LE(pixelBytesCount, 20);   // biSizeImage
    payload.writeInt32LE(0, 24);                  // biXPelsPerMeter
    payload.writeInt32LE(0, 28);                  // biYPelsPerMeter
    payload.writeUInt32LE(0, 32);                 // biClrUsed
    payload.writeUInt32LE(0, 36);                 // biClrImportant

    // Draw DAI brand pixels: dark navy border (#0f172a), DAI blue core (#3b82f6), green accent (#10b981)
    let offset = bmiHeaderSize;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const isBorder = x === 0 || y === 0 || x === width - 1 || y === height - 1;
        const isAccent = x >= Math.floor(width * 0.65) && y <= Math.floor(height * 0.35);

        let r = 0x3b, g = 0x82, b = 0xf6, a = 0xff; // DAI blue (#3b82f6)
        if (isBorder) {
          r = 0x0f; g = 0x17; b = 0x2a; // Navy border (#0f172a)
        } else if (isAccent) {
          r = 0x10; g = 0xb9; b = 0x81; // Green accent (#10b981)
        }

        // BGRA format in Windows DIB
        payload.writeUInt8(b, offset);
        payload.writeUInt8(g, offset + 1);
        payload.writeUInt8(r, offset + 2);
        payload.writeUInt8(a, offset + 3);
        offset += 4;
      }
    }
    // AND mask remains all zeros (opaque) in payload.slice(bmiHeaderSize + pixelBytesCount)

    return { width, height, data: payload };
  });

  // Calculate offsets
  let currentOffset = dirSize;
  const entries = payloads.map(p => {
    const entry = {
      width: p.width >= 256 ? 0 : p.width,
      height: p.height >= 256 ? 0 : p.height,
      size: p.data.length,
      offset: currentOffset,
    };
    currentOffset += p.data.length;
    return entry;
  });

  const icoBuffer = Buffer.alloc(currentOffset);

  // Write ICONDIR
  icoBuffer.writeUInt16LE(0, 0);           // Reserved
  icoBuffer.writeUInt16LE(1, 2);           // Type: 1 = ICO
  icoBuffer.writeUInt16LE(numImages, 4);   // Count

  // Write ICONDIRENTRY list
  entries.forEach((e, i) => {
    const entryOffset = headerSize + i * entrySize;
    icoBuffer.writeUInt8(e.width, entryOffset);
    icoBuffer.writeUInt8(e.height, entryOffset + 1);
    icoBuffer.writeUInt8(0, entryOffset + 2); // Colors
    icoBuffer.writeUInt8(0, entryOffset + 3); // Reserved
    icoBuffer.writeUInt16LE(1, entryOffset + 4); // Planes
    icoBuffer.writeUInt16LE(32, entryOffset + 6); // BitCount
    icoBuffer.writeUInt32LE(e.size, entryOffset + 8); // BytesInRes
    icoBuffer.writeUInt32LE(e.offset, entryOffset + 12); // ImageOffset
  });

  // Write Image Payloads
  payloads.forEach((p, i) => {
    p.data.copy(icoBuffer, entries[i].offset);
  });

  return icoBuffer;
}

// Generate valid Windows multi-size ICO binary
const icoBuffer = createWindowsIco([
  { width: 16, height: 16 },
  { width: 32, height: 32 },
  { width: 48, height: 48 },
  { width: 256, height: 256 }
]);

writeFileSync(resolve(iconsDir, "icon.ico"), icoBuffer);

// PNG icon placeholders for 32x32, 128x128, 512x512
const png1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
);

writeFileSync(resolve(iconsDir, "32x32.png"), png1x1);
writeFileSync(resolve(iconsDir, "128x128.png"), png1x1);
writeFileSync(resolve(iconsDir, "128x128@2x.png"), png1x1);
writeFileSync(resolve(iconsDir, "icon.png"), png1x1);
writeFileSync(resolve(iconsDir, "icon.icns"), png1x1);

console.log(`Generated valid Windows 3.00 format icon.ico (${icoBuffer.length} bytes, 4 layers: 16x16, 32x32, 48x48, 256x256)`);
