import { eq, like, sql } from "drizzle-orm";
import type { db as productionDb } from "../db";
import {
	photoExif,
	photos as photosTable,
	publicPhotoColumns,
} from "../db/schema";

export type ApiDatabase = typeof productionDb;

export type FolderNode = {
	name: string;
	path: string;
	photoCount: number;
	children: FolderNode[];
};

export type PhotoFilters = {
	filterRaw?: "all" | "raw" | "standard";
	folder?: string;
	camera?: string;
	lens?: string;
	iso?: number;
	dateMonth?: string;
};

export type PhotoCatalogRepresentation = {
	normalizeDateMonths?: boolean;
};

export async function listFolders(database: ApiDatabase) {
	const results = await database
		.select({ path: photosTable.path })
		.from(photosTable);
	const folderMap = new Map<string, FolderNode>();

	for (const { path } of results) {
		const lastSlash = path.lastIndexOf("/");
		const folderPath = lastSlash > 0 ? path.substring(0, lastSlash) : "";
		if (!folderPath) continue;

		const parts = folderPath.split("/");
		let currentPath = "";
		for (let index = 0; index < parts.length; index++) {
			currentPath =
				index === 0 ? parts[index] : `${currentPath}/${parts[index]}`;
			if (!folderMap.has(currentPath)) {
				folderMap.set(currentPath, {
					name: parts[index],
					path: currentPath,
					photoCount: 0,
					children: [],
				});
			}
			if (index === parts.length - 1) {
				const folder = folderMap.get(currentPath);
				if (folder) folder.photoCount++;
			}
		}
	}

	const rootFolders: FolderNode[] = [];
	for (const [folderPath, folder] of folderMap) {
		const lastSlash = folderPath.lastIndexOf("/");
		if (lastSlash === -1) {
			rootFolders.push(folder);
			continue;
		}
		folderMap.get(folderPath.substring(0, lastSlash))?.children.push(folder);
	}

	const sortFolders = (folders: FolderNode[]): FolderNode[] =>
		folders
			.sort((left, right) => left.name.localeCompare(right.name))
			.map((folder) => ({
				...folder,
				children: sortFolders(folder.children),
			}));

	return { folders: sortFolders(rootFolders), totalPhotos: results.length };
}

export async function listFilterOptions(
	database: ApiDatabase,
	input: { folder?: string } = {},
	representation: PhotoCatalogRepresentation = {},
) {
	const folderCondition = input.folder
		? sql` AND ${photosTable.path} LIKE ${`${input.folder}/%`}`
		: sql``;
	const dateMonthExpression = representation.normalizeDateMonths
		? sql`replace(substr(${photoExif.dateTaken}, 1, 7), ':', '-')`
		: sql`substr(${photoExif.dateTaken}, 1, 7)`;
	const camerasResult = await database.all<{ camera: string }>(sql`
		SELECT DISTINCT
			CASE
				WHEN ${photoExif.cameraModel} LIKE ${photoExif.cameraMake} || '%' THEN ${photoExif.cameraModel}
				ELSE ${photoExif.cameraMake} || ' ' || ${photoExif.cameraModel}
			END as camera
		FROM ${photoExif}
		INNER JOIN ${photosTable} ON ${photosTable.id} = ${photoExif.photoId}
		WHERE ${photoExif.cameraMake} IS NOT NULL AND ${photoExif.cameraModel} IS NOT NULL${folderCondition}
		ORDER BY camera
	`);
	const lensesResult = await database.all<{ lens: string }>(sql`
		SELECT DISTINCT ${photoExif.lensModel} as lens
		FROM ${photoExif}
		INNER JOIN ${photosTable} ON ${photosTable.id} = ${photoExif.photoId}
		WHERE ${photoExif.lensModel} IS NOT NULL${folderCondition}
		ORDER BY lens
	`);
	const isosResult = await database.all<{ iso: number }>(sql`
		SELECT DISTINCT ${photoExif.iso} as iso
		FROM ${photoExif}
		INNER JOIN ${photosTable} ON ${photosTable.id} = ${photoExif.photoId}
		WHERE ${photoExif.iso} IS NOT NULL${folderCondition}
		ORDER BY iso
	`);
	const datesResult = await database.all<{ month: string }>(sql`
		SELECT DISTINCT ${dateMonthExpression} as month
		FROM ${photoExif}
		INNER JOIN ${photosTable} ON ${photosTable.id} = ${photoExif.photoId}
		WHERE ${photoExif.dateTaken} IS NOT NULL${folderCondition}
		ORDER BY month
	`);

	return {
		cameras: camerasResult.map(({ camera }) => camera),
		lenses: lensesResult.map(({ lens }) => lens),
		isos: isosResult.map(({ iso }) => iso),
		dates: datesResult.map(({ month }) => month),
	};
}

export async function listPhotos(
	database: ApiDatabase,
	input: PhotoFilters = {},
	representation: PhotoCatalogRepresentation = {},
) {
	const folder = input.folder;
	const conditions = [];
	const dateMonthExpression = representation.normalizeDateMonths
		? sql`replace(substr(photo_exif.date_taken, 1, 7), ':', '-')`
		: sql`substr(photo_exif.date_taken, 1, 7)`;
	if (input.filterRaw === "raw") {
		conditions.push(eq(photosTable.isRaw, true));
	} else if (input.filterRaw === "standard") {
		conditions.push(eq(photosTable.isRaw, false));
	}
	if (folder) {
		conditions.push(like(photosTable.path, `${folder}/%`));
	}
	if (input.camera) {
		conditions.push(sql`EXISTS (SELECT 1 FROM photo_exif WHERE photo_exif.photo_id = photos.id AND (
			CASE WHEN photo_exif.camera_model LIKE photo_exif.camera_make || '%'
				THEN photo_exif.camera_model
				ELSE photo_exif.camera_make || ' ' || photo_exif.camera_model
			END = ${input.camera}
		))`);
	}
	if (input.lens) {
		conditions.push(
			sql`EXISTS (SELECT 1 FROM photo_exif WHERE photo_exif.photo_id = photos.id AND photo_exif.lens_model = ${input.lens})`,
		);
	}
	if (input.iso) {
		conditions.push(
			sql`EXISTS (SELECT 1 FROM photo_exif WHERE photo_exif.photo_id = photos.id AND photo_exif.iso = ${input.iso})`,
		);
	}
	if (input.dateMonth) {
		conditions.push(
			sql`EXISTS (SELECT 1 FROM photo_exif WHERE photo_exif.photo_id = photos.id AND ${dateMonthExpression} = ${input.dateMonth})`,
		);
	}

	const photos = await database.query.photos.findMany({
		columns: publicPhotoColumns,
		where:
			conditions.length > 0
				? sql`${sql.join(conditions, sql` AND `)}`
				: undefined,
		with: { exif: true },
	});
	const directPhotos = folder
		? photos.filter((photo) => {
				const relativePath = photo.path.substring(folder.length + 1);
				return !relativePath.includes("/");
			})
		: photos;

	return {
		photos: directPhotos,
		total: directPhotos.length,
		rawCount: directPhotos.filter((photo) => photo.isRaw).length,
	};
}

export async function getPhoto(database: ApiDatabase, id: number) {
	return database.query.photos.findFirst({
		columns: publicPhotoColumns,
		where: (photos, operators) => operators.eq(photos.id, id),
		with: { exif: true },
	});
}
