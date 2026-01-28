const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

// Watch all files in the monorepo so workspace packages resolve
config.watchFolders = [monorepoRoot];

// Resolve packages from both the app's node_modules and the monorepo root
config.resolver.nodeModulesPaths = [
	path.resolve(projectRoot, "node_modules"),
	path.resolve(monorepoRoot, "node_modules"),
];

// Stub out native-only packages that cannot be bundled for web/Metro
config.resolver.resolveRequest = (context, moduleName, platform) => {
	if (moduleName === "@photobrain/image-processing") {
		return {
			filePath: path.resolve(
				monorepoRoot,
				"packages/image-processing/browser.js",
			),
			type: "sourceFile",
		};
	}
	return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
