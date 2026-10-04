/**
 * Incremental STORE-only ZIP encoder for streamed archives. Each entry's bytes
 * are complete before its local header is written, so headers carry the real
 * CRC-32 and sizes (no data descriptors). Names are UTF-8 (general purpose bit
 * 11). ZIP64 extra fields and end records are emitted only when a size,
 * offset, or entry count does not fit the classic fields.
 */

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY = 0x06064b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EXTRA = 0x0001;
const UTF8_NAMES = 0x0800;
const VERSION_STORE = 20;
const VERSION_ZIP64 = 45;
// Upper byte 3 = Unix, so readers apply the external mode bits below.
const VERSION_MADE_BY = (3 << 8) | VERSION_ZIP64;
// Regular file, rw-r--r--.
const EXTERNAL_ATTRIBUTES = (0o100644 << 16) >>> 0;
const MAX_U16 = 0xffff;
const MAX_U32 = 0xffffffff;
const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const ZIP64_END_SIZE = 56;
const ZIP64_LOCATOR_SIZE = 20;
const END_SIZE = 22;

const utf8 = new TextEncoder();

/**
 * MS-DOS date/time fields from the UTC fields of `date` (2-second precision).
 * Dates the format cannot represent clamp to 1980-01-01 or 2107-12-31 23:59:58.
 */
export function dosDateTime(date: Date): { date: number; time: number } {
	const year = date.getUTCFullYear();
	if (!(year >= 1980)) return { date: (1 << 5) | 1, time: 0 };
	if (year > 2107) {
		return {
			date: (127 << 9) | (12 << 5) | 31,
			time: (23 << 11) | (59 << 5) | 29,
		};
	}
	return {
		date:
			((year - 1980) << 9) |
			((date.getUTCMonth() + 1) << 5) |
			date.getUTCDate(),
		time:
			(date.getUTCHours() << 11) |
			(date.getUTCMinutes() << 5) |
			(date.getUTCSeconds() >> 1),
	};
}

export class ZipWriter {
	private offset: number;
	private central: Uint8Array[] = [];
	private centralSize = 0;
	private count = 0;
	private finished = false;

	/**
	 * @param startOffset Archive offset of the first local header. Nonzero only
	 *   to exercise ZIP64 offset encoding without writing gigabytes.
	 */
	constructor(startOffset = 0) {
		this.offset = startOffset;
	}

	/**
	 * Encodes one stored entry. Returns its local header and `data` itself, to be
	 * written in that order before the next entry.
	 */
	entry(name: string, data: Uint8Array, modifiedAt: Date): Uint8Array[] {
		const local = this.header(
			name,
			data.byteLength,
			Bun.hash.crc32(data) >>> 0,
			modifiedAt,
		);
		return [local, data];
	}

	/**
	 * The local header for `size` stored bytes with checksum `crc`, recording
	 * the entry in the central directory. `entry` is the normal path; this is
	 * the test seam for sizes too large to allocate.
	 */
	header(
		name: string,
		size: number,
		crc: number,
		modifiedAt: Date,
	): Uint8Array {
		if (this.finished) throw new Error("ZIP archive is already finished");
		const nameBytes = utf8.encode(name);
		if (nameBytes.byteLength === 0 || nameBytes.byteLength > MAX_U16) {
			throw new RangeError("ZIP entry name must be 1-65535 UTF-8 bytes");
		}
		const { date, time } = dosDateTime(modifiedAt);
		const offset = this.offset;
		const largeSize = size >= MAX_U32;
		const largeOffset = offset >= MAX_U32;

		const local = new Uint8Array(
			LOCAL_HEADER_SIZE + nameBytes.byteLength + (largeSize ? 20 : 0),
		);
		const localView = new DataView(local.buffer);
		localView.setUint32(0, LOCAL_HEADER, true);
		localView.setUint16(4, largeSize ? VERSION_ZIP64 : VERSION_STORE, true);
		localView.setUint16(6, UTF8_NAMES, true);
		localView.setUint16(8, 0, true); // STORE
		localView.setUint16(10, time, true);
		localView.setUint16(12, date, true);
		localView.setUint32(14, crc, true);
		localView.setUint32(18, largeSize ? MAX_U32 : size, true);
		localView.setUint32(22, largeSize ? MAX_U32 : size, true);
		localView.setUint16(26, nameBytes.byteLength, true);
		localView.setUint16(
			28,
			local.byteLength - LOCAL_HEADER_SIZE - nameBytes.byteLength,
			true,
		);
		local.set(nameBytes, LOCAL_HEADER_SIZE);
		if (largeSize) {
			const extra = LOCAL_HEADER_SIZE + nameBytes.byteLength;
			localView.setUint16(extra, ZIP64_EXTRA, true);
			localView.setUint16(extra + 2, 16, true);
			localView.setBigUint64(extra + 4, BigInt(size), true);
			localView.setBigUint64(extra + 12, BigInt(size), true);
		}

		// ZIP64 central fields appear only for overflowing values, in this order.
		const zip64Fields = largeSize ? [size, size] : [];
		if (largeOffset) zip64Fields.push(offset);
		const extraSize = zip64Fields.length ? 4 + 8 * zip64Fields.length : 0;
		const record = new Uint8Array(
			CENTRAL_HEADER_SIZE + nameBytes.byteLength + extraSize,
		);
		const view = new DataView(record.buffer);
		view.setUint32(0, CENTRAL_HEADER, true);
		view.setUint16(4, VERSION_MADE_BY, true);
		view.setUint16(6, zip64Fields.length ? VERSION_ZIP64 : VERSION_STORE, true);
		view.setUint16(8, UTF8_NAMES, true);
		view.setUint16(10, 0, true);
		view.setUint16(12, time, true);
		view.setUint16(14, date, true);
		view.setUint32(16, crc, true);
		view.setUint32(20, largeSize ? MAX_U32 : size, true);
		view.setUint32(24, largeSize ? MAX_U32 : size, true);
		view.setUint16(28, nameBytes.byteLength, true);
		view.setUint16(30, extraSize, true);
		view.setUint16(32, 0, true); // comment
		view.setUint16(34, 0, true); // disk
		view.setUint16(36, 0, true); // internal attributes
		view.setUint32(38, EXTERNAL_ATTRIBUTES, true);
		view.setUint32(42, largeOffset ? MAX_U32 : offset, true);
		record.set(nameBytes, CENTRAL_HEADER_SIZE);
		if (extraSize) {
			const extra = CENTRAL_HEADER_SIZE + nameBytes.byteLength;
			view.setUint16(extra, ZIP64_EXTRA, true);
			view.setUint16(extra + 2, extraSize - 4, true);
			zip64Fields.forEach((value, index) => {
				view.setBigUint64(extra + 4 + 8 * index, BigInt(value), true);
			});
		}

		this.central.push(record);
		this.centralSize += record.byteLength;
		this.count++;
		this.offset += local.byteLength + size;
		return local;
	}

	/** The central directory and end records; the writer accepts nothing after. */
	finish(): Uint8Array {
		if (this.finished) throw new Error("ZIP archive is already finished");
		this.finished = true;
		const directoryOffset = this.offset;
		const directorySize = this.centralSize;
		const zip64 =
			this.count >= MAX_U16 ||
			directorySize >= MAX_U32 ||
			directoryOffset >= MAX_U32;
		const output = new Uint8Array(
			directorySize +
				(zip64 ? ZIP64_END_SIZE + ZIP64_LOCATOR_SIZE : 0) +
				END_SIZE,
		);
		let position = 0;
		for (const record of this.central) {
			output.set(record, position);
			position += record.byteLength;
		}
		this.central = [];
		const view = new DataView(output.buffer);
		if (zip64) {
			const zip64EndOffset = directoryOffset + directorySize;
			view.setUint32(position, ZIP64_END_OF_CENTRAL_DIRECTORY, true);
			view.setBigUint64(position + 4, BigInt(ZIP64_END_SIZE - 12), true);
			view.setUint16(position + 12, VERSION_MADE_BY, true);
			view.setUint16(position + 14, VERSION_ZIP64, true);
			view.setUint32(position + 16, 0, true); // this disk
			view.setUint32(position + 20, 0, true); // directory disk
			view.setBigUint64(position + 24, BigInt(this.count), true);
			view.setBigUint64(position + 32, BigInt(this.count), true);
			view.setBigUint64(position + 40, BigInt(directorySize), true);
			view.setBigUint64(position + 48, BigInt(directoryOffset), true);
			position += ZIP64_END_SIZE;
			view.setUint32(position, ZIP64_LOCATOR, true);
			view.setUint32(position + 4, 0, true);
			view.setBigUint64(position + 8, BigInt(zip64EndOffset), true);
			view.setUint32(position + 16, 1, true); // total disks
			position += ZIP64_LOCATOR_SIZE;
		}
		view.setUint32(position, END_OF_CENTRAL_DIRECTORY, true);
		view.setUint16(position + 4, 0, true);
		view.setUint16(position + 6, 0, true);
		view.setUint16(position + 8, Math.min(this.count, MAX_U16), true);
		view.setUint16(position + 10, Math.min(this.count, MAX_U16), true);
		view.setUint32(position + 12, Math.min(directorySize, MAX_U32), true);
		view.setUint32(position + 16, Math.min(directoryOffset, MAX_U32), true);
		view.setUint16(position + 20, 0, true); // comment
		return output;
	}
}
