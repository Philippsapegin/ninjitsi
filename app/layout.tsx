import type { Metadata } from "next";
import Script from "next/script";
import { I18nProvider } from "@/lib/i18n";
import "./globals.css";

const previewTitle = "Ninjitsi";
const previewDescription = "simple calls";
const previewIcon = "/ninjitsi-preview-icon.png";

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
    title: previewTitle,
    description: previewDescription,
    images: [
      {
        url: previewIcon,
        width: 256,
        height: 256,
        alt: previewTitle,
      },
    ],
  },
  twitter: {
    card: "summary",
    title: previewTitle,
    description: previewDescription,
    images: [previewIcon],
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
