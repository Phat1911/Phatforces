import type { Metadata } from 'next';
import './globals.css';
import { Toaster } from 'react-hot-toast';

export const metadata: Metadata = {
  title: 'Phatforces - Short Videos',
  description: 'Phatforces - Share your moments with the world',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="vi">
      <body>
        {children}
        <Toaster
          position="top-center"
          toastOptions={{
            style: { background: '#1F2030', color: '#fff', border: '1px solid #2D2F3E' },
          }}
        />
      </body>
    </html>
  );
}
