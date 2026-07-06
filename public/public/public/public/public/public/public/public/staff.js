async function loadStaff() {
  try {
    const staff = await api("/staff");

    $("staffTable").innerHTML = staff.map(s => `
      <tr>
        <td>${s.full_name}</td>
        <td>${s.role}</td>
        <td>${s.email || ""}</td>
        <td>${s.phone || ""}</td>
        <td>${badge(s.status)}</td>
      </tr>
    `).join("");

  } catch (err) {
    toast(err.message);
  }
}

function openStaffModal() {
  openModal("Add Staff", `
    <input id="staffName" placeholder="Full name">
    <input id="staffEmail" placeholder="Email">
    <input id="staffPassword" type="password" placeholder="Password">

    <select id="staffRole">
      <option value="dentist">Dentist</option>
      <option value="receptionist">Receptionist</option>
      <option value="pharmacist">Pharmacist</option>
      <option value="assistant">Assistant</option>
      <option value="admin">Admin</option>
    </select>

    <input id="staffPhone" placeholder="Phone">
    <input id="staffSpecialization" placeholder="Specialization">

    <button class="btn primary" onclick="saveStaff()">Save Staff</button>
  `);
}

async function saveStaff() {
  try {
    await api("/staff", {
      method: "POST",
      body: JSON.stringify({
        full_name: $("staffName").value,
        email: $("staffEmail").value,
        password: $("staffPassword").value,
        role: $("staffRole").value,
        phone: $("staffPhone").value,
        specialization: $("staffSpecialization").value
      })
    });

    closeModal();
    loadStaff();
    toast("Staff added.");

  } catch (err) {
    toast(err.message);
  }
}

async function loadAudit() {
  try {
    const logs = await api("/audit-logs");

    $("auditTable").innerHTML = logs.map(a => `
      <tr>
        <td>${new Date(a.created_at).toLocaleString()}</td>
        <td>${a.action || ""}</td>
        <td>${a.entity || ""}</td>
        <td>${a.actor_name || ""}</td>
        <td>${a.description || ""}</td>
      </tr>
    `).join("");

  } catch (err) {
    toast(err.message);
  }
}
