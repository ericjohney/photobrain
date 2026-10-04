import { BarChart3, Loader2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import {
	barPercent,
	GEAR_LIST_PREVIEW_LIMIT,
	gearCountLabel,
	gearSummary,
	OTHER_CAMERAS_LABEL,
	photoCountLabel,
	previewGearCounts,
	shotsPerYear,
} from "@/lib/gear-stats";
import type { GearBucket, GearCount, GearStats } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Segment colors by camera rank; "Other" uses the muted color. */
const CAMERA_COLORS = [
	"bg-sky-500",
	"bg-emerald-500",
	"bg-amber-500",
	"bg-fuchsia-500",
	"bg-rose-500",
];
const OTHER_COLOR = "bg-muted-foreground/50";

function Section({
	title,
	testId,
	className,
	children,
}: {
	title: string;
	testId: string;
	className?: string;
	children: ReactNode;
}) {
	return (
		<section
			data-testid={testId}
			aria-label={title}
			className={cn("rounded-md border border-border bg-panel p-3", className)}
		>
			<h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				{title}
			</h3>
			{children}
		</section>
	);
}

/**
 * Horizontal bar list (API order: count desc, label asc), top
 * GEAR_LIST_PREVIEW_LIMIT then "Show all". Clicking a row applies its filter.
 */
function GearCountList({
	entries,
	emptyText,
	onSelect,
}: {
	entries: readonly GearCount[];
	emptyText: string;
	onSelect: (label: string) => void;
}) {
	const [showAll, setShowAll] = useState(false);
	if (entries.length === 0) {
		return <p className="text-xs text-muted-foreground">{emptyText}</p>;
	}
	const max = entries[0].count;
	return (
		<>
			<ul className="space-y-0.5">
				{previewGearCounts(entries, showAll).map((entry) => (
					<li key={entry.label}>
						<button
							type="button"
							data-testid="gear-count-row"
							aria-label={gearCountLabel(entry)}
							title={gearCountLabel(entry)}
							onClick={() => onSelect(entry.label)}
							className="group grid w-full grid-cols-[minmax(0,10rem)_1fr_auto] items-center gap-2 rounded px-1.5 py-1 text-left text-xs hover:bg-secondary/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
						>
							<span className="truncate group-hover:text-foreground">
								{entry.label}
							</span>
							<span className="h-2 overflow-hidden rounded-sm bg-secondary">
								<span
									className="block h-full rounded-sm bg-primary/80 group-hover:bg-primary"
									style={{ width: `${barPercent(entry.count, max)}%` }}
								/>
							</span>
							<span className="tabular-nums text-muted-foreground">
								{entry.count.toLocaleString("en-US")}
							</span>
						</button>
					</li>
				))}
			</ul>
			{entries.length > GEAR_LIST_PREVIEW_LIMIT && (
				<button
					type="button"
					onClick={() => setShowAll((current) => !current)}
					className="mt-1 w-full rounded px-1.5 py-1 text-left text-xs text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
				>
					{showAll ? "Show fewer" : `Show all (${entries.length})`}
				</button>
			)}
		</>
	);
}

/** Vertical bars in the API's fixed bucket order, zero buckets included. */
function Histogram({ buckets }: { buckets: readonly GearBucket[] }) {
	const max = Math.max(0, ...buckets.map((bucket) => bucket.count));
	return (
		<ul className="flex h-36 items-stretch gap-1">
			{buckets.map((bucket) => (
				<li
					key={bucket.label}
					role="img"
					data-testid="gear-bucket"
					data-count={bucket.count}
					aria-label={gearCountLabel(bucket)}
					title={gearCountLabel(bucket)}
					className="group flex min-w-0 flex-1 flex-col items-center gap-1"
				>
					<span className="text-2xs tabular-nums text-muted-foreground">
						{bucket.count.toLocaleString("en-US")}
					</span>
					<span className="flex w-full flex-1 items-end rounded-sm bg-secondary/60">
						<span
							className="block w-full rounded-sm bg-primary/80 group-hover:bg-primary"
							style={{ height: `${barPercent(bucket.count, max)}%` }}
						/>
					</span>
					<span className="w-full truncate text-center text-2xs text-muted-foreground">
						{bucket.label}
					</span>
				</li>
			))}
		</ul>
	);
}

/** Per year: total and a bar segmented by the top cameras plus "Other". */
function ShotsPerYearChart({ stats }: { stats: GearStats }) {
	const { cameras, hasOther, years } = shotsPerYear(stats.cameraYears);
	if (years.length === 0) {
		return (
			<p className="text-xs text-muted-foreground">No dated camera data</p>
		);
	}
	const max = Math.max(...years.map((year) => year.total));
	const legend = [
		...cameras.map((camera, index) => ({
			label: camera,
			color: CAMERA_COLORS[index],
		})),
		...(hasOther ? [{ label: OTHER_CAMERAS_LABEL, color: OTHER_COLOR }] : []),
	];
	return (
		<>
			<ul
				data-testid="shots-per-year-legend"
				className="mb-2 flex flex-wrap gap-x-3 gap-y-1 text-2xs text-muted-foreground"
			>
				{legend.map(({ label, color }) => (
					<li key={label} className="flex items-center gap-1">
						<span className={cn("h-2 w-2 rounded-sm", color)} />
						{label}
					</li>
				))}
			</ul>
			<ul className="space-y-1">
				{years.map((year) => (
					<li
						key={year.year}
						data-testid="shots-per-year-row"
						data-year={year.year}
						className="grid grid-cols-[3rem_1fr_auto] items-center gap-2 text-xs"
					>
						<span className="tabular-nums">{year.year}</span>
						<span className="flex h-3 overflow-hidden rounded-sm bg-secondary">
							<span
								className="flex h-full"
								style={{ width: `${barPercent(year.total, max)}%` }}
							>
								{year.segments.map((segment) => {
									const label = gearCountLabel({
										label: segment.camera ?? OTHER_CAMERAS_LABEL,
										count: segment.count,
									});
									return (
										<span
											key={segment.camera ?? OTHER_CAMERAS_LABEL}
											role="img"
											data-testid="shots-per-year-segment"
											aria-label={label}
											title={label}
											className={cn(
												"block h-full",
												segment.camera === null
													? OTHER_COLOR
													: CAMERA_COLORS[cameras.indexOf(segment.camera)],
											)}
											style={{
												width: `${(segment.count / year.total) * 100}%`,
											}}
										/>
									);
								})}
							</span>
						</span>
						<span
							data-testid="shots-per-year-total"
							className="tabular-nums text-muted-foreground"
						>
							{photoCountLabel(year.total)}
						</span>
					</li>
				))}
			</ul>
		</>
	);
}

/**
 * Gear statistics over the library grid's photo set (same filters): cameras,
 * lenses, exposure histograms, and shots per year.
 */
export function GearStatsView({
	stats,
	error,
	onCameraSelect,
	onLensSelect,
}: {
	stats: GearStats | undefined;
	error: { message: string } | null;
	onCameraSelect: (camera: string) => void;
	onLensSelect: (lens: string) => void;
}) {
	if (error) {
		return (
			<div className="flex h-full items-center justify-center">
				<div className="rounded-lg border border-destructive/20 bg-destructive/10 px-6 py-4 text-destructive">
					<p className="font-medium">Error loading gear stats</p>
					<p className="text-sm">{error.message}</p>
				</div>
			</div>
		);
	}
	if (!stats) {
		return (
			<div className="flex h-full flex-col items-center justify-center">
				<Loader2 className="mb-3 h-10 w-10 animate-spin text-primary" />
				<p className="text-sm text-muted-foreground">Loading gear stats...</p>
			</div>
		);
	}
	if (stats.total === 0) {
		return (
			<div
				data-testid="gear-stats-empty"
				className="flex h-full flex-col items-center justify-center text-muted-foreground"
			>
				<BarChart3 className="mb-4 h-16 w-16 opacity-20" />
				<p className="text-sm font-medium">No photos match these filters</p>
			</div>
		);
	}
	return (
		<div data-testid="gear-stats" className="h-full overflow-auto p-3">
			<h2
				data-testid="gear-stats-summary"
				className="mb-3 flex items-center gap-1.5 text-sm font-medium"
			>
				<BarChart3 className="h-4 w-4 text-muted-foreground" />
				{gearSummary(stats)}
			</h2>
			<div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
				<Section title="Cameras" testId="gear-cameras">
					<GearCountList
						entries={stats.cameras}
						emptyText="No camera data"
						onSelect={onCameraSelect}
					/>
				</Section>
				<Section title="Lenses" testId="gear-lenses">
					<GearCountList
						entries={stats.lenses}
						emptyText="No lens data"
						onSelect={onLensSelect}
					/>
				</Section>
				<Section title="Focal length" testId="gear-focal-lengths">
					<Histogram buckets={stats.focalLengths} />
				</Section>
				<Section title="Aperture" testId="gear-apertures">
					<Histogram buckets={stats.apertures} />
				</Section>
				<Section title="Shutter speed" testId="gear-shutter-speeds">
					<Histogram buckets={stats.shutterSpeeds} />
				</Section>
				<Section title="ISO" testId="gear-isos">
					<Histogram buckets={stats.isos} />
				</Section>
				<Section
					title="Shots per year"
					testId="gear-shots-per-year"
					className="xl:col-span-2"
				>
					<ShotsPerYearChart stats={stats} />
				</Section>
			</div>
		</div>
	);
}
