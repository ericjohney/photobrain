"""Reproduce synthetic.ARW: a tiny uncompressed Sony-shaped TIFF, no real photograph."""
import pathlib
import struct

u16 = lambda *v: struct.pack('<' + 'H' * len(v), *v)
u32 = lambda *v: struct.pack('<' + 'I' * len(v), *v)
w, h = 192, 144
# Reserve separate IFD regions; external tag payloads start at byte 512.
buf = bytearray(512)
buf[:8] = b'II' + u16(42) + u32(8)

def append(data):
    offset = len(buf)
    buf.extend(data)
    if len(buf) % 2:
        buf.append(0)
    return offset

def ifd(offset, tags):
    data = bytearray(u16(len(tags)))
    for tag, kind, count, payload in sorted(tags):
        value = payload.ljust(4, b'\0') if len(payload) <= 4 else u32(append(payload))
        data.extend(u16(tag, kind) + u32(count) + value)
    data.extend(u32(0))
    buf[offset:offset + len(data)] = data

ifd(8, [(0x10f, 2, 5, b'SONY\0'), (0x110, 2, 9, b'ILCE-7CR\0'),
        (0x112, 3, 1, u16(6)), (0x14a, 4, 1, u32(96))])
# A low-gradient mosaic with real Bayer channel structure and highlight headroom.
pixels = []
for y in range(h):
    for x in range(w):
        channel = [0, 1, 1, 2][(y % 2) * 2 + x % 2]
        pixels.append(int((1200 + x * 16 + y * 5) * [0.75, 1.0, 0.85][channel]))
strip = u16(*pixels)
strip_offset = append(strip)
ifd(96, [(0x100, 4, 1, u32(w)), (0x101, 4, 1, u32(h)),
         (0x102, 3, 1, u16(14)), (0x103, 3, 1, u16(1)),
         (0x106, 3, 1, u16(32803)), (0x111, 4, 1, u32(strip_offset)),
         (0x117, 4, 1, u32(len(strip))), (0x828d, 3, 2, u16(2, 2)),
         (0x828e, 1, 4, bytes([0, 1, 1, 2])),
         (0x7310, 3, 4, u16(512, 512, 512, 512)),
         (0x7313, 3, 4, u16(1800, 1000, 1000, 1600)),
         (0x787f, 3, 1, u16(16383))])
pathlib.Path(__file__).with_name('synthetic.ARW').write_bytes(buf)
