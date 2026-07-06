const rolePages = {
  admin: ["dashboard", "patients", "appointments", "pharmacy", "billing", "services", "staff", "audit"],
  dentist: ["dashboard", "patients", "appointments"],
  receptionist: ["dashboard", "patients", "appointments", "billing"],
  pharmacist: ["dashboard", "pharmacy"],
  assistant: ["dashboard", "patients", "appointments"],
  patient: ["dashboard", "patients", "appointments", "pharmacy", "billing"]
};

const pageTitles = {
  dashboard: "Dashboard",
  patients: "Patients",
  appointments: "Appointments",
  pharmacy: "Pharmacy",
  billing: "Billing",
  services: "Services",
  staff: "Staff",
  audit: "Audit Logs"
};

function buildNavigation() {
  const pages = rolePages[user.role] || ["dashboard"];

  $("nav").innerHTML = pages.map(page => `
    <button onclick="showPage('${page}')">
      ${pageTitles[page]}
    </button>
  `).join("");
}

function showPage(page) {
  document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));

  const target = $(`${page}Page`);
  if (target) target.classList.add("active");

  $("pageTitle").innerText = pageTitles[page] || page;

  if (page === "dashboard") loadDashboard();
  if (page === "patients") loadPatients();
  if (page === "appointments") loadAppointments();
  if (page === "pharmacy") {
    loadDrugs();
    loadPrescriptions();
  }
  if (page === "billing") loadInvoices();
  if (page === "services") loadServices();
  if (page === "staff") loadStaff();
  if (page === "audit") loadAudit();
}
