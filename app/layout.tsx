import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ShoppingListProvider } from "@/components/shopping-list-context";
import { AuthSessionProvider } from "@/components/session-provider";
import { ToastProvider } from "@/components/toast-provider";
import { CollaborationUIProvider } from "@/components/collaboration-ui-context";
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
              <ShoppingListProvider>{children}</ShoppingListProvider>
            </CollaborationUIProvider>
          </ToastProvider>
        </AuthSessionProvider>
      </body>
    </html>
  );
}
