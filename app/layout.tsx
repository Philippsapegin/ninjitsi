import type { Metadata } from "next";
import Script from "next/script";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ninjitsi — спокойные видеовстречи",
  description: "Desktop-first клиент для видеовстреч на базе Jitsi.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru">
      <body>
        <Script src="/runtime-config.js" strategy="beforeInteractive" />
        {children}
      </body>
    </html>
  );
}
