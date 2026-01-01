import { ImageIcon } from "lucide-react";
import { useState } from "react";
import { Card } from "@/components/ui/card";
import type { PhotoMetadata } from "@photobrain/api-client";
import { formatFileSize } from "@photobrain/utils";

interface PhotoGridProps {
	photos: PhotoMetadata[];
}

export function PhotoGrid({ photos }: PhotoGridProps) {
	const [selectedPhoto, setSelectedPhoto] = useState<PhotoMetadata | null>(
		null,
	);

	const getImageUrl = (photo: PhotoMetadata) => {
		const apiUrl = import.meta.env.VITE_API_URL || "http://localhost:3000";
		return `${apiUrl}/api/photos/${photo.id}/file`;
	};

	return (
		<>
			<div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-4">
				{photos.map((photo) => (
					<Card
						key={photo.id}
						className="group relative overflow-hidden cursor-pointer transition-all hover:shadow-lg hover:scale-[1.02]"
						onClick={() => setSelectedPhoto(photo)}
					>
						<div className="aspect-square relative bg-muted">
							<img
								src={getImageUrl(photo)}
								alt={photo.name}
								className="w-full h-full object-cover"
								loading="lazy"
							/>
							<div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors" />
						</div>
						<div className="p-2 bg-card">
							<p className="text-xs font-medium truncate" title={photo.name}>
								{photo.name}
							</p>
							<p className="text-xs text-muted-foreground">
								{formatFileSize(photo.size)}
							</p>
						</div>
					</Card>
				))}
			</div>

			{photos.length === 0 && (
				<div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
					<ImageIcon className="w-16 h-16 mb-4 opacity-20" />
					<p className="text-lg font-medium">No photos found</p>
					<p className="text-sm">
						Try adjusting your search or add some photos
					</p>
				</div>
			)}

			{selectedPhoto && (
				<div
					className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
					onClick={() => setSelectedPhoto(null)}
				>
					<div
						className="relative max-w-7xl max-h-[90vh]"
						onClick={(e) => e.stopPropagation()}
					>
						<img
							src={getImageUrl(selectedPhoto)}
							alt={selectedPhoto.name}
							className="max-w-full max-h-[90vh] object-contain rounded-lg"
						/>
						<div className="absolute bottom-0 left-0 right-0 bg-black/70 text-white p-4 rounded-b-lg">
							<p className="font-medium">{selectedPhoto.name}</p>
							<p className="text-sm text-gray-300">
								{formatFileSize(selectedPhoto.size)} •{" "}
								{new Date(selectedPhoto.modifiedAt).toLocaleDateString()}
							</p>
						</div>
						<button
							onClick={() => setSelectedPhoto(null)}
							className="absolute top-4 right-4 bg-black/50 hover:bg-black/70 text-white rounded-full p-2 transition-colors"
						>
							<svg
								xmlns="http://www.w3.org/2000/svg"
								width="24"
								height="24"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
								strokeLinecap="round"
								strokeLinejoin="round"
							>
								<line x1="18" y1="6" x2="6" y2="18"></line>
								<line x1="6" y1="6" x2="18" y2="18"></line>
							</svg>
						</button>
					</div>
				</div>
			)}
		</>
	);
}
