import type { Metadata } from "next";
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
      <body>{children}</body>
    </html>
  );
}
