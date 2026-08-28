import type { Metadata } from "next";
import "./globals.css";
import "./memory-reminder.css";

export const metadata: Metadata = {
  title: "Job Hunt",
  description: "Private job application console",
};

// Authentication is read through the Supabase server client from nested
// layouts/pages. Keep every route request-bound so a build cannot prerender a
// signed-out dashboard and then try to reuse it for an authenticated user.
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
