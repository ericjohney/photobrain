import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface PanelLayoutProps {
	leftPanel?: ReactNode;
	rightPanel?: ReactNode;
	filmstrip?: ReactNode;
	toolbar?: ReactNode;
	children: ReactNode;
	leftPanelVisible?: boolean;
	rightPanelVisible?: boolean;
	filmstripVisible?: boolean;
}

export function PanelLayout({
	leftPanel,
	rightPanel,
	filmstrip,
	toolbar,
	children,
	leftPanelVisible = true,
	rightPanelVisible = true,
	filmstripVisible = true,
}: PanelLayoutProps) {
	return (
		<div className="flex h-screen w-full flex-col overflow-hidden bg-background">
			{/* Toolbar */}
			{toolbar && (
				<div className="flex-shrink-0 border-b border-border bg-toolbar">
					{toolbar}
				</div>
			)}

			{/* Main content area */}
			<div className="flex flex-1 overflow-hidden">
				{/* Left Panel */}
				{leftPanel && leftPanelVisible && (
					<div className="w-64 flex-shrink-0 border-r border-border bg-panel overflow-hidden">
						{leftPanel}
					</div>
				)}

				{/* Center area (content + filmstrip) */}
				<div className="flex flex-1 flex-col overflow-hidden">
					{/* Main Content */}
					<div className="flex-1 overflow-hidden">{children}</div>

					{/* Filmstrip */}
					{filmstrip && filmstripVisible && (
						<div className="h-24 flex-shrink-0 border-t border-border bg-filmstrip overflow-hidden">
							{filmstrip}
						</div>
					)}
				</div>

				{/* Right Panel */}
				{rightPanel && rightPanelVisible && (
					<div className="w-72 flex-shrink-0 border-l border-border bg-panel overflow-hidden">
						{rightPanel}
					</div>
				)}
			</div>
		</div>
	);
}

// Panel section component for consistent styling
interface PanelSectionProps {
	title: string;
	children: ReactNode;
	defaultOpen?: boolean;
	actions?: ReactNode;
	className?: string;
}

export function PanelSection({
	title,
	children,
	defaultOpen = true,
	actions,
	className,
}: PanelSectionProps) {
	return (
		<div className={cn("panel-section", className)}>
			<div className="panel-header">
				<span>{title}</span>
				{actions}
			</div>
			{children}
		</div>
	);
}
