import type { Metadata } from "next";
import Script from "next/script";
import { I18nProvider } from "@/lib/i18n";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://nin.caerwydyr.ru"),
  title: "Ninjitsi simple calls",
  description: "Simple video calls powered by Jitsi.",
  alternates: {
    canonical: "/",
  },
  openGraph: {
    type: "website",
    url: "/",
    siteName: "Ninjitsi",
    title: "Ninjitsi simple calls",
    description: "Simple video calls powered by Jitsi.",
    images: [
      {
        url: "/ninjitsi-social.png",
        width: 1200,
        height: 630,
        alt: "Ninjitsi",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Ninjitsi simple calls",
    description: "Simple video calls powered by Jitsi.",
    images: ["/ninjitsi-social.png"],
  },
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
