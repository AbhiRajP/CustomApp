import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Azure Cloud Monitoring Platform',
  description: 'Production-oriented Azure monitoring, cost intelligence, and AI optimization dashboard.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
