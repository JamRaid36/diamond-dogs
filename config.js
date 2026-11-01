// DEV PREVIEW config: no Firebase at all, so this site can never touch the real group's data. app.js sees DD_DEV and
// runs on sample players (backend-demo.js).
window.DD_FIREBASE = null;
window.DD_DEV = true;
