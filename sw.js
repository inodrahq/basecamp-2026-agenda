// Exists so Android Chrome can show reminders; nothing is cached.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => (cs[0] ? cs[0].focus() : self.clients.openWindow("./"))),
  );
});
