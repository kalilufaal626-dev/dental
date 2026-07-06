async function loadPatients() {
  try {
    const search = $("patientSearch")?.value || "";

    patientsCache = await api(
      `/patients${search ? "?search=" + encodeURIComponent(search) : ""}`
    );

    $("patientsTable").innerHTML = patientsCache.map(p => `
      <tr>
        <td>${p.patient_id || ""}</td>
        <td>${p.full_name}</td>
        <td>${p.phone || ""}</td>
        <td>${badge(p.status)}</td>
        <td>
          <button class="btn primary small" onclick="openPatient(${p.id})">
            Open
          </button>
        </td>
      </tr>
    `).join("");

  } catch (err) {
    toast(err.message);
  }
}

async function openPatient(id) {
  try {
    currentPatient = await api(`/patients/${id}`);

    $("profileName").innerText = currentPatient.full_name;

    $("profileInfo").innerText =
      `${currentPatient.patient_id || ""} • ${currentPatient.phone || ""} • ${currentPatient.email || ""}`;

    showPage("patientProfile");

    loadChart();
    loadRecords();
    loadXrays();

  } catch (err) {
    toast(err.message);
  }
}

function openPatientModal() {
  openModal("Add Patient", `
    <input id="pName" placeholder="Full name">
    <input id="pPhone" placeholder="Phone">
    <input id="pEmail" placeholder="Email">

    <select id="pGender">
      <option value="">Gender</option>
      <option value="male">Male</option>
      <option value="female">Female</option>
    </select>

    <input id="pDob" type="date">

    <input id="pBlood" placeholder="Blood type">
    <textarea id="pAddress" placeholder="Address"></textarea>
    <textarea id="pAllergies" placeholder="Allergies"></textarea>

    <button class="btn primary" onclick="savePatient()">Save Patient</button>
  `);
}

async function savePatient() {
  try {
    await api("/patients", {
      method: "POST",
      body: JSON.stringify({
        full_name: $("pName").value,
        phone: $("pPhone").value,
        email: $("pEmail").value,
        gender: $("pGender").value,
        date_of_birth: $("pDob").value || null,
        blood_type: $("pBlood").value,
        address: $("pAddress").value,
        allergies: $("pAllergies").value
      })
    });

    closeModal();

    loadPatients();

    toast("Patient added.");

  } catch (err) {
    toast(err.message);
  }
}

async function loadChart() {
  try {
    const chart = await api(`/patients/${currentPatient.id}/chart`);

    const chartMap = {};

    chart.forEach(item => {
      chartMap[item.tooth_number] = item;
    });

    let html = "";

    for (let i = 1; i <= 32; i++) {
      const item = chartMap[i];
      const condition = item ? item.condition : "healthy";

      html += `
        <button class="tooth ${condition}" onclick="openToothModal(${i})">
          <strong>${i}</strong>
          <small>${condition}</small>
        </button>
      `;
    }

    $("toothGrid").innerHTML = html;

  } catch (err) {
    toast(err.message);
  }
}

function openToothModal(toothNumber) {
  openModal(`Tooth ${toothNumber}`, `
    <select id="toothCondition">
      <option value="healthy">Healthy</option>
      <option value="cavity">Cavity</option>
      <option value="filling">Filling</option>
      <option value="crown">Crown</option>
      <option value="extraction">Extraction</option>
      <option value="root-canal">Root Canal</option>
      <option value="implant">Implant</option>
    </select>

    <input id="toothDate" type="date">

    <textarea id="toothNotes" placeholder="Notes"></textarea>

    <button class="btn primary" onclick="saveTooth(${toothNumber})">
      Save Tooth
    </button>
  `);
}

async function saveTooth(toothNumber) {
  try {
    await api(`/patients/${currentPatient.id}/chart`, {
      method: "POST",
      body: JSON.stringify({
        tooth_number: toothNumber,
        condition: $("toothCondition").value,
        treatment_date: $("toothDate").value || null,
        notes: $("toothNotes").value
      })
    });

    closeModal();

    loadChart();

    toast("Tooth updated.");

  } catch (err) {
    toast(err.message);
  }
}

async function loadRecords() {
  try {
    const records =
      await api(`/patients/${currentPatient.id}/records`);

    $("recordsList").innerHTML = records.length
      ? records.map(r => `
          <p>
            <strong>${new Date(r.created_at).toLocaleDateString()}</strong><br>
            ${r.diagnosis || ""}
            <br>
            <span class="muted">${r.treatment_done || ""}</span>
          </p>
        `).join("")
      : `<p class="muted">No medical records.</p>`;

  } catch (err) {
    toast(err.message);
  }
}

function openRecordModal() {
  openModal("Add Medical Record", `
    <input id="recordDiagnosis" placeholder="Diagnosis">
    <textarea id="recordDone" placeholder="Treatment done"></textarea>
    <textarea id="recordPlan" placeholder="Treatment plan"></textarea>
    <textarea id="recordNotes" placeholder="Notes"></textarea>

    <button class="btn primary" onclick="saveRecord()">Save Record</button>
  `);
}

async function saveRecord() {
  try {
    await api(`/patients/${currentPatient.id}/records`, {
      method: "POST",
      body: JSON.stringify({
        diagnosis: $("recordDiagnosis").value,
        treatment_done: $("recordDone").value,
        treatment_plan: $("recordPlan").value,
        notes: $("recordNotes").value
      })
    });

    closeModal();

    loadRecords();

    toast("Record saved.");

  } catch (err) {
    toast(err.message);
  }
}

async function loadXrays() {
  try {
    const xrays =
      await api(`/patients/${currentPatient.id}/xrays`);

    $("xraysList").innerHTML = xrays.length
      ? xrays.map(x => `
          <p>
            <strong>${x.type || "X-ray"}</strong>
            ${badge(x.status)}
            <br>
            Tooth: ${x.tooth_number || "-"}
            <br>
            <span class="muted">${x.findings || ""}</span>
          </p>
        `).join("")
      : `<p class="muted">No x-rays.</p>`;

  } catch (err) {
    toast(err.message);
  }
}

function openXrayModal() {
  openModal("Add X-ray", `
    <input id="xType" placeholder="Type">
    <input id="xTooth" type="number" placeholder="Tooth number">
    <input id="xUrl" placeholder="File URL">
    <textarea id="xFindings" placeholder="Findings"></textarea>

    <button class="btn primary" onclick="saveXray()">Save X-ray</button>
  `);
}

async function saveXray() {
  try {
    await api(`/patients/${currentPatient.id}/xrays`, {
      method: "POST",
      body: JSON.stringify({
        type: $("xType").value || "other",
        tooth_number: $("xTooth").value || null,
        file_url: $("xUrl").value,
        findings: $("xFindings").value
      })
    });

    closeModal();

    loadXrays();

    toast("X-ray saved.");

  } catch (err) {
    toast(err.message);
  }
}

function openPrescriptionModal() {
  openModal("New Prescription", `
    <input id="rxDrug" placeholder="Drug name">
    <input id="rxDosage" placeholder="Dosage">
    <input id="rxFrequency" placeholder="Frequency">
    <input id="rxDuration" placeholder="Duration">
    <textarea id="rxNotes" placeholder="Notes"></textarea>

    <button class="btn primary" onclick="savePrescription()">
      Save Prescription
    </button>
  `);
}

async function savePrescription() {
  try {
    await api(`/patients/${currentPatient.id}/prescriptions`, {
      method: "POST",
      body: JSON.stringify({
        drug_name: $("rxDrug").value,
        dosage: $("rxDosage").value,
        frequency: $("rxFrequency").value,
        duration: $("rxDuration").value,
        notes: $("rxNotes").value
      })
    });

    closeModal();

    toast("Prescription saved.");

  } catch (err) {
    toast(err.message);
  }
}
