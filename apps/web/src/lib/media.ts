/** Whole seconds of a duration; unknown (null), negative, or non-finite is 0. */
function durationParts(ms: number | null) {
	const totalSeconds =
		ms !== null && Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
	return {
		hours: Math.floor(totalSeconds / 3600),
		minutes: Math.floor((totalSeconds % 3600) / 60),
		seconds: totalSeconds % 60,
	};
}

/**
 * A video's duration badge text: `m:ss`, or `h:mm:ss` from one hour, floored
 * to whole seconds (59.9 s is `0:59`). Null or negative shows `0:00`.
 */
export function formatDuration(ms: number | null): string {
	const { hours, minutes, seconds } = durationParts(ms);
	const ss = String(seconds).padStart(2, "0");
	return hours > 0
		? `${hours}:${String(minutes).padStart(2, "0")}:${ss}`
		: `${minutes}:${ss}`;
}

/**
 * A video tile's accessible label: `Video, 1 minute 5 seconds`, omitting zero
 * components; `Video` alone when the duration is unknown or under a second.
 */
export function videoLabel(ms: number | null): string {
	const { hours, minutes, seconds } = durationParts(ms);
	const parts = (
		[
			[hours, "hour"],
			[minutes, "minute"],
			[seconds, "second"],
		] as const
	)
		.filter(([value]) => value > 0)
		.map(([value, unit]) => `${value} ${unit}${value === 1 ? "" : "s"}`);
	return parts.length > 0 ? `Video, ${parts.join(" ")}` : "Video";
}
