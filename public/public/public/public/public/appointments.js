async function loadDoctors() {
  try {
    doctorsCache = await api("/doctors");
  } catch (err) {
    doctorsCache = [];
    toast(err.message);
  }
}

async function loadAppointments() {
  try {
    const date = $("appointmentDate")?.value || "";

    const appointments = await api(
      `/appointments${date ? "?date=" + date : ""}`
    );

    $("appointmentsTable").innerHTML = appointments.map(a => `
      <tr>
        <td>${a.date ? a.date.slice(0, 10) : ""}</td>
        <td>${a.time || ""}</td>
        <td>${a.patient_name || ""}</td>
        <td>${a.doctor_name || ""}</td>
        <td>${a.treatment || ""}</td>
        <td>${badge(a.status)}</td>
        <td>
          <button class="btn primary small" onclick="completeAppointment(${a.id})">
            Done
          </button>
        </td>
      </tr>
    `).join("");

  } catch (err) {
    toast(err.message);
  }
}

async function openAppointmentModal() {
  try {
    await loadPatients();
    await loadDoctors();

    openModal("Book Appointment", `
      <select id="appointmentPatient">
        <option value="">Select patient</option>
        ${patientsCache.map(p => `
          <option value="${p.id}">${p.full_name}</option>
        `).join("")}
      </select>

      <select id="appointmentDoctor">
        <option value="">Select doctor</option>
        ${doctorsCache.map(d => `
          <option value="${d.id}">${d.full_name}</option>
        `).join("")}
      </select>

      <input id="appointmentNewDate" type="date" value="${today()}">
      <input id="appointmentTime" type="time">

      <input id="appointmentTreatment" placeholder="Treatment">
      <textarea id="appointmentNotes" placeholder="Notes"></textarea>

      <button class="btn primary" onclick="saveAppointment()">
        Book Appointment
      </button>
    `);

  } catch (err) {
    toast(err.message);
  }
}

async function saveAppointment() {
  try {
    await api("/appointments", {
      method: "POST",
      body: JSON.stringify({
        patient_id: $("appointmentPatient").value,
        doctor_id: $("appointmentDoctor").value,
        date: $("appointmentNewDate").value,
        time: $("appointmentTime").value,
        treatment: $("appointmentTreatment").value,
        notes: $("appointmentNotes").value,
        type: "booked"
      })
    });

    closeModal();

    loadAppointments();

    toast("Appointment booked.");

  } catch (err) {
    toast(err.message);
  }
}

async function completeAppointment(id) {
  try {
    await api(`/appointments/${id}`, {
      method: "PATCH",
      body: JSON.stringify({
        status: "completed"
      })
    });

    loadAppointments();

    toast("Appointment completed.");

  } catch (err) {
    toast(err.message);
  }
}
