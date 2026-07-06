async function loadDashboard() {
  try {
    const stats = await api("/stats");

    $("statsGrid").innerHTML = Object.entries(stats).map(([key, value]) => `
      <div class="card">
        <p class="muted">${key.replaceAll("_", " ")}</p>
        <h2>${value}</h2>
      </div>
    `).join("");

    const appointments =
      await api(`/appointments?date=${today()}`).catch(() => []);

    $("todayAppointments").innerHTML = appointments.length
      ? appointments.map(a => `
          <p>
            <strong>${a.time}</strong>
            ${a.patient_name || ""}
            — ${a.treatment}
            ${badge(a.status)}
          </p>
        `).join("")
      : `<p class="muted">No appointments today.</p>`;

    const lowStock =
      await api("/drugs?low=true").catch(() => []);

    $("lowStockDrugs").innerHTML = lowStock.length
      ? lowStock.map(d => `
          <p>
            <strong>${d.name}</strong>
            — ${d.stock}/${d.min_stock}
          </p>
        `).join("")
      : `<p class="muted">No low stock drugs.</p>`;

  } catch (err) {
    toast(err.message);
  }
}
