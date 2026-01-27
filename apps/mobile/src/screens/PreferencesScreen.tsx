import { Ionicons } from "@expo/vector-icons";
import type React from "react";
import {
	Pressable,
	ScrollView,
	StyleSheet,
	Switch,
	Text,
	View,
} from "react-native";
import { useColors, useTheme } from "@/theme";

interface SettingRowProps {
	icon: keyof typeof Ionicons.glyphMap;
	label: string;
	description?: string;
	children: React.ReactNode;
}

function SettingRow({ icon, label, description, children }: SettingRowProps) {
	const colors = useColors();

	return (
		<View style={[styles.settingRow, { borderBottomColor: colors.border }]}>
			<View style={styles.settingIcon}>
				<Ionicons name={icon} size={22} color={colors.mutedForeground} />
			</View>
			<View style={styles.settingContent}>
				<Text style={[styles.settingLabel, { color: colors.foreground }]}>
					{label}
				</Text>
				{description && (
					<Text
						style={[
							styles.settingDescription,
							{ color: colors.mutedForeground },
						]}
					>
						{description}
					</Text>
				)}
			</View>
			<View style={styles.settingAction}>{children}</View>
		</View>
	);
}

interface ThemeOptionProps {
	value: "light" | "dark" | "system";
	label: string;
	icon: keyof typeof Ionicons.glyphMap;
	selected: boolean;
	onPress: () => void;
}

function ThemeOption({
	value,
	label,
	icon,
	selected,
	onPress,
}: ThemeOptionProps) {
	const colors = useColors();

	return (
		<Pressable
			onPress={onPress}
			style={[
				styles.themeOption,
				{ backgroundColor: colors.card, borderColor: colors.border },
				selected && {
					borderColor: colors.primary,
					backgroundColor: `${colors.primary}10`,
				},
			]}
		>
			<Ionicons
				name={icon}
				size={24}
				color={selected ? colors.primary : colors.mutedForeground}
			/>
			<Text
				style={[
					styles.themeOptionLabel,
					{ color: selected ? colors.primary : colors.foreground },
				]}
			>
				{label}
			</Text>
			{selected && (
				<Ionicons
					name="checkmark-circle"
					size={20}
					color={colors.primary}
					style={styles.themeOptionCheck}
				/>
			)}
		</Pressable>
	);
}

export default function PreferencesScreen() {
	const colors = useColors();
	const { themePreference, setThemePreference } = useTheme();

	return (
		<ScrollView
			style={[styles.container, { backgroundColor: colors.background }]}
		>
			{/* Appearance Section */}
			<View style={styles.section}>
				<Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>
					APPEARANCE
				</Text>

				<View style={[styles.sectionContent, { backgroundColor: colors.card }]}>
					<View
						style={[styles.themeSelector, { borderBottomColor: colors.border }]}
					>
						<Text
							style={[styles.themeSelectorLabel, { color: colors.foreground }]}
						>
							Theme
						</Text>
						<View style={styles.themeOptions}>
							<ThemeOption
								value="light"
								label="Light"
								icon="sunny"
								selected={themePreference === "light"}
								onPress={() => setThemePreference("light")}
							/>
							<ThemeOption
								value="dark"
								label="Dark"
								icon="moon"
								selected={themePreference === "dark"}
								onPress={() => setThemePreference("dark")}
							/>
							<ThemeOption
								value="system"
								label="System"
								icon="phone-portrait"
								selected={themePreference === "system"}
								onPress={() => setThemePreference("system")}
							/>
						</View>
					</View>
				</View>
			</View>

			{/* Display Section */}
			<View style={styles.section}>
				<Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>
					DISPLAY
				</Text>

				<View style={[styles.sectionContent, { backgroundColor: colors.card }]}>
					<SettingRow
						icon="grid-outline"
						label="Grid Columns"
						description="Number of columns in photo grid"
					>
						<Text
							style={[styles.settingValue, { color: colors.mutedForeground }]}
						>
							3
						</Text>
					</SettingRow>

					<SettingRow
						icon="expand-outline"
						label="Show RAW Badges"
						description="Display RAW format indicator on thumbnails"
					>
						<Switch
							value={true}
							trackColor={{ false: colors.muted, true: colors.primary }}
							thumbColor="#ffffff"
							disabled
						/>
					</SettingRow>
				</View>
			</View>

			{/* Behavior Section */}
			<View style={styles.section}>
				<Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>
					BEHAVIOR
				</Text>

				<View style={[styles.sectionContent, { backgroundColor: colors.card }]}>
					<SettingRow
						icon="hand-left-outline"
						label="Haptic Feedback"
						description="Vibrate on photo selection and navigation"
					>
						<Switch
							value={true}
							trackColor={{ false: colors.muted, true: colors.primary }}
							thumbColor="#ffffff"
							disabled
						/>
					</SettingRow>
				</View>
			</View>

			{/* About Section */}
			<View style={styles.section}>
				<Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>
					ABOUT
				</Text>

				<View style={[styles.sectionContent, { backgroundColor: colors.card }]}>
					<SettingRow icon="information-circle-outline" label="Version">
						<Text
							style={[styles.settingValue, { color: colors.mutedForeground }]}
						>
							0.1.0
						</Text>
					</SettingRow>

					<SettingRow
						icon="logo-github"
						label="Source Code"
						description="View on GitHub"
					>
						<Ionicons
							name="chevron-forward"
							size={20}
							color={colors.mutedForeground}
						/>
					</SettingRow>
				</View>
			</View>
		</ScrollView>
	);
}

const styles = StyleSheet.create({
	container: {
		flex: 1,
	},
	section: {
		marginTop: 24,
	},
	sectionTitle: {
		fontSize: 12,
		fontWeight: "600",
		letterSpacing: 0.5,
		marginLeft: 16,
		marginBottom: 8,
	},
	sectionContent: {
		borderRadius: 12,
		marginHorizontal: 16,
		overflow: "hidden",
	},
	themeSelector: {
		padding: 16,
		borderBottomWidth: 1,
	},
	themeSelectorLabel: {
		fontSize: 16,
		fontWeight: "500",
		marginBottom: 12,
	},
	themeOptions: {
		flexDirection: "row",
		gap: 8,
	},
	themeOption: {
		flex: 1,
		alignItems: "center",
		paddingVertical: 12,
		paddingHorizontal: 8,
		borderRadius: 8,
		borderWidth: 1,
		gap: 6,
	},
	themeOptionLabel: {
		fontSize: 13,
		fontWeight: "500",
	},
	themeOptionCheck: {
		position: "absolute",
		top: 4,
		right: 4,
	},
	settingRow: {
		flexDirection: "row",
		alignItems: "center",
		paddingVertical: 12,
		paddingHorizontal: 16,
		borderBottomWidth: 1,
	},
	settingIcon: {
		width: 32,
		marginRight: 12,
	},
	settingContent: {
		flex: 1,
	},
	settingLabel: {
		fontSize: 16,
	},
	settingDescription: {
		fontSize: 13,
		marginTop: 2,
	},
	settingAction: {
		marginLeft: 12,
	},
	settingValue: {
		fontSize: 16,
	},
});
