import axios from 'axios';
import Cookies from 'js-cookie';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080/api/v1';
const UPLOADS_URL = process.env.NEXT_PUBLIC_UPLOADS_URL || 'http://localhost:8080';

export const api = axios.create({ baseURL: API_URL });

api.interceptors.request.use((config) => {
  const token = Cookies.get('photcot_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      Cookies.remove('photcot_token');
      // FIX: Dispatch event instead of redirecting to non-existent /login page
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('photcot:auth-expired'));
      }
    }
    return Promise.reject(err);
  }
);

export const getVideoUrl = (url: string) => {
  if (!url) return '';
  if (url.startsWith('http')) return url;
  return UPLOADS_URL + url;
};

export const getThumbUrl = (url: string) => {
  if (!url) return '';
  if (url.startsWith('http')) return url;
  return UPLOADS_URL + url;
};
