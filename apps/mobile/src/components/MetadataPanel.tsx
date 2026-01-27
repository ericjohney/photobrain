import { Ionicons } from "@expo/vector-icons";
import type { AppRouter } from "@photobrain/api";
import { formatDate, formatFileSize } from "@photobrain/utils";
import type { inferRouterOutputs } from "@trpc/server";
import { Image } from "expo-image";
import type React from "react";
import { useCallback, useState } from "react";
import {
	Modal,
	Pressable,
	ScrollView,
	StyleSheet,
	Text,
	View,
} from "react-native";
import { useColors } from "@/theme";

type RouterOutputs = inferRouterOutputs<AppRouter>;
type PhotoMetadata = RouterOutputs["photos"]["photos"][number];

interface MetadataPanelProps {
	visible: boolean;
	photo: PhotoMetadata | null;
	apiUrl: string;
	onClose: () => void;
}

interface SectionProps {
	title: string;
	icon: keyof typeof Ionicons.glyphMap;
	children: React.ReactNode;
	defaultOpen?: boolean;
}

function CollapsibleSection({
	title,
	icon,
	children,
	defaultOpen = true,
}: SectionProps) {
	const colors = useColors();
	const [isOpen, setIsOpen] = useState(defaultOpen);

	return (
		<View style={[styles.section, { borderBottomColor: colors.border }]}>
			<Pressable
				style={styles.sectionHeader}
				onPress={() => setIsOpen(!isOpen)}
			>
				<View style={styles.sectionHeaderLeft}>
					<Ionicons name={icon} size={16} color={colors.mutedForeground} />
					<Text style={[styles.sectionTitle, { color: colors.foreground }]}>
						{title}
					</Text>
				</View>
				<Ionicons
					name={isOpen ? "chevron-up" : "chevron-down"}
					size={20}
					color={colors.mutedForeground}
				/>
			</Pressable>
			{isOpen && <View style={styles.sectionContent}>{children}</View>}
		</View>
	);
}

interface MetadataRowProps {
	label: string;
	value: string | number | null | undefined;
}

function MetadataRow({ label, value }: MetadataRowProps) {
	const colors = useColors();
	if (value === null || value === undefined || value === "") return null;

	return (
		<View style={styles.row}>
			<Text style={[styles.rowLabel, { color: colors.mutedForeground }]}>
				{label}
			</Text>
			<Text
				style={[styles.rowValue, { color: colors.foreground }]}
				numberOfLines={1}
			>
				{value}
			</Text>
		</View>
	);
}

export default function MetadataPanel({
	visible,
	photo,
	apiUrl,
	onClose,
}: MetadataPanelProps) {
	const colors = useColors();

	if (!photo) return null;

	const exif = photo.exif;

	// Format camera info
	const cameraInfo = [exif?.cameraMake, exif?.cameraModel]
		.filter(Boolean)
		.join(" ");

	const lensInfo = [exif?.lensMake, exif?.lensModel].filter(Boolean).join(" ");

	// Format exposure info
	const focalLength = exif?.focalLength ? `${exif.focalLength}mm` : null;
	const aperture = exif?.aperture ? `f/${exif.aperture}` : null;
	const iso = exif?.iso ? `ISO ${exif.iso}` : null;
	const shutterSpeed = exif?.shutterSpeed || null;

	// GPS info
	const hasGps = exif?.gpsLatitude && exif?.gpsLongitude;
	const gpsCoords = hasGps ? `${exif.gpsLatitude}, ${exif.gpsLongitude}` : null;

	return (
		<Modal
			visible={visible}
			animationType="slide"
			presentationStyle="pageSheet"
			onRequestClose={onClose}
		>
			<View style={[styles.container, { backgroundColor: colors.background }]}>
				{/* Header */}
				<View style={[styles.header, { backgroundColor: colors.toolbar }]}>
					<Text style={[styles.headerTitle, { color: colors.foreground }]}>
						Photo Info
					</Text>
					<Pressable onPress={onClose} style={styles.closeButton}>
						<Ionicons name="close" size={24} color={colors.foreground} />
					</Pressable>
				</View>

				<ScrollView style={styles.content}>
					{/* Preview thumbnail */}
					<View
						style={[styles.previewContainer, { backgroundColor: colors.muted }]}
					>
						<Image
							source={{
								uri: `${apiUrl}/api/photos/${photo.id}/thumbnail/small`,
							}}
							style={styles.preview}
							contentFit="contain"
							cachePolicy="memory-disk"
						/>
					</View>

					{/* File Info */}
					<CollapsibleSection title="File" icon="document-outline">
						<MetadataRow label="Name" value={photo.name} />
						<MetadataRow label="Size" value={formatFileSize(photo.size)} />
						{photo.width && photo.height && (
							<MetadataRow
								label="Dimensions"
								value={`${photo.width} x ${photo.height}`}
							/>
						)}
						<MetadataRow label="Type" value={photo.mimeType} />
						<MetadataRow
							label="Modified"
							value={formatDate(photo.modifiedAt)}
						/>
					</CollapsibleSection>

					{/* RAW Info */}
					{photo.isRaw && (
						<CollapsibleSection title="RAW" icon="camera-outline">
							<MetadataRow label="Format" value={photo.rawFormat} />
							<MetadataRow
								label="Status"
								value={
									photo.rawStatus === "converted"
										? "Converted"
										: photo.rawStatus === "failed"
											? "Failed"
											: photo.rawStatus === "no_converter"
												? "No Converter"
												: "Pending"
								}
							/>
							{photo.rawError && (
								<View style={styles.errorRow}>
									<Text
										style={[styles.errorText, { color: colors.destructive }]}
									>
										{photo.rawError}
									</Text>
								</View>
							)}
						</CollapsibleSection>
					)}

					{/* Camera Info */}
					{(cameraInfo || lensInfo) && (
						<CollapsibleSection title="Camera" icon="aperture-outline">
							<MetadataRow label="Camera" value={cameraInfo} />
							<MetadataRow label="Lens" value={lensInfo} />
						</CollapsibleSection>
					)}

					{/* Exposure Settings */}
					{(focalLength || aperture || shutterSpeed || iso) && (
						<CollapsibleSection title="Settings" icon="options-outline">
							<MetadataRow label="Focal Length" value={focalLength} />
							<MetadataRow label="Aperture" value={aperture} />
							<MetadataRow label="Shutter" value={shutterSpeed} />
							<MetadataRow label="ISO" value={iso} />
							<MetadataRow label="Exposure Bias" value={exif?.exposureBias} />
						</CollapsibleSection>
					)}

					{/* Date Info */}
					{exif?.dateTaken && (
						<CollapsibleSection title="Date" icon="calendar-outline">
							<MetadataRow label="Taken" value={exif.dateTaken} />
						</CollapsibleSection>
					)}

					{/* Location Info */}
					{hasGps && (
						<CollapsibleSection
							title="Location"
							icon="location-outline"
							defaultOpen={false}
						>
							<MetadataRow label="Coordinates" value={gpsCoords} />
							<MetadataRow label="Altitude" value={exif?.gpsAltitude} />
						</CollapsibleSection>
					)}
				</ScrollView>
			</View>
		</Modal>
	);
}

const styles = StyleSheet.create({
	container: {
		flex: 1,
	},
	header: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		paddingTop: 16,
		paddingBottom: 16,
		paddingHorizontal: 16,
	},
	headerTitle: {
		fontSize: 18,
		fontWeight: "600",
	},
	closeButton: {
		padding: 4,
	},
	content: {
		flex: 1,
	},
	previewContainer: {
		height: 200,
		margin: 16,
		borderRadius: 8,
		overflow: "hidden",
	},
	preview: {
		width: "100%",
		height: "100%",
	},
	section: {
		borderBottomWidth: 1,
	},
	sectionHeader: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		paddingVertical: 12,
		paddingHorizontal: 16,
	},
	sectionHeaderLeft: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
	},
	sectionTitle: {
		fontSize: 14,
		fontWeight: "600",
		textTransform: "uppercase",
		letterSpacing: 0.5,
	},
	sectionContent: {
		paddingHorizontal: 16,
		paddingBottom: 12,
	},
	row: {
		flexDirection: "row",
		justifyContent: "space-between",
		paddingVertical: 6,
		gap: 12,
	},
	rowLabel: {
		fontSize: 14,
		flexShrink: 0,
	},
	rowValue: {
		fontSize: 14,
		fontWeight: "500",
		textAlign: "right",
		flex: 1,
	},
	errorRow: {
		paddingVertical: 6,
	},
	errorText: {
		fontSize: 13,
	},
});
