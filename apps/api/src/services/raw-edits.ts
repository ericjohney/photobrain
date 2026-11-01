import { eq } from "drizzle-orm";
import { z } from "zod";
import { photoRawEdits, photos } from "../db/schema";
import type { ApiDatabase } from "./photo-catalog";

export const rawEditSettingsSchema = z
	.object({
		version: z.literal(1),
		exposure: z.number().finite().min(-5).max(5).multipleOf(0.01),
		contrast: z.number().int().min(-100).max(100),
		highlights: z.number().int().min(-100).max(100),
		shadows: z.number().int().min(-100).max(100),
		whites: z.number().int().min(-100).max(100),
		blacks: z.number().int().min(-100).max(100),
	})
	.strict();
export type RawEditSettings = z.infer<typeof rawEditSettingsSchema>;
export const defaultRawEditSettings: RawEditSettings = {
	version: 1,
	exposure: 0,
	contrast: 0,
	highlights: 0,
	shadows: 0,
	whites: 0,
	blacks: 0,
};
export type RawEngine = "apple" | "adobe";
export type RawEdit = {
	settings: RawEditSettings;
	revision: number;
	engine: RawEngine;
	supportsTone: boolean;
};

export class RawEditError extends Error {
	constructor(
		public readonly code:
			| "PHOTO_NOT_FOUND"
			| "NOT_RAW"
			| "RAW_EDIT_CONFLICT"
			| "RAW_TONE_UNSUPPORTED",
	) {
		super(code);
	}
}

export function readRawEdit(
	database: Pick<ApiDatabase, "select">,
	photoId: number,
	defaultEngine: RawEngine,
): RawEdit {
	const photo = database
		.select({ isRaw: photos.isRaw, path: photos.path })
		.from(photos)
		.where(eq(photos.id, photoId))
		.get();
	if (!photo) throw new RawEditError("PHOTO_NOT_FOUND");
	if (!photo.isRaw) throw new RawEditError("NOT_RAW");
	const saved = database
		.select()
		.from(photoRawEdits)
		.where(eq(photoRawEdits.photoId, photoId))
		.get();
	// The supported DNGs are LinearRaw ProRAW, for which Adobe is unavailable.
	const engine = /\.dng$/i.test(photo.path)
		? "apple"
		: (saved?.engine ?? defaultEngine);
	return {
		settings: saved
			? rawEditSettingsSchema.parse(JSON.parse(saved.settings))
			: { ...defaultRawEditSettings },
		revision: saved?.revision ?? 0,
		engine,
		supportsTone: engine === "adobe",
	};
}

export function validateRawTone(settings: RawEditSettings, engine: RawEngine) {
	if (
		engine === "apple" &&
		[
			settings.contrast,
			settings.highlights,
			settings.shadows,
			settings.whites,
			settings.blacks,
		].some((value) => value !== 0)
	)
		throw new RawEditError("RAW_TONE_UNSUPPORTED");
}

export function saveRawEdit(
	database: ApiDatabase,
	photoId: number,
	expectedRevision: number,
	input: RawEditSettings,
	defaultEngine: RawEngine,
): RawEdit {
	const settings = rawEditSettingsSchema.parse(input);
	return database.transaction((tx) => {
		const current = readRawEdit(tx, photoId, defaultEngine);
		if (expectedRevision !== current.revision)
			throw new RawEditError("RAW_EDIT_CONFLICT");
		validateRawTone(settings, current.engine);
		const revision = current.revision + 1;
		const values = {
			photoId,
			settings: JSON.stringify(settings),
			engine: current.engine,
			revision,
			updatedAt: new Date(),
		};
		tx.insert(photoRawEdits)
			.values(values)
			.onConflictDoUpdate({ target: photoRawEdits.photoId, set: values })
			.run();
		return { ...current, settings, revision };
	});
}

/** Only expose the six supported controls, never arbitrary pipeline/profile options. */
export function rawDevelopSettingsJson(
	settings: RawEditSettings,
	engine: RawEngine,
): string {
	return JSON.stringify({
		exposure: settings.exposure,
		adobe_tone:
			engine === "adobe"
				? {
						contrast: settings.contrast,
						highlights: settings.highlights,
						shadows: settings.shadows,
						whites: settings.whites,
						blacks: settings.blacks,
					}
				: undefined,
	});
}
