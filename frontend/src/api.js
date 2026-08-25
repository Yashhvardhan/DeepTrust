import axios from 'axios';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || 'http://localhost:5000/api',
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use((response) => response, (error) => {
  if (error.response?.status === 401 && !String(error.config?.url||'').includes('/auth/')) {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
  }
  return Promise.reject(error);
});

export const register = (email, password) =>
  api.post('/auth/register', { email, password });

export const login = (email, password) =>
  api.post('/auth/login', { email, password });

export const health = () => api.get('/health');

export const analyze = (formData) =>
  api.post('/analyze', formData, {
    headers: { "Content-Type": "multipart/form-data" },
  });

export const getHistory = () => api.get('/analyze/history');
export const getReport = (id) => api.get(`/analyze/${id}`);

export default api;