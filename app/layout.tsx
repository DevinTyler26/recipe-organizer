import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ShoppingListProvider } from "@/components/shopping-list-context";
import { AuthSessionProvider } from "@/components/session-provider";
import { ToastProvider } from "@/components/toast-provider";
import { CollaborationUIProvider } from "@/components/collaboration-ui-context";
import { SiteFooter } from "@/components/site-footer";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Recipe Organizer",
  description:
    "Keep track of your favorite dishes and build a sharable shopping list",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      {
        url: "/icons/android/android-launchericon-192-192.png",
        sizes: "192x192",
        type: "image/png",
      },
      {
        url: "/icons/android/android-launchericon-512-512.png",
        sizes: "512x512",
        type: "image/png",
      },
      {
        url: "/icons/windows11/Square150x150Logo.scale-200.png",
        sizes: "300x300",
        type: "image/png",
      },
    ],
    apple: [
      { url: "/icons/ios/120.png", sizes: "120x120", type: "image/png" },
      { url: "/icons/ios/152.png", sizes: "152x152", type: "image/png" },
      { url: "/icons/ios/167.png", sizes: "167x167", type: "image/png" },
      { url: "/icons/ios/180.png", sizes: "180x180", type: "image/png" },
    ],
    shortcut: [
      { url: "/icons/ios/192.png", sizes: "192x192", type: "image/png" },
    ],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Recipe Organizer",
  },
  other: {
    "msapplication-TileColor": "#0f172a",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: "#0f172a",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <AuthSessionProvider>
          <ToastProvider>
            <CollaborationUIProvider>
              <ShoppingListProvider>
                <div className="flex min-h-screen flex-col">
                  <div className="flex-1">{children}</div>
                  <SiteFooter />
                </div>
              </ShoppingListProvider>
            </CollaborationUIProvider>
          </ToastProvider>
        </AuthSessionProvider>
      </body>
    </html>
  );
}
