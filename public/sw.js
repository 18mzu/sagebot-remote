// SageBot Mobile Service Worker - Push & Background Notifications
const CACHE_NAME = 'sagebot-v4.0';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Listen for Web Push events from push server (APNs / FCM)
self.addEventListener('push', (event) => {
  let data = {
    title: 'SageBot Alert',
    body: 'Match status updated.',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: 'sagebot-alert',
  };

  if (event.data) {
    try {
      const json = event.data.json();
      data = { ...data, ...json };
    } catch {
      data.body = event.data.text();
    }
  }

  const options = {
    body: data.body,
    icon: data.icon || '/icon-192.png',
    badge: data.badge || '/icon-192.png',
    tag: data.tag || 'sagebot-status',
    vibrate: [150, 80, 150],
    data: {
      url: '/',
    },
  };

  event.waitUntil(self.registration.showNotification(data.title, options));
});

// Listen for messages from frontend App to trigger native OS system notification
self.addEventListener('message', (event) => {
  if (!event.data) return;

  if (event.data.type === 'SHOW_NOTIFICATION') {
    const { title, body, tag } = event.data;
    const options = {
      body: body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: tag || 'sagebot-status',
      vibrate: [150, 80, 150],
      renotify: true,
      data: {
        url: '/',
      },
    };

    self.registration.showNotification(title || 'SageBot Alert', options);
  }
});

// Click notification to focus/open the SageBot app
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes('/') && 'focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow('/');
      }
    })
  );
});
