import "maplibre-gl/dist/maplibre-gl.css";
import { Loader2, MapPin } from "lucide-react";
import type {
	GeoJSONSource,
	LngLatBoundsLike,
	Map as MapLibreMap,
} from "maplibre-gl";
import * as maplibregl from "maplibre-gl";
// Vite bundles MapLibre's module worker and serves it from our own origin.
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { config } from "@/lib/config";
import {
	locationInBounds,
	normalizeViewportBounds,
	PHOTO_FOCUS_ZOOM,
} from "@/lib/map";
import type { PhotoBounds, PhotoLocation } from "@/lib/types";

maplibregl.setWorkerUrl(workerUrl);

declare global {
	interface Window {
		/** Development-only handle for Playwright to project coordinates. */
		__PHOTOBRAIN_MAP__?: MapLibreMap;
	}
}

const SOURCE_ID = "photo-locations";
const CLUSTER_LAYER = "photo-clusters";
const POINT_LAYER = "photo-points";
const FIT_PADDING = 48;
// Colors match the app's primary accent (hsl(210 100% 45-50%)).
const ACCENT = "#0073e6";
const OUTLINE = "#ffffff";

/** A photo the map should center on instead of fitting every point. */
export interface MapFocus {
	photoId: number;
	latitude: number;
	longitude: number;
}

interface MapViewProps {
	/** Locations for the current library scope; undefined while loading. */
	points: PhotoLocation[] | undefined;
	error: { message: string } | null;
	/** Changes whenever the scope changes; the map refits to the new points. */
	fitKey: string;
	/** Centered/zoomed once instead of the next fit; then `onFocusApplied`. */
	focus: MapFocus | null;
	onFocusApplied: () => void;
	onPointClick: (photoId: number) => void;
	/** "Show N photos in this area": the viewport as an API `bounds` filter. */
	onShowArea: (bounds: PhotoBounds) => void;
}

function toGeoJson(points: PhotoLocation[]): GeoJSON.FeatureCollection {
	return {
		type: "FeatureCollection",
		features: points.map((point) => ({
			type: "Feature",
			properties: { id: point.id },
			geometry: {
				type: "Point",
				coordinates: [point.longitude, point.latitude],
			},
		})),
	};
}

function pointsBounds(points: PhotoLocation[]): LngLatBoundsLike {
	let west = 180;
	let south = 90;
	let east = -180;
	let north = -90;
	for (const { latitude, longitude } of points) {
		west = Math.min(west, longitude);
		east = Math.max(east, longitude);
		south = Math.min(south, latitude);
		north = Math.max(north, latitude);
	}
	return [west, south, east, north];
}

function viewportBounds(map: MapLibreMap): PhotoBounds {
	const bounds = map.getBounds();
	return normalizeViewportBounds({
		north: bounds.getNorth(),
		south: bounds.getSouth(),
		east: bounds.getEast(),
		west: bounds.getWest(),
	});
}

/**
 * Geotagged photos on a MapLibre map: a clustered GeoJSON source with
 * cluster circles (counts as DOM labels, so no style glyphs are required)
 * and small point circles. Clicking a cluster zooms to its expansion zoom;
 * clicking a point opens that photo.
 */
export default function MapView({
	points,
	error,
	fitKey,
	focus,
	onFocusApplied,
	onPointClick,
	onShowArea,
}: MapViewProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const mapRef = useRef<MapLibreMap | null>(null);
	const [ready, setReady] = useState(false);
	const [mapError, setMapError] = useState<string | null>(null);
	const [viewport, setViewport] = useState<PhotoBounds | null>(null);
	const fittedKey = useRef<string | null>(null);
	// DOM count labels per rendered cluster ID; cleared whenever data changes
	// because MapLibre reuses cluster IDs across `setData` calls.
	const clusterLabels = useRef(new Map<number, maplibregl.Marker>());
	const pointClick = useRef(onPointClick);
	pointClick.current = onPointClick;

	const empty = points !== undefined && points.length === 0;
	const showMap = !empty && !error && !mapError;

	// Create the map while it is shown (empty/error states unmount it).
	useEffect(() => {
		const container = containerRef.current;
		if (!container || !showMap) return;
		let map: MapLibreMap;
		try {
			map = new maplibregl.Map({
				container,
				style: config.MAP_STYLE_URL,
				center: [0, 20],
				zoom: 1,
				attributionControl: { compact: true },
				dragRotate: false,
				pitchWithRotate: false,
				touchPitch: false,
			});
		} catch (createError) {
			// Typically no WebGL in this browser.
			setMapError(
				createError instanceof Error
					? createError.message
					: String(createError),
			);
			return;
		}
		mapRef.current = map;
		if (import.meta.env.DEV) window.__PHOTOBRAIN_MAP__ = map;
		map.addControl(
			new maplibregl.NavigationControl({ showCompass: false }),
			"top-right",
		);

		const labels = clusterLabels.current;
		const syncClusterLabels = () => {
			if (!map.getLayer(CLUSTER_LAYER) || !map.isSourceLoaded(SOURCE_ID)) {
				return;
			}
			const seen = new Set<number>();
			// Only clusters drawn now: source features also include other zooms.
			for (const feature of map.queryRenderedFeatures({
				layers: [CLUSTER_LAYER],
			})) {
				const props = feature.properties;
				if (feature.geometry.type !== "Point") continue;
				const clusterId = Number(props.cluster_id);
				if (seen.has(clusterId)) continue;
				seen.add(clusterId);
				if (labels.has(clusterId)) continue;
				const element = document.createElement("div");
				element.className =
					"pointer-events-none text-xs font-semibold text-white";
				element.dataset.testid = "map-cluster-count";
				element.textContent = String(props.point_count);
				const [lng, lat] = feature.geometry.coordinates;
				labels.set(
					clusterId,
					new maplibregl.Marker({ element }).setLngLat([lng, lat]).addTo(map),
				);
			}
			for (const [clusterId, marker] of labels) {
				if (!seen.has(clusterId)) {
					marker.remove();
					labels.delete(clusterId);
				}
			}
		};

		map.on("error", (event) => {
			// Before the style loads nothing can render; afterwards (e.g. a
			// failed tile) the map stays usable.
			if (!map.loaded()) setMapError(event.error?.message ?? "Map error");
		});
		map.on("load", () => {
			map.addSource(SOURCE_ID, {
				type: "geojson",
				data: toGeoJson([]),
				cluster: true,
				clusterRadius: 50,
				clusterMaxZoom: 16,
			});
			map.addLayer({
				id: CLUSTER_LAYER,
				type: "circle",
				source: SOURCE_ID,
				filter: ["has", "point_count"],
				paint: {
					"circle-color": ACCENT,
					"circle-opacity": 0.85,
					"circle-radius": [
						"step",
						["get", "point_count"],
						14,
						10,
						18,
						100,
						24,
						1000,
						30,
					],
					"circle-stroke-color": OUTLINE,
					"circle-stroke-width": 2,
				},
			});
			map.addLayer({
				id: POINT_LAYER,
				type: "circle",
				source: SOURCE_ID,
				filter: ["!", ["has", "point_count"]],
				paint: {
					"circle-color": ACCENT,
					"circle-radius": 6,
					"circle-stroke-color": OUTLINE,
					"circle-stroke-width": 2,
				},
			});
			map.on("click", CLUSTER_LAYER, (event) => {
				const feature = event.features?.[0];
				if (!feature || feature.geometry.type !== "Point") return;
				const center = feature.geometry.coordinates as [number, number];
				const source = map.getSource<GeoJSONSource>(SOURCE_ID);
				void source
					?.getClusterExpansionZoom(Number(feature.properties.cluster_id))
					.then((zoom) => map.easeTo({ center, zoom }));
			});
			map.on("click", POINT_LAYER, (event) => {
				const id = Number(event.features?.[0]?.properties.id);
				if (Number.isInteger(id)) pointClick.current(id);
			});
			for (const layer of [CLUSTER_LAYER, POINT_LAYER]) {
				map.on("mouseenter", layer, () => {
					map.getCanvas().style.cursor = "pointer";
				});
				map.on("mouseleave", layer, () => {
					map.getCanvas().style.cursor = "";
				});
			}
			map.on("render", syncClusterLabels);
			setReady(true);
		});
		map.on("moveend", () => setViewport(viewportBounds(map)));

		return () => {
			for (const marker of labels.values()) marker.remove();
			labels.clear();
			map.remove();
			mapRef.current = null;
			fittedKey.current = null;
			if (window.__PHOTOBRAIN_MAP__ === map) delete window.__PHOTOBRAIN_MAP__;
			setReady(false);
		};
	}, [showMap]);

	// Push new points into the source; fit to them (or center on the focus).
	useEffect(() => {
		const map = mapRef.current;
		if (!ready || !map || points === undefined) return;
		for (const marker of clusterLabels.current.values()) marker.remove();
		clusterLabels.current.clear();
		map.getSource<GeoJSONSource>(SOURCE_ID)?.setData(toGeoJson(points));
		if (focus) {
			map.jumpTo({
				center: [focus.longitude, focus.latitude],
				zoom: PHOTO_FOCUS_ZOOM,
			});
			fittedKey.current = fitKey;
			onFocusApplied();
		} else if (fittedKey.current !== fitKey && points.length > 0) {
			fittedKey.current = fitKey;
			if (points.length === 1) {
				map.jumpTo({
					center: [points[0].longitude, points[0].latitude],
					zoom: PHOTO_FOCUS_ZOOM,
				});
			} else {
				map.fitBounds(pointsBounds(points), {
					padding: FIT_PADDING,
					maxZoom: PHOTO_FOCUS_ZOOM,
					duration: 0,
				});
			}
		}
		setViewport(viewportBounds(map));
	}, [ready, points, fitKey, focus, onFocusApplied]);

	const areaCount = useMemo(
		() =>
			viewport && points
				? points.filter((point) => locationInBounds(point, viewport)).length
				: 0,
		[points, viewport],
	);

	if (error || mapError) {
		return (
			<div
				data-testid="map-error"
				className="flex h-full items-center justify-center px-6"
			>
				<p className="text-sm text-destructive">
					Map unavailable: {mapError ?? error?.message}
				</p>
			</div>
		);
	}

	if (empty) {
		return (
			<div
				data-testid="map-empty"
				className="flex h-full flex-col items-center justify-center text-muted-foreground"
			>
				<MapPin className="mb-4 h-16 w-16 opacity-20" />
				<p className="text-sm font-medium">No geotagged photos</p>
				<p className="mt-1 text-xs">
					Photos with GPS coordinates in their EXIF appear here.
				</p>
			</div>
		);
	}

	return (
		<div className="relative h-full w-full">
			<div
				ref={containerRef}
				data-testid="map-view"
				// MapLibre adds `position: relative`, so size it explicitly.
				className="h-full w-full"
			/>
			<div className="pointer-events-none absolute left-3 top-3 flex items-center gap-2">
				<span
					data-testid="map-summary"
					className="rounded bg-background/90 px-2 py-1 text-xs shadow"
				>
					{points === undefined ? (
						<Loader2 className="h-3.5 w-3.5 animate-spin" />
					) : (
						`${points.length} ${points.length === 1 ? "photo" : "photos"} on map`
					)}
				</span>
			</div>
			{points !== undefined && (
				<div className="absolute bottom-8 left-1/2 -translate-x-1/2">
					<Button
						size="sm"
						className="shadow"
						disabled={areaCount === 0}
						onClick={() => {
							const map = mapRef.current;
							if (map) onShowArea(viewportBounds(map));
						}}
					>
						Show {areaCount} {areaCount === 1 ? "photo" : "photos"} in this area
					</Button>
				</div>
			)}
		</div>
	);
}
