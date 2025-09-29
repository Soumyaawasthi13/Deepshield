

document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("open-dashboard");
  btn.addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
  });
});
