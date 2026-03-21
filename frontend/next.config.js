/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    domains: ['localhost', '127.0.0.1', 'api.phatforces.me'],
  },
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: 'https://api.phatforces.me/api/:path*',
      },
      {
        source: '/uploads/:path*',
        destination: 'https://api.phatforces.me/uploads/:path*',
      },
    ];
  },
};
module.exports = nextConfig;
