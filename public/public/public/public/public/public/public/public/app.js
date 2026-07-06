async function initApplication() {
  $("loginView").classList.add("hidden");
  $("appView").classList.remove("hidden");

  $("userName").innerText = user.full_name || user.email;
  $("userRole").innerText = user.role;

  buildNavigation();

  try {
    await api("/health");
    $("apiStatus").innerText = "API online";
  } catch {
    $("apiStatus").innerText = "API offline";
  }

  showPage("dashboard");
}

if (token && user) {
  initApplication();
}
