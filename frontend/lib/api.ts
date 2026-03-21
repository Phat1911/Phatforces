import axios from 'axios';

const isProd = process.env.NODE_ENV === 'production';
const cleanUrl = (value: string | undefined, fallback: string) => (value || fallback).trim().replace(/[\r\n]+/g, '');
const API_URL = cleanUrl(process.env.NEXT_PUBLIC_API_URL, isProd ? '/api/v1' : 'http://localhost:8080/api/v1');
const UPLOADS_URL = cleanUrl(process.env.NEXT_PUBLIC_UPLOADS_URL, isProd ? '' : 'http://localhost:8080');

export const api = axios.create({
  baseURL: API_URL,
  // Use bearer token auth only; avoids browser CORS rejection when server returns wildcard origin.
  withCredentials: false,
});

api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
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
  return UPLOADS_URL ? UPLOADS_URL + url : url;
};

export const getThumbUrl = (url: string) => {
  if (!url) return '';
  if (url.startsWith('http')) return url;
  return UPLOADS_URL ? UPLOADS_URL + url : url;
};
