// 서버실 점검 앱 서비스워커 — 오프라인에서도 앱 껍데기가 뜨도록 정적 파일을 캐싱합니다.
// 실제 점검 기록 전송(fetch to Apps Script)은 캐싱하지 않고 항상 네트워크로 보냅니다.

const CACHE_NAME = 'server-room-checklist-v12';
const PRECACHE_URLS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Apps Script(또는 다른 원격 API) 요청은 캐시하지 않고 네트워크로만 처리
  if (url.origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((res) => {
          if (res && res.status === 200 && event.request.method === 'GET') {
            const resClone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, resClone));
          }
          return res;
        })
        .catch(() => caches.match('./index.html'));
    })
  );
});
