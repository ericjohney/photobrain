import { FolderOpen, Home, ImageIcon, Info, Settings } from "lucide-react";
import { BrowserRouter, Link, Route, Routes } from "react-router-dom";
import {
	Sidebar,
	SidebarContent,
	SidebarGroup,
	SidebarGroupContent,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarProvider,
} from "@/components/ui/sidebar";
import { About } from "@/pages/About";
import { Collections } from "@/pages/Collections";
import { Dashboard } from "@/pages/Dashboard";
import { Preferences } from "@/pages/Preferences";

function App() {
	return (
		<BrowserRouter>
			<SidebarProvider>
				<div className="flex min-h-screen w-full">
					<Sidebar>
						<SidebarHeader>
							<div className="flex items-center gap-2 px-4 py-2">
								<ImageIcon className="h-6 w-6 text-primary" />
								<span className="font-bold text-lg">PhotoBrain</span>
							</div>
						</SidebarHeader>
						<SidebarContent>
							<SidebarGroup>
								<SidebarGroupLabel>Navigation</SidebarGroupLabel>
								<SidebarGroupContent>
									<SidebarMenu>
										<SidebarMenuItem>
											<SidebarMenuButton asChild>
												<Link to="/">
													<Home className="h-4 w-4" />
													<span>Gallery</span>
												</Link>
											</SidebarMenuButton>
										</SidebarMenuItem>
										<SidebarMenuItem>
											<SidebarMenuButton asChild>
												<Link to="/collections">
													<FolderOpen className="h-4 w-4" />
													<span>Collections</span>
												</Link>
											</SidebarMenuButton>
										</SidebarMenuItem>
									</SidebarMenu>
								</SidebarGroupContent>
							</SidebarGroup>
							<SidebarGroup>
								<SidebarGroupLabel>Settings</SidebarGroupLabel>
								<SidebarGroupContent>
									<SidebarMenu>
										<SidebarMenuItem>
											<SidebarMenuButton asChild>
												<Link to="/preferences">
													<Settings className="h-4 w-4" />
													<span>Preferences</span>
												</Link>
											</SidebarMenuButton>
										</SidebarMenuItem>
										<SidebarMenuItem>
											<SidebarMenuButton asChild>
												<Link to="/about">
													<Info className="h-4 w-4" />
													<span>About</span>
												</Link>
											</SidebarMenuButton>
										</SidebarMenuItem>
									</SidebarMenu>
								</SidebarGroupContent>
							</SidebarGroup>
						</SidebarContent>
					</Sidebar>

					<Routes>
						<Route path="/" element={<Dashboard />} />
						<Route path="/collections" element={<Collections />} />
						<Route path="/preferences" element={<Preferences />} />
						<Route path="/about" element={<About />} />
					</Routes>
				</div>
			</SidebarProvider>
		</BrowserRouter>
	);
}

export default App;
