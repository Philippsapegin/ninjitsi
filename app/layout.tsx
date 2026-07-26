import type { Metadata } from "next";
import Script from "next/script";
import { I18nProvider } from "@/lib/i18n";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ninjitsi — simple Jitsi meetings",
  description: "A desktop-first video meeting client built on Jitsi.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <Script src="/runtime-config.js" strategy="beforeInteractive" />
        <I18nProvider>{children}</I18nProvider>
      </body>
    </html>
  );
}
