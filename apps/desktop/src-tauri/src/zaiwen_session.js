// Read only the dedicated top-level production site. This script does no HTTP.
JSON.stringify(
  window.top === window && location.origin === "https://chat.zaiwenai.com"
    ? localStorage.getItem("token") : null
);
