import { execFile } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const pendingStatuses = new Set(["NEW", "IN_QUEUE", "IN_PROGRESS"]);
const statuses = new Set([
	...pendingStatuses,
	"FINISHED",
	"ERRORED",
	"CANCELED",
	"PENDING_CANCEL",
]);
const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const pageSize = 50;
const waitLimit = 75 * 60 * 1000;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function commandJson(command, args) {
	let stdout;
	try {
		({ stdout } = await execFileAsync(command, args, {
			maxBuffer: 16 * 1024 * 1024,
			timeout: 10 * 60 * 1000,
			env: { ...process.env, EXPO_NO_DOTENV: "1" },
		}));
	} catch {
		// CLI output can contain credentials, environment values, or fingerprint sources.
		throw new Error(`${args[0]} failed; refusing to release the preview.`);
	}
	try {
		return JSON.parse(stdout);
	} catch {
		throw new Error(`${args[0]} returned invalid JSON.`);
	}
}

function validateBuild(build) {
	const nullableString = (value) => value === null || typeof value === "string";
	if (
		!build ||
		!uuid.test(build.id) ||
		!uuid.test(build.app?.id) ||
		!statuses.has(build.status) ||
		!["IOS", "ANDROID"].includes(build.platform) ||
		typeof build.isForIosSimulator !== "boolean" ||
		!nullableString(build.buildProfile) ||
		![null, "INTERNAL", "STORE", "SIMULATOR"].includes(build.distribution) ||
		!nullableString(build.appIdentifier) ||
		!(build.runtime === null || typeof build.runtime?.version === "string") ||
		!(
			build.updateChannel === null ||
			typeof build.updateChannel?.name === "string"
		) ||
		!(build.artifacts === null || nullableString(build.artifacts?.buildUrl)) ||
		!(
			build.expirationDate === null ||
			(typeof build.expirationDate === "string" &&
				Number.isFinite(Date.parse(build.expirationDate)))
		)
	) {
		throw new Error("EAS returned a malformed build record.");
	}
	return build;
}

function isCompatible(build, target) {
	return (
		build.app.id === target.projectId &&
		build.appIdentifier === target.appIdentifier &&
		build.platform === "IOS" &&
		build.isForIosSimulator === false &&
		build.distribution === "INTERNAL" &&
		build.buildProfile === "preview" &&
		build.updateChannel?.name === "preview" &&
		build.runtime?.version === target.runtimeVersion
	);
}

function isExpired(build, now) {
	return (
		build.expirationDate !== null && Date.parse(build.expirationDate) <= now
	);
}

function hasArtifact(build) {
	if (!build.artifacts?.buildUrl) return false;
	try {
		const url = new URL(build.artifacts.buildUrl);
		if (url.protocol !== "https:" || url.username || url.password) {
			throw new Error("Invalid artifact URL");
		}
		return true;
	} catch {
		throw new Error("EAS returned an invalid build artifact URL.");
	}
}

// EAS build:list returns BuildFragment[], build:view returns BuildFragment, and
// build --json --no-wait returns BuildFragment[]. Runtime compatibility is
// runtime.version, NOT the separate fingerprint.hash/source fingerprint.
export async function ensurePreviewBuild({
	runtimeVersion,
	projectId,
	appIdentifier,
	force = false,
	runEas = (args) => commandJson("eas", args),
	now = Date.now,
	sleep = delay,
}) {
	if (
		!/^[\da-f]{40,64}$/i.test(runtimeVersion) ||
		!uuid.test(projectId) ||
		!appIdentifier
	) {
		throw new Error(
			"Missing or invalid preview runtime/project configuration.",
		);
	}
	const target = { runtimeVersion, projectId, appIdentifier };
	let selected;
	let pending;
	if (!force) {
		for (let offset = 0; ; offset += pageSize) {
			const builds = await runEas([
				"build:list",
				"--platform",
				"ios",
				"--build-profile",
				"preview",
				"--distribution",
				"internal",
				"--channel",
				"preview",
				"--runtime-version",
				runtimeVersion,
				"--limit",
				String(pageSize),
				"--offset",
				String(offset),
				"--json",
				"--non-interactive",
			]);
			if (!Array.isArray(builds) || builds.length > pageSize) {
				throw new Error("EAS returned an invalid build list.");
			}
			for (const build of builds) {
				validateBuild(build);
				if (!isCompatible(build, target) || isExpired(build, now())) continue;
				if (build.status === "FINISHED" && hasArtifact(build))
					selected ??= build;
				if (pendingStatuses.has(build.status)) pending ??= build;
			}
			if (selected || builds.length < pageSize) break;
		}
	}
	let action = selected ? "Reused" : "Awaited existing";
	selected ??= pending;
	if (!selected) {
		action = force ? "Built (manual rebuild)" : "Built";
		const builds = await runEas([
			"build",
			"--platform",
			"ios",
			"--profile",
			"preview",
			"--non-interactive",
			"--no-wait",
			"--json",
			"--message",
			`preview@${(process.env.GITHUB_SHA ?? "local").slice(0, 7)}`,
		]);
		if (!Array.isArray(builds) || builds.length !== 1) {
			throw new Error("EAS did not return exactly one preview build.");
		}
		selected = validateBuild(builds[0]);
	}

	const deadline = now() + waitLimit;
	while (true) {
		const build = validateBuild(
			await runEas(["build:view", selected.id, "--json"]),
		);
		if (
			build.id !== selected.id ||
			!isCompatible(build, target) ||
			isExpired(build, now())
		) {
			throw new Error(
				"Preview build is incompatible or expired; refusing to release.",
			);
		}
		if (build.status === "FINISHED") {
			if (!hasArtifact(build))
				throw new Error("Finished preview build has no installable artifact.");
			return { action, build };
		}
		if (!pendingStatuses.has(build.status)) {
			throw new Error(`Preview build ${build.id} ended with ${build.status}.`);
		}
		if (now() >= deadline)
			throw new Error("Timed out waiting for the preview build.");
		await sleep(30_000);
	}
}

async function main() {
	if (process.argv.slice(2).some((arg) => arg !== "--force")) {
		throw new Error("Only --force is supported (manual native rebuild).");
	}
	const { build: profiles } = JSON.parse(await readFile("eas.json", "utf8"));
	const { expo } = JSON.parse(await readFile("app.json", "utf8"));
	const profile = profiles?.preview;
	if (
		profile?.extends ||
		profile?.environment !== "preview" ||
		profile.channel !== "preview" ||
		profile.distribution !== "internal" ||
		profile.developmentClient !== false ||
		profile.ios?.simulator !== false
	) {
		throw new Error(
			"Expected a physical-device internal preview profile in the preview environment.",
		);
	}
	// The workflow runs this inside `eas env:exec preview`. EAS Update loads that
	// same environment, but does not load eas.json build-profile overrides.
	for (const [name, value] of Object.entries(profile.env ?? {})) {
		if (process.env[name] !== value) {
			throw new Error(
				`Preview environment variable ${name} must match eas.json before releasing.`,
			);
		}
	}
	// This is the exact resolver used by EAS Build and EAS Update for our policy.
	// fingerprint:generate instead returns { hash, sources } and also uploads it.
	const runtime = await commandJson(process.execPath, [
		require.resolve("expo-updates/bin/cli.js"),
		"runtimeversion:resolve",
		"--platform",
		"ios",
		"--workflow",
		"managed",
	]);
	if (
		!Array.isArray(runtime?.fingerprintSources) ||
		!runtime.fingerprintSources.length ||
		runtime.workflow !== "managed"
	) {
		throw new Error("Expected the Expo fingerprint runtime policy for iOS.");
	}
	const { action, build } = await ensurePreviewBuild({
		runtimeVersion: runtime.runtimeVersion,
		projectId: expo.extra?.eas?.projectId,
		appIdentifier: expo.ios?.bundleIdentifier,
		force: process.argv.includes("--force"),
	});
	const account = build.app.ownerAccount?.name;
	const slug = build.app.slug;
	if (
		typeof account !== "string" ||
		!account ||
		typeof slug !== "string" ||
		!slug
	) {
		throw new Error("EAS returned no preview install page.");
	}
	const installUrl = `https://expo.dev/accounts/${encodeURIComponent(account)}/projects/${encodeURIComponent(slug)}/builds/${build.id}`;
	const summary = `### iOS preview\n\n- Native binary: **${action}**\n- Runtime: \`${runtime.runtimeVersion}\`\n- [Install on a registered iPhone](${installUrl})\n`;
	console.log(`${action} iOS preview: ${installUrl}`);
	if (process.env.GITHUB_STEP_SUMMARY)
		await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
}
